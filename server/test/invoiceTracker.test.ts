import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { trackerStatus, dueDateOf, trackerRows, trackerSummary } from '../src/services/invoiceTracker.js';
import { makeCustomer, makeInvoice, makeProforma, makePayment } from './helpers/factory.js';

/**
 * The invoice tracker's rules: the status is the balance and nothing else, a
 * blank due date is the shipment's ETA, and the figures are receivables' own.
 */

const head = (id: number) => db.prepare(
  `SELECT i.id, i.number, i.date, i.customer_id, COALESCE(c.name, '') AS customer_name,
          i.currency, i.is_export, i.grand_total, i.due_date
     FROM commercial_invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`
).get(id) as unknown as Parameters<typeof trackerRows>[0][number];

function trip(customerId: number, invoiceId: number, o: Partial<{ eta: string; etd: string; bl: string; docs: string }>) {
  const orderId = Number((db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status)
     VALUES (?, '2026-09-01', ?, 1, 'USD', 'none', 'pending') RETURNING id`
  ).get(`SO/T-${invoiceId}-${Math.random()}`, customerId) as { id: number }).id);
  return Number((db.prepare(
    `INSERT INTO despatches (order_id, date, invoice_id, bl_no, etd, eta, docs_status)
     VALUES (?, '2026-09-06', ?, ?, ?, ?, ?) RETURNING id`
  ).get(orderId, invoiceId, o.bl ?? '', o.etd ?? '', o.eta ?? '', o.docs ?? '') as { id: number }).id);
}

describe('status is the balance', () => {
  test('owed is pending, settled is completed, over-paid is completed', () => {
    assert.equal(trackerStatus(1), 'pending');
    assert.equal(trackerStatus(0.01), 'pending');
    assert.equal(trackerStatus(0), 'completed');
    assert.equal(trackerStatus(-5), 'completed');
  });
});

describe('the due date', () => {
  test('a typed date wins, and says it was typed', () => {
    assert.deepEqual(dueDateOf('2026-10-31', [{ eta: '2026-10-01' }]), { due_date: '2026-10-31', due_on_arrival: false });
  });
  test('blank falls back to the latest ETA and says so', () => {
    assert.deepEqual(dueDateOf('', [{ eta: '2026-10-01' }, { eta: '2026-10-09' }, { eta: '' }]), { due_date: '2026-10-09', due_on_arrival: true });
  });
  test('blank with no ETA is blank, and is not "on arrival"', () => {
    assert.deepEqual(dueDateOf('  ', [{ eta: '' }]), { due_date: '', due_on_arrival: false });
    assert.deepEqual(dueDateOf('', []), { due_date: '', due_on_arrival: false });
  });
});

describe('the row is receivables plus the sea leg', () => {
  test('advance from the proforma, balance nets it, the trip rides along', () => {
    const c = makeCustomer();
    const pi = makeProforma({ customerId: c, currency: 'USD', total: 10000 });
    makePayment({ customerId: c, amount: 3000, currency: 'USD', piId: pi });
    const inv = makeInvoice({ customerId: c, currency: 'USD', total: 10000, piId: pi });
    const d = trip(c, inv, { bl: 'MEDUJB634981', etd: '2026-09-10', eta: '2026-10-05', docs: 'sent' });
    const [row] = trackerRows([head(inv)], true);
    assert.equal(row.advance_applied, 3000);
    assert.equal(row.amount_received, 3000);
    assert.equal(row.balance_due, 7000);
    assert.equal(row.status, 'pending');
    assert.deepEqual({ due: row.due_date, arrival: row.due_on_arrival }, { due: '2026-10-05', arrival: true });
    assert.equal(row.shipments?.length, 1);
    assert.equal(row.shipments?.[0].despatch_id, d);
    assert.equal(row.shipments?.[0].bl_no, 'MEDUJB634981');
    // The balance paid directly closes it; the advance column stays the advance.
    makePayment({ customerId: c, amount: 7000, currency: 'USD', invoiceId: inv });
    const [after] = trackerRows([head(inv)], true);
    assert.equal(after.advance_applied, 3000);
    assert.equal(after.amount_received, 10000);
    assert.equal(after.balance_due, 0);
    assert.equal(after.status, 'completed');
  });

  test('without dispatch the shipments key is absent, not empty', () => {
    const c = makeCustomer();
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 500 });
    trip(c, inv, { eta: '2026-10-01' });
    const [row] = trackerRows([head(inv)], false);
    assert.equal('shipments' in row, false);
    // The due date still falls back to the ETA — the fact is read either way.
    assert.equal(row.due_date, '2026-10-01');
  });

  test('a typed due date on the invoice wins over the ETA', () => {
    const c = makeCustomer();
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 500 });
    trip(c, inv, { eta: '2026-10-01' });
    db.prepare("UPDATE commercial_invoices SET due_date = '2026-11-15' WHERE id = ?").run(inv);
    const [row] = trackerRows([head(inv)], true);
    assert.deepEqual({ due: row.due_date, arrival: row.due_on_arrival }, { due: '2026-11-15', arrival: false });
  });

  test('the summary is per currency and counts pending over the whole set', () => {
    const c = makeCustomer();
    const a = makeInvoice({ customerId: c, currency: 'USD', total: 1000 });
    const b = makeInvoice({ customerId: c, currency: 'USD', total: 400 });
    const r = makeInvoice({ customerId: c, currency: 'INR', total: 9000 });
    makePayment({ customerId: c, amount: 400, currency: 'USD', invoiceId: b });
    const s = trackerSummary(trackerRows([head(a), head(b), head(r)], false));
    assert.equal(s.invoices, 3);
    assert.equal(s.pending, 2);
    assert.equal(s.completed, 1);
    assert.deepEqual(s.by_currency, [
      { currency: 'INR', invoiced: 9000, balance: 9000 },
      { currency: 'USD', invoiced: 1400, balance: 1000 },
    ]);
  });
});
