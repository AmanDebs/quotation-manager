import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { priceHistory, per1000, type BookDoc } from '../src/services/priceHistory.js';
import type { ReportFilter } from '../src/services/reports.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * The price history of one product.
 *
 * Most of these are about the two ways a price chart can lie: a rate read in
 * the wrong basis, which moves a point by a factor of a thousand, and a
 * document silently left out, which is how a trend comes to be drawn through
 * the deals we won and none of the ones we lost.
 */

const ALL: ReportFilter = { scope: { sql: '', params: [] }, companyId: 0 };
const DOCS: BookDoc[] = ['order', 'proforma', 'quotation'];
let seq = 0;

const product = (name = `Product ${++seq}`): number =>
  Number((db.prepare('INSERT INTO products (name) VALUES (?) RETURNING id').get(name) as { id: number }).id);

function order(customerId: number, date: string, o: Partial<{ status: string; currency: string; company: number }> = {}): number {
  return Number((db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status)
     VALUES (?, ?, ?, ?, ?, 'none', ?) RETURNING id`
  ).get(`SO/P-${++seq}`, date, customerId, o.company ?? 1, o.currency ?? 'USD', o.status ?? 'pending') as { id: number }).id);
}

function pi(customerId: number, date: string, o: Partial<{ status: string; orderId: number | null; validity: string; currency: string }> = {}): number {
  return Number((db.prepare(
    `INSERT INTO proforma_invoices (number, date, customer_id, company_id, currency, order_id, status, validity_date)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?) RETURNING id`
  ).get(`PI/P-${++seq}`, date, customerId, o.currency ?? 'USD', o.orderId ?? null,
    o.status ?? 'sent', o.validity ?? '') as { id: number }).id);
}

function quotation(customerId: number, date: string, o: Partial<{ status: string; superseded: number | null; currency: string }> = {}): number {
  return Number((db.prepare(
    `INSERT INTO quotations (number, date, customer_id, company_id, currency, tax_type, status, superseded_by)
     VALUES (?, ?, ?, 1, ?, 'none', ?, ?) RETURNING id`
  ).get(`QT/P-${++seq}`, date, customerId, o.currency ?? 'USD', o.status ?? 'draft', o.superseded ?? null) as { id: number }).id);
}

/** A goods line, in the shape all three item tables share. */
function line(
  table: 'order_items' | 'pi_items' | 'quotation_items',
  fk: string,
  id: number,
  productId: number | null,
  o: Partial<{ price: number; unit: string; qty: number; pcs: number | null; charge: number; color: string }> = {},
) {
  db.prepare(
    `INSERT INTO ${table} (${fk}, product_id, description, color, qty, unit, total_pcs, unit_price, amount, is_charge, sort_order)
     VALUES (?, ?, 'a line', ?, ?, ?, ?, ?, 0, ?, 0)`
  ).run(id, productId, o.color ?? 'Natural', o.qty ?? 10, o.unit ?? 'per 1000',
    o.pcs === undefined ? null : o.pcs, o.price ?? 100, o.charge ?? 0);
}

const history = (productId: number, q: Partial<{ customerId: number; from: string; to: string; docs: BookDoc[] }> = {}) =>
  priceHistory(ALL, { productId, docs: q.docs ?? DOCS, customerId: q.customerId, from: q.from, to: q.to });

/** Every comparable point, whatever its currency. */
const pointsOf = (productId: number, q: Parameters<typeof history>[1] = {}) =>
  history(productId, q).series.flatMap((s) => s.points);

describe('the rate per 1000 pieces', () => {
  /**
   * The case the whole report rests on. This catalogue is quoted `per 1000`
   * almost everywhere; the same money stated per piece is the identical
   * price, and read naively it plots a thousandfold lower.
   */
  test('a per-piece rate and a per-1000 rate for the same money land on one figure', () => {
    assert.equal(per1000(0.65, 'unit'), 650);
    assert.equal(per1000(650, 'per 1000'), 650);
  });

  test('a basis with no piece count has no rate per 1000 and is never invented', () => {
    assert.equal(per1000(128.4, 'kg'), null);
    assert.equal(per1000(128.4, 'tonne'), null);
    assert.equal(per1000(128.4, ''), null);
  });

  /** 3.017 / 1000 * 1000 is 3.0169999999999995 in float; a price list reads that as a defect. */
  test('a three-decimal rate survives the conversion exactly', () => {
    assert.equal(per1000(3.017, 'per 1000'), 3.017);
  });
});

describe('the price history of a product', () => {
  test('reads the three document kinds, oldest first', () => {
    const c = makeCustomer();
    const p = product();
    line('order_items', 'order_id', order(c, '2026-03-01'), p, { price: 30 });
    line('pi_items', 'pi_id', pi(c, '2026-02-01'), p, { price: 20 });
    line('quotation_items', 'quotation_id', quotation(c, '2026-01-01'), p, { price: 10 });
    assert.deepEqual(
      pointsOf(p).map((x) => [x.doc, x.per1000]),
      [['quotation', 10], ['proforma', 20], ['order', 30]],
    );
  });

  /**
   * The departure from `bookReport`, and the reason this report exists: a
   * rejected quotation is the price we asked and lost at. Dropping it would
   * draw the trend through the deals we won and none of the others.
   */
  test('a rejected quotation and a cancelled order are kept, and marked not live', () => {
    const c = makeCustomer();
    const p = product();
    line('quotation_items', 'quotation_id', quotation(c, '2026-01-01', { status: 'rejected' }), p, { price: 90 });
    line('order_items', 'order_id', order(c, '2026-02-01', { status: 'cancelled' }), p, { price: 80 });
    const got = pointsOf(p);
    assert.deepEqual(got.map((x) => x.per1000), [90, 80]);
    assert.deepEqual(got.map((x) => x.live), [false, false]);
    assert.deepEqual(got.map((x) => x.status), ['rejected', 'cancelled']);
  });

  test('a superseded revision is kept and says so', () => {
    const c = makeCustomer();
    const p = product();
    const latest = quotation(c, '2026-02-01');
    const old = quotation(c, '2026-01-01', { superseded: latest });
    line('quotation_items', 'quotation_id', old, p, { price: 95 });
    line('quotation_items', 'quotation_id', latest, p, { price: 88 });
    const got = pointsOf(p);
    assert.deepEqual(got.map((x) => [x.status, x.live]), [['superseded', false], ['draft', true]]);
  });

  /** A booked proforma is a price that really was agreed — the sales book's `order_id` rule does not apply. */
  test('a proforma that has been booked is still part of the history', () => {
    const c = makeCustomer();
    const p = product();
    const o = order(c, '2026-02-01');
    line('order_items', 'order_id', o, p, { price: 40 });
    line('pi_items', 'pi_id', pi(c, '2026-01-01', { orderId: o }), p, { price: 40 });
    assert.deepEqual(pointsOf(p).map((x) => x.doc), ['proforma', 'order']);
  });

  test('a lapsed proforma is kept and marked, by the proforma list’s own reading', () => {
    const c = makeCustomer();
    const p = product();
    line('pi_items', 'pi_id', pi(c, '2026-01-01', { validity: '2020-01-01' }), p, { price: 50 });
    const [x] = pointsOf(p);
    assert.equal(x.status, 'expired');
    assert.equal(x.live, false);
  });

  test('a charge line is not a price for anything', () => {
    const c = makeCustomer();
    const p = product();
    const o = order(c, '2026-01-01');
    line('order_items', 'order_id', o, p, { price: 25 });
    line('order_items', 'order_id', o, p, { price: 1800, charge: 1 });
    assert.deepEqual(pointsOf(p).map((x) => x.per1000), [25]);
  });

  test('another product’s lines are not this product’s history', () => {
    const c = makeCustomer();
    const mine = product();
    const theirs = product();
    const o = order(c, '2026-01-01');
    line('order_items', 'order_id', o, mine, { price: 11 });
    line('order_items', 'order_id', o, theirs, { price: 22 });
    // A custom line names no product at all and has no catalogue identity to trend.
    line('order_items', 'order_id', o, null, { price: 33 });
    assert.deepEqual(pointsOf(mine).map((x) => x.per1000), [11]);
  });

  /**
   * A weight-billed line states a real price and no comparable one. Converting
   * it would invent a figure; dropping it would show half the history of a
   * product sold both ways.
   */
  test('a weight-billed line is listed apart rather than converted or dropped', () => {
    const c = makeCustomer();
    const p = product();
    line('order_items', 'order_id', order(c, '2026-01-01'), p, { price: 128.4, unit: 'kg' });
    line('order_items', 'order_id', order(c, '2026-02-01'), p, { price: 26 });
    const r = history(p);
    assert.deepEqual(r.series.flatMap((s) => s.points).map((x) => x.per1000), [26]);
    assert.equal(r.incomparable.length, 1);
    assert.equal(r.incomparable[0].unit, 'kg');
    assert.equal(r.incomparable[0].unit_price, 128.4);
    assert.equal(r.incomparable[0].per1000, null);
  });

  /** Money only adds up within one currency — `receivables.ts`'s rule. */
  test('two currencies are two series and never one trend', () => {
    const c = makeCustomer();
    const p = product();
    line('order_items', 'order_id', order(c, '2026-01-01', { currency: 'USD' }), p, { price: 30 });
    line('order_items', 'order_id', order(c, '2026-02-01', { currency: 'INR' }), p, { price: 2600 });
    const r = history(p);
    assert.deepEqual(r.series.map((s) => [s.currency, s.points.length]), [['INR', 1], ['USD', 1]]);
  });

  test('the summary is the first, the last and the span of its own points', () => {
    const c = makeCustomer();
    const p = product();
    line('order_items', 'order_id', order(c, '2026-01-01'), p, { price: 20 });
    line('order_items', 'order_id', order(c, '2026-02-01'), p, { price: 35 });
    line('order_items', 'order_id', order(c, '2026-03-01'), p, { price: 25 });
    const [s] = history(p).series;
    assert.deepEqual([s.first, s.last, s.min, s.max], [20, 25, 20, 35]);
    assert.equal(s.change_pct, 25);
  });

  test('a first rate of zero has no percentage rather than an infinite one', () => {
    const c = makeCustomer();
    const p = product();
    line('order_items', 'order_id', order(c, '2026-01-01'), p, { price: 0 });
    line('order_items', 'order_id', order(c, '2026-02-01'), p, { price: 40 });
    assert.equal(history(p).series[0].change_pct, null);
  });

  test('one customer’s history is that customer’s alone', () => {
    const p = product();
    const a = makeCustomer();
    const b = makeCustomer();
    line('order_items', 'order_id', order(a, '2026-01-01'), p, { price: 30 });
    line('order_items', 'order_id', order(b, '2026-02-01'), p, { price: 45 });
    assert.deepEqual(pointsOf(p, { customerId: a }).map((x) => x.per1000), [30]);
    assert.deepEqual(pointsOf(p).map((x) => x.per1000), [30, 45]);
  });

  test('a date range takes either end, and an undated document is in no range', () => {
    const c = makeCustomer();
    const p = product();
    line('order_items', 'order_id', order(c, '2026-01-01'), p, { price: 10 });
    line('order_items', 'order_id', order(c, '2026-06-01'), p, { price: 20 });
    line('order_items', 'order_id', order(c, ''), p, { price: 99 });
    assert.deepEqual(pointsOf(p, { from: '2026-01-01', to: '2026-06-01' }).map((x) => x.per1000), [10, 20]);
    assert.deepEqual(pointsOf(p, { from: '2026-02-01' }).map((x) => x.per1000), [20]);
    assert.deepEqual(pointsOf(p, { to: '2026-05-31' }).map((x) => x.per1000), [10]);
  });

  /** Absent, not empty: a caller without a function does not get its documents. */
  test('only the document kinds asked for are read', () => {
    const c = makeCustomer();
    const p = product();
    line('order_items', 'order_id', order(c, '2026-01-01'), p, { price: 10 });
    line('quotation_items', 'quotation_id', quotation(c, '2026-02-01'), p, { price: 20 });
    assert.deepEqual(pointsOf(p, { docs: ['order'] }).map((x) => x.doc), ['order']);
    const none = history(p, { docs: [] });
    assert.deepEqual(none.series, []);
    assert.deepEqual(none.included, []);
  });

  test('pieces come from the packing count, else from the basis', () => {
    const c = makeCustomer();
    const p = product();
    const o = order(c, '2026-01-01');
    line('order_items', 'order_id', o, p, { qty: 137.5, pcs: null });
    line('order_items', 'order_id', o, p, { qty: 137.5, pcs: 140000 });
    line('order_items', 'order_id', o, p, { qty: 500, unit: 'kg' });
    const r = history(p);
    assert.deepEqual(r.series[0].points.map((x) => x.pieces), [137500, 140000]);
    assert.equal(r.incomparable[0].pieces, null, 'a weight line states no piece count');
  });

  test('a product with no history at all reads as empty rather than throwing', () => {
    const p = product();
    const r = history(p);
    assert.deepEqual(r.series, []);
    assert.deepEqual(r.incomparable, []);
    assert.equal(r.product_name.startsWith('Product'), true);
    assert.deepEqual(priceHistory(ALL, { productId: 999999, docs: DOCS }).product_name, '');
  });
});
