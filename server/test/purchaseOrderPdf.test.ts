import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildPurchaseOrderPdf } from '../src/services/pdf.js';
import { db } from '../src/db/connection.js';

/**
 * The purchase order is modelled on Aglo's own — `Alternicq-PO-Preform 2925
 * 12GRM .pdf` in `D:\Quotation Doc\` — the way the four selling documents are
 * modelled on their samples in the same folder. What that document states, and
 * in what shape, is the spec; these read the built definition rather than
 * rendering it, like `invoicePdf.test.ts`, which keeps them as fast as the rest.
 */

type Node = Record<string, any>;

/** Every string in the definition, in drawing order. */
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

interface Line {
  description?: string; qty?: number | null; unit?: string; rate?: number;
  tax_pct?: number; amount?: number; packs?: number | null; pcs_per_pack?: number | null;
  material_id?: number | null; product_id?: number | null; total_pcs?: number | null; color?: string; image?: string;
}

let seq = 0;
function makePo(header: Record<string, unknown>, lines: Line[]): number {
  const sup = db.prepare("INSERT INTO suppliers (name, address) VALUES ('Alternicq Polymers', '12 Industrial Road, Kolkata')").run();
  const cols = ['number', 'supplier_id', 'date', 'currency', 'tax_type', 'subtotal', 'tax_total', 'tcs_pct', 'tcs_amount', 'grand_total',
    'attn', 'vendor_ref', 'ship_to', 'inco_terms', 'transport', 'ship_via', 'packing', 'payment_terms', 'notes',
    'bill_to', 'bill_to_gstin', 'ship_to_gstin'];
  const values: Record<string, unknown> = {
    number: `PO/TEST/${++seq}`, supplier_id: Number(sup.lastInsertRowid), date: '2026-09-04',
    currency: 'INR', tax_type: 'igst', subtotal: 0, tax_total: 0, tcs_pct: 0, tcs_amount: 0, grand_total: 0,
    attn: '', vendor_ref: '', ship_to: '', inco_terms: '', transport: '', ship_via: '', packing: '',
    payment_terms: '', notes: '', bill_to: '', bill_to_gstin: '', ship_to_gstin: '', ...header,
  };
  const po = db.prepare(
    `INSERT INTO purchase_orders (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...cols.map((c) => values[c] as never));
  const id = Number(po.lastInsertRowid);
  const ins = db.prepare(
    `INSERT INTO po_items (po_id, material_id, product_id, description, color, image, qty, unit, packs, pcs_per_pack, total_pcs, rate, tax_pct, amount, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  lines.forEach((l, i) => ins.run(
    id, l.material_id ?? null, l.product_id ?? null, l.description ?? '', l.color ?? '', l.image ?? '', l.qty ?? null, l.unit ?? 'kg',
    l.packs ?? null, l.pcs_per_pack ?? null, l.total_pcs ?? null, l.rate ?? 0, l.tax_pct ?? 0, l.amount ?? 0, i
  ));
  return id;
}

const GOODS: Line = { description: '28mm Preform 12gm', qty: 100000, unit: 'unit', packs: 100, pcs_per_pack: 1000, rate: 1.4, tax_pct: 18, amount: 140000 };

describe('what the purchase order states', () => {
  test('it says what it is, and to whom', () => {
    const id = makePo({ attn: 'Mr Sharma', vendor_ref: 'ALT-99', ship_to: 'Aglo Polymers\nJungalpur' }, [GOODS]);
    // Case-insensitively: `lv()` uppercases a boxed cell's label, and which
    // labels shout is a styling decision, not this document's contract.
    const texts = textsOf(buildPurchaseOrderPdf(id)).map((t) => t.toLowerCase());
    for (const want of ['purchase order', 'vendor', 'alternicq polymers', 'ship to', 'jungalpur', 'kind attn', 'mr sharma', 'vendor id', 'alt-99']) {
      assert.ok(texts.some((t) => t.includes(want)), `missing: ${want}`);
    }
  });

  /** The reference document's line table, column for column. */
  test('bill-to and ship-to print with a GSTIN each, the company standing in where blank', () => {
    db.prepare("UPDATE companies SET gstin = '19AAACA0000A1Z5' WHERE id = 1").run();
    const blank = textsOf(buildPurchaseOrderPdf(makePo({}, [GOODS])));
    assert.ok(blank.includes('BILL TO') && blank.includes('SHIP TO'));
    // Three: the letterhead's own, then one standing in on each block.
    assert.equal(blank.filter((t) => t === 'GSTIN: 19AAACA0000A1Z5').length, 3, 'the company GSTIN should stand in on both blocks');
    const typed = textsOf(buildPurchaseOrderPdf(makePo({ bill_to: 'Aglo Packaging\nHaldia', bill_to_gstin: '19BBBBB1111B1Z1', ship_to: 'PACK SKRL', ship_to_gstin: '19CCCCC2222C1Z2' }, [GOODS])));
    assert.ok(typed.includes('Aglo Packaging') && typed.includes('GSTIN: 19BBBBB1111B1Z1'));
    assert.ok(typed.includes('PACK SKRL') && typed.includes('GSTIN: 19CCCCC2222C1Z2'));
  });

  test('the line table is the packing-shaped one', () => {
    const texts = textsOf(buildPurchaseOrderPdf(makePo({}, [GOODS])));
    for (const want of ['DESCRIPTION', 'NO. OF CART./BAGS', 'PCS./KGS. IN CART.', 'TOTAL QUANTITY', 'UNIT PRICE', 'TOTAL']) {
      assert.ok(texts.some((t) => t.includes(want)), `missing column: ${want}`);
    }
    // The banner the proforma draws over its packing columns, here over these.
    assert.ok(texts.includes('QUANTITY'), 'no QUANTITY group banner');
  });

  /**
   * Quantity is pieces on a piece basis (2026-09-20, the client with 19 boxes
   * of 5,000 on the line: "why quantity is showing 95, it should show
   * 95000") — `95 per 1000` is how the line is priced, not how much is
   * bought. A kilo line prints its kilos as before.
   */
  test('a per-1000 line prints its pieces, a kilo line its kilos', () => {
    const pieces = textsOf(buildPurchaseOrderPdf(makePo({}, [
      { description: '28mm Preform 12gm', qty: 95, unit: 'per 1000', packs: 19, pcs_per_pack: 5000, total_pcs: 95000, rate: 1400, tax_pct: 18, amount: 133000 },
    ])));
    assert.ok(pieces.includes('95,000 Pcs'), `expected the piece count, got ${pieces.filter((t) => /Pcs|per 1000/.test(t)).join(' | ')}`);
    assert.ok(!pieces.some((t) => t.includes('95 per 1000')), 'the billing quantity must not print as the quantity');
    // No packing typed: the pieces are still read off the billed figure.
    const bare = textsOf(buildPurchaseOrderPdf(makePo({}, [
      { description: '28mm Preform 12gm', qty: 137.5, unit: 'per 1000', rate: 1400, tax_pct: 18, amount: 192500 },
    ])));
    assert.ok(bare.includes('1,37,500 Pcs'));
    const kilos = textsOf(buildPurchaseOrderPdf(makePo({}, [
      { description: 'HDPE Resin', qty: 1000, unit: 'kg', rate: 85, tax_pct: 18, amount: 85000 },
    ])));
    assert.ok(kilos.includes('1,000 kg'));
  });

  test('a line photo prints as an image cell and the column is absent where none', () => {
    // A 1x1 PNG, the smallest thing pdfmake will accept as an image.
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const doc = buildPurchaseOrderPdf(makePo({}, [{ ...GOODS, image: png }]));
    const withImage = textsOf(doc);
    assert.ok(withImage.includes('IMAGE'));
    assert.ok(JSON.stringify(doc).includes(`"image":"${png}"`), 'the photo should be an image cell, not text');
    const bare = textsOf(buildPurchaseOrderPdf(makePo({}, [GOODS])));
    assert.ok(!bare.includes('IMAGE'), 'an order with no photo must not print an empty column');
  });

  test('the colour prints where stated and the column is absent where not', () => {
    const stated = textsOf(buildPurchaseOrderPdf(makePo({}, [{ ...GOODS, color: 'Natural' }])));
    assert.ok(stated.includes('COLOUR') && stated.includes('Natural'));
    const bare = textsOf(buildPurchaseOrderPdf(makePo({}, [GOODS])));
    assert.ok(!bare.includes('COLOUR'), 'an order stating no colour must not print an empty column');
  });

  /**
   * A column with nothing in it auto-hides, and the banner shrinks with its
   * run — so an order that states no packing must not print an empty header.
   */
  test('an order with no packing prints no packing columns', () => {
    const texts = textsOf(buildPurchaseOrderPdf(makePo({}, [
      { description: 'HDPE Resin', qty: 1000, unit: 'kg', rate: 85, tax_pct: 18, amount: 85000 },
    ])));
    assert.ok(!texts.some((t) => t.includes('NO. OF CART./BAGS')));
    assert.ok(texts.some((t) => t.includes('TOTAL QUANTITY')), 'the quantity itself must stay');
  });
});

describe('how it adds up', () => {
  test('TCS is stated with its rate, and rides into the total', () => {
    const id = makePo(
      { subtotal: 140000, tax_total: 25200, tcs_pct: 0.1, tcs_amount: 165.2, grand_total: 165365 },
      [GOODS]
    );
    const texts = textsOf(buildPurchaseOrderPdf(id));
    assert.ok(texts.some((t) => t.startsWith('TCS @')), 'no TCS row');
    assert.ok(texts.some((t) => t.includes('165.20')), 'the TCS figure is not printed');
  });

  test('IGST at 0.1% on every line is named as the deemed-export concession', () => {
    const id = makePo({ subtotal: 140000, tax_total: 140, grand_total: 140140 }, [{ ...GOODS, tax_pct: 0.1 }]);
    const texts = textsOf(buildPurchaseOrderPdf(id));
    assert.ok(texts.some((t) => t === 'Add IGST @ 0.1% (Deemed Export)'), texts.filter((t) => t.startsWith('Add')).join(' | '));
    // At any other rate the row keeps its plain name.
    const plain = textsOf(buildPurchaseOrderPdf(makePo({ subtotal: 140000, tax_total: 25200, grand_total: 165200 }, [GOODS])));
    assert.ok(plain.some((t) => t === 'Add IGST'));
  });

  /**
   * The rounding line must not absorb TCS. `roundOffOf` knows about freight
   * and insurance and not about this, so the purchase order derives its own —
   * without that, a hundred rupees of tax reads as a rounding difference.
   */
  test('the round-off line is not TCS wearing another name', () => {
    const id = makePo(
      { subtotal: 140000, tax_total: 25200, tcs_pct: 0.1, tcs_amount: 165.2, grand_total: 165365 },
      [GOODS]
    );
    const texts = textsOf(buildPurchaseOrderPdf(id));
    // 140,000 + 25,200 + 165.20 = 165,365.20, rounded to 165,365. The rounding
    // line is therefore 20 paise — the rupee that was dropped, and nothing
    // else. Derived through `roundOffOf`, which knows about freight and not
    // about TCS, it would have read (165.20): the whole of the tax, presented
    // as a rounding difference.
    const roundIdx = texts.findIndex((t) => t.startsWith('Round off'));
    assert.ok(roundIdx >= 0, 'no rounding line');
    assert.equal(texts[roundIdx + 1], '(0.20)');
    // Lakh grouping, because the document is in rupees.
    assert.ok(texts.some((t) => t.includes('1,65,365')), 'the grand total is not printed');
  });

  test('no TCS means no TCS row at all, rather than a zero', () => {
    const id = makePo({ subtotal: 85000, tax_total: 15300, grand_total: 100300 }, [
      { description: 'HDPE Resin', qty: 1000, unit: 'kg', rate: 85, tax_pct: 18, amount: 85000 },
    ]);
    const texts = textsOf(buildPurchaseOrderPdf(id));
    assert.ok(!texts.some((t) => t.startsWith('TCS')));
    assert.ok(texts.some((t) => t.includes('Add IGST')), 'the tax it does carry should still be there');
  });
});
