import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import {
  creditedForInvoice, creditedByInvoice, returnedQtyByLine, returnLimitError, creditTotalError,
} from '../src/services/creditNotes.js';
import { invoiceReceivable, receivedByInvoice } from '../src/services/receivables.js';
import { syncInvoiceStatus } from '../src/services/invoiceStatus.js';
import { checkDocument, incompleteError } from '../src/services/documentChecks.js';
import { makeCustomer, makeProforma, makeInvoice, makePayment, statusOf } from './helpers/factory.js';

/**
 * The credit note: what a buyer is credited, and what came back.
 *
 * Two rules carry everything, and most of what follows is a consequence of
 * one or the other. **Only an approved credit note credits anything** — a
 * draft that reduced a balance would be a way to write a debt off by typing
 * one. And **only a return moves goods** — an adjustment credits money against
 * a line without anything coming back, so it must never re-open the line.
 */

let seq = 0;

/** Lines on the invoice, by position. Null qty makes a charge line. */
function invoiceLines(invoiceId: number, lines: { qty: number | null; price: number; charge?: boolean; desc?: string }[]) {
  lines.forEach((l, i) => db.prepare(
    `INSERT INTO invoice_items (invoice_id, description, qty, unit, unit_price, amount, is_charge, sort_order)
     VALUES (?, ?, ?, 'unit', ?, ?, ?, ?)`
  ).run(invoiceId, l.desc ?? `Line ${i + 1}`, l.qty, l.price, (l.qty ?? 1) * l.price, l.charge ? 1 : 0, i));
}

function creditNote(o: {
  invoiceId: number; total: number; kind?: string; approval?: string;
  lines?: { qty: number | null; charge?: boolean }[];
}): number {
  const inv = db.prepare('SELECT customer_id, currency FROM commercial_invoices WHERE id = ?').get(o.invoiceId) as
    { customer_id: number; currency: string };
  const id = Number((db.prepare(
    `INSERT INTO credit_notes (number, date, invoice_id, customer_id, company_id, kind, currency, grand_total, approval_status)
     VALUES (?, '2026-09-10', ?, ?, 1, ?, ?, ?, ?) RETURNING id`
  ).get(`CN/${++seq}`, o.invoiceId, inv.customer_id, o.kind ?? 'return', inv.currency, o.total, o.approval ?? 'approved') as { id: number }).id);
  (o.lines ?? []).forEach((l, i) => db.prepare(
    `INSERT INTO credit_note_items (credit_note_id, description, qty, unit, is_charge, sort_order)
     VALUES (?, ?, ?, 'unit', ?, ?)`
  ).run(id, `Line ${i + 1}`, l.qty, l.charge ? 1 : 0, i));
  return id;
}

const approve = (id: number, status = 'approved') =>
  db.prepare('UPDATE credit_notes SET approval_status = ? WHERE id = ?').run(status, id);

describe('only an approved credit note credits anything', () => {
  test('a draft leaves the balance exactly where it was', () => {
    const c = makeCustomer();
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 10000 });
    creditNote({ invoiceId: inv, total: 3000, approval: 'not_submitted' });
    const r = invoiceReceivable(inv);
    assert.equal(r.credited, 0);
    assert.equal(r.balance_due, 10000);
  });

  test('approved, it comes off what is owed — and is not money received', () => {
    const c = makeCustomer();
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 10000 });
    makePayment({ customerId: c, invoiceId: inv, amount: 4000, currency: 'INR' });
    creditNote({ invoiceId: inv, total: 3000 });
    const r = invoiceReceivable(inv);
    assert.equal(r.amount_received, 4000, 'a credit note was counted as a payment');
    assert.equal(r.credited, 3000);
    assert.equal(r.balance_due, 3000);
    assert.equal(creditedForInvoice(inv), 3000);
  });

  test('a rejected one, likewise, credits nothing', () => {
    const c = makeCustomer();
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 10000 });
    const n = creditNote({ invoiceId: inv, total: 3000 });
    approve(n, 'rejected');
    assert.equal(invoiceReceivable(inv).balance_due, 10000);
  });

  test('the batch reader agrees with the single one', () => {
    const c = makeCustomer();
    const a = makeInvoice({ customerId: c, currency: 'INR', total: 10000 });
    const b = makeInvoice({ customerId: c, currency: 'INR', total: 5000 });
    creditNote({ invoiceId: a, total: 2500 });
    creditNote({ invoiceId: a, total: 500 });
    creditNote({ invoiceId: b, total: 100, approval: 'pending' });
    const m = creditedByInvoice();
    assert.equal(m.get(a), 3000);
    assert.equal(m.has(b), false, 'a pending note reached the dashboard figure');
  });
});

/**
 * The subtle one. An advance is allocated earliest-invoice-first, capped at
 * what each still owes — so a credit note on the first invoice has to shrink
 * its capacity, or the advance sits trapped against a bill nobody owes while
 * the next invoice reads unpaid.
 */
describe('an advance flows past a credited invoice', () => {
  test('to the next one raised from the same proforma', () => {
    const c = makeCustomer();
    const pi = makeProforma({ customerId: c, currency: 'INR', total: 20000 });
    const first = makeInvoice({ customerId: c, currency: 'INR', total: 10000, piId: pi, date: '2026-08-01' });
    const second = makeInvoice({ customerId: c, currency: 'INR', total: 10000, piId: pi, date: '2026-08-02' });
    makePayment({ customerId: c, piId: pi, amount: 10000, currency: 'INR' });

    // Before the credit: the advance is swallowed whole by the first invoice.
    assert.equal(invoiceReceivable(first).advance_applied, 10000);
    assert.equal(invoiceReceivable(second).advance_applied, 0);

    creditNote({ invoiceId: first, total: 4000 });
    const a = invoiceReceivable(first);
    const b = invoiceReceivable(second);
    assert.equal(a.advance_applied, 6000, 'the credited invoice still absorbed the whole advance');
    assert.equal(a.balance_due, 0);
    assert.equal(b.advance_applied, 4000, 'the freed advance did not reach the next invoice');
    assert.equal(b.balance_due, 6000);

    // And the dashboard path allocates identically.
    const all = receivedByInvoice();
    assert.equal(all.get(first), 6000);
    assert.equal(all.get(second), 4000);
  });
});

describe('a fully credited invoice has nothing outstanding', () => {
  test('and its status follows, in both directions', () => {
    const c = makeCustomer();
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 10000, status: 'final' });
    const n = creditNote({ invoiceId: inv, total: 10000 });
    syncInvoiceStatus(inv);
    assert.equal(statusOf('commercial_invoices', inv), 'paid');
    // Editing the note resets its approval, and the balance comes back.
    approve(n, 'not_submitted');
    syncInvoiceStatus(inv);
    assert.equal(statusOf('commercial_invoices', inv), 'final');
  });
});

describe('only a return moves goods', () => {
  test('returned quantities are read by position, and an adjustment counts for nothing', () => {
    const c = makeCustomer();
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 100 });
    creditNote({ invoiceId: inv, total: 10, lines: [{ qty: 500 }, { qty: 200 }] });
    creditNote({ invoiceId: inv, total: 10, lines: [{ qty: 100 }] });
    creditNote({ invoiceId: inv, total: 10, kind: 'adjustment', lines: [{ qty: 9999 }] });
    creditNote({ invoiceId: inv, total: 10, approval: 'pending', lines: [{ qty: 9999 }] });
    const m = returnedQtyByLine(inv);
    assert.equal(m.get(0), 600);
    assert.equal(m.get(1), 200);
  });

  /** Positions count charge lines, the chain's index rule. */
  test('a charge line keeps its slot so the goods after it still line up', () => {
    const c = makeCustomer();
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 100 });
    creditNote({ invoiceId: inv, total: 10, lines: [{ qty: null, charge: true }, { qty: 250 }] });
    const m = returnedQtyByLine(inv);
    assert.equal(m.has(0), false, 'a charge was counted as goods returned');
    assert.equal(m.get(1), 250);
  });
});

describe('nothing may be returned that was not billed', () => {
  const setup = () => {
    const c = makeCustomer();
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 1000 });
    invoiceLines(inv, [{ qty: null, price: 100, charge: true, desc: 'Freight' }, { qty: 1000, price: 1, desc: 'Caps' }]);
    return inv;
  };
  const line = (qty: number | null, charge = false) => ({ description: 'x', qty, unit: 'unit', unit_price: 1, is_charge: charge });

  test('exactly what was billed is allowed', () => {
    const inv = setup();
    assert.equal(returnLimitError(inv, 'return', [line(null, true), line(1000)]), null);
  });

  test('one more is refused, naming the line and the figures', () => {
    const inv = setup();
    const msg = returnLimitError(inv, 'return', [line(null, true), line(1001)]);
    assert.match(msg ?? '', /Line 2 returns 1,001 of Caps, but the invoice billed 1,000/);
  });

  test('what an earlier note took is counted, a rejected one is not', () => {
    const inv = setup();
    const n = creditNote({ invoiceId: inv, total: 1, approval: 'not_submitted', lines: [{ qty: null, charge: true }, { qty: 400 }] });
    assert.equal(returnLimitError(inv, 'return', [line(null, true), line(600)]), null);
    assert.match(returnLimitError(inv, 'return', [line(null, true), line(601)]) ?? '', /400 has already been credited, leaving 600/);
    approve(n, 'rejected');
    assert.equal(returnLimitError(inv, 'return', [line(null, true), line(1000)]), null, 'a rejected note still blocked');
  });

  /** Without this, re-saving an unchanged note counts itself and refuses itself. */
  test('the note being edited is not counted against itself', () => {
    const inv = setup();
    const n = creditNote({ invoiceId: inv, total: 1, lines: [{ qty: null, charge: true }, { qty: 1000 }] });
    assert.match(returnLimitError(inv, 'return', [line(null, true), line(1000)]) ?? '', /already been credited/);
    assert.equal(returnLimitError(inv, 'return', [line(null, true), line(1000)], n), null);
  });

  test('a charge line has no ceiling; nor does an adjustment', () => {
    const inv = setup();
    assert.equal(returnLimitError(inv, 'return', [line(null, true)]), null);
    assert.equal(returnLimitError(inv, 'adjustment', [line(null, true), line(999999)]), null);
  });

  test('a line the invoice does not have is refused, and so is a negative', () => {
    const inv = setup();
    assert.match(returnLimitError(inv, 'return', [line(null, true), line(1), line(1)]) ?? '', /Line 3 has no counterpart/);
    assert.match(returnLimitError(inv, 'return', [line(null, true), line(-5)]) ?? '', /Line 2 returns a negative/);
  });
});

describe('nothing may be credited beyond what was billed', () => {
  test('exactly the invoice total is allowed, a paisa more is not', () => {
    const c = makeCustomer();
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 10000 });
    assert.equal(creditTotalError(inv, 10000), null);
    assert.match(creditTotalError(inv, 10000.01) ?? '', /comes to INR 10,000.01, but invoice .* was raised for INR 10,000.00/);
  });

  test('earlier notes count, rejected ones do not, and the one being edited is excluded', () => {
    const c = makeCustomer();
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 10000 });
    const n = creditNote({ invoiceId: inv, total: 6000, approval: 'pending' });
    assert.equal(creditTotalError(inv, 4000), null);
    assert.match(creditTotalError(inv, 4001) ?? '', /6,000.00 of it has already been credited, leaving INR 4,000.00/);
    assert.equal(creditTotalError(inv, 6000, n), null, 'the note counted itself');
    approve(n, 'rejected');
    assert.equal(creditTotalError(inv, 10000), null);
  });
});

/**
 * The completeness gate, for the two rules a credit note deliberately does
 * not share with the selling documents.
 */
describe('a credit note has to be finished, on its own terms', () => {
  test('one that is nothing but a charge is not refused — freight is credited for its money alone', () => {
    const c = makeCustomer();
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 1000 });
    const n = creditNote({ invoiceId: inv, total: 100, lines: [{ qty: null, charge: true }] });
    db.prepare("UPDATE credit_note_items SET description = 'Freight overbilled' WHERE credit_note_id = ?").run(n);
    assert.equal(incompleteError('credit_notes', n), null);
  });

  test('a credit for nothing is refused, in its own words', () => {
    const c = makeCustomer();
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 1000 });
    const n = creditNote({ invoiceId: inv, total: 0, lines: [{ qty: 5 }] });
    const keys = checkDocument('credit_notes', n).map((f) => f.key);
    assert.ok(keys.includes('total'));
    assert.ok(!keys.includes('quantity'), 'a lump-sum adjustment was asked for a quantity');
    assert.match(incompleteError('credit_notes', n) ?? '', /nothing to credit/);
  });
});
