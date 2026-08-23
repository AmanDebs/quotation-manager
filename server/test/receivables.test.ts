import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceReceivable, receivedByInvoice } from '../src/services/receivables.js';
import { makeCustomer, makeProforma, makeInvoice, makePayment } from './helpers/factory.js';

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
