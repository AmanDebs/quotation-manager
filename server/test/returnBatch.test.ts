import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import {
  batchesFor, dispositionError, setDespatchBatches, setCreditNoteBatches, returnBatchError,
  batchesOnCreditNote, batchesForInvoice,
} from '../src/services/batch.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * Which lot came back — `despatch_batches` read the other way, and the fact
 * that finally lets `dispositionError` rule on a lot that has been to the
 * customer. The whole point is in one test: a dispatched lot is refused scrap
 * until it is named on an **approved** return credit note, and then allowed.
 */

let seq = 0;

function order(customerId = makeCustomer()) {
  const orderId = Number((db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status)
     VALUES (?, '2026-09-01', ?, 1, 'INR', 'igst', 'confirmed') RETURNING id`
  ).get(`SO/RB-${++seq}`, customerId) as { id: number }).id);
  const woId = Number((db.prepare(
    `INSERT INTO work_orders (number, order_id, order_line, qty_planned, status)
     VALUES (?, ?, 0, 100000, 'released') RETURNING id`
  ).get(`WO/RB-${seq}`, orderId) as { id: number }).id);
  const batchId = Number((db.prepare(
    "INSERT INTO batches (number, work_order_id, date, coa_no) VALUES (?, ?, '2026-09-02', ?) RETURNING id"
  ).get(`B/RB-${seq}`, woId, `COA/RB-${seq}`) as { id: number }).id);
  db.prepare(
    `INSERT INTO production_entries (work_order_id, batch_id, date, qty_ok, qty_reject) VALUES (?, ?, '2026-09-03', 40000, 0)`
  ).run(woId, batchId);
  return { customerId, orderId, woId, batchId };
}

/** An invoice against the order — via `order_id`, or via a proforma's, like the real walk. */
function invoice(o: { customerId: number; orderId: number }, viaProforma = false) {
  let piId: number | null = null;
  let orderId: number | null = o.orderId;
  if (viaProforma) {
    piId = Number((db.prepare(
      `INSERT INTO proforma_invoices (number, date, customer_id, company_id, currency, order_id, grand_total)
       VALUES (?, '2026-09-01', ?, 1, 'INR', ?, 1000) RETURNING id`
    ).get(`PI/RB-${++seq}`, o.customerId, o.orderId) as { id: number }).id);
    orderId = null;
  }
  return Number((db.prepare(
    `INSERT INTO commercial_invoices (number, date, customer_id, company_id, currency, pi_id, order_id, grand_total, status, approval_status)
     VALUES (?, '2026-09-05', ?, 1, 'INR', ?, ?, 1000, 'final', 'approved') RETURNING id`
  ).get(`INV/RB-${++seq}`, o.customerId, piId, orderId) as { id: number }).id);
}

const trip = (orderId: number, batchId: number) => {
  const d = Number((db.prepare(
    `INSERT INTO despatches (order_id, date, challan_no) VALUES (?, '2026-09-06', ?) RETURNING id`
  ).get(orderId, `DC/RB-${++seq}`) as { id: number }).id);
  setDespatchBatches(d, [batchId]);
  return d;
};

const note = (invoiceId: number, kind = 'return', approval = 'approved') => Number((db.prepare(
  `INSERT INTO credit_notes (number, date, invoice_id, customer_id, company_id, kind, currency, grand_total, approval_status)
   SELECT ?, '2026-09-10', id, customer_id, 1, ?, currency, 100, ? FROM commercial_invoices WHERE id = ? RETURNING id`
).get(`CN/RB-${++seq}`, kind, approval, invoiceId) as { id: number }).id);

const lot = (woId: number) => batchesFor(woId)[0];

describe('a lot that came back may be scrapped', () => {
  test('dispatched: refused. Named on an approved return: allowed. Un-approved again: refused', () => {
    const o = order();
    trip(o.orderId, o.batchId);
    assert.match(String(dispositionError(o.batchId, 'scrapped')), /already been dispatched on DC\/RB-\d+/);

    const inv = invoice(o);
    const n = note(inv, 'return', 'not_submitted');
    setCreditNoteBatches(n, [o.batchId]);
    // Drafted is not returned — the refusal says so.
    assert.match(String(dispositionError(o.batchId, 'scrapped')), /drafted but not yet approved/);
    assert.equal(lot(o.woId).returned, false);
    assert.equal(lot(o.woId).returns.length, 1);

    db.prepare("UPDATE credit_notes SET approval_status = 'approved' WHERE id = ?").run(n);
    assert.equal(lot(o.woId).returned, true);
    assert.equal(dispositionError(o.batchId, 'scrapped'), null, 'a returned lot was still refused scrap');
    assert.equal(dispositionError(o.batchId, 'rework'), null);

    // An edit resets approval, and the door closes again with it.
    db.prepare("UPDATE credit_notes SET approval_status = 'not_submitted' WHERE id = ?").run(n);
    assert.match(String(dispositionError(o.batchId, 'scrapped')), /already been dispatched/);
  });

  test('the reverse lookup names the note and its invoice', () => {
    const o = order();
    const inv = invoice(o);
    const n = note(inv);
    setCreditNoteBatches(n, [o.batchId]);
    const r = lot(o.woId).returns[0];
    assert.equal(r.credit_note_id, n);
    assert.match(r.invoice_number, /^INV\/RB-/);
    assert.deepEqual(batchesOnCreditNote(n).map((b) => b.id), [o.batchId]);
  });
});

describe('what may be named as returned', () => {
  test('naming no lots is always fine', () => {
    const o = order();
    assert.equal(returnBatchError(invoice(o), 'return', []), null);
    assert.equal(returnBatchError(invoice(o), 'adjustment', []), null);
  });

  test('an adjustment moves no goods, so it may name none', () => {
    const o = order();
    assert.match(String(returnBatchError(invoice(o), 'adjustment', [o.batchId])), /adjustment credits money and moves no goods/);
  });

  test('a lot on this order is allowed, reached through the invoice either way', () => {
    const o = order();
    assert.equal(returnBatchError(invoice(o), 'return', [o.batchId]), null);
    assert.equal(returnBatchError(invoice(o, true), 'return', [o.batchId]), null, 'the walk through the proforma failed');
  });

  test('a lot made against another order is refused, and so is one not on file', () => {
    const a = order();
    const b = order();
    assert.match(String(returnBatchError(invoice(a), 'return', [b.batchId])), /made against another sales order/);
    assert.match(String(returnBatchError(invoice(a), 'return', [999999])), /not on file/);
    assert.match(String(returnBatchError(invoice(a), 'return', ['x'])), /not on file/);
  });

  test('a scrapped lot never left, so it cannot have come back', () => {
    const o = order();
    db.prepare("UPDATE batches SET disposition = 'scrapped' WHERE id = ?").run(o.batchId);
    assert.match(String(returnBatchError(invoice(o), 'return', [o.batchId])), /scrapped and never left/);
  });

  /** An invoice with no order behind it was produced against nothing. */
  test('an invoice with no order behind it has no lots to offer or accept', () => {
    const o = order();
    const inv = Number((db.prepare(
      `INSERT INTO commercial_invoices (number, date, customer_id, company_id, currency, grand_total, status, approval_status)
       VALUES (?, '2026-09-05', ?, 1, 'INR', 1000, 'final', 'approved') RETURNING id`
    ).get(`INV/RB-${++seq}`, o.customerId) as { id: number }).id);
    assert.deepEqual(batchesForInvoice(inv), []);
    assert.match(String(returnBatchError(inv, 'return', [o.batchId])), /another sales order/);
  });

  test('the picker carries where each lot went', () => {
    const o = order();
    trip(o.orderId, o.batchId);
    const lots = batchesForInvoice(invoice(o, true));
    assert.equal(lots.length, 1);
    assert.equal(lots[0].trips.length, 1);
    assert.match(lots[0].trips[0].reference, /^DC\/RB-/);
  });
});
