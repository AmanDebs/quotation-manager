import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import {
  batchesFor, batchById, checkEditError, coaBlockError, coaEditError, coaReissueError,
  despatchBatchError, lotsUnderCoa, renameError,
  cleanCoaExtra, coaExtraError, parseCoaExtra, MAX_COA_EXTRA,
} from '../src/services/batch.js';
import { certifiedSql } from '../src/services/qc.js';
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

/**
 * A certificate is correctable and withdrawable until it is on paper
 * somewhere else — 2026-10-22, the client: *"Add option to edit and delete
 * COA"*.
 *
 * The one-certificate rule is not weakened by it: a withdrawn number is never
 * re-used, and by this guard nothing has gone out under it. What it prevents
 * is the trap the rest of this module is careful about from the other side —
 * a certificate issued with the wrong date or over the wrong lot, permanent
 * for the life of the book.
 */
describe('when a certificate may be corrected or withdrawn', () => {
  /** A made, passed, certified lot on its own job. */
  function certified(no = 'COA/26-27/010') {
    const made = job();
    const b = batch(made.woId);
    shift(made.woId, b, 40000);
    check(made.woId, b, made.paramId, 28.0);
    db.prepare("UPDATE batches SET coa_no = ?, coa_date = '2026-10-21', coa_approved_by = 'asif' WHERE id = ?")
      .run(no, b);
    return { ...made, b };
  }

  test('freely while the number is on nothing but itself', () => {
    const { b } = certified();
    assert.equal(coaEditError(b), null);
  });

  test('never once a lot it covers has been dispatched, naming the challan', () => {
    const { b, orderId } = certified('COA/26-27/011');
    const d = Number((db.prepare(
      "INSERT INTO despatches (order_id, date, challan_no) VALUES (?, '2026-10-22', 'DC/26-27/009') RETURNING id"
    ).get(orderId) as { id: number }).id);
    db.prepare('INSERT INTO despatch_batches (despatch_id, batch_id) VALUES (?, ?)').run(d, b);
    const refused = String(coaEditError(b));
    assert.match(refused, /COA\/26-27\/011/);
    assert.match(refused, /DC\/26-27\/009/);
    assert.match(refused, /cannot be changed or withdrawn/);
  });

  test('never once a lot it covers is named as returned', () => {
    const { b, orderId } = certified('COA/26-27/012');
    const customerId = Number((db.prepare('SELECT customer_id FROM orders WHERE id = ?')
      .get(orderId) as { customer_id: number }).customer_id);
    const inv = makeInvoice({ customerId, currency: 'INR', total: 1000 });
    db.prepare('UPDATE commercial_invoices SET order_id = ? WHERE id = ?').run(orderId, inv);
    const n = Number((db.prepare(
      `INSERT INTO credit_notes (number, date, invoice_id, customer_id, company_id, kind, currency, grand_total, approval_status)
       VALUES ('CN/26-27/009', '2026-10-22', ?, ?, 1, 'return', 'INR', 100, 'not_submitted') RETURNING id`
    ).get(inv, customerId) as { id: number }).id);
    db.prepare('INSERT INTO credit_note_batches (credit_note_id, batch_id) VALUES (?, ?)').run(n, b);
    assert.match(String(coaEditError(b)), /CN\/26-27\/009/);
  });

  test('a lot carrying no certificate has none to correct', () => {
    const { woId } = job();
    const b = batch(woId);
    assert.match(String(coaEditError(b)), /No certificate has been issued/);
    assert.equal(coaEditError(999999), 'No certificate has been issued for this batch.');
  });

  /**
   * The whole reason both acts take a lot and resolve the rest: a number may
   * cover several, and correcting one of them would leave a certificate whose
   * own lots disagree about when it was issued.
   */
  test('the group is every lot sharing the number, from any of them', () => {
    const made = job();
    const a = batch(made.woId);
    const c = batch(made.woId);
    for (const id of [a, c]) {
      shift(made.woId, id, 20000);
      check(made.woId, id, made.paramId, 28.0);
      db.prepare("UPDATE batches SET coa_no = 'COA/26-27/013', coa_date = '2026-10-21' WHERE id = ?").run(id);
    }
    assert.deepEqual(lotsUnderCoa(a).map((l) => l.id).sort(), [a, c].sort(), 'opened from the first lot');
    assert.deepEqual(lotsUnderCoa(c).map((l) => l.id).sort(), [a, c].sort(), 'opened from the second');
    // ...and one of them shipping stops the whole certificate moving.
    const d = Number((db.prepare(
      "INSERT INTO despatches (order_id, date, challan_no) VALUES (?, '2026-10-22', 'DC/26-27/010') RETURNING id"
    ).get(made.orderId) as { id: number }).id);
    db.prepare('INSERT INTO despatch_batches (despatch_id, batch_id) VALUES (?, ?)').run(d, a);
    assert.match(String(coaEditError(c)), /DC\/26-27\/010/, 'the other lot of the group was not held');
  });

  test('an uncertified lot is its own group of none', () => {
    const { woId } = job();
    assert.deepEqual(lotsUnderCoa(batch(woId)), [], 'an uncertified lot gathered a group');
  });
});

/**
 * **A withdrawn certificate is a draft** (2026-10-24, the client: *"When we
 * withdraw a COA, the COA should go to draft mode so that we can make changes
 * and do not have to make the whole thing again"*).
 *
 * Two things are being protected, and the second is the one that would be
 * expensive to get wrong. The certificate **survives as a unit** — the number
 * is what holds a group together, so clearing it dissolved the thing the
 * client wants to correct. And **a draft certifies nothing**: `cleared` means
 * *issued*, so the QC gate holds the line and no lorry takes the lot. Most of
 * these assert that second half, because a draft that cleared goods would be
 * the specification's own Hard Stop walked around.
 */
describe('a withdrawn certificate is a draft', () => {
  /** A made, passed, certified lot, drafted or not. */
  function certified(no: string, draft = false) {
    const made = job();
    const b = batch(made.woId);
    shift(made.woId, b, 40000);
    check(made.woId, b, made.paramId, 28.0);
    db.prepare(
      `UPDATE batches SET coa_no = ?, coa_date = '2026-10-21', coa_approved_by = 'asif',
                          coa_status = ? WHERE id = ?`
    ).run(no, draft ? 'draft' : '', b);
    return { ...made, b };
  }

  test('it keeps its number, its date and its approver — the whole of what it was', () => {
    const { b } = certified('COA/26-27/020', true);
    const lot = batchById(b)!;
    assert.equal(lot.coa_no, 'COA/26-27/020', 'the number was cleared, so the group is gone');
    assert.equal(lot.coa_date, '2026-10-21');
    assert.equal(lot.coa_approved_by, 'asif');
    assert.equal(lot.coa_draft, true);
  });

  test('and it certifies nothing: the lot is not cleared', () => {
    const { b } = certified('COA/26-27/021', true);
    assert.equal(batchById(b)!.cleared, false, 'a draft cleared the lot it covers');
  });

  test('so no lorry takes it, and the refusal names the draft rather than denying it exists', () => {
    const { b, orderId } = certified('COA/26-27/022', true);
    const refused = String(despatchBatchError(orderId, [b]));
    assert.match(refused, /COA\/26-27\/022/, 'the sentence hid the number the register shows');
    assert.match(refused, /not been issued/);
    // And issued, the same lot goes.
    db.prepare("UPDATE batches SET coa_status = '' WHERE id = ?").run(b);
    assert.equal(despatchBatchError(orderId, [b]), null);
  });

  test('a second certificate is refused over a lot already on a draft', () => {
    const { b } = certified('COA/26-27/023', true);
    const refused = String(coaBlockError(b));
    assert.match(refused, /draft certificate COA\/26-27\/023/);
    assert.match(refused, /Issue that certificate or discard it/);
  });

  test('its group gathers from any of its lots, so it can be issued or discarded at all', () => {
    const made = job();
    const ids = [batch(made.woId), batch(made.woId)];
    for (const id of ids) {
      shift(made.woId, id, 20000);
      check(made.woId, id, made.paramId, 28.0);
      db.prepare("UPDATE batches SET coa_no = 'COA/26-27/024', coa_status = 'draft' WHERE id = ?").run(id);
    }
    assert.deepEqual(lotsUnderCoa(ids[0]).map((l) => l.id).sort(), [...ids].sort());
    assert.deepEqual(lotsUnderCoa(ids[1]).map((l) => l.id).sort(), [...ids].sort());
  });

  test('it is correctable — there is nothing out in the world to disagree with', () => {
    const { b } = certified('COA/26-27/025', true);
    assert.equal(coaEditError(b), null);
  });

  test('and issuable, which is what re-asks each lot state rather than the number', () => {
    const { b } = certified('COA/26-27/026', true);
    assert.equal(coaReissueError(b), null);
  });

  test('never issuable while a lot of it is scrapped, however its checks read', () => {
    const { b } = certified('COA/26-27/027', true);
    db.prepare("UPDATE batches SET disposition = 'scrapped' WHERE id = ?").run(b);
    assert.match(String(coaReissueError(b)), /was scrapped/);
  });

  test('nor once it has been re-inspected to a failing reading', () => {
    const made = job();
    const b = batch(made.woId);
    shift(made.woId, b, 40000);
    check(made.woId, b, made.paramId, 28.0);
    db.prepare("UPDATE batches SET coa_no = 'COA/26-27/028', coa_status = 'draft' WHERE id = ?").run(b);
    assert.equal(coaReissueError(b), null);
    // The latest decided check is the one read — the rule a lot's verdict
    // already follows, and the whole reason re-issuing asks again.
    check(made.woId, b, made.paramId, 30.5);
    assert.match(String(coaReissueError(b)), /did not pass/);
  });

  test('an issued certificate is not issued again', () => {
    const { b } = certified('COA/26-27/029');
    assert.match(String(coaReissueError(b)), /has already been issued/);
  });

  test('and a lot under a draft keeps its number, the rule paper already sets', () => {
    const { b } = certified('COA/26-27/030', true);
    assert.match(String(renameError(b, 'B/renamed')), /draft certificate COA\/26-27\/030/);
  });

  /**
   * The two spellings of one rule, over every state a lot can be in.
   *
   * `certifiedSql` answers it for the paged readers — the QC gate and the COA
   * register, which never load a row — and `cleared` answers it in
   * TypeScript. If they part, a draft clears goods in one half of the app and
   * not the other, so this walks the four combinations rather than trusting
   * that two expressions written a file apart say the same thing.
   */
  test('the SQL and the TypeScript halves agree over every state', () => {
    const made = job();
    const states: [string, string][] = [
      ['', ''], ['', 'draft'], ['COA/26-27/031', ''], ['COA/26-27/031', 'draft'],
    ];
    for (const [no, status] of states) {
      const b = batch(made.woId);
      db.prepare('UPDATE batches SET coa_no = ?, coa_status = ? WHERE id = ?').run(no, status, b);
      const sql = db.prepare(
        `SELECT CASE WHEN ${certifiedSql()} THEN 1 ELSE 0 END AS ok FROM batches b WHERE b.id = ?`
      ).get(b) as { ok: number };
      assert.equal(
        Number(sql.ok) === 1, batchById(b)!.cleared,
        `certifiedSql and cleared disagree about coa_no=${JSON.stringify(no)} status=${JSON.stringify(status)}`,
      );
    }
  });
});

/**
 * Correcting a reading, which is what a draft is for.
 *
 * The cases that matter are the two it must **not** refuse — an uncertified
 * lot and one under a draft — because a figure that cannot be put right is
 * the whole complaint this answers, and the one it must: a lot whose
 * certificate has been issued, where everything downstream reads `cleared`
 * rather than the reading behind it.
 */
describe("a lot's readings are corrected while the certificate has gone nowhere", () => {
  /** A made, passed lot, with whatever certificate state is asked for. */
  function lot(no = '', status = '') {
    const made = job();
    const b = batch(made.woId);
    shift(made.woId, b, 40000);
    check(made.woId, b, made.paramId, 28.0);
    if (no) {
      db.prepare(
        "UPDATE batches SET coa_no = ?, coa_date = '2026-10-24', coa_status = ? WHERE id = ?"
      ).run(no, status, b);
    }
    return { ...made, b };
  }

  test('an uncertified lot is free — nothing has been claimed about it yet', () => {
    assert.equal(checkEditError(lot().b), null);
  });

  test('and so is a lot under a draft, which is the case this exists for', () => {
    assert.equal(checkEditError(lot('COA/26-27/040', 'draft').b), null);
  });

  test('an issued certificate refuses it, and names the way through', () => {
    const { b } = lot('COA/26-27/041');
    const refused = String(checkEditError(b));
    assert.match(refused, /COA\/26-27\/041/, 'the sentence hid the certificate it is about');
    assert.match(refused, /Withdraw/, 'refused with no way out — the trap this codebase builds once');
    // And withdrawing it is exactly that way through.
    db.prepare("UPDATE batches SET coa_status = 'draft' WHERE id = ?").run(b);
    assert.equal(checkEditError(b), null);
  });

  test('a lot that is not there says so rather than being quietly allowed', () => {
    assert.match(String(checkEditError(999999)), /not found/);
  });

  /*
   * The reason the issued case is refused at all, stated as a test rather than
   * only in a comment: a reading edited to a failing value leaves the lot
   * still clearing a lorry, because `cleared` reads the number. So the guard
   * is what stands between a corrected figure and goods going out on a
   * certificate its own check no longer supports.
   */
  test('because an issued certificate clears the lot whatever its readings later say', () => {
    const { b, orderId, woId, paramId } = lot('COA/26-27/042');
    assert.equal(despatchBatchError(orderId, [b]), null);
    check(woId, b, paramId, 30.5);
    assert.equal(batchById(b)!.qc, 'failed');
    assert.equal(
      despatchBatchError(orderId, [b]), null,
      'a failing re-inspection stopped the lorry, so the edit guard could be dropped',
    );
  });
});

/**
 * **The extra details a particular buyer asks for** (2026-10-27, the client:
 * *"COA - optional field to be add : Customer may want specific details to be
 * added like Purchase order"*).
 *
 * Mostly about the split between **refusing** and **dropping**, which is
 * `despatchBatchError`'s own rule read for a different shape: a row with
 * nothing in it is the empty pair the form carries the moment somebody presses
 * *add*, so dropping it loses nothing anybody meant — where dropping a label
 * whose value was forgotten would print a certificate missing the very detail
 * it was being added for, with nothing afterwards to say so.
 */
describe('the extra details on a certificate', () => {
  test('a pair is kept, and the stored form reads back as it went in', () => {
    const sent = [{ label: "Customer's PO", value: '4500123456' }];
    assert.equal(coaExtraError(sent), null);
    const stored = cleanCoaExtra(sent);
    assert.deepEqual(parseCoaExtra(stored), sent);
  });

  test('an empty row is dropped rather than refused', () => {
    const sent = [{ label: 'Shelf life', value: '24 months' }, { label: '', value: '' }];
    assert.equal(coaExtraError(sent), null, 'the form\'s own empty row was refused');
    assert.deepEqual(parseCoaExtra(cleanCoaExtra(sent)), [{ label: 'Shelf life', value: '24 months' }]);
  });

  test('...but a half-filled one is refused, not quietly lost', () => {
    assert.match(String(coaExtraError([{ label: 'Shelf life', value: '' }])), /no value/);
    assert.match(String(coaExtraError([{ label: '', value: '24 months' }])), /no label/);
  });

  test('a repeated label is refused — two cells, one name, no answer', () => {
    assert.match(
      String(coaExtraError([{ label: 'PO', value: 'A' }, { label: 'po', value: 'B' }])),
      /named twice/,
      'the same label twice was accepted',
    );
  });

  test('more than the header has room for is refused by the count', () => {
    const many = Array.from({ length: MAX_COA_EXTRA + 1 }, (_, i) => ({ label: `L${i}`, value: `V${i}` }));
    assert.match(String(coaExtraError(many)), new RegExp(`at most ${MAX_COA_EXTRA}`));
    assert.equal(coaExtraError(many.slice(0, MAX_COA_EXTRA)), null, 'the cap itself was refused');
  });

  test('and so is anything that is not a list of details', () => {
    assert.match(String(coaExtraError('Customer PO: 4500123456')), /must be a list/);
    assert.match(String(coaExtraError({ label: 'PO', value: 'A' })), /must be a list/);
    assert.ok(coaExtraError([{ label: 'x'.repeat(61), value: 'v' }]), 'a label too long to print was accepted');
    assert.ok(coaExtraError([{ label: 'L', value: 'v'.repeat(201) }]), 'a value too long to print was accepted');
  });

  /**
   * What is **stored** is data rather than vocabulary — a row hand-written, a
   * backup restored, an older client — so reading it back never throws. A
   * certificate one detail short is survivable; a PDF route answering 500 is
   * not. The rule the permission loader states about a level it does not know.
   */
  test('a stored value that makes no sense reads back as nothing', () => {
    for (const junk of ['', 'not json', '{"label":"x"}', '[]', '[null]', '["PO"]', '[{"value":"v"}]']) {
      assert.deepEqual(parseCoaExtra(junk), [], `${junk} came back as a detail`);
    }
  });

  test('nothing to say is stored as nothing, not as an empty list', () => {
    assert.equal(cleanCoaExtra([]), '', 'a blank column would read as JSON');
    assert.equal(cleanCoaExtra([{ label: '', value: '' }]), '');
  });

  /** Asked by a reader that does not know which of the two it is holding. */
  test('the parse is idempotent, so a parsed row can be asked again', () => {
    const rows = parseCoaExtra(cleanCoaExtra([{ label: 'PO', value: 'A' }]));
    assert.deepEqual(parseCoaExtra(rows), rows);
  });
});
