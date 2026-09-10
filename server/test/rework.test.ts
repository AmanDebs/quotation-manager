import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { batchesFor, coaBlockError, despatchBatchError, dispositionError, setDespatchBatches } from '../src/services/batch.js';
import { progressFor, productionByOrder } from '../src/services/production.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * What becomes of a lot that failed.
 *
 * The specification asks for two words — *"initiating rework or scrap
 * procedures"* — and the two behave completely differently, which is what
 * these are mostly about. **Rework changes no figure**: the loop it closes was
 * already there, since a lot's verdict is its latest decided check, so putting
 * one back and re-inspecting it clears it. What rework adds is the record.
 * **Scrap changes every figure that counts what exists**, because condemned
 * goods stop existing — and the one figure it must *not* change is the lot's
 * own, or "what did we scrap" becomes unanswerable.
 */

let seq = 0;

interface Fixture { orderId: number; woId: number; paramId: number }

function job(planned = 100000): Fixture {
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
  ).get(`SO/R-${seq}`, makeCustomer()) as { id: number }).id);
  db.prepare(
    `INSERT INTO order_items (order_id, product_id, description, qty, unit, unit_price, amount, total_pcs, sort_order)
     VALUES (?, ?, 'Cap', 100, 'per 1000', 10, 1000, ?, 0)`
  ).run(orderId, productId, planned);
  const woId = Number((db.prepare(
    `INSERT INTO work_orders (number, order_id, order_line, product_id, qty_planned, status)
     VALUES (?, ?, 0, ?, ?, 'released') RETURNING id`
  ).get(`WO/R-${seq}`, orderId, productId, planned) as { id: number }).id);
  return { orderId, woId, paramId };
}

const batch = (woId: number) => Number((db.prepare(
  "INSERT INTO batches (number, work_order_id, date) VALUES (?, ?, '2026-09-02') RETURNING id"
).get(`B/${++seq}`, woId) as { id: number }).id);

const shift = (woId: number, batchId: number | null, ok: number, reject = 0) =>
  db.prepare(
    `INSERT INTO production_entries (work_order_id, batch_id, date, qty_ok, qty_reject)
     VALUES (?, ?, '2026-09-02', ?, ?)`
  ).run(woId, batchId, ok, reject);

const check = (woId: number, batchId: number | null, paramId: number, value: number) => {
  const id = Number((db.prepare(
    "INSERT INTO qc_checks (work_order_id, batch_id, date) VALUES (?, ?, '2026-09-03') RETURNING id"
  ).get(woId, batchId) as { id: number }).id);
  db.prepare(
    `INSERT INTO qc_results (check_id, param_id, name, kind, unit, value, min_value, max_value)
     VALUES (?, ?, 'Neck diameter', 'numeric', 'mm', ?, 27.9, 28.1)`
  ).run(id, paramId, value);
};

const rule = (batchId: number, d: string, note = '') =>
  db.prepare('UPDATE batches SET disposition = ?, disposition_date = ?, disposition_note = ? WHERE id = ?')
    .run(d, d ? '2026-09-07' : '', note, batchId);

const only = (woId: number) => batchesFor(woId)[0];

describe('a lot that failed and nobody has ruled on', () => {
  test('is held, which is derived and not a third stored state', () => {
    const { woId, paramId } = job();
    const b = batch(woId);
    shift(woId, b, 40000);
    check(woId, b, paramId, 30.5);
    const got = only(woId);
    assert.equal(got.qc, 'failed');
    assert.equal(got.disposition, '');
    assert.equal(got.held, true);
    assert.equal(got.scrapped, false);
  });

  test('and stops being held the moment somebody decides, either way', () => {
    const { woId, paramId } = job();
    const b = batch(woId);
    shift(woId, b, 40000);
    check(woId, b, paramId, 30.5);
    rule(b, 'rework');
    assert.equal(only(woId).held, false);
    rule(b, 'scrapped');
    assert.equal(only(woId).held, false);
    rule(b, '');
    assert.equal(only(woId).held, true, 'withdrawing a decision left the lot decided');
  });

  test('a lot that passed is never held, whatever else is true of it', () => {
    const { woId, paramId } = job();
    const b = batch(woId);
    shift(woId, b, 40000);
    check(woId, b, paramId, 28.0);
    assert.equal(only(woId).held, false);
  });
});

describe('rework', () => {
  /**
   * The loop was already closed before the disposition existed — a verdict is
   * the latest decided check — so this asserts the record does not get in the
   * way of it, which is the only way rework could have gone wrong.
   */
  test('changes no figure, and a re-inspection still clears the lot', () => {
    const { woId, paramId } = job();
    const b = batch(woId);
    shift(woId, b, 40000);
    check(woId, b, paramId, 30.5);
    rule(b, 'rework', 'Re-trim');
    assert.equal(only(woId).made, 40000);
    assert.equal(progressFor(woId, 100000).produced, 40000);
    assert.match(String(coaBlockError(b)), /did not pass/);
    check(woId, b, paramId, 28.0);            // back from rework, and it passes
    assert.equal(only(woId).qc, 'passed');
    assert.equal(coaBlockError(b), null, 'a reworked lot could not be certified');
  });

  test('and the reason is kept, because it is the part nobody can reconstruct', () => {
    const { woId, paramId } = job();
    const b = batch(woId);
    shift(woId, b, 40000);
    check(woId, b, paramId, 30.5);
    rule(b, 'rework', 'Re-trim and re-inspect');
    assert.equal(only(woId).disposition_note, 'Re-trim and re-inspect');
    assert.equal(only(woId).disposition_date, '2026-09-07');
  });
});

describe('scrap takes the goods out of every figure that counts what exists', () => {
  test('the job has made less, and has more left to make', () => {
    const { woId } = job();
    const b = batch(woId);
    shift(woId, b, 40000);
    shift(woId, null, 25000);              // output in no lot at all
    assert.equal(progressFor(woId, 100000).produced, 65000);
    rule(b, 'scrapped');
    const p = progressFor(woId, 100000);
    assert.equal(p.produced, 25000, 'condemned pieces still counted as made');
    assert.equal(p.balance, 75000, 'the job did not know it has to make them again');
  });

  /**
   * Condemned output becomes *rejected* output rather than vanishing. Dropping
   * it from both columns makes the reject rate improve when a whole lot is
   * condemned, which is the worst outcome there is.
   */
  test('and counts as rejected, so the reject rate worsens rather than improves', () => {
    const { woId } = job();
    const b = batch(woId);
    shift(woId, b, 30000, 1000);
    shift(woId, null, 70000);
    const before = progressFor(woId, 100000);
    assert.equal(before.rejected, 1000);
    assert.equal(before.reject_pct, 0.99);       // 1,000 rejected of 101,000 moulded
    rule(b, 'scrapped');
    const after = progressFor(woId, 100000);
    assert.equal(after.produced, 70000);
    assert.equal(after.rejected, 31000, 'the condemned pieces went nowhere');
    // Nothing was un-moulded, so the base is unchanged and only the side moved.
    assert.equal(after.reject_pct, 30.69);
  });

  test('the order line agrees with the job about it', () => {
    const { orderId, woId } = job();
    const b = batch(woId);
    shift(woId, b, 40000);
    assert.equal(productionByOrder(orderId).get(0)!.produced, 40000);
    rule(b, 'scrapped');
    const line = productionByOrder(orderId).get(0)!;
    assert.equal(line.produced, 0);
    assert.equal(line.rejected, 40000);
    assert.equal(line.balance, 100000);
  });

  /**
   * The one figure scrap must NOT move. The job stops counting the lot; the
   * lot goes on saying what it made, or "how much did we scrap" has no answer.
   */
  test('but the lot itself still remembers what it made', () => {
    const { woId } = job();
    const b = batch(woId);
    shift(woId, b, 40000, 500);
    rule(b, 'scrapped');
    const got = only(woId);
    assert.equal(got.made, 40000);
    assert.equal(got.rejected, 500);
    assert.equal(got.scrapped, true);
  });

  test('and a job with nothing condemned is untouched, which is every job on file', () => {
    const { woId, orderId } = job();
    const b = batch(woId);
    shift(woId, b, 40000, 600);
    shift(woId, null, 10000);
    assert.equal(progressFor(woId, 100000).produced, 50000);
    assert.equal(progressFor(woId, 100000).rejected, 600);
    assert.equal(productionByOrder(orderId).get(0)!.produced, 50000);
  });
});

describe('what a scrapped lot may no longer do', () => {
  test('it is never certified, however its checks later read', () => {
    const { woId, paramId } = job();
    const b = batch(woId);
    shift(woId, b, 40000);
    check(woId, b, paramId, 30.5);
    rule(b, 'scrapped');
    assert.match(String(coaBlockError(b)), /was scrapped, so it cannot be certified/);
    // A verdict is the *latest* decided check, so without this rule a fresh
    // reading would walk a condemned lot straight back to a certificate.
    check(woId, b, paramId, 28.0);
    assert.equal(only(woId).qc, 'passed');
    assert.match(String(coaBlockError(b)), /was scrapped/);
    rule(b, '');
    assert.equal(coaBlockError(b), null, 'withdrawing the scrap left no way back');
  });

  test('and it is never dispatched, even carrying a certificate issued earlier', () => {
    const { orderId, woId, paramId } = job();
    const b = batch(woId);
    shift(woId, b, 40000);
    check(woId, b, paramId, 28.0);
    db.prepare("UPDATE batches SET coa_no = 'COA/1', coa_date = '2026-09-06' WHERE id = ?").run(b);
    assert.equal(despatchBatchError(orderId, [b]), null);
    rule(b, 'scrapped');       // certified, then dropped in the yard
    assert.match(String(despatchBatchError(orderId, [b])), /was scrapped, so it cannot be dispatched/);
  });
});

describe('what may be decided at all', () => {
  test('a lot that has gone to the customer cannot be reworked or scrapped', () => {
    const { orderId, woId } = job();
    const b = batch(woId);
    shift(woId, b, 40000);
    const d = Number((db.prepare(
      `INSERT INTO despatches (order_id, date, challan_no) VALUES (?, '2026-09-08', 'DC/9') RETURNING id`
    ).get(orderId) as { id: number }).id);
    setDespatchBatches(d, [b]);
    assert.match(String(dispositionError(b, 'scrapped')), /already been dispatched on DC\/9/);
    assert.match(String(dispositionError(b, 'rework')), /already been dispatched/);
    // Withdrawing is still allowed, or a lot could be trapped by a trip
    // recorded after the decision.
    assert.equal(dispositionError(b, ''), null);
  });

  test('and a lot still in the plant may be ruled on either way', () => {
    const { woId } = job();
    const b = batch(woId);
    shift(woId, b, 40000);
    assert.equal(dispositionError(b, 'rework'), null);
    assert.equal(dispositionError(b, 'scrapped'), null);
  });

  test('a lot that does not exist refuses rather than throwing', () => {
    assert.equal(dispositionError(999999, 'scrapped'), 'Batch not found.');
  });
});
