import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import {
  buildQuotationPdf, buildProformaPdf, buildOrderPdf, buildPurchaseOrderPdf,
} from '../src/services/pdf.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * A deemed export names itself on the paper (2026-09-24, the client: *"Add
 * this deemed export also in quotation and proforma"*, the concession having
 * been built for the purchase order on 2026-09-20).
 *
 * The rule under all of this is that **it is not a stored tax type**: every one
 * of these tables carries a CHECK naming three and SQLite cannot ALTER one, so
 * the picker offers a *preset* — IGST with every line at 0.1% — and the page
 * reads it back from the lines. Which makes the interesting cases the ones
 * where it must **not** be claimed: the document says 0.1% only while its lines
 * do, and nothing stored can assert otherwise.
 */

type Node = Record<string, unknown>;

function textsOf(node: unknown, out: string[] = []): string[] {
  if (node == null) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (Array.isArray(node)) { for (const n of node) textsOf(n, out); return out; }
  if (typeof node === 'object') {
    const n = node as Node;
    if (typeof n.text === 'string') out.push(n.text);
    for (const k of ['stack', 'columns', 'ul', 'body', 'table', 'content']) {
      if (n[k] !== undefined) textsOf(n[k], out);
    }
  }
  return out;
}

const customerId = makeCustomer('Merchant Exporter Pvt Ltd');
let seq = 0;

interface Line { pct: number; pcs?: number }

/** A goods line at a stated rate. 1,00,000 pieces at ₹1.40 per 1000 = ₹140. */
const line = (pct: number) => ({ pct });

/**
 * One document of each selling kind, with its lines and the totals the server
 * would have stamped on it. Written out rather than run through `computeTotals`
 * because what is under test is how the page *reads* the lines, not the
 * arithmetic — `totals.test.ts` owns that.
 */
function makeDoc(kind: 'quotation' | 'proforma' | 'order', taxType: string, lines: Line[]) {
  const n = ++seq;
  const subtotal = 140000 * lines.length;
  // Each line's own rate, so a mixed-rate fixture carries a figure that is
  // actually its own — the label is what is under test, but a total that does
  // not add up is a fixture somebody would later read as a rule.
  const taxTotal = taxType === 'none' ? 0 : round(lines.reduce((a, l) => a + 140000 * l.pct / 100, 0));
  const table = { quotation: 'quotations', proforma: 'proforma_invoices', order: 'orders' }[kind];
  const items = { quotation: 'quotation_items', proforma: 'pi_items', order: 'order_items' }[kind];
  const fk = { quotation: 'quotation_id', proforma: 'pi_id', order: 'order_id' }[kind];

  const id = Number((db.prepare(
    `INSERT INTO ${table} (number, date, customer_id, company_id, currency, tax_type,
                           subtotal, tax_total, grand_total)
     VALUES (?, '2026-09-24', ?, 1, 'INR', ?, ?, ?, ?) RETURNING id`
  ).get(`${kind.toUpperCase()}/${n}`, customerId, taxType, subtotal, taxTotal, subtotal + taxTotal) as { id: number }).id);

  lines.forEach((l, i) => {
    db.prepare(
      `INSERT INTO ${items} (${fk}, description, color, qty, unit, unit_price, tax_pct, amount, total_pcs, is_charge, sort_order)
       VALUES (?, 'Preform 29/21', 'Natural', 100, 'per 1000', 1.4, ?, 140000, ?, 0, ?)`
    ).run(id, l.pct, (l.pcs ?? 100000), i);
  });
  return id;
}

const round = (n: number) => Math.round(n * 100) / 100;

const build = {
  quotation: buildQuotationPdf,
  proforma: buildProformaPdf,
  order: buildOrderPdf,
};

/** The tax line the document prints, or '' where it prints none. */
function taxLine(kind: 'quotation' | 'proforma' | 'order', taxType: string, lines: Line[]): string {
  const texts = textsOf(build[kind](makeDoc(kind, taxType, lines)));
  return texts.find((t) => t.startsWith('Add IGST') || t.startsWith('Add CGST')) ?? '';
}

describe('a deemed export names itself', () => {
  for (const kind of ['quotation', 'proforma', 'order'] as const) {
    test(`on the ${kind}`, () => {
      assert.equal(taxLine(kind, 'igst', [line(0.1), line(0.1)]), 'Add IGST @ 0.1% (Deemed Export)');
    });
  }

  test('and on the purchase order it was built for', () => {
    // Left as its own case rather than folded in: that builder now reads the
    // shared rule, and this is what says the refactor kept its behaviour.
    const sup = Number((db.prepare(
      "INSERT INTO suppliers (name) VALUES ('Merchant Exporter Pvt Ltd') RETURNING id"
    ).get() as { id: number }).id);
    const po = Number((db.prepare(
      `INSERT INTO purchase_orders (number, date, supplier_id, company_id, currency, tax_type,
                                    subtotal, tax_total, grand_total)
       VALUES ('PO/DE', '2026-09-24', ?, 1, 'INR', 'igst', 140000, 140, 140140) RETURNING id`
    ).get(sup) as { id: number }).id);
    db.prepare(
      `INSERT INTO po_items (po_id, description, qty, unit, rate, tax_pct, amount, sort_order)
       VALUES (?, 'Preform', 100, 'kg', 1400, 0.1, 140000, 0)`
    ).run(po);
    assert.ok(textsOf(buildPurchaseOrderPdf(po)).some((t) => t === 'Add IGST @ 0.1% (Deemed Export)'));
  });
});

describe('and says nothing of the sort otherwise', () => {
  test('an ordinary IGST document keeps the plain row', () => {
    for (const kind of ['quotation', 'proforma', 'order'] as const) {
      assert.equal(taxLine(kind, 'igst', [line(18)]), 'Add IGST', kind);
    }
  });

  /**
   * The conservative direction, and the one worth stating: a document where
   * one line is at 18% is not uniformly concessional, so the page declines to
   * name the concession rather than claiming it over a line not carrying it.
   * It is also what makes the preset honest — typing a rate back is how the
   * claim is withdrawn, and the paper follows the lines without being told.
   */
  test('one line at another rate withdraws the claim', () => {
    assert.equal(taxLine('quotation', 'igst', [line(0.1), line(18)]), 'Add IGST');
  });

  /**
   * `every` over an empty list is vacuously true, so a document with no lines
   * would read as a deemed export on the strength of having nothing in it.
   */
  test('a document with no lines is not one', () => {
    const id = makeDoc('quotation', 'igst', []);
    db.prepare('UPDATE quotations SET tax_total = 140, grand_total = 140140 WHERE id = ?').run(id);
    const texts = textsOf(buildQuotationPdf(id));
    assert.ok(!texts.some((t) => t.includes('Deemed Export')), texts.filter((t) => t.startsWith('Add')).join(' | '));
  });

  test('the concessional rate under CGST + SGST is still CGST + SGST', () => {
    // The concession is an IGST one; the rate alone does not make it.
    const texts = textsOf(buildProformaPdf(makeDoc('proforma', 'cgst_sgst', [line(0.1)])));
    assert.ok(texts.some((t) => t === 'Add CGST'));
    assert.ok(!texts.some((t) => t.includes('Deemed Export')));
  });

  test('an export document prints no tax row at all, as before', () => {
    const texts = textsOf(buildProformaPdf(makeDoc('proforma', 'none', [line(0.1)])));
    assert.ok(!texts.some((t) => t.startsWith('Add IGST') || t.startsWith('Add CGST')));
  });
});
