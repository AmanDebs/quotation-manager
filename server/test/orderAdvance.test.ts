import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { orderAdvance } from '../src/services/receivables.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * The advance behind an order is the proforma's, derived. What is worth
 * asserting is the two ways it can be quietly wrong: money in another currency
 * counted anyway, and a date of credit taken from a payment that was not.
 */

const order = (customerId: number) => {
  const r = db.prepare(
    `INSERT INTO orders (number, date, customer_id, currency, tax_type, status)
     VALUES (?, '2026-09-01', ?, 'INR', 'igst', 'confirmed') RETURNING id`
  ).get(`SO/${Math.random().toString(36).slice(2, 8)}`, customerId) as { id: number };
  return r.id;
};

const proforma = (customerId: number, orderId: number | null, currency = 'INR') => {
  const r = db.prepare(
    `INSERT INTO proforma_invoices (number, date, customer_id, currency, tax_type, order_id, grand_total, status)
     VALUES (?, '2026-09-01', ?, ?, 'igst', ?, 100000, 'draft') RETURNING id`
  ).get(`PI/${Math.random().toString(36).slice(2, 8)}`, customerId, currency, orderId) as { id: number };
  return r.id;
};

const pay = (piId: number, customerId: number, amount: number, date: string, currency = 'INR') =>
  db.prepare(
    `INSERT INTO payments (pi_id, customer_id, amount, currency, date, method)
     VALUES (?, ?, ?, ?, ?, 'bank')`
  ).run(piId, customerId, amount, currency, date);

describe('the advance behind an order', () => {
  test('an order with no proforma reports nothing, never a zero that looks banked', () => {
    const a = orderAdvance(order(makeCustomer()));
    assert.equal(a.pi_id, null);
    assert.equal(a.amount_received, 0);
    assert.equal(a.last_date, '');
  });

  test('sums what was banked against the proforma pointing at it', () => {
    const c = makeCustomer();
    const o = order(c);
    const pi = proforma(c, o);
    pay(pi, c, 30000, '2026-09-02');
    pay(pi, c, 20000, '2026-09-05');
    const a = orderAdvance(o);
    assert.equal(a.pi_id, pi);
    assert.equal(a.amount_received, 50000);
    // The most recent payment, not the first.
    assert.equal(a.last_date, '2026-09-05');
  });

  test('money in another currency is excluded, and cannot set the date of credit', () => {
    const c = makeCustomer();
    const o = order(c);
    const pi = proforma(c, o);
    pay(pi, c, 30000, '2026-09-02');
    pay(pi, c, 500, '2026-09-09', 'EUR');
    const a = orderAdvance(o);
    assert.equal(a.amount_received, 30000, 'the EUR payment is credited to nothing');
    assert.equal(a.last_date, '2026-09-02', 'and does not become the date of credit');
    assert.deepEqual(a.currency_mismatch, [{ currency: 'EUR', amount: 500 }]);
  });

  test("another order's proforma is not counted", () => {
    const c = makeCustomer();
    const mine = order(c);
    const theirs = order(c);
    const pi = proforma(c, theirs);
    pay(pi, c, 90000, '2026-09-03');
    assert.equal(orderAdvance(mine).amount_received, 0);
    assert.equal(orderAdvance(theirs).amount_received, 90000);
  });

  test('a proforma attached to no order is not counted either', () => {
    const c = makeCustomer();
    const o = order(c);
    const loose = proforma(c, null);
    pay(loose, c, 40000, '2026-09-04');
    assert.equal(orderAdvance(o).amount_received, 0);
  });
});
