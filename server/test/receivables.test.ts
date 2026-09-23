import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceReceivable, receivedByInvoice, advanceAppliedByInvoice,
  orderAdvance } from '../src/services/receivables.js';
import { makeCustomer, makeProforma, makeInvoice, makePayment, makeOrder } from './helpers/factory.js';

/**
 * `receivables.ts` is the only place allowed to answer "how much has this
 * invoice been credited". Two rules do the work, and both were learned from
 * getting them wrong.
 */

describe('a payment on the invoice itself', () => {
  test('credits that invoice and leaves the balance', () => {
    const c = makeCustomer();
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 10000 });
    makePayment({ customerId: c, invoiceId: inv, amount: 4000, currency: 'INR' });

    const r = invoiceReceivable(inv);
    assert.equal(r.amount_received, 4000);
    assert.equal(r.balance_due, 6000);
  });

  test('paid in full leaves nothing outstanding', () => {
    const c = makeCustomer();
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 10000 });
    makePayment({ customerId: c, invoiceId: inv, amount: 10000, currency: 'INR' });
    assert.equal(invoiceReceivable(inv).balance_due, 0);
  });
});

/**
 * A PI advance is a pool, not a credit to one invoice: partial shipments are
 * normal, so several invoices can be raised from one proforma. Counting the
 * whole advance against each of them would credit the customer several times.
 */
describe('an advance on the proforma', () => {
  test('is allocated across the invoices raised from it, earliest first', () => {
    const c = makeCustomer();
    const pi = makeProforma({ customerId: c, currency: 'INR', total: 30000 });
    makePayment({ customerId: c, piId: pi, amount: 12000, currency: 'INR' });
    const first = makeInvoice({ customerId: c, currency: 'INR', total: 10000, piId: pi, date: '2026-08-05' });
    const second = makeInvoice({ customerId: c, currency: 'INR', total: 10000, piId: pi, date: '2026-08-09' });

    assert.equal(invoiceReceivable(first).amount_received, 10000, 'the first is covered in full');
    assert.equal(invoiceReceivable(second).amount_received, 2000, 'the remainder goes to the next');
  });

  test('is never counted twice — the pool is what it is', () => {
    const c = makeCustomer();
    const pi = makeProforma({ customerId: c, currency: 'INR', total: 30000 });
    makePayment({ customerId: c, piId: pi, amount: 12000, currency: 'INR' });
    const a = makeInvoice({ customerId: c, currency: 'INR', total: 10000, piId: pi, date: '2026-08-05' });
    const b = makeInvoice({ customerId: c, currency: 'INR', total: 10000, piId: pi, date: '2026-08-09' });

    const total = invoiceReceivable(a).amount_received + invoiceReceivable(b).amount_received;
    assert.equal(total, 12000, 'the advance credited in total must equal the advance taken');
  });

  test('is capped at each invoice, never over-crediting one', () => {
    const c = makeCustomer();
    const pi = makeProforma({ customerId: c, currency: 'INR', total: 50000 });
    makePayment({ customerId: c, piId: pi, amount: 40000, currency: 'INR' });
    const small = makeInvoice({ customerId: c, currency: 'INR', total: 5000, piId: pi });
    assert.equal(invoiceReceivable(small).amount_received, 5000);
    assert.equal(invoiceReceivable(small).balance_due, 0);
  });
});

/**
 * There is no exchange rate stored anywhere, and inventing one would put a
 * fiction on a ledger. A €10,000 advance is not ₹10,000 — treating it as one
 * once marked a ₹5,000 invoice paid in full.
 */
describe('money only adds up within one currency', () => {
  test('a payment in another currency does not credit the invoice', () => {
    const c = makeCustomer();
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 5000 });
    makePayment({ customerId: c, invoiceId: inv, amount: 10000, currency: 'EUR' });

    const r = invoiceReceivable(inv);
    assert.equal(r.amount_received, 0, 'not credited');
    assert.equal(r.balance_due, 5000, 'and not converted either');
  });

  test('it is reported rather than silently dropped', () => {
    const c = makeCustomer();
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 5000 });
    makePayment({ customerId: c, invoiceId: inv, amount: 10000, currency: 'EUR' });
    assert.deepEqual(invoiceReceivable(inv).currency_mismatch, [{ currency: 'EUR', amount: 10000 }],
      'silently under-reporting is the one outcome worse than an awkward figure');
  });

  test('a blank currency counts as matching — it can only be a legacy row', () => {
    const c = makeCustomer();
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 5000 });
    makePayment({ customerId: c, invoiceId: inv, amount: 2000, currency: '' });
    assert.equal(invoiceReceivable(inv).amount_received, 2000,
      'payments inherit their currency from the document, so blank predates that');
  });

  test('a mismatched advance is not allocated either', () => {
    const c = makeCustomer();
    const pi = makeProforma({ customerId: c, currency: 'USD', total: 9000 });
    makePayment({ customerId: c, piId: pi, amount: 9000, currency: 'USD' });
    const inr = makeInvoice({ customerId: c, currency: 'INR', total: 9000, piId: pi });
    assert.equal(invoiceReceivable(inr).amount_received, 0);
  });
});

/**
 * The dashboard uses the bulk form and the invoice page the single one. If
 * they ever disagree, one of the two screens is lying.
 */
test('the bulk figures match the single ones, invoice for invoice', () => {
  const c = makeCustomer();
  const pi = makeProforma({ customerId: c, currency: 'INR', total: 20000 });
  makePayment({ customerId: c, piId: pi, amount: 7500, currency: 'INR' });
  const ids = [
    makeInvoice({ customerId: c, currency: 'INR', total: 5000, piId: pi, date: '2026-08-03' }),
    makeInvoice({ customerId: c, currency: 'INR', total: 6000, piId: pi, date: '2026-08-04' }),
    makeInvoice({ customerId: c, currency: 'INR', total: 4000 }),
  ];
  makePayment({ customerId: c, invoiceId: ids[2], amount: 1000, currency: 'INR' });

  const bulk = receivedByInvoice();
  for (const id of ids) {
    assert.equal(bulk.get(id) ?? 0, invoiceReceivable(id).amount_received,
      `invoice ${id}: the dashboard and the invoice page must agree`);
  }
});

/**
 * The dashboard's *advances held* is what the proformas took in less what the
 * invoices absorbed, and the absorbed half comes from the same allocation as
 * `receivedByInvoice` — one walk, two figures. So the bulk applied figure must
 * match the single one invoice for invoice, and what is left over is what the
 * pool still holds.
 */
test('the bulk advance-applied figures match the single ones, and the remainder is what is held', () => {
  const c = makeCustomer();
  const pi = makeProforma({ customerId: c, currency: 'INR', total: 20000 });
  makePayment({ customerId: c, piId: pi, amount: 7500, currency: 'INR' });
  const ids = [
    makeInvoice({ customerId: c, currency: 'INR', total: 5000, piId: pi, date: '2026-08-03' }),
    makeInvoice({ customerId: c, currency: 'INR', total: 1000, piId: pi, date: '2026-08-04' }),
  ];
  const applied = advanceAppliedByInvoice();
  let absorbed = 0;
  for (const id of ids) {
    assert.equal(applied.get(id) ?? 0, invoiceReceivable(id).advance_applied);
    absorbed += applied.get(id) ?? 0;
  }
  assert.equal(absorbed, 6000);
  assert.equal(7500 - absorbed, 1500, 'the pool still holds what no invoice has absorbed');
});

/**
 * An advance banked against the **sales order** (2026-09-23).
 *
 * The chain banks an advance against the proforma, and that is still where it
 * goes wherever there is one. An order with no proforma — every order loaded
 * from the backlog spreadsheet — had nowhere but a typed figure on its own
 * row, which credits no invoice, so the invoice raised later asked the
 * customer for money already sent. These are the same pool rules read against
 * the other document, which is why they are asserted the same way.
 */
describe('an advance on the sales order', () => {
  test('credits the invoice raised from that order', () => {
    const c = makeCustomer();
    const so = makeOrder({ customerId: c, currency: 'INR' });
    makePayment({ customerId: c, orderId: so, amount: 4000, currency: 'INR' });
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 10000, orderId: so });

    const r = invoiceReceivable(inv);
    assert.equal(r.advance_applied, 4000);
    assert.equal(r.amount_received, 4000);
    assert.equal(r.balance_due, 6000);
  });

  test('reaches an invoice that names only the proforma, through its back-pointer', () => {
    // `dispatchProgress()`'s walk: the invoice's own link, else its proforma's.
    const c = makeCustomer();
    const so = makeOrder({ customerId: c, currency: 'INR' });
    const pi = makeProforma({ customerId: c, currency: 'INR', total: 10000, orderId: so });
    makePayment({ customerId: c, orderId: so, amount: 2500, currency: 'INR' });
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 10000, piId: pi });

    assert.equal(invoiceReceivable(inv).advance_applied, 2500);
  });

  test('is a pool like the proforma’s own — split earliest first, never counted twice', () => {
    const c = makeCustomer();
    const so = makeOrder({ customerId: c, currency: 'INR' });
    makePayment({ customerId: c, orderId: so, amount: 12000, currency: 'INR' });
    const first = makeInvoice({ customerId: c, currency: 'INR', total: 10000, orderId: so, date: '2026-08-05' });
    const second = makeInvoice({ customerId: c, currency: 'INR', total: 10000, orderId: so, date: '2026-08-09' });

    assert.equal(invoiceReceivable(first).amount_received, 10000);
    assert.equal(invoiceReceivable(second).amount_received, 2000);
    assert.equal(
      invoiceReceivable(first).amount_received + invoiceReceivable(second).amount_received, 12000,
      'the advance credited in total must equal the advance taken',
    );
  });

  test('in another currency is credited to nothing, and reported instead', () => {
    const c = makeCustomer();
    const so = makeOrder({ customerId: c, currency: 'INR' });
    makePayment({ customerId: c, orderId: so, amount: 500, currency: 'EUR' });
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 10000, orderId: so });

    const r = invoiceReceivable(inv);
    assert.equal(r.amount_received, 0);
    assert.deepEqual(r.currency_mismatch, [{ currency: 'EUR', amount: 500 }]);
  });

  test('the bulk allocation agrees with the single one, as it must for the dashboard', () => {
    const c = makeCustomer();
    const so = makeOrder({ customerId: c, currency: 'INR' });
    makePayment({ customerId: c, orderId: so, amount: 7000, currency: 'INR' });
    const a = makeInvoice({ customerId: c, currency: 'INR', total: 5000, orderId: so, date: '2026-08-03' });
    const b = makeInvoice({ customerId: c, currency: 'INR', total: 5000, orderId: so, date: '2026-08-04' });

    const received = receivedByInvoice();
    const applied = advanceAppliedByInvoice();
    for (const id of [a, b]) {
      assert.equal(received.get(id) ?? 0, invoiceReceivable(id).amount_received);
      assert.equal(applied.get(id) ?? 0, invoiceReceivable(id).advance_applied);
    }
  });

  test('a payment row sits in one pool, so two documents cannot both spend it', () => {
    // The proforma's advance and the order's are separate rows by construction
    // — `POST /payments` writes exactly one link — and the invoice draws on
    // both without either being double counted.
    const c = makeCustomer();
    const so = makeOrder({ customerId: c, currency: 'INR' });
    const pi = makeProforma({ customerId: c, currency: 'INR', total: 10000, orderId: so });
    makePayment({ customerId: c, piId: pi, amount: 3000, currency: 'INR', date: '2026-08-02' });
    makePayment({ customerId: c, orderId: so, amount: 2000, currency: 'INR', date: '2026-08-03' });
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 10000, piId: pi, orderId: so });

    assert.equal(invoiceReceivable(inv).advance_applied, 5000);
    assert.equal(invoiceReceivable(inv).balance_due, 5000);
  });
});

describe('what the order page reads', () => {
  test('an order with no proforma reads its own advance, in its own currency', () => {
    const c = makeCustomer();
    const so = makeOrder({ customerId: c, currency: 'INR' });
    makePayment({ customerId: c, orderId: so, amount: 1500, currency: 'INR', date: '2026-08-04' });
    makePayment({ customerId: c, orderId: so, amount: 500, currency: 'INR', date: '2026-08-07' });

    const a = orderAdvance(so);
    assert.equal(a.pi_id, null);
    assert.equal(a.amount_received, 2000);
    assert.equal(a.currency, 'INR');
    assert.equal(a.last_date, '2026-08-07', 'the date of credit is the most recent that counted');
    assert.equal(a.payments.length, 2);
  });

  test('an order booked from a proforma still reads that proforma’s advance', () => {
    const c = makeCustomer();
    const so = makeOrder({ customerId: c, currency: 'EUR' });
    const pi = makeProforma({ customerId: c, currency: 'EUR', total: 20000, orderId: so });
    makePayment({ customerId: c, piId: pi, amount: 6000, currency: 'EUR', date: '2026-08-05' });

    const a = orderAdvance(so);
    assert.equal(a.pi_id, pi);
    assert.equal(a.amount_received, 6000);
    assert.equal(a.last_date, '2026-08-05');
  });

  test('and both pools read as one figure where an order somehow holds both', () => {
    const c = makeCustomer();
    const so = makeOrder({ customerId: c, currency: 'INR' });
    const pi = makeProforma({ customerId: c, currency: 'INR', total: 20000, orderId: so });
    makePayment({ customerId: c, piId: pi, amount: 6000, currency: 'INR', date: '2026-08-05' });
    makePayment({ customerId: c, orderId: so, amount: 1000, currency: 'INR', date: '2026-08-08' });

    const a = orderAdvance(so);
    assert.equal(a.amount_received, 7000);
    assert.equal(a.last_date, '2026-08-08');
  });

  test('a date drawn from a payment in another currency would name money nothing counted', () => {
    const c = makeCustomer();
    const so = makeOrder({ customerId: c, currency: 'INR' });
    makePayment({ customerId: c, orderId: so, amount: 1000, currency: 'INR', date: '2026-08-04' });
    makePayment({ customerId: c, orderId: so, amount: 900, currency: 'EUR', date: '2026-08-09' });

    const a = orderAdvance(so);
    assert.equal(a.amount_received, 1000);
    assert.equal(a.last_date, '2026-08-04');
    assert.deepEqual(a.currency_mismatch, [{ currency: 'EUR', amount: 900 }]);
  });

  test('an order with nothing banked reads zero rather than nothing at all', () => {
    const c = makeCustomer();
    const a = orderAdvance(makeOrder({ customerId: c, currency: 'USD' }));
    assert.equal(a.amount_received, 0);
    assert.equal(a.currency, 'USD');
    assert.deepEqual(a.payments, []);
  });
});
