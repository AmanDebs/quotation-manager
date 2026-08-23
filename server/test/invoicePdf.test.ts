import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoicePdf } from '../src/services/pdf.js';
import { db } from '../src/db/connection.js';
import { makeCustomer, makeInvoice, makePayment } from './helpers/factory.js';

/**
 * The invoice's money rides *inside* the items table, as it does on the
 * proforma, rather than in floating bands below it. Those bands are taller
 * than a table row and each carried its own margin, which cost about a third
 * of an inch on every invoice.
 *
 * A layout change like that regresses silently — nothing throws, the figures
 * stay right, the page just grows again — so it is worth a test. These build
 * the document definition and read it; they do not render, which keeps them
 * as fast as the rest.
 */

type Node = Record<string, any>;

interface ItemInput {
  description: string; hsn_code?: string; qty?: number | null; unit?: string;
  unit_price?: number; tax_pct?: number; amount?: number;
  packs?: number | null; total_pcs?: number | null; is_charge?: number; sort_order?: number;
}

const addItem = (invoiceId: number, it: ItemInput) => {
  db.prepare(
    `INSERT INTO invoice_items (invoice_id, description, hsn_code, qty, unit, unit_price, tax_pct,
                                amount, packs, total_pcs, is_charge, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(invoiceId, it.description, it.hsn_code ?? '', it.qty ?? null, it.unit ?? 'pcs',
    it.unit_price ?? 0, it.tax_pct ?? 0, it.amount ?? 0, it.packs ?? null,
    it.total_pcs ?? null, it.is_charge ?? 0, it.sort_order ?? 0);
};

const cellText = (c: any): string => {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (typeof c.text === 'string') return c.text;
  if (Array.isArray(c.text)) return c.text.map(cellText).join('');
  return '';
};

/**
 * The rows of the items table, found by its header rather than by its size.
 *
 * "The biggest table" was the first attempt and it picked the boxed customs
 * grid instead, which on an export invoice has about as many rows and whose
 * cells hold nested stacks rather than text — so the test read six blank rows
 * and failed on the wrong thing.
 */
function itemsTableRows(id: number): string[][] {
  const content = buildInvoicePdf(id).content as Node[];
  const tables = content.filter((n) => n && typeof n === 'object' && n.table);
  const items = tables.find((t) =>
    t.table.body.some((row: any[]) => row.some((c) => /Description of Goods/.test(cellText(c)))));
  assert.ok(items, 'no items table in the document');
  return items.table.body.map((row: any[]) => row.map(cellText).filter(Boolean));
}

/** Right-hand coloured blocks floating outside the table. There should be none. */
function floatingBands(id: number): number {
  const content = buildInvoicePdf(id).content as Node[];
  return content.filter((n) => n && n.columns && JSON.stringify(n).includes('fillColor')).length;
}

const cust = makeCustomer('PDF Customer');

function exportInvoice(): number {
  const id = makeInvoice({ customerId: cust, currency: 'USD', total: 78500 });
  db.prepare("UPDATE commercial_invoices SET freight = 3600, is_export = 1, inco_terms = 'FOB', port_of_discharge = 'XYZ', subtotal = 74900, tax_total = 0 WHERE id = ?").run(id);
  addItem(id, { description: '20 LTR Threaded Cap', qty: 300000, unit: 'per 1000', unit_price: 10, amount: 3000, packs: 300, total_pcs: 300000 });
  addItem(id, { description: '28mm PCO 1810', qty: 1650000, unit: 'per 1000', unit_price: 6, amount: 9900, packs: 300, total_pcs: 1650000, sort_order: 1 });
  return id;
}

describe('the money sits in the items table', () => {
  test('every money line is a row of the table', () => {
    const id = exportInvoice();
    const rows = itemsTableRows(id).map((r) => r.join(' | '));
    const joined = rows.join('\n');
    for (const label of ['TOTAL PRICE', 'Add Freight', 'AMOUNT IN FOB XYZ']) {
      assert.ok(joined.includes(label), `"${label}" should be a table row:\n${joined}`);
    }
  });

  test('and nothing is left floating beside it', () => {
    assert.equal(floatingBands(exportInvoice()), 0,
      'a separate band costs its own margin and taller rows than the table');
  });

  test('the payment lines come after the total, and are in the table too', () => {
    const id = exportInvoice();
    makePayment({ customerId: cust, invoiceId: id, amount: 13500, currency: 'USD' });
    const rows = itemsTableRows(id).map((r) => r.join(' | '));
    const total = rows.findIndex((r) => r.includes('AMOUNT IN FOB'));
    const received = rows.findIndex((r) => r.includes('Amount Received'));
    const balance = rows.findIndex((r) => r.includes('Balance Due'));
    assert.ok(total >= 0 && received > total && balance > received,
      `expected total → received → balance, got:\n${rows.join('\n')}`);
  });

  test('with no payment there are no payment rows at all', () => {
    const rows = itemsTableRows(exportInvoice()).join('\n');
    assert.ok(!rows.includes('Amount Received'));
    assert.ok(!rows.includes('Balance Due'));
  });
});

describe('a domestic invoice, which carries the most lines', () => {
  const domestic = () => {
    const id = makeInvoice({ customerId: cust, currency: 'INR', total: 720425 });
    db.prepare(`UPDATE commercial_invoices
                SET freight = 4500, insurance = 1200, tax_type = 'cgst_sgst',
                    subtotal = 604830, tax_total = 109895.4 WHERE id = ?`).run(id);
    addItem(id, { description: 'Preform', qty: 240000, unit: 'pcs', unit_price: 2.137, amount: 512880, tax_pct: 18, packs: 200, total_pcs: 240000 });
    return id;
  };

  test('shows the taxable value, both halves of GST and the round off', () => {
    const rows = itemsTableRows(domestic()).map((r) => r.join(' | ')).join('\n');
    for (const label of ['TOTAL PRICE', 'Indicative Freight & Insurance', 'Add CGST', 'Add SGST', 'Round off', 'GRAND TOTAL']) {
      assert.ok(rows.includes(label), `"${label}" missing:\n${rows}`);
    }
  });

  /**
   * The proforma drops its subtotal, since its amount column is summed. An
   * invoice must not: CGST and SGST are charged on the taxable value, and a
   * reader has to be able to see the figure they were charged on.
   */
  test('the subtotal is kept, unlike on the proforma', () => {
    const rows = itemsTableRows(domestic()).map((r) => r.join(' | ')).join('\n');
    assert.ok(/TOTAL PRICE \| ₹6,04,830/.test(rows), `taxable value should be printed:\n${rows}`);
  });

  test('and nothing floats beside the table here either', () => {
    assert.equal(floatingBands(domestic()), 0);
  });
});
