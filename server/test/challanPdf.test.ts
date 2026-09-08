import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { buildDeliveryChallanPdf } from '../src/services/pdf.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * The document that travels with the lorry.
 *
 * Its figures are the interesting part: nothing on a challan is stored, so the
 * quantities come from the despatch and the description, HSN, rate and tax
 * rate from the order line at the same position. These build the definition
 * and read it, like `invoicePdf.test.ts`; they do not render.
 */

type Node = Record<string, any>;

const cellText = (c: any): string => {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (typeof c.text === 'string') return c.text;
  if (Array.isArray(c.text)) return c.text.map(cellText).join('');
  if (c.stack) return c.stack.map(cellText).join('\n');
  return '';
};

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

/** The items table's rows, found by its header rather than by its size. */
function itemRows(id: number): string[][] {
  const content = buildDeliveryChallanPdf(id).content as Node[];
  const items = content
    .filter((n) => n && typeof n === 'object' && n.table)
    .find((t) => t.table.body.some((row: any[]) => row.some((c) => /Description of Goods/.test(cellText(c)))));
  assert.ok(items, 'no items table on the challan');
  return items.table.body.map((row: any[]) => row.map(cellText).filter(Boolean));
}

let seq = 0;

interface LineInput {
  description: string; unit?: string; unit_price?: number; tax_pct?: number;
  total_pcs?: number | null; pcs_per_pack?: number | null; hsn_code?: string; is_charge?: number;
}

function orderWith(taxType: string, currency: string, lines: LineInput[]): number {
  const id = (db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status, destination, po_number)
     VALUES (?, '2026-09-01', ?, 1, ?, ?, 'confirmed', 'Hazipur', 'PO-77') RETURNING id`
  ).get(`SO/DC-${++seq}`, makeCustomer(`Buyer ${seq}`), currency, taxType) as { id: number }).id;
  lines.forEach((l, i) => db.prepare(
    `INSERT INTO order_items (order_id, description, qty, unit, unit_price, tax_pct, amount,
                              total_pcs, pcs_per_pack, hsn_code, is_charge, sort_order)
     VALUES (?, ?, NULL, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
  ).run(id, l.description, l.unit ?? 'per 1000', l.unit_price ?? 10, l.tax_pct ?? 18,
    l.total_pcs ?? null, l.pcs_per_pack ?? null, l.hsn_code ?? '', l.is_charge ?? 0, i));
  return id;
}

const tripFor = (orderId: number, lines: { order_line: number; qty?: number | null; packs?: number | null }[],
  extra: { challan_no?: string; cn_no?: string } = {}) => {
  const id = (db.prepare(
    `INSERT INTO despatches (order_id, date, destination, challan_no, cn_no)
     VALUES (?, '2026-09-05', 'Hazipur', ?, ?) RETURNING id`
  ).get(orderId, extra.challan_no ?? `DC/26-27/${String(++seq).padStart(3, '0')}`, extra.cn_no ?? '') as { id: number }).id;
  lines.forEach((l, i) => db.prepare(
    'INSERT INTO despatch_items (despatch_id, order_line, qty, packs, sort_order) VALUES (?, ?, ?, ?, ?)'
  ).run(id, l.order_line, l.qty ?? null, l.packs ?? null, i));
  return id;
};

describe('what the challan states about the goods', () => {
  test('the physical pieces, not the billing basis', () => {
    const o = orderWith('igst', 'INR', [{ description: '29/21 Cap', total_pcs: 176000, pcs_per_pack: 800, hsn_code: '3923' }]);
    const rows = itemRows(tripFor(o, [{ order_line: 0, qty: 80000, packs: 100 }])).map((r) => r.join(' | '));
    const joined = rows.join('\n');
    // A challan describes goods on a lorry: "80 per 1000" is a basis, not a
    // count of anything, so the piece figure is what is printed.
    assert.ok(/80,000 pcs/.test(joined), `expected the pieces, got:\n${joined}`);
    assert.ok(!/\b80 per 1000\b/.test(joined), `the billing quantity was printed:\n${joined}`);
    assert.ok(/3923/.test(joined), 'the HSN code should ride along from the order line');
  });

  /** 80,000 at ₹10 per 1000 is ₹800, and 18% of that is ₹144. */
  test('the value is the despatched quantity at the order line’s own rate', () => {
    const o = orderWith('igst', 'INR', [{ description: '29/21 Cap', unit_price: 10, total_pcs: 176000 }]);
    const joined = itemRows(tripFor(o, [{ order_line: 0, qty: 80000 }])).map((r) => r.join(' | ')).join('\n');
    assert.ok(/TAXABLE VALUE \| ₹800\.00/.test(joined), joined);
    assert.ok(/Add IGST \| ₹144\.00/.test(joined), joined);
    assert.ok(/TOTAL VALUE OF GOODS[^\n]*₹944\.00/.test(joined), joined);
  });

  test('CGST and SGST are stated as halves on an intra-state movement', () => {
    const o = orderWith('cgst_sgst', 'INR', [{ description: 'Cap', unit_price: 10, total_pcs: 176000 }]);
    const joined = itemRows(tripFor(o, [{ order_line: 0, qty: 80000 }])).map((r) => r.join(' | ')).join('\n');
    assert.ok(/Add CGST \| ₹72\.00/.test(joined), joined);
    assert.ok(/Add SGST \| ₹72\.00/.test(joined), joined);
  });

  /** Zero-rated, so there is no tax row and no Tax % column to put one in. */
  test('an export movement states a value and no tax', () => {
    const o = orderWith('none', 'EUR', [{ description: 'Cap', unit_price: 10, total_pcs: 176000 }]);
    const joined = itemRows(tripFor(o, [{ order_line: 0, qty: 120000 }])).map((r) => r.join(' | ')).join('\n');
    assert.ok(/€1,200\.00/.test(joined), joined);
    assert.ok(!/IGST|CGST|SGST|Tax %/.test(joined), `an export challan carried tax:\n${joined}`);
  });

  /**
   * The rounding this document would otherwise appear to get wrong: INR grand
   * totals go to the whole rupee, so 480 + 86.40 prints as 566 and needs the
   * difference stated or it reads as an arithmetic error.
   */
  test('the round-off is shown when the rupee total has one', () => {
    const o = orderWith('igst', 'INR', [{ description: 'Seal Cap', unit_price: 12, total_pcs: 70000 }]);
    const joined = itemRows(tripFor(o, [{ order_line: 0, qty: 40000 }])).map((r) => r.join(' | ')).join('\n');
    assert.ok(/Add IGST \| ₹86\.40/.test(joined), joined);
    assert.ok(/Round off/.test(joined), `480 + 86.40 printed as 566 with nothing to explain it:\n${joined}`);
  });

  test('a charge line never ships, so it is not on the challan', () => {
    const o = orderWith('igst', 'INR', [
      { description: 'Cap', unit_price: 10, total_pcs: 176000 },
      { description: 'Freight', unit: 'unit', unit_price: 5000, is_charge: 1 },
    ]);
    const joined = itemRows(tripFor(o, [
      { order_line: 0, qty: 80000 }, { order_line: 1, qty: 1 },
    ])).map((r) => r.join(' | ')).join('\n');
    assert.ok(!/Freight/.test(joined), `a charge line was despatched:\n${joined}`);
    assert.ok(/TAXABLE VALUE \| ₹800\.00/.test(joined), 'the freight was priced into the goods');
  });
});

describe('how the challan identifies itself', () => {
  const withNumbers = (challan: string, cn: string) => {
    const o = orderWith('igst', 'INR', [{ description: 'Cap', total_pcs: 176000 }]);
    return textsOf(buildDeliveryChallanPdf(tripFor(o, [{ order_line: 0, qty: 80000 }], { challan_no: challan, cn_no: cn })));
  };

  test('by its own number', () => {
    assert.ok(withNumbers('DC/26-27/001', 'LR-4471').some((t) => t.includes('DC/26-27/001')));
  });

  /**
   * A trip recorded before this document existed has no challan number. Its
   * consignment note is the reference it does have, and printing that beats an
   * empty box on a document whose whole point is to be serially numbered.
   */
  test('and by its consignment note when it predates the series', () => {
    const texts = withNumbers('', 'LR-4488');
    assert.ok(texts.some((t) => t.includes('LR-4488')), 'nothing identified the challan');
  });

  /**
   * `registrationLine` keeps the GSTIN off an export document, because an
   * export *sale* is zero-rated and the buyer is abroad. A challan describes a
   * movement that begins in India whichever way the lorry is pointed, so the
   * consigner's registration belongs on it either way.
   */
  test('the consigner’s GSTIN is printed even on an export movement', () => {
    db.prepare("UPDATE companies SET gstin = '19AABCD1234F1Z5' WHERE id = 1").run();
    const o = orderWith('none', 'EUR', [{ description: 'Cap', total_pcs: 176000 }]);
    const texts = textsOf(buildDeliveryChallanPdf(tripFor(o, [{ order_line: 0, qty: 80000 }])));
    assert.ok(texts.some((t) => t.includes('19AABCD1234F1Z5')), 'the challan dropped our own GSTIN');
  });

  test('it says so when the goods have gone out unbilled', () => {
    const o = orderWith('igst', 'INR', [{ description: 'Cap', total_pcs: 176000 }]);
    const texts = textsOf(buildDeliveryChallanPdf(tripFor(o, [{ order_line: 0, qty: 80000 }])));
    assert.ok(texts.some((t) => /Not yet billed/.test(t)), 'no invoice reference either way');
  });
});
