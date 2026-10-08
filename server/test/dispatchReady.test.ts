import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { readyLines } from '../src/services/dispatchReady.js';
import { qcBlockError } from '../src/services/qc.js';
import { advanceBlockError } from '../src/services/despatchLimits.js';
import type { AuthedRequest } from '../src/middleware/auth.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * "What can be loaded onto a lorry now."
 *
 * Most of what is worth pinning here is what must **not** appear: a queue that
 * names goods which cannot actually go is worse than no queue, because the
 * save then refuses what the badge promised.
 */

const req = { user: { id: 1, team_role: 'super_admin' } } as unknown as AuthedRequest;

let seq = 0;

function makeProduct(opts: { spec?: boolean; madeHere?: boolean } = {}): number {
  const id = Number(db.prepare(
    "INSERT INTO products (name, unit, made_here) VALUES (?, 'per 1000', ?)"
  ).run(`Product ${++seq}`, opts.madeHere === false ? 0 : 1).lastInsertRowid);
  if (opts.spec) {
    db.prepare(
      `INSERT INTO product_qc_params (product_id, name, kind, unit, min_value, max_value, sort_order)
       VALUES (?, 'Wall thickness', 'numeric', 'mm', 0.3, 0.5, 0)`
    ).run(id);
  }
  return id;
}

/** `null` is a charge line. `total_pcs` is the ordered figure in pieces. */
function makeOrder(lines: ({ productId: number | null; pcs?: number } | null)[]): number {
  const orderId = Number(db.prepare(
    "INSERT INTO orders (number, date, customer_id, currency, status) VALUES (?, '2026-10-01', ?, 'INR', 'scheduled')"
  ).run(`SO/T/${++seq}`, makeCustomer()).lastInsertRowid);
  lines.forEach((l, i) => {
    const charge = l === null;
    db.prepare(
      `INSERT INTO order_items (order_id, product_id, description, qty, unit, total_pcs, is_charge, sort_order)
       VALUES (?, ?, ?, ?, 'per 1000', ?, ?, ?)`
    ).run(
      orderId, charge ? null : l!.productId, charge ? 'Freight' : `Line ${i}`,
      charge ? 1 : (l!.pcs ?? 10000) / 1000, charge ? null : (l!.pcs ?? 10000),
      charge ? 1 : 0, i,
    );
  });
  return orderId;
}

function makeJob(orderId: number, line: number, productId: number | null, planned = 10000): number {
  return Number(db.prepare(
    `INSERT INTO work_orders (number, order_id, order_line, product_id, qty_planned, status)
     VALUES (?, ?, ?, ?, ?, 'released')`
  ).run(`WO/T/${++seq}`, orderId, line, productId, planned).lastInsertRowid);
}

function book(jobId: number, ok: number, batchId: number | null = null): void {
  db.prepare(
    `INSERT INTO production_entries (work_order_id, date, shift, qty_ok, qty_reject, batch_id)
     VALUES (?, '2026-10-02', 'A', ?, 0, ?)`
  ).run(jobId, ok, batchId);
}

function ship(orderId: number, line: number, qty: number): void {
  const id = Number(db.prepare(
    "INSERT INTO despatches (order_id, date) VALUES (?, '2026-10-03')"
  ).run(orderId).lastInsertRowid);
  db.prepare(
    'INSERT INTO despatch_items (despatch_id, order_line, qty, sort_order) VALUES (?, ?, ?, 0)'
  ).run(id, line, qty);
}

/** A check whose single reading is in tolerance or out of it. */
function pass(jobId: number, value = 0.4): void {
  const checkId = Number(db.prepare(
    "INSERT INTO qc_checks (work_order_id, date, inspector) VALUES (?, '2026-10-02', 'QC')"
  ).run(jobId).lastInsertRowid);
  db.prepare(
    `INSERT INTO qc_results (check_id, name, kind, unit, value, min_value, max_value, sort_order)
     VALUES (?, 'Wall thickness', 'numeric', 'mm', ?, 0.3, 0.5, 0)`
  ).run(checkId, value);
}

const forOrder = (orderId: number) => readyLines(req).rows.filter((r) => r.order_id === orderId);

describe('what is ready to dispatch', () => {
  test('a line that has been made and not sent is ready, in pieces', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    book(makeJob(o, 0, p, 20000), 12000);
    const rows = forOrder(o);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ordered, 20000);
    assert.equal(rows[0].made, 12000);
    assert.equal(rows[0].sent, 0);
    assert.equal(rows[0].ready, 12000);
    assert.equal(rows[0].held, null);
  });

  test('part of it shipped leaves the rest ready', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    book(makeJob(o, 0, p, 20000), 12000);
    ship(o, 0, 5000);
    assert.equal(forOrder(o)[0].ready, 7000);
  });

  test('a line with nothing made is not in the queue at all', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    makeJob(o, 0, p, 20000);
    assert.deepEqual(forOrder(o), []);
  });

  test('a line already fully sent leaves the queue', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    book(makeJob(o, 0, p, 20000), 20000);
    ship(o, 0, 20000);
    assert.deepEqual(forOrder(o), []);
  });

  test('an over-run is capped at what was ordered — it is not an instruction to ship more', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    book(makeJob(o, 0, p, 20000), 26000);
    const row = forOrder(o)[0];
    assert.equal(row.made, 26000);
    assert.equal(row.ready, 20000);
  });

  test('a charge line never appears, however the order is numbered', () => {
    const p = makeProduct();
    // Freight at position 1, so the goods line after it sits at position 2.
    const o = makeOrder([{ productId: p, pcs: 10000 }, null, { productId: p, pcs: 10000 }]);
    book(makeJob(o, 0, p), 10000);
    book(makeJob(o, 2, p), 10000);
    const rows = forOrder(o);
    assert.deepEqual(rows.map((r) => r.order_line), [0, 2]);
  });

  test('a scrapped lot is not ready to ship', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    const job = makeJob(o, 0, p, 20000);
    const batch = Number(db.prepare(
      "INSERT INTO batches (number, work_order_id, date) VALUES (?, ?, '2026-10-02')"
    ).run(`B/T/${++seq}`, job).lastInsertRowid);
    book(job, 12000, batch);
    assert.equal(forOrder(o)[0].ready, 12000);
    db.prepare("UPDATE batches SET disposition = 'scrapped' WHERE id = ?").run(batch);
    assert.deepEqual(forOrder(o), []);
  });

  test('a cancelled job does not count as having made anything', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    const job = makeJob(o, 0, p, 20000);
    book(job, 12000);
    db.prepare("UPDATE work_orders SET status = 'cancelled' WHERE id = ?").run(job);
    assert.deepEqual(forOrder(o), []);
  });

  test('a split run names both of its jobs', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    book(makeJob(o, 0, p, 10000), 6000);
    book(makeJob(o, 0, p, 10000), 4000);
    const row = forOrder(o)[0];
    assert.equal(row.made, 10000);
    assert.equal(row.jobs.length, 2);
  });

  test('a cancelled or completed order is not offered', () => {
    const p = makeProduct();
    for (const status of ['cancelled', 'completed']) {
      const o = makeOrder([{ productId: p, pcs: 20000 }]);
      book(makeJob(o, 0, p, 20000), 20000);
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, o);
      assert.deepEqual(forOrder(o), [], status);
    }
  });

  test('a bought-in line is ready without a job, and says so', () => {
    const p = makeProduct({ madeHere: false });
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    const row = forOrder(o)[0];
    assert.equal(row.bought_in, true);
    assert.equal(row.ready, 20000);
    assert.deepEqual(row.jobs, []);
  });
});

describe('what is holding a line back', () => {
  test('a spec\'d line with no passing check is held, in the gate\'s own words', () => {
    const p = makeProduct({ spec: true });
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    book(makeJob(o, 0, p, 20000), 12000);
    const row = forOrder(o)[0];
    // Not a copy of the sentence: the queue must say what the save would say.
    assert.equal(row.held, qcBlockError(o, [{ order_line: 0 }]));
    assert.match(row.held!, /has not passed QC yet/);
    assert.equal(row.ready, 12000, 'still listed — the goods exist, they are just held');
  });

  test('recording the pass releases it', () => {
    const p = makeProduct({ spec: true });
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    const job = makeJob(o, 0, p, 20000);
    book(job, 12000);
    assert.notEqual(forOrder(o)[0].held, null);
    pass(job);
    assert.equal(forOrder(o)[0].held, null);
  });

  test('a failed check does not release it — a failure is not a pass', () => {
    const p = makeProduct({ spec: true });
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    const job = makeJob(o, 0, p, 20000);
    book(job, 12000);
    pass(job, 0.9);
    assert.notEqual(forOrder(o)[0].held, null);
  });

  test('an unpaid advance holds the line, in the money gate\'s own words', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    db.prepare("UPDATE orders SET payment_terms = ?, grand_total = 50000 WHERE id = ?")
      .run('30% Advance and Balance before Dispatch', o);
    book(makeJob(o, 0, p, 20000), 12000);
    const row = forOrder(o)[0];
    assert.equal(row.held, advanceBlockError(o));
    // These terms settle the balance before dispatch, so the gate holds the
    // whole order value rather than the 30% — its `full` basis, not `advance`.
    assert.match(row.held!, /has not been paid for/);
    assert.equal(row.ready, 12000, 'still listed — Logistics can see it is waiting on Sales');
  });

  test('an export order on the same split holds the advance alone', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    db.prepare("UPDATE orders SET payment_terms = ?, grand_total = 50000 WHERE id = ?")
      .run('30% Advance and Balance against shipping documents', o);
    book(makeJob(o, 0, p, 20000), 12000);
    assert.match(forOrder(o)[0].held!, /up front/);
  });

  test('QC is reported before money, the order the save asks them in', () => {
    const p = makeProduct({ spec: true });
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    db.prepare("UPDATE orders SET payment_terms = ?, grand_total = 50000 WHERE id = ?")
      .run('30% Advance and Balance before Dispatch', o);
    book(makeJob(o, 0, p, 20000), 12000);
    assert.match(forOrder(o)[0].held!, /has not passed QC yet/);
  });

  test('terms naming no money hold nothing', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    db.prepare("UPDATE orders SET payment_terms = '30 Days Credit', grand_total = 50000 WHERE id = ?").run(o);
    book(makeJob(o, 0, p, 20000), 12000);
    assert.equal(forOrder(o)[0].held, null);
  });

  test('held lines are counted apart from ready ones, so the badge promises only what can go', () => {
    const plain = makeProduct();
    const specd = makeProduct({ spec: true });
    const a = makeOrder([{ productId: plain, pcs: 10000 }]);
    const b = makeOrder([{ productId: specd, pcs: 10000 }]);
    book(makeJob(a, 0, plain), 10000);
    book(makeJob(b, 0, specd), 10000);
    const all = readyLines(req);
    const ours = all.rows.filter((r) => r.order_id === a || r.order_id === b);
    assert.equal(ours.filter((r) => !r.held).length, 1);
    assert.equal(ours.filter((r) => r.held).length, 1);
    assert.equal(all.ready, all.rows.filter((r) => !r.held).length);
    assert.equal(all.held, all.rows.filter((r) => r.held).length);
  });
});
