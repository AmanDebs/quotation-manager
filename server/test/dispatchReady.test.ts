import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { readyLines } from '../src/services/dispatchReady.js';
import { qcBlockError } from '../src/services/qc.js';
import { advanceBlockError } from '../src/services/despatchLimits.js';
import { setApproval, deskApprovalError } from '../src/services/dispatchApproval.js';
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

/** A real row, since `dispatch_approvals.approved_by` is a foreign key. */
const APPROVER = Number(db.prepare(
  "INSERT INTO users (name, email, password_hash, role, team_role) VALUES ('Desk', 'desk@test', 'x', 'employee', 'sales')"
).run().lastInsertRowid);

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

/**
 * The sales desk releasing a line, the way the button does: everything the
 * floor has made and not yet sent, unless a figure is named.
 *
 * Nothing reaches *Ready to dispatch* without this since 2026-10-08, so most
 * of the cases below call it — which is the gate being visible rather than a
 * nuisance.
 */
function release(orderId: number, line: number, qty?: number): void {
  const row = readyLines(req).rows.find((r) => r.order_id === orderId && r.order_line === line);
  const supply = row ? Math.min(row.made, row.ordered) : 0;
  setApproval(orderId, line, qty ?? supply, APPROVER);
}

const forOrder = (orderId: number) => readyLines(req).rows.filter((r) => r.order_id === orderId);

describe('what is ready to dispatch', () => {
  test('a line that has been made and not sent is ready, in pieces', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    book(makeJob(o, 0, p, 20000), 12000);
    release(o, 0);
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
    release(o, 0);
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
    release(o, 0);
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
    release(o, 0);
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

  /*
   * 2026-10-08, the client: *"leave them out"*. A bought-in line raises no job
   * and the QC gate skips it, so it is shippable from the day the order is
   * booked — which made it a permanent resident of a queue that exists to say
   * what has just become ready. Asserted on a line that *could* otherwise
   * qualify, so flipping the rule back trips this rather than passing quietly.
   */
  test('a bought-in line is left out entirely, however much of it was ordered', () => {
    const p = makeProduct({ madeHere: false });
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    assert.deepEqual(forOrder(o), []);
  });

  test('and stays out even where somebody has booked output against it', () => {
    const p = makeProduct({ madeHere: false });
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    book(makeJob(o, 0, p, 20000), 12000);
    assert.deepEqual(forOrder(o), []);
  });

  /* A custom line names no product, so there is nothing to call bought in —
     `COALESCE(p.made_here, 1)` reads it as made here, and it keeps its job. */
  test('a custom line naming no product is not mistaken for a bought-in one', () => {
    const o = makeOrder([{ productId: null, pcs: 20000 }]);
    book(makeJob(o, 0, null, 20000), 12000);
    release(o, 0);
    const rows = forOrder(o);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ready, 12000);
  });

  test('every row names at least one job — output implies a live job', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    book(makeJob(o, 0, p, 20000), 12000);
    assert.ok(forOrder(o).every((r) => r.jobs.length > 0));
  });
});

describe('what is holding a line back', () => {
  test('a spec\'d line with no passing check is held, in the gate\'s own words', () => {
    const p = makeProduct({ spec: true });
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    book(makeJob(o, 0, p, 20000), 12000);
    release(o, 0);
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
    release(o, 0);
    assert.notEqual(forOrder(o)[0].held, null);
    pass(job);
    assert.equal(forOrder(o)[0].held, null);
  });

  test('a failed check does not release it — a failure is not a pass', () => {
    const p = makeProduct({ spec: true });
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    const job = makeJob(o, 0, p, 20000);
    book(job, 12000);
    release(o, 0);
    pass(job, 0.9);
    assert.notEqual(forOrder(o)[0].held, null);
  });

  test('an unpaid advance holds the line, in the money gate\'s own words', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    db.prepare("UPDATE orders SET payment_terms = ?, grand_total = 50000 WHERE id = ?")
      .run('30% Advance and Balance before Dispatch', o);
    book(makeJob(o, 0, p, 20000), 12000);
    release(o, 0);
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
    release(o, 0);
    assert.match(forOrder(o)[0].held!, /up front/);
  });

  test('QC is reported before money, the order the save asks them in', () => {
    const p = makeProduct({ spec: true });
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    db.prepare("UPDATE orders SET payment_terms = ?, grand_total = 50000 WHERE id = ?")
      .run('30% Advance and Balance before Dispatch', o);
    book(makeJob(o, 0, p, 20000), 12000);
    release(o, 0);
    assert.match(forOrder(o)[0].held!, /has not passed QC yet/);
  });

  test('terms naming no money hold nothing', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    db.prepare("UPDATE orders SET payment_terms = '30 Days Credit', grand_total = 50000 WHERE id = ?").run(o);
    book(makeJob(o, 0, p, 20000), 12000);
    release(o, 0);
    assert.equal(forOrder(o)[0].held, null);
  });

  test('held lines are counted apart from ready ones, so the badge promises only what can go', () => {
    const plain = makeProduct();
    const specd = makeProduct({ spec: true });
    const a = makeOrder([{ productId: plain, pcs: 10000 }]);
    const b = makeOrder([{ productId: specd, pcs: 10000 }]);
    book(makeJob(a, 0, plain), 10000);
    book(makeJob(b, 0, specd), 10000);
    release(a, 0);
    release(b, 0);
    const all = readyLines(req);
    const ours = all.rows.filter((r) => r.order_id === a || r.order_id === b);
    assert.equal(ours.filter((r) => !r.held).length, 1);
    assert.equal(ours.filter((r) => r.held).length, 1);
    assert.equal(all.ready, all.rows.filter((r) => r.ready > 0 && !r.held).length);
    assert.equal(all.held, all.rows.filter((r) => r.held).length);
  });
});

/**
 * The sales desk's release (2026-10-08, the client: *"When a product is ready,
 * it should be first be approved by the SPOC of that order, if he approves
 * then it should go to ready to dispatch tab so that logistic person can
 * record dispatch"*).
 *
 * The one stored fact in this queue, so most of what is worth pinning is the
 * arithmetic that keeps the two audiences' lists adding up rather than
 * overlapping — and that nothing reaches Logistics before somebody signs it.
 */
describe('the sales desk releasing goods for dispatch', () => {
  test('made and unreleased is awaiting the desk, and ready to nobody', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    book(makeJob(o, 0, p, 20000), 12000);
    const row = forOrder(o)[0];
    assert.equal(row.made, 12000);
    assert.equal(row.awaiting, 12000);
    assert.equal(row.ready, 0, 'Logistics cannot load it until the desk releases it');
    assert.match(row.held!, /not yet released for dispatch/);
  });

  test('releasing it moves the whole figure across', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    book(makeJob(o, 0, p, 20000), 12000);
    release(o, 0);
    const row = forOrder(o)[0];
    assert.equal(row.ready, 12000);
    assert.equal(row.awaiting, 0);
    assert.equal(row.held, null);
    assert.equal(row.approved, 12000);
  });

  /* The whole reason it is a quantity rather than a flag: a flag would release
     next week's production on last week's signature. */
  test('making more after a release leaves the excess awaiting the desk again', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    const job = makeJob(o, 0, p, 20000);
    book(job, 12000);
    release(o, 0);
    book(job, 5000);
    const row = forOrder(o)[0];
    assert.equal(row.made, 17000);
    assert.equal(row.ready, 12000, 'what was signed off stays signed off');
    assert.equal(row.awaiting, 5000);
    assert.equal(row.held, null, 'it is on the ready list, so it is not held');
  });

  test('releasing again clears the remainder', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    const job = makeJob(o, 0, p, 20000);
    book(job, 12000);
    release(o, 0);
    book(job, 5000);
    release(o, 0);
    const row = forOrder(o)[0];
    assert.equal(row.ready, 17000);
    assert.equal(row.awaiting, 0);
  });

  test('a partial release splits the line between the two queues', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    book(makeJob(o, 0, p, 20000), 12000);
    release(o, 0, 5000);
    const row = forOrder(o)[0];
    assert.equal(row.ready, 5000);
    assert.equal(row.awaiting, 7000);
  });

  test('shipping what was released leaves nothing ready and nothing awaiting', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    book(makeJob(o, 0, p, 20000), 12000);
    release(o, 0);
    ship(o, 0, 12000);
    assert.deepEqual(forOrder(o), []);
  });

  /* Withdrawing has to stay possible — an approval has no artefact out in the
     world, and one that could not be taken back would be a trap. */
  test('withdrawing a release puts the line back on the desk', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    book(makeJob(o, 0, p, 20000), 12000);
    release(o, 0);
    assert.equal(forOrder(o)[0].ready, 12000);
    setApproval(o, 0, 0, APPROVER);
    const row = forOrder(o)[0];
    assert.equal(row.ready, 0);
    assert.equal(row.awaiting, 12000);
    assert.equal(row.approved, 0);
  });

  /* Goods that have gone are gone: withdrawing cannot un-ship them, so they
     must not reappear as something for the desk to sign off. */
  test('withdrawing after a lorry has left does not put shipped goods back in a queue', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    const job = makeJob(o, 0, p, 20000);
    book(job, 17000);
    release(o, 0);
    ship(o, 0, 12000);
    setApproval(o, 0, 0, APPROVER);
    const row = forOrder(o)[0];
    assert.equal(row.sent, 12000);
    assert.equal(row.ready, 0);
    assert.equal(row.awaiting, 5000, 'only the part still here is awaiting anybody');
  });

  test('releasing more than was made releases only what was made', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    book(makeJob(o, 0, p, 20000), 12000);
    setApproval(o, 0, 20000, APPROVER);
    assert.equal(forOrder(o)[0].ready, 12000);
  });

  test('the counts answer three separate questions', () => {
    const p = makeProduct();
    const a = makeOrder([{ productId: p, pcs: 10000 }]);
    const b = makeOrder([{ productId: p, pcs: 10000 }]);
    book(makeJob(a, 0, p), 10000);
    book(makeJob(b, 0, p), 10000);
    release(a, 0);
    const all = readyLines(req);
    assert.equal(all.ready, all.rows.filter((r) => r.ready > 0 && !r.held).length);
    assert.equal(all.awaiting, all.rows.filter((r) => r.awaiting > 0).length);
    const ours = all.rows.filter((r) => r.order_id === a || r.order_id === b);
    assert.equal(ours.filter((r) => r.ready > 0 && !r.held).length, 1);
    assert.equal(ours.filter((r) => r.awaiting > 0).length, 1);
  });

  /* QC and the advance are the save's own guards and their sentence is the one
     the save would give; saying "awaiting Meisha" over a failed check would
     send somebody to chase the wrong person. */
  test('a QC hold is reported ahead of the missing release', () => {
    const p = makeProduct({ spec: true });
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    book(makeJob(o, 0, p, 20000), 12000);
    assert.match(forOrder(o)[0].held!, /has not passed QC yet/);
  });

  test('the hold names the SPOC where the order has one', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    db.prepare("UPDATE orders SET spoc = 'Meisha' WHERE id = ?").run(o);
    book(makeJob(o, 0, p, 20000), 12000);
    const row = forOrder(o)[0];
    assert.equal(row.spoc, 'Meisha');
    assert.match(row.held!, /not yet released for dispatch by Meisha/);
  });

  test('and says so plainly where it has none', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    book(makeJob(o, 0, p, 20000), 12000);
    assert.equal(forOrder(o)[0].held, 'Made, but not yet released for dispatch.');
  });

  test('a release records who gave it', () => {
    const p = makeProduct();
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    book(makeJob(o, 0, p, 20000), 12000);
    release(o, 0);
    const row = db.prepare('SELECT * FROM dispatch_approvals WHERE order_id = ? AND order_line = ?')
      .get(o, 0) as { approved_by: number; approved_qty: number } | undefined;
    assert.equal(row?.approved_by, APPROVER);
    assert.equal(row?.approved_qty, 12000);
  });

  /* A bought-in line is not in the queue at all, so it needs no release — and
     must not be made unshippable by a gate that can never be opened for it. */
  test('a bought-in line needs no release, being in neither queue', () => {
    const p = makeProduct({ madeHere: false });
    const o = makeOrder([{ productId: p, pcs: 20000 }]);
    book(makeJob(o, 0, p, 20000), 12000);
    assert.deepEqual(forOrder(o), []);
  });
});

/**
 * Whose order it is.
 *
 * `orders.spoc` is one of six free-text desk names and a login is an account,
 * so `users.desk_name` is the link — and the rule over it has to let today's
 * book carry on working, every row of which has that field blank.
 */
describe('who may release an order', () => {
  const as = (team: string, desk = '') =>
    ({ user: { id: 2, team_role: team, desk_name: desk } } as unknown as AuthedRequest);

  test('a super admin may release any order, whoever handles it', () => {
    assert.equal(deskApprovalError(as('super_admin'), 'Meisha'), null);
    assert.equal(deskApprovalError(as('super_admin', 'Sanjib'), 'Meisha'), null);
  });

  test('an account with no desk name may release any order it can see', () => {
    assert.equal(deskApprovalError(as('sales'), 'Meisha'), null);
  });

  test('an account with a desk name may release its own', () => {
    assert.equal(deskApprovalError(as('sales', 'Meisha'), 'Meisha'), null);
  });

  test('and may not release another desk, naming who does', () => {
    const err = deskApprovalError(as('sales', 'Sanjib'), 'Meisha');
    assert.match(err!, /handled by Meisha, so Meisha releases it/);
  });

  /* Spelling, not identity: the picker offers six names and the match must not
     turn on a stray capital or a trailing space. */
  test('the match ignores case and surrounding space', () => {
    assert.equal(deskApprovalError(as('sales', ' meisha '), 'Meisha'), null);
  });

  /* An order naming nobody is nobody's in particular. Refusing it would strand
     every order imported from the backlog, where the field is often blank. */
  test('an order naming no SPOC is left to the function gate', () => {
    assert.equal(deskApprovalError(as('sales', 'Meisha'), ''), null);
  });

  test('nobody signed in may release anything', () => {
    assert.notEqual(deskApprovalError({} as AuthedRequest, 'Meisha'), null);
  });
});
