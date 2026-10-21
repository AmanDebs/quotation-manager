import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { paramsFor, specOwner } from '../src/services/qc.js';
import { buildQcReportPdf, buildInvoiceWithQcPdf, buildInvoicePdf } from '../src/services/pdf.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * The two rules this feature turns on: whose tolerances a job is judged
 * against, and what the report says about it.
 */

let seq = 0;

const makeProduct = () => Number(db.prepare(
  "INSERT INTO products (name, unit) VALUES (?, 'per 1000')"
).run(`Product ${++seq}`).lastInsertRowid);

function addParam(productId: number, customerId: number | null, name: string, min: number, max: number) {
  db.prepare(
    `INSERT INTO product_qc_params (product_id, customer_id, name, kind, unit, min_value, max_value, sort_order)
     VALUES (?, ?, ?, 'numeric', 'mm', ?, ?, 0)`
  ).run(productId, customerId, name, min, max);
}

describe('whose specification applies', () => {
  test('a customer with their own gets theirs, and it replaces the default', () => {
    const p = makeProduct();
    const mine = makeCustomer();
    addParam(p, null, 'Wall thickness', 0.3, 0.5);
    addParam(p, mine, 'Wall thickness', 0.38, 0.42);
    addParam(p, mine, 'Flatness', 0, 0.1);

    const theirs = paramsFor(p, mine);
    // Replaced, not merged: two rows, both theirs. A merge would give three.
    assert.equal(theirs.length, 2);
    assert.equal(theirs[0].min_value, 0.38);
    assert.equal(specOwner(p, mine), 'customer');
  });

  test('a customer without their own falls back to the product’s', () => {
    const p = makeProduct();
    const mine = makeCustomer();
    const other = makeCustomer();
    addParam(p, null, 'Wall thickness', 0.3, 0.5);
    addParam(p, other, 'Wall thickness', 0.38, 0.42);

    const fallback = paramsFor(p, mine);
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].min_value, 0.3);
    assert.equal(specOwner(p, mine), 'default');
  });

  /** One customer's tighter tolerance must not quietly become everybody's. */
  test('and the default is untouched by anyone else’s', () => {
    const p = makeProduct();
    addParam(p, null, 'Wall thickness', 0.3, 0.5);
    addParam(p, makeCustomer(), 'Wall thickness', 0.38, 0.42);

    const base = paramsFor(p);
    assert.equal(base.length, 1);
    assert.equal(base[0].max_value, 0.5);
    assert.equal(specOwner(p), 'default');
  });

  /**
   * The rule qc.ts states twice about itself: no specification is *no opinion*,
   * never "everything passed".
   */
  test('a product nobody has specified has none, for anyone', () => {
    const p = makeProduct();
    assert.deepEqual(paramsFor(p), []);
    assert.deepEqual(paramsFor(p, makeCustomer()), []);
    assert.equal(specOwner(p, makeCustomer()), 'none');
    assert.equal(specOwner(null), 'none');
  });
});

/** A whole chain: order (charge line first), job on the goods line, checks. */
function chain(opts: { customerId?: number; viaProforma?: boolean; withChecks?: boolean } = {}) {
  const customerId = opts.customerId ?? makeCustomer();
  const product = makeProduct();
  addParam(product, null, 'Wall thickness', 0.3, 0.5);

  const orderId = Number(db.prepare(
    "INSERT INTO orders (number, date, customer_id, currency) VALUES (?, '2026-09-05', ?, 'INR')"
  ).run(`SO/T/${++seq}`, customerId).lastInsertRowid);
  // Freight first, so the goods line sits at position 1 — the off-by-one the
  // whole chain's index rule turns on.
  db.prepare(
    "INSERT INTO order_items (order_id, description, is_charge, sort_order) VALUES (?, 'Freight', 1, 0)"
  ).run(orderId);
  db.prepare(
    `INSERT INTO order_items (order_id, product_id, description, qty, unit, is_charge, sort_order)
     VALUES (?, ?, 'Preforms', 10000, 'unit', 0, 1)`
  ).run(orderId, product);

  const woId = Number(db.prepare(
    `INSERT INTO work_orders (number, order_id, order_line, product_id, description, qty_planned, status)
     VALUES (?, ?, 1, ?, 'Preforms', 10000, 'released')`
  ).run(`WO/T/${++seq}`, orderId, product).lastInsertRowid);

  if (opts.withChecks !== false) {
    for (const [shift, value] of [['A', 0.4], ['B', 0.45]] as [string, number][]) {
      const checkId = Number(db.prepare(
        "INSERT INTO qc_checks (work_order_id, date, shift, inspector) VALUES (?, '2026-09-05', ?, 'R. Das')"
      ).run(woId, shift).lastInsertRowid);
      db.prepare(
        `INSERT INTO qc_results (check_id, name, kind, unit, value, min_value, max_value, sort_order)
         VALUES (?, 'Wall thickness', 'numeric', 'mm', ?, 0.3, 0.5, 0)`
      ).run(checkId, value);
    }
  }

  let piId: number | null = null;
  if (opts.viaProforma) {
    piId = Number(db.prepare(
      `INSERT INTO proforma_invoices (number, date, customer_id, currency, order_id)
       VALUES (?, '2026-09-05', ?, 'INR', ?)`
    ).run(`PI/T/${++seq}`, customerId, orderId).lastInsertRowid);
  }
  const invoiceId = Number(db.prepare(
    `INSERT INTO commercial_invoices (number, date, customer_id, currency, order_id, pi_id)
     VALUES (?, '2026-09-05', ?, 'INR', ?, ?)`
  ).run(`AP/T/${++seq}`, customerId, opts.viaProforma ? null : orderId, piId).lastInsertRowid);
  // Billed in the same positions the order uses: freight at 0, goods at 1.
  db.prepare("INSERT INTO invoice_items (invoice_id, description, is_charge, sort_order) VALUES (?, 'Freight', 1, 0)").run(invoiceId);
  db.prepare(
    `INSERT INTO invoice_items (invoice_id, product_id, description, qty, unit, is_charge, sort_order)
     VALUES (?, ?, 'Preforms', 6000, 'unit', 0, 1)`
  ).run(invoiceId, product);

  return { customerId, product, orderId, woId, invoiceId };
}

const textsOf = (node: unknown, out: string[] = []): string[] => {
  if (node == null) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (Array.isArray(node)) { for (const x of node) textsOf(x, out); return out; }
  if (typeof node === 'object') {
    const n = node as Record<string, any>;
    if (typeof n.text === 'string') out.push(n.text);
    for (const k of ['stack', 'columns', 'ul', 'body', 'table', 'content']) if (n[k] !== undefined) textsOf(n[k], out);
  }
  return out;
};

describe('what the report says', () => {
  test('groups the inspections by date and shift', () => {
    const { woId } = chain();
    const texts = textsOf(buildQcReportPdf(woId));
    assert.ok(texts.some((t) => t.includes('Shift A')), 'no shift A heading');
    assert.ok(texts.some((t) => t.includes('Shift B')), 'no shift B heading');
  });

  test('and prints the verdict against the tolerance the reading was judged by', () => {
    const { woId } = chain();
    const texts = textsOf(buildQcReportPdf(woId));
    assert.ok(texts.includes('Pass'), 'no passing reading');
    assert.ok(texts.some((t) => t.includes('0.3 – 0.5')), 'the spec column is missing');
  });

  /** `passed: null` is not a pass — the trap `decorate` exists to avoid. */
  test('a reading nobody took says so rather than passing', () => {
    const { woId } = chain({ withChecks: false });
    const checkId = Number(db.prepare(
      "INSERT INTO qc_checks (work_order_id, date, shift, inspector) VALUES (?, '2026-09-05', 'A', 'R. Das')"
    ).run(woId).lastInsertRowid);
    db.prepare(
      `INSERT INTO qc_results (check_id, name, kind, unit, value, min_value, max_value, sort_order)
       VALUES (?, 'Wall thickness', 'numeric', 'mm', NULL, 0.3, 0.5, 0)`
    ).run(checkId);

    const texts = textsOf(buildQcReportPdf(woId));
    assert.ok(texts.includes('not measured'));
    assert.ok(!texts.includes('Pass'));
  });

  test('says whose specification was applied', () => {
    const { woId, product, customerId } = chain();
    addParam(product, customerId, 'Wall thickness', 0.38, 0.42);
    const texts = textsOf(buildQcReportPdf(woId));
    assert.ok(texts.some((t) => t.startsWith('Specification:') && t.includes('own')), 'does not name the customer');
  });

  test('names the inspector once, over the group, not against every reading', () => {
    /*
     * Removed as a column 2026-10-21 at the client word: it is one fact about
     * the check, so a column repeated the same name against every parameter —
     * nineteen rows of it on a preform — where the reading beside it changes
     * on every line.
     */
    const { woId, product, customerId } = chain();
    addParam(product, customerId, 'Wall thickness', 0.38, 0.42);
    const texts = textsOf(buildQcReportPdf(woId));
    assert.ok(!texts.includes('Inspector'), 'the column heading is back');
    const named = texts.filter((t) => t.includes('R. Das'));
    // One per group — a date and a shift — and never on its own in a cell,
    // which is what a column would have produced.
    assert.ok(named.length > 0, 'the inspector is not named at all');
    assert.ok(named.every((t) => t.includes('Inspected by')), 'the inspector appears outside a heading');
    // ...and the readings keep every column that varies down the page.
    for (const h of ['Parameter', 'Spec', 'Reading', 'Result']) assert.ok(texts.includes(h), h);
  });

  test('but does not list the specification as a table of its own', () => {
    /*
     * Removed 2026-10-21 at the client word: on a preform that table ran to
     * most of a page before a single reading appeared, and every tolerance it
     * stated is already on the row it was judged against. The caption stays,
     * which is what the assertion above holds.
     */
    const { woId, product, customerId } = chain();
    addParam(product, customerId, 'Wall thickness', 0.38, 0.42);
    const texts = textsOf(buildQcReportPdf(woId));
    assert.ok(!texts.includes('Min'), 'the Min/Max listing is back');
    assert.ok(!texts.includes('Max'));
    assert.ok(!texts.includes('Unit'));
    // ...while the readings keep the tolerance each was measured against.
    assert.ok(texts.includes('Spec'), 'the readings lost their Spec column');
  });
});

describe('the Spec column states the window, in full', () => {
  /*
   * Read off the client's own printed report (2026-10-21). This file had its
   * own tolerance formatter beside the certificate's, and it was wrong in two
   * ways visible on that page: a window open at one end, and the unit.
   */

  function withTolerance(min: number | null, max: number | null, unit = 'mm') {
    const { woId } = chain({ withChecks: false });
    const checkId = Number((db.prepare(
      "INSERT INTO qc_checks (work_order_id, date, shift, inspector) VALUES (?, '2026-10-20', 'A', 'Aman') RETURNING id"
    ).get(woId) as { id: number }).id);
    db.prepare(
      `INSERT INTO qc_results (check_id, name, kind, unit, value, min_value, max_value, sort_order)
       VALUES (?, 'Perpendicularity', 'numeric', ?, 0.7, ?, ?, 0)`
    ).run(checkId, unit, min, max);
    return textsOf(buildQcReportPdf(woId));
  }

  test('a window open at the bottom reads as a maximum, not as a missing number', () => {
    const texts = withTolerance(null, 1.5);
    assert.ok(texts.includes('max 1.5 mm'), 'the one-sided tolerance is not named');
    // The shape it used to print, which reads as a negative or a broken range.
    assert.ok(!texts.some((t) => t.trim().startsWith('–')), 'a bare dash is back');
  });

  test('and one open at the top reads as a minimum', () => {
    assert.ok(withTolerance(0.4, null).includes('min 0.4 mm'));
  });

  test('a two-sided window carries its unit, like the reading beside it', () => {
    const texts = withTolerance(9, 11, 'gm');
    assert.ok(texts.includes('9 – 11 gm'), 'the Spec column dropped the unit');
  });

  test('and a pass/fail check states what is allowed rather than a verdict', () => {
    const { woId } = chain({ withChecks: false });
    const checkId = Number((db.prepare(
      "INSERT INTO qc_checks (work_order_id, date, shift, inspector) VALUES (?, '2026-10-20', 'A', 'Aman') RETURNING id"
    ).get(woId) as { id: number }).id);
    db.prepare(
      `INSERT INTO qc_results (check_id, name, kind, unit, value, sort_order)
       VALUES (?, 'Appearance', 'boolean', '', 1, 0)`
    ).run(checkId);
    assert.ok(textsOf(buildQcReportPdf(woId)).includes('pass / fail'));
  });
});

describe('the three blocks the client certificate prints', () => {
  /*
   * Aglo own 48mm cap certificate (2026-10-21, *"The format should be like
   * this"*) prints Visual, Dimensional and Fitment as separate tables of
   * different shapes. These hold the two halves that could go silently wrong:
   * a specification that says nothing must print exactly as it always did,
   * and a result must keep the block it was issued under however the
   * specification is re-sectioned afterwards.
   */

  /** A check on this job, with one reading per parameter given. */
  function record(woId: number, rows: { name: string; section: string; kind?: string; value: number | null; na?: number }[]) {
    const checkId = Number(db.prepare(
      "INSERT INTO qc_checks (work_order_id, date, shift, inspector) VALUES (?, '2026-10-20', 'A', 'Aman')"
    ).run(woId).lastInsertRowid);
    rows.forEach((r, i) => {
      db.prepare(
        `INSERT INTO qc_results (check_id, name, kind, section, unit, value, value_max, na, min_value, max_value, sort_order)
         VALUES (?, ?, ?, ?, 'mm', ?, NULL, ?, 0.3, 0.5, ?)`
      ).run(checkId, r.name, r.kind ?? 'numeric', r.section, r.value, r.na ?? 0, i);
    });
    return checkId;
  }

  test('an unsectioned specification prints the single table it always did', () => {
    const { woId } = chain();
    const texts = textsOf(buildQcReportPdf(woId));
    // The flat shape, and none of the three headings.
    assert.ok(texts.includes('Reading'), 'the flat table is gone');
    for (const h of ['VISUAL CHECKS', 'DIMENSIONAL CHECKS', 'FITMENT CHECK']) {
      assert.ok(!texts.includes(h), h);
    }
  });

  test('and a sectioned one prints a block per section, in the paper order', () => {
    const { woId } = chain({ withChecks: false });
    record(woId, [
      { name: 'Short Molding', section: 'visual', kind: 'boolean', value: 1 },
      { name: 'Closure O/D', section: 'dimensional', value: 0.4 },
      { name: 'TE Band', section: 'fitment', kind: 'boolean', value: 1 },
    ]);
    const texts = textsOf(buildQcReportPdf(woId));
    const at = (t: string) => texts.indexOf(t);
    assert.ok(at('VISUAL CHECKS') >= 0 && at('DIMENSIONAL CHECKS') >= 0 && at('FITMENT CHECK') >= 0);
    assert.ok(at('VISUAL CHECKS') < at('DIMENSIONAL CHECKS'), 'visual is not first');
    assert.ok(at('DIMENSIONAL CHECKS') < at('FITMENT CHECK'), 'fitment is not last');
    // The dimensional block alone carries the two-row banner.
    assert.ok(texts.includes('Specification') && texts.includes('Actual'));
    assert.ok(texts.filter((t) => t === 'Minimum').length === 2, 'the Min columns are not a pair');
  });

  test('a reading the specification did not place is named, never dropped', () => {
    /* Silently leaving a recorded reading off a certificate is the one
       failure this cannot have, so an unplaced row gets its own block. */
    const { woId } = chain({ withChecks: false });
    record(woId, [
      { name: 'Closure O/D', section: 'dimensional', value: 0.4 },
      { name: 'Something nobody sectioned', section: '', value: 0.35 },
    ]);
    const texts = textsOf(buildQcReportPdf(woId));
    assert.ok(texts.includes('OTHER CHECKS'));
    assert.ok(texts.includes('Something nobody sectioned'));
  });

  test('the verdict is derived from the readings, and says so when nothing was decided', () => {
    const { woId } = chain({ withChecks: false });
    record(woId, [{ name: 'Closure O/D', section: 'dimensional', value: 0.4 }]);
    assert.ok(textsOf(buildQcReportPdf(woId)).includes('QC PASSED'));

    const fail = chain({ withChecks: false });
    record(fail.woId, [{ name: 'Closure O/D', section: 'dimensional', value: 9 }]);
    assert.ok(textsOf(buildQcReportPdf(fail.woId)).includes('QC FAILED'));

    const none = chain({ withChecks: false });
    record(none.woId, [{ name: 'Closure O/D', section: 'dimensional', value: null, na: 1 }]);
    const texts = textsOf(buildQcReportPdf(none.woId));
    assert.ok(texts.includes('NOT YET DECIDED'), 'an N/A was read as a pass');
    assert.ok(!texts.includes('QC PASSED'));
  });

  test('a single reading has no maximum observed, and says so rather than repeating itself', () => {
    /* Printing the same figure in both Actual cells would claim a range
       nobody took — the em-dash is the absence it actually is. */
    const { woId } = chain({ withChecks: false });
    record(woId, [{ name: 'Closure O/D', section: 'dimensional', value: 0.4 }]);
    const texts = textsOf(buildQcReportPdf(woId));
    assert.equal(texts.filter((t) => t === '0.4 mm').length, 1, 'the reading is printed twice');
    assert.ok(texts.includes('\u2014'), 'the empty Maximum cell is blank rather than dashed');
  });
});

describe('the invoice’s own quality summary', () => {
  test('finds the jobs through the order', () => {
    const { invoiceId } = chain();
    const texts = textsOf(buildInvoiceWithQcPdf(invoiceId));
    assert.ok(texts.includes('QUALITY REPORT'), 'the QC half is missing');
  });

  /** The invoice may reach its order only through the proforma that carries it. */
  test('and through a proforma when that is the only link', () => {
    const { invoiceId } = chain({ viaProforma: true });
    const texts = textsOf(buildInvoiceWithQcPdf(invoiceId));
    assert.ok(texts.includes('QUALITY REPORT'), 'the proforma route was not walked');
  });

  /**
   * The packing list's behaviour, deliberately copied: nothing to say means
   * the invoice alone, not an invoice followed by a page saying nothing.
   */
  test('degrades to the invoice alone when no check has been recorded', () => {
    const { invoiceId } = chain({ withChecks: false });
    const combined = textsOf(buildInvoiceWithQcPdf(invoiceId));
    assert.ok(!combined.includes('QUALITY REPORT'));
    assert.deepEqual(combined, textsOf(buildInvoicePdf(invoiceId)));
  });
});
