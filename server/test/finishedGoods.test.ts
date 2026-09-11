import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { finishedGoods, fgOnHandByProduct } from '../src/services/finishedGoods.js';
import { withStock } from '../src/services/orderLines.js';
import { makeCustomer, makeInvoice, makeLocation } from './helpers/factory.js';

/**
 * Finished goods on hand: made − dispatched + returned + adjusted, over the
 * records that already exist, plus the one table that holds a count. Most of
 * these move one fact and watch one figure move; the one worth reading first
 * is scrap-after-return, where three records cancel out to exactly nothing.
 */

let seq = 0;

const product = (name = `Cap ${++seq}`) => Number((db.prepare(
  "INSERT INTO products (name, unit, unit_price) VALUES (?, 'per 1000', 10) RETURNING id"
).get(name) as { id: number }).id);

/** An order whose lines are given in position order; `null` is a charge line. */
function order(lines: (number | null)[], customerId = makeCustomer()) {
  const id = Number((db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status)
     VALUES (?, '2026-09-01', ?, 1, 'INR', 'igst', 'pending') RETURNING id`
  ).get(`SO/FG-${++seq}`, customerId) as { id: number }).id);
  lines.forEach((p, i) => db.prepare(
    `INSERT INTO order_items (order_id, product_id, description, qty, unit, unit_price, amount, total_pcs, is_charge, sort_order)
     VALUES (?, ?, ?, 100, 'per 1000', 10, 1000, 100000, ?, ?)`
  ).run(id, p, p == null ? 'Freight' : `Line ${i}`, p == null ? 1 : 0, i));
  return { id, customerId };
}

const job = (orderId: number, line: number, productId: number, locationId: number | null = null) => Number((db.prepare(
  `INSERT INTO work_orders (number, order_id, order_line, product_id, qty_planned, status, location_id)
   VALUES (?, ?, ?, ?, 100000, 'released', ?) RETURNING id`
).get(`WO/FG-${++seq}`, orderId, line, productId, locationId) as { id: number }).id);

const batch = (jobId: number) => Number((db.prepare(
  "INSERT INTO batches (number, work_order_id, date) VALUES (?, ?, '2026-09-02') RETURNING id"
).get(`B/FG-${++seq}`, jobId) as { id: number }).id);

const shift = (jobId: number, ok: number, batchId: number | null = null) => db.prepare(
  "INSERT INTO production_entries (work_order_id, batch_id, date, qty_ok, qty_reject) VALUES (?, ?, '2026-09-03', ?, 0)"
).run(jobId, batchId, ok);

function trip(orderId: number, lines: [number, number][], locationId: number | null = null) {
  const d = Number((db.prepare(
    "INSERT INTO despatches (order_id, date, location_id) VALUES (?, '2026-09-06', ?) RETURNING id"
  ).get(orderId, locationId) as { id: number }).id);
  for (const [line, qty] of lines) db.prepare(
    'INSERT INTO despatch_items (despatch_id, order_line, qty, sort_order) VALUES (?, ?, ?, ?)'
  ).run(d, line, qty, line);
  return d;
}

/** An approved return of `pcs` of a product, arriving at a plant. */
function returned(o: { id: number; customerId: number }, productId: number, pcs: number, locationId: number | null = null, approval = 'approved') {
  const inv = makeInvoice({ customerId: o.customerId, currency: 'INR', total: 1000 });
  db.prepare('UPDATE commercial_invoices SET order_id = ? WHERE id = ?').run(o.id, inv);
  const n = Number((db.prepare(
    `INSERT INTO credit_notes (number, date, invoice_id, customer_id, company_id, kind, currency, grand_total, approval_status, location_id)
     VALUES (?, '2026-09-10', ?, ?, 1, 'return', 'INR', 100, ?, ?) RETURNING id`
  ).get(`CN/FG-${++seq}`, inv, o.customerId, approval, locationId) as { id: number }).id);
  db.prepare(
    `INSERT INTO credit_note_items (credit_note_id, product_id, description, qty, unit, total_pcs, sort_order)
     VALUES (?, ?, 'x', ?, 'per 1000', ?, 0)`
  ).run(n, productId, pcs / 1000, pcs);
  return n;
}

const adjust = (productId: number, qty: number, locationId: number | null = null) => db.prepare(
  "INSERT INTO fg_adjustments (product_id, location_id, date, qty, reason) VALUES (?, ?, '2026-09-11', ?, 'count')"
).run(productId, locationId, qty);

const rowFor = (productId: number, locationId: number | null = null) =>
  finishedGoods({ productId }).rows.find((r) => r.location_id === locationId);
const onHand = (productId: number, locationId: number | null = null) => rowFor(productId, locationId)?.on_hand ?? 0;

describe('each record moves the figure it should', () => {
  test('a shift adds, a lorry takes away, by position through the order line', () => {
    const p = product();
    const o = order([null, p]);                       // freight first: the goods are line 1
    const j = job(o.id, 1, p);
    shift(j, 40000);
    assert.equal(onHand(p), 40000);
    trip(o.id, [[1, 15000]]);
    assert.equal(onHand(p), 25000);
    // A figure against the freight line is placed against no product.
    trip(o.id, [[0, 7]]);
    assert.equal(onHand(p), 25000);
    assert.equal(finishedGoods({ productId: p }).unplaced.dispatched, 0, 'a charge line was counted as unplaced goods');
  });

  test('an approved return comes back; a drafted one does not', () => {
    const p = product();
    const o = order([p]);
    shift(job(o.id, 0, p), 10000);
    trip(o.id, [[0, 10000]]);
    assert.equal(onHand(p), 0);
    returned(o, p, 2000, null, 'not_submitted');
    assert.equal(onHand(p), 0, 'a drafted return put goods on the shelf');
    returned(o, p, 2000);
    assert.equal(onHand(p), 2000);
  });

  test('a scrapped lot is not stock', () => {
    const p = product();
    const o = order([p]);
    const j = job(o.id, 0, p);
    const b = batch(j);
    shift(j, 30000, b);
    shift(j, 5000);
    assert.equal(onHand(p), 35000);
    db.prepare("UPDATE batches SET disposition = 'scrapped' WHERE id = ?").run(b);
    assert.equal(onHand(p), 5000);
  });

  /**
   * The case the whole return loop exists for. A lot made, shipped, returned
   * and condemned has left three records and nothing on the shelf — and the
   * arithmetic says exactly that without a special case: scrapping drops the
   * lot from *made*, the trip and the return still stand and cancel out.
   */
  test('made, shipped, returned, then scrapped comes to exactly nothing', () => {
    const p = product();
    const o = order([p]);
    const j = job(o.id, 0, p);
    const b = batch(j);
    shift(j, 2000, b);
    trip(o.id, [[0, 2000]]);
    returned(o, p, 2000);
    assert.equal(onHand(p), 2000, 'a returned lot is back on the shelf until condemned');
    db.prepare("UPDATE batches SET disposition = 'scrapped' WHERE id = ?").run(b);
    assert.equal(onHand(p), 0);
  });

  test('a count corrects the record, and the sign is the person\'s', () => {
    const p = product();
    const o = order([p]);
    shift(job(o.id, 0, p), 1000);
    adjust(p, -350);
    assert.equal(onHand(p), 650);
    assert.equal(rowFor(p)!.adjusted, -350);
  });

  test('stock shipped before the record reads negative — shown, not floored — until an opening balance', () => {
    const p = product();
    const o = order([p]);
    trip(o.id, [[0, 4000]]);
    assert.equal(onHand(p), -4000);
    adjust(p, 9000);
    assert.equal(onHand(p), 5000);
  });
});

describe('per plant', () => {
  test('output sits at the job\'s plant, a load at the lorry\'s, a return at the note\'s', () => {
    const p = product();
    const [a, b] = [makeLocation('Jungalpur'), makeLocation('PACK SKRL')];
    const o = order([p]);
    shift(job(o.id, 0, p, a), 10000);
    trip(o.id, [[0, 3000]], b);
    returned(o, p, 500, b);
    assert.equal(onHand(p, a), 10000);
    assert.equal(onHand(p, b), -2500);
    const rows = finishedGoods({ productId: p, locationId: b }).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].location_name, 'PACK SKRL');
  });

  test('a record with no plant lands in its own bucket rather than a guessed one', () => {
    const p = product();
    const o = order([p]);
    shift(job(o.id, 0, p, null), 800);
    const r = rowFor(p, null)!;
    assert.equal(r.location_name, null);
    assert.equal(r.on_hand, 800);
  });
});

describe('what cannot be placed is reported, not dropped', () => {
  test('a custom line with no product', () => {
    const o = order([null]);
    db.prepare("UPDATE order_items SET is_charge = 0, description = 'Custom moulding' WHERE order_id = ?").run(o.id);
    trip(o.id, [[0, 1200]]);
    assert.equal(finishedGoods().unplaced.dispatched >= 1200, true);
  });

  test('a weight-billed return with no piece count says nothing', () => {
    const p = product();
    const o = order([p]);
    const inv = makeInvoice({ customerId: o.customerId, currency: 'INR', total: 1000 });
    const n = Number((db.prepare(
      `INSERT INTO credit_notes (number, date, invoice_id, customer_id, company_id, kind, currency, grand_total, approval_status)
       VALUES (?, '2026-09-10', ?, ?, 1, 'return', 'INR', 100, 'approved') RETURNING id`
    ).get(`CN/FG-${++seq}`, inv, o.customerId) as { id: number }).id);
    db.prepare("INSERT INTO credit_note_items (credit_note_id, product_id, description, qty, unit, sort_order) VALUES (?, ?, 'x', 850, 'kg', 0)").run(n, p);
    assert.equal(rowFor(p), undefined);
  });
});

describe('the shelf beside the demand', () => {
  test('per product across plants, the same figure on every line of it, and null on a custom line', () => {
    const p = product();
    const [a, b] = [makeLocation('A'), makeLocation('B')];
    const o = order([p, p, null]);
    db.prepare("UPDATE order_items SET is_charge = 0, description = 'Custom' WHERE order_id = ? AND sort_order = 2").run(o.id);
    shift(job(o.id, 0, p, a), 6000);
    shift(job(o.id, 1, p, b), 4000);
    trip(o.id, [[0, 1000]], a);
    assert.equal(fgOnHandByProduct().get(p), 9000);
    const rows = withStock([
      { product_id: p, line: 0 }, { product_id: p, line: 1 }, { product_id: null, line: 2 },
    ]);
    assert.deepEqual(rows.map((r) => r.in_stock), [9000, 9000, null]);
  });
});
