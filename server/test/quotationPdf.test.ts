import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuotationPdf } from '../src/services/pdf.js';
import { db } from '../src/db/connection.js';
import { makeCustomer } from './helpers/factory.js';
import { assertFits, itemsTable } from './helpers/pdfFit.js';

/**
 * The delivery basis and the load print on the quotation, and print wherever
 * the money does not (2026-09-25, the client with both boxes filled: *"These
 * two are not getting captured in the PDF print for quotation"*).
 *
 * They used to reach the page only inside the grand total's own label —
 * *TOTAL PRICE IN FOB (1 X 40FT HC)* — which is gated on `showMoney`, so a
 * quotation sent as a rate-and-packing price list (Amount hidden) or one
 * carrying no quantities printed neither anywhere. Both fields are mandatory
 * on that form, which is what makes the gap worth a test of its own: a field
 * the app refuses to let you leave blank has to reach the paper.
 *
 * Reads the document definition like `orderPdf.test.ts`; nothing renders here.
 */

/** Every string in the definition, flattened — the page as the eye reads it. */
function textOf(def: any): string {
  const out: string[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n.text === 'string') out.push(n.text);
    else if (Array.isArray(n.text)) walk(n.text);
    for (const k of ['stack', 'columns', 'content', 'table', 'body']) if (n[k]) walk(n[k]);
  };
  walk(def.content);
  return out.join(' | ');
}

/** A 1x1 PNG, so the photo column is drawn without carrying a fixture file. */
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let seq = 0;

function makeQuotation(over: Record<string, unknown> = {}, qty: number | null = 25.2): number {
  const customerId = makeCustomer(`Quotation PDF ${++seq}`);
  const cols: string[] = ['number', 'revision', 'date', 'customer_id', 'company_id', 'currency', 'tax_type', 'is_export', 'status'];
  const vals: unknown[] = [`QT/PDF/${seq}`, 0, '2026-09-20', customerId, 1, 'USD', 'none', 1, 'draft'];
  // Overriding a column the base list already names replaces its value rather
  // than naming it twice: `INSERT INTO quotations (… is_export …, is_export)`
  // takes the first, so an override of `tax_type` or `is_export` was silently
  // ignored — which is how the domestic shape below first tested as an export
  // one and passed against widths that did not fit.
  for (const [k, v] of Object.entries(over)) {
    const at = cols.indexOf(k);
    if (at >= 0) vals[at] = v;
    else { cols.push(k); vals.push(v); }
  }
  const id = Number(db.prepare(
    `INSERT INTO quotations (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...(vals as never[])).lastInsertRowid);
  db.prepare(
    `INSERT INTO quotation_items (quotation_id, description, color, qty, unit, unit_price, amount, total_pcs, packs, pcs_per_pack, sort_order)
     VALUES (?, '48mm Seal Cap', 'Red', ?, 'per 1000', 26, ?, 25200, 10, 2520, 0)`
  ).run(id, qty, qty == null ? 0 : 655.2);
  return id;
}

describe('the basis and the load on a quotation', () => {
  test('both are stated in the header block', async () => {
    const def = await buildQuotationPdf(
      makeQuotation({ inco_terms: 'FOB', container_count: '1 X 40FT HC' })
    ) as any;
    const t = textOf(def);
    assert.match(t, /INCO Terms:/);
    assert.match(t, /\bFOB\b/);
    assert.match(t, /Containers:/);
    assert.match(t, /1 X 40FT HC/);
  });

  /*
   * The case that started this. The band carrying the basis is gated on the
   * amounts being shown, so a price list dropped both fields off the page
   * entirely — while the form went on refusing to save without them.
   */
  test('and on a price list, where the money band is not printed at all', async () => {
    const def = await buildQuotationPdf(makeQuotation({
      inco_terms: 'FOB',
      container_count: '1 X 40FT HC',
      column_config: JSON.stringify({ hidden: ['amount'], custom: [] }),
    })) as any;
    const t = textOf(def);
    assert.ok(!/TOTAL PRICE/.test(t), 'the money band is deliberately absent');
    assert.match(t, /INCO Terms:/);
    assert.match(t, /1 X 40FT HC/);
  });

  test('and on a quotation carrying no quantities', async () => {
    const def = await buildQuotationPdf(
      makeQuotation({ inco_terms: 'EX-Works', container_count: '' }, null)
    ) as any;
    const t = textOf(def);
    assert.match(t, /Quantities to be confirmed/, 'the price-only note still prints');
    assert.match(t, /INCO Terms:/);
    assert.match(t, /EX-Works/);
  });

  /** The basis still qualifies the figure — the Sanya sample's own line. */
  test('the grand total names the basis, and no longer repeats the load', async () => {
    const def = await buildQuotationPdf(
      makeQuotation({ inco_terms: 'FOB', container_count: '1 X 40FT HC' })
    ) as any;
    const t = textOf(def);
    assert.match(t, /TOTAL PRICE IN FOB/);
    assert.ok(!/TOTAL PRICE IN FOB \(/.test(t), 'the container is stated once, in the header');
    assert.equal((t.match(/1 X 40FT HC/g) ?? []).length, 1);
  });

  /** A field the document does not carry prints no row, not a blank one. */
  test('a quotation stating neither prints neither row, and reads GRAND TOTAL', async () => {
    const def = await buildQuotationPdf(makeQuotation()) as any;
    const t = textOf(def);
    assert.ok(!/INCO Terms:/.test(t));
    assert.ok(!/Containers:/.test(t));
    assert.match(t, /GRAND TOTAL/);
  });
});


/**
 * The items table has to fit between the margins, and nothing renders here to
 * say whether it does — so this asserts the arithmetic that decides it
 * (2026-09-29, the client: *"alignment is not coming properly"*). The rule and
 * the figures behind it live in `helpers/pdfFit.ts`, which `orderPdf.test.ts`
 * is held to as well — two copies of that arithmetic is how the two would come
 * to disagree about the same page.
 */
describe('the items table fits the page', () => {
  test('a domestic quotation, which carries the most columns', () => {
    assertFits(
      buildQuotationPdf(makeQuotation({ tax_type: 'igst', is_export: 0, currency: 'INR' })),
      'domestic quotation'
    );
  });

  /** The tightest shape that still has to fit: the photo column costs 46pt. */
  test('an export quotation carrying line photos', () => {
    const id = makeQuotation({ tax_type: 'none', is_export: 1 });
    db.prepare('UPDATE quotation_items SET image = ? WHERE quotation_id = ?').run(PIXEL, id);
    const def = buildQuotationPdf(id);
    assert.equal(itemsTable(def).widths.length, 10, 'the photo column is drawn');
    assertFits(def, 'export quotation with photos');
  });

  /**
   * The header block's two halves must not touch. pdfmake's default gap is 0,
   * which put the buyer's address 4pt from *"Payment Terms:"* — measured on
   * the client's own quotation, where the two read as one line of running
   * text. The value is a judgement; having one at all is the rule.
   */
  test('and the two halves of the header block are held apart', () => {
    const def = buildQuotationPdf(makeQuotation()) as any;
    const meta = (def.content as any[]).find((n) => Array.isArray(n?.columns) && n.columns.length === 2 && n.columns[0]?.table);
    assert.ok(meta, 'no two-column header block');
    assert.ok(meta.columnGap > 0, 'the buyer block would run into the offer block');
  });
});
