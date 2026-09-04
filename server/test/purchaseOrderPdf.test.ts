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
  material_id?: number | null; product_id?: number | null;
}

let seq = 0;
function makePo(header: Record<string, unknown>, lines: Line[]): number {
  const sup = db.prepare("INSERT INTO suppliers (name, address) VALUES ('Alternicq Polymers', '12 Industrial Road, Kolkata')").run();
  const cols = ['number', 'supplier_id', 'date', 'currency', 'tax_type', 'subtotal', 'tax_total', 'tcs_pct', 'tcs_amount', 'grand_total',
    'attn', 'vendor_ref', 'ship_to', 'inco_terms', 'transport', 'ship_via', 'packing', 'payment_terms', 'notes'];
  const values: Record<string, unknown> = {
    number: `PO/TEST/${++seq}`, supplier_id: Number(sup.lastInsertRowid), date: '2026-09-04',
    currency: 'INR', tax_type: 'igst', subtotal: 0, tax_total: 0, tcs_pct: 0, tcs_amount: 0, grand_total: 0,
    attn: '', vendor_ref: '', ship_to: '', inco_terms: '', transport: '', ship_via: '', packing: '',
    payment_terms: '', notes: '', ...header,
  };
  const po = db.prepare(
    `INSERT INTO purchase_orders (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...cols.map((c) => values[c] as never));
  const id = Number(po.lastInsertRowid);
  const ins = db.prepare(
    `INSERT INTO po_items (po_id, material_id, product_id, description, qty, unit, packs, pcs_per_pack, rate, tax_pct, amount, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  lines.forEach((l, i) => ins.run(
    id, l.material_id ?? null, l.product_id ?? null, l.description ?? '', l.qty ?? null, l.unit ?? 'kg',
    l.packs ?? null, l.pcs_per_pack ?? null, l.rate ?? 0, l.tax_pct ?? 0, l.amount ?? 0, i
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
  test('the line table is the packing-shaped one', () => {
    const texts = textsOf(buildPurchaseOrderPdf(makePo({}, [GOODS])));
    for (const want of ['DESCRIPTION', 'NO. OF CART./BAGS', 'PCS./KGS. IN CART.', 'TOTAL QUANTITY', 'UNIT PRICE', 'TOTAL']) {
      assert.ok(texts.some((t) => t.includes(want)), `missing column: ${want}`);
    }
    // The banner the proforma draws over its packing columns, here over these.
    assert.ok(texts.includes('QUANTITY'), 'no QUANTITY group banner');
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
