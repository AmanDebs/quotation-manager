import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { syncOrderJobs, raiseJobsForOpenOrders } from '../src/services/orderJobs.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * The sales order owns its work orders. One job per goods line on booking,
 * kept in step while nothing has happened on the floor, and left strictly
 * alone the moment something has — a job with a shift against it is a day's
 * production, not a figure to be restated from a sales edit.
 */

let seq = 0;

interface Line { desc?: string; pcs?: number | null; qty?: number | null; charge?: boolean; product?: number | null }

function order(lines: Line[], status = 'pending'): number {
  const id = Number((db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status)
     VALUES (?, '2026-09-01', ?, 1, 'INR', 'igst', ?) RETURNING id`
  ).get(`SO/OJ-${++seq}`, makeCustomer(), status) as { id: number }).id);
  setLines(id, lines);
  return id;
}

/** Rewrite the lines whole, as `saveItems` does. */
function setLines(orderId: number, lines: Line[]) {
  db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId);
  lines.forEach((l, i) => db.prepare(
    `INSERT INTO order_items (order_id, product_id, description, qty, unit, unit_price, amount, total_pcs, is_charge, sort_order)
     VALUES (?, ?, ?, ?, 'per 1000', 10, 0, ?, ?, ?)`
  ).run(orderId, l.product ?? null, l.desc ?? `Line ${i + 1}`, l.qty ?? (l.pcs == null ? null : l.pcs / 1000), l.pcs ?? null, l.charge ? 1 : 0, i));
}

const jobs = (orderId: number) => db.prepare(
  'SELECT id, order_line, qty_planned, description, status FROM work_orders WHERE order_id = ? ORDER BY order_line, id'
).all(orderId) as { id: number; order_line: number; qty_planned: number; description: string; status: string }[];
const live = (orderId: number) => jobs(orderId).filter((j) => j.status !== 'cancelled');

const shift = (jobId: number) => db.prepare(
  "INSERT INTO production_entries (work_order_id, date, qty_ok, qty_reject) VALUES (?, '2026-09-03', 5000, 0)"
).run(jobId);

describe('one job per goods line, on booking', () => {
  test('goods lines get a job each at what they order; a charge line gets none', () => {
    const o = order([{ pcs: 120000, desc: 'Cap' }, { charge: true, desc: 'Freight' }, { pcs: 40000, desc: 'Handle' }]);
    const r = syncOrderJobs(o, null);
    assert.equal(r.raised.length, 2);
    // Positions count the charge line: the handle is line 2, not line 1.
    assert.deepEqual(live(o).map((j) => [j.order_line, j.qty_planned, j.description]), [[0, 120000, 'Cap'], [2, 40000, 'Handle']]);
  });

  /** The live-book case: `137.5 per 1000` with no boxes typed is 137,500 pieces, not 137.5. */
  test('a per-1000 line with no packing figures plans at its quantity in pieces', () => {
    const o = order([{ qty: 137.5, pcs: null, desc: 'Preforms 48 mm' }]);
    syncOrderJobs(o, null);
    assert.equal(live(o)[0].qty_planned, 137500);
  });

  test('the boot pass corrects an untouched job planned under the old reading, and raises nothing for an order that has cancelled its own', () => {
    const o = order([{ qty: 137.5, pcs: null }]);
    syncOrderJobs(o, null);
    db.prepare('UPDATE work_orders SET qty_planned = 137.5 WHERE order_id = ?').run(o);   // as the old rule left it
    const declined = order([{ pcs: 1000 }]);
    syncOrderJobs(declined, null);
    db.prepare("UPDATE work_orders SET status = 'cancelled' WHERE order_id = ?").run(declined);
    raiseJobsForOpenOrders();
    assert.equal(live(o)[0].qty_planned, 137500, 'the boot pass left the mis-planned job alone');
    assert.equal(live(declined).length, 0, 'a deliberately cancelled job was re-raised');
  });

  test('the job carries the line\'s product', () => {
    const p = Number((db.prepare("INSERT INTO products (name, unit, unit_price) VALUES ('P', 'per 1000', 1) RETURNING id").get() as { id: number }).id);
    const o = order([{ pcs: 1000, product: p }]);
    syncOrderJobs(o, null);
    const j = db.prepare('SELECT product_id FROM work_orders WHERE order_id = ?').get(o) as { product_id: number };
    assert.equal(j.product_id, p);
  });

  /** Bought in and sold on: nothing to make, so nothing to raise. */
  test('a bought-in product raises nothing, and flipping it withdraws the untouched job', () => {
    const bought = Number((db.prepare("INSERT INTO products (name, unit, unit_price, made_here) VALUES ('Traded flange', 'unit', 1, 0) RETURNING id").get() as { id: number }).id);
    const o = order([{ pcs: 1000, product: bought }, { pcs: 2000 }]);
    const r = syncOrderJobs(o, null);
    assert.deepEqual(live(o).map((j) => j.order_line), [1], 'a job was raised for a bought-in line');
    assert.equal(r.raised.length, 1);
    // It starts being made here after all.
    db.prepare('UPDATE products SET made_here = 1 WHERE id = ?').run(bought);
    assert.equal(syncOrderJobs(o, null).raised.length, 1);
    assert.deepEqual(live(o).map((j) => j.order_line), [0, 1]);
    // ...and then not.
    db.prepare('UPDATE products SET made_here = 0 WHERE id = ?').run(bought);
    assert.equal(syncOrderJobs(o, null).cancelled.length, 1);
    assert.deepEqual(live(o).map((j) => j.order_line), [1]);
  });

  test('is idempotent', () => {
    const o = order([{ pcs: 120000 }]);
    syncOrderJobs(o, null);
    const again = syncOrderJobs(o, null);
    assert.deepEqual(again, { raised: [], adjusted: [], cancelled: [] });
    assert.equal(jobs(o).length, 1);
  });
});

describe('kept in step while nothing has happened on the floor', () => {
  test('a corrected quantity moves the untouched job', () => {
    const o = order([{ pcs: 120000 }]);
    syncOrderJobs(o, null);
    setLines(o, [{ pcs: 100000 }]);
    const r = syncOrderJobs(o, null);
    assert.equal(r.adjusted.length, 1);
    assert.equal(live(o)[0].qty_planned, 100000);
  });

  test('a new line gets its job; a line that is gone has its unstarted job cancelled', () => {
    const o = order([{ pcs: 120000 }, { pcs: 40000 }]);
    syncOrderJobs(o, null);
    setLines(o, [{ pcs: 120000 }]);
    const r = syncOrderJobs(o, null);
    assert.equal(r.cancelled.length, 1);
    assert.deepEqual(live(o).map((j) => j.order_line), [0]);
    setLines(o, [{ pcs: 120000 }, { pcs: 40000 }, { pcs: 7000 }]);
    const r2 = syncOrderJobs(o, null);
    assert.equal(r2.raised.length, 2, 'the cancelled job was reused for a line that came back');
    assert.deepEqual(live(o).map((j) => [j.order_line, j.qty_planned]), [[0, 120000], [1, 40000], [2, 7000]]);
  });

  test('cancelling the order withdraws its unstarted jobs and raises nothing', () => {
    const o = order([{ pcs: 120000 }, { pcs: 40000 }]);
    syncOrderJobs(o, null);
    shift(live(o)[0].id);
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(o);
    const r = syncOrderJobs(o, null);
    assert.equal(r.cancelled.length, 1, 'the job with a shift against it was cancelled too');
    assert.equal(r.raised.length, 0);
    assert.deepEqual(live(o).map((j) => j.order_line), [0]);
  });
});

describe('left alone once the floor has acted', () => {
  test('a job with output keeps its figure whatever the line now says', () => {
    const o = order([{ pcs: 120000 }]);
    syncOrderJobs(o, null);
    shift(live(o)[0].id);
    setLines(o, [{ pcs: 80000 }]);
    const r = syncOrderJobs(o, null);
    assert.deepEqual(r, { raised: [], adjusted: [], cancelled: [] });
    assert.equal(live(o)[0].qty_planned, 120000);
  });

  test('a released job is the floor\'s, and so is a line with two', () => {
    const o = order([{ pcs: 120000 }, { pcs: 40000 }]);
    syncOrderJobs(o, null);
    const [a, b] = live(o);
    db.prepare("UPDATE work_orders SET status = 'released' WHERE id = ?").run(a.id);
    // A split run: a second job Production raised on line 1.
    db.prepare(`INSERT INTO work_orders (number, order_id, order_line, qty_planned, status) VALUES ('WO/OJ-X', ?, 1, 10000, 'planned')`).run(o);
    setLines(o, [{ pcs: 90000 }, { pcs: 30000 }]);
    const r = syncOrderJobs(o, null);
    assert.deepEqual(r, { raised: [], adjusted: [], cancelled: [] });
    assert.equal(live(o).find((j) => j.id === a.id)!.qty_planned, 120000);
    assert.equal(live(o).find((j) => j.id === b.id)!.qty_planned, 40000);
  });

  test('a line that is gone leaves a job with output standing', () => {
    const o = order([{ pcs: 120000 }, { pcs: 40000 }]);
    syncOrderJobs(o, null);
    shift(live(o)[1].id);
    setLines(o, [{ pcs: 120000 }]);
    syncOrderJobs(o, null);
    assert.equal(live(o).length, 2, 'a day\'s production was cancelled from a sales edit');
  });
});

describe('the book as it stands', () => {
  test('open orders with no job at all get theirs; anything with a job, or closed, is left alone', () => {
    const fresh = order([{ pcs: 1000 }]);
    const done = order([{ pcs: 1000 }], 'completed');
    const gone = order([{ pcs: 1000 }], 'cancelled');
    const declined = order([{ pcs: 1000 }]);
    syncOrderJobs(declined, null);
    db.prepare("UPDATE work_orders SET status = 'cancelled' WHERE order_id = ?").run(declined);

    raiseJobsForOpenOrders();
    assert.equal(live(fresh).length, 1);
    assert.equal(jobs(done).length, 0);
    assert.equal(jobs(gone).length, 0);
    assert.equal(live(declined).length, 0, 'a deliberately cancelled job was re-raised on boot');
    raiseJobsForOpenOrders();
    assert.equal(jobs(fresh).length, 1, 'a second boot raised again');
  });
});
