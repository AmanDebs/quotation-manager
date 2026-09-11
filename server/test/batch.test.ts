import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { batchesFor, batchById, coaBlockError, renameError } from '../src/services/batch.js';
import { makeCustomer, makeInvoice } from './helpers/factory.js';

/**
 * A lot, and the certificate that clears it.
 *
 * Two things are being protected. **Almost nothing is stored** — a batch's
 * quantity is the shift entries booked into it and its verdict is its final
 * check's own readings — so most of these assert that moving the facts moves
 * the figures. And **silence is not a verdict**: a lot nobody has finalised is
 * neither a pass nor a failure, which is the distinction the whole QC module
 * exists to keep and the one a certificate must never paper over.
 */

let seq = 0;

function job(): { woId: number; productId: number; paramId: number; orderId: number } {
  const productId = Number((db.prepare(
    "INSERT INTO products (name, unit, unit_price) VALUES (?, 'per 1000', 10) RETURNING id"
  ).get(`Cap ${++seq}`) as { id: number }).id);
  const paramId = Number((db.prepare(
    `INSERT INTO product_qc_params (product_id, name, kind, unit, min_value, max_value)
     VALUES (?, 'Neck diameter', 'numeric', 'mm', 27.9, 28.1) RETURNING id`
  ).get(productId) as { id: number }).id);
  const orderId = Number((db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status)
     VALUES (?, '2026-09-01', ?, 1, 'INR', 'igst', 'confirmed') RETURNING id`
  ).get(`SO/B-${seq}`, makeCustomer()) as { id: number }).id);
  db.prepare(
    `INSERT INTO order_items (order_id, product_id, description, qty, unit, unit_price, amount, total_pcs, sort_order)
     VALUES (?, ?, 'Cap', 100, 'per 1000', 10, 1000, 100000, 0)`
  ).run(orderId, productId);
  const woId = Number((db.prepare(
    `INSERT INTO work_orders (number, order_id, order_line, product_id, qty_planned, status)
     VALUES (?, ?, 0, ?, 100000, 'released') RETURNING id`
  ).get(`WO/B-${seq}`, orderId, productId) as { id: number }).id);
  return { woId, productId, paramId, orderId };
}

const batch = (woId: number) => Number((db.prepare(
  "INSERT INTO batches (number, work_order_id, date) VALUES (?, ?, '2026-09-02') RETURNING id"
).get(`B/${++seq}`, woId) as { id: number }).id);

const shift = (woId: number, batchId: number | null, ok: number, reject = 0) =>
  db.prepare(
    `INSERT INTO production_entries (work_order_id, batch_id, date, qty_ok, qty_reject)
     VALUES (?, ?, '2026-09-02', ?, ?)`
  ).run(woId, batchId, ok, reject);

/** A check against the job, naming a lot or not; `null` reading = not measured. */
const check = (woId: number, batchId: number | null, paramId: number, value: number | null) => {
  const id = Number((db.prepare(
    "INSERT INTO qc_checks (work_order_id, batch_id, date) VALUES (?, ?, '2026-09-03') RETURNING id"
  ).get(woId, batchId) as { id: number }).id);
  db.prepare(
    `INSERT INTO qc_results (check_id, param_id, name, kind, unit, value, min_value, max_value)
     VALUES (?, ?, 'Neck diameter', 'numeric', 'mm', ?, 27.9, 28.1)`
  ).run(id, paramId, value);
  return id;
};

const only = (woId: number) => batchesFor(woId)[0];

describe('what a lot is made of', () => {
  test('its quantity is the output booked into it, and nothing else on the job', () => {
    const { woId } = job();
    const b = batch(woId);
    shift(woId, b, 40000, 300);
    shift(woId, b, 20000, 100);
    // Output on the same job that went into no lot at all — counted by the
    // job, never by this batch.
    shift(woId, null, 90000);
    const got = only(woId);
    assert.equal(got.made, 60000);
    assert.equal(got.rejected, 400);
    assert.equal(got.entries, 2);
  });

  test('and deleting a mis-keyed shift corrects it by construction', () => {
    const { woId } = job();
    const b = batch(woId);
    shift(woId, b, 40000);
    const bad = db.prepare(
      "INSERT INTO production_entries (work_order_id, batch_id, date, qty_ok) VALUES (?, ?, '2026-09-02', 999999) RETURNING id"
    ).get(woId, b) as { id: number };
    assert.equal(only(woId).made, 1039999);
    db.prepare('DELETE FROM production_entries WHERE id = ?').run(bad.id);
    assert.equal(only(woId).made, 40000, 'the lot kept a shift that is no longer recorded');
  });
});

describe('what finalises a lot', () => {
  test('a lot nobody has checked is not a pass and not a failure', () => {
    const { woId } = job();
    batch(woId);
    assert.equal(only(woId).qc, 'none');
  });

  /** The specification's two levels, over one nullable column. */
  test('an in-process check does not finalise anything', () => {
    const { woId, paramId } = job();
    const b = batch(woId);
    shift(woId, b, 40000);
    check(woId, null, paramId, 28.0);   // against the job, naming no lot
    assert.equal(only(woId).qc, 'none', 'a shift-wise check certified a batch');
    assert.equal(only(woId).final_checks.length, 0);
  });

  test('a final check that fails says so', () => {
    const { woId, paramId } = job();
    const b = batch(woId);
    check(woId, b, paramId, 30.5);
    assert.equal(only(woId).qc, 'failed');
  });

  /**
   * Latest decided wins, unlike `qcBlockError`'s "any check passed" for a job.
   * A job accumulates in-process checks and one pass is evidence the line can
   * be made; a lot is a thing that is re-tested, and the last word about it is
   * the one that counts.
   */
  test('and re-testing a failed lot is what changes its verdict', () => {
    const { woId, paramId } = job();
    const b = batch(woId);
    check(woId, b, paramId, 30.5);
    check(woId, b, paramId, 28.0);
    assert.equal(only(woId).qc, 'passed');
  });

  test('a check with nothing measured is no verdict at all', () => {
    const { woId, paramId } = job();
    const b = batch(woId);
    check(woId, b, paramId, 28.0);
    check(woId, b, paramId, null);     // recorded, nothing read
    assert.equal(only(woId).qc, 'passed', 'an unmeasured check overwrote a real verdict');
  });
});

describe('when a certificate may be issued', () => {
  const refusal = (woId: number) => coaBlockError(only(woId).id);

  test('never for a lot nothing was booked into', () => {
    const { woId, paramId } = job();
    const b = batch(woId);
    check(woId, b, paramId, 28.0);
    assert.match(String(refusal(woId)), /Nothing has been booked into/);
  });

  test('never for a lot with no final check', () => {
    const { woId } = job();
    const b = batch(woId);
    shift(woId, b, 40000);
    assert.match(String(refusal(woId)), /no final quality check/);
  });

  test('never for a lot whose final check failed', () => {
    const { woId, paramId } = job();
    const b = batch(woId);
    shift(woId, b, 40000);
    check(woId, b, paramId, 30.5);
    assert.match(String(refusal(woId)), /did not pass/);
  });

  test('and freely for one that was made and passed', () => {
    const { woId, paramId } = job();
    const b = batch(woId);
    shift(woId, b, 40000);
    check(woId, b, paramId, 28.0);
    assert.equal(refusal(woId), null);
  });

  /**
   * A certificate is issued once. The number may already be with the customer,
   * and a second one would make "which COA covers this box" unanswerable —
   * the rule every issued number in this app follows.
   */
  test('and never twice', () => {
    const { woId, paramId } = job();
    const b = batch(woId);
    shift(woId, b, 40000);
    check(woId, b, paramId, 28.0);
    assert.equal(refusal(woId), null);
    db.prepare("UPDATE batches SET coa_no = 'COA/26-27/001', coa_date = '2026-09-04' WHERE id = ?").run(b);
    assert.match(String(refusal(woId)), /already certified as COA\/26-27\/001/);
    assert.equal(batchById(b)!.cleared, true);
  });

  test('a lot that does not exist refuses rather than throwing', () => {
    assert.equal(coaBlockError(999999), 'Batch not found.');
    assert.equal(batchById(999999), undefined);
  });
});

/**
 * A lot's number is fixed once it is on paper — a certificate, a challan or a
 * credit note — the rule every issued number here follows. Until then it is a
 * free-text field somebody may well have mistyped.
 */
describe('when a lot may be renamed', () => {
  test('freely while nothing names it, and a no-op is never refused', () => {
    const { woId } = job();
    const b = batch(woId);
    assert.equal(renameError(b, 'B/CORRECTED'), null);
    assert.equal(renameError(b, only(woId).number), null);
    assert.equal(renameError(b, undefined), null, 'a PUT that does not send the number');
    assert.equal(renameError(b, '  '), null, 'a blank keeps the old number, the route rule');
  });

  test('never once certified, naming the certificate', () => {
    const { woId } = job();
    const b = batch(woId);
    db.prepare("UPDATE batches SET coa_no = 'COA/26-27/007', coa_date = '2026-09-05' WHERE id = ?").run(b);
    assert.match(String(renameError(b, 'B/OTHER')), /named on certificate COA\/26-27\/007/);
  });

  test('never once on a challan, naming the trip', () => {
    const { woId, orderId } = job();
    const b = batch(woId);
    const d = Number((db.prepare(
      "INSERT INTO despatches (order_id, date, challan_no) VALUES (?, '2026-09-06', 'DC/26-27/003') RETURNING id"
    ).get(orderId) as { id: number }).id);
    db.prepare('INSERT INTO despatch_batches (despatch_id, batch_id) VALUES (?, ?)').run(d, b);
    assert.match(String(renameError(b, 'B/OTHER')), /named on DC\/26-27\/003/);
  });

  test('never once on a credit note, drafted or not', () => {
    const { woId, orderId } = job();
    const b = batch(woId);
    const customerId = Number((db.prepare('SELECT customer_id FROM orders WHERE id = ?').get(orderId) as { customer_id: number }).customer_id);
    const inv = makeInvoice({ customerId, currency: 'INR', total: 1000 });
    db.prepare('UPDATE commercial_invoices SET order_id = ? WHERE id = ?').run(orderId, inv);
    const n = Number((db.prepare(
      `INSERT INTO credit_notes (number, date, invoice_id, customer_id, company_id, kind, currency, grand_total, approval_status)
       VALUES ('CN/26-27/002', '2026-09-10', ?, ?, 1, 'return', 'INR', 100, 'not_submitted') RETURNING id`
    ).get(inv, customerId) as { id: number }).id);
    db.prepare('INSERT INTO credit_note_batches (credit_note_id, batch_id) VALUES (?, ?)').run(n, b);
    assert.match(String(renameError(b, 'B/OTHER')), /named on credit note CN\/26-27\/002/);
  });
});
