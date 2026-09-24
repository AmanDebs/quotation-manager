import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { buildQuotationPdf, buildOrderPdf } from '../src/services/pdf.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * A rate prints to two decimals (2026-09-24, the client with a quotation's
 * Unit Price column in front of them: *"Can all digit be 2 decimal"* — it read
 * 26, 4.8, 7, 35.75, 55.1 down one column).
 *
 * Two things are being held apart here, and the second is the reason this file
 * exists rather than a one-line change. **A rate pads**, so a column of them
 * lines up on the decimal point. **A quantity does not**, because 20,000
 * pieces is not 20,000.00 — and the formatter is shared enough that applying
 * it one column too far is the easy mistake.
 */

const customerId = makeCustomer('Sanya Packaging');
let seq = 0;

function makeQuotation(lines: { price: number; pcs?: number }[]): number {
  const id = Number((db.prepare(
    `INSERT INTO quotations (number, date, customer_id, company_id, currency, tax_type, subtotal, grand_total)
     VALUES (?, '2026-09-24', ?, 1, 'EUR', 'none', 100, 100) RETURNING id`
  ).get(`QT/RATE/${++seq}`, customerId) as { id: number }).id);
  lines.forEach((l, i) => {
    db.prepare(
      `INSERT INTO quotation_items (quotation_id, description, color, qty, unit, unit_price, amount, total_pcs, is_charge, sort_order)
       VALUES (?, 'Preform', 'Natural', 100, 'per 1000', ?, 100, ?, 0, ?)`
    ).run(id, l.price, l.pcs ?? 20000, i);
  });
  return id;
}

type Node = Record<string, unknown>;

/** The items table's rows, as arrays of cell strings. */
function itemsRows(def: unknown): string[][] {
  const tables: string[][][] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    const node = n as Node;
    const table = node.table as { body?: unknown[][] } | undefined;
    if (table?.body && table.body.length > 1) {
      tables.push(table.body.map((row) => row.map((c) => {
        const cell = c as Node;
        return typeof cell?.text === 'string' ? cell.text : String((c as string) ?? '');
      })));
    }
    for (const k of ['stack', 'columns', 'content', 'table', 'body']) if (node[k]) walk(node[k]);
  };
  walk((def as Node).content);
  return tables.sort((a, b) => (b[0]?.length ?? 0) - (a[0]?.length ?? 0))[0] ?? [];
}

function column(rows: string[][], heading: string): string[] {
  const i = rows[0].findIndex((h) => h.trim().toLowerCase().startsWith(heading.toLowerCase()));
  assert.ok(i >= 0, `no ${heading} column in: ${rows[0].join(' | ')}`);
  return rows.slice(1).map((r) => r[i]);
}

describe('a rate prints to two decimals', () => {
  /** The client's own column, figure for figure. */
  test('the five figures off the screenshot', () => {
    const rows = itemsRows(buildQuotationPdf(makeQuotation(
      [26, 4.8, 7, 35.75, 55.1].map((price) => ({ price })),
    )));
    assert.deepEqual(column(rows, 'Unit Price'), ['26.00', '4.80', '7.00', '35.75', '55.10']);
  });

  /**
   * Two is the minimum, three is still the maximum. Rounding a genuine
   * three-decimal rate — this book has them — would leave the printed rate no
   * longer reproducing the amount printed beside it, which a buyer checking
   * the arithmetic would read as an error on our side.
   */
  test('and a third decimal is kept where the rate carries one', () => {
    const rows = itemsRows(buildQuotationPdf(makeQuotation([{ price: 3.017 }, { price: 2 }])));
    assert.deepEqual(column(rows, 'Unit Price'), ['3.017', '2.00']);
  });

  test('on the sales order too, which quotes the same rate', () => {
    const id = Number((db.prepare(
      `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, subtotal, grand_total)
       VALUES ('SO/RATE/1', '2026-09-24', ?, 1, 'EUR', 'none', 100, 100) RETURNING id`
    ).get(customerId) as { id: number }).id);
    db.prepare(
      `INSERT INTO order_items (order_id, description, color, qty, unit, unit_price, amount, total_pcs, is_charge, sort_order)
       VALUES (?, 'Preform', 'Natural', 100, 'per 1000', 7, 700, 20000, 0, 0)`
    ).run(id);
    assert.deepEqual(column(itemsRows(buildOrderPdf(id)), 'Rate'), ['7.00']);
  });
});

describe('and a quantity does not', () => {
  /**
   * The guard against applying the rate format one column too far: pieces,
   * boxes and pcs-per-box are counts, and 20,000.00 of them is not a figure
   * anybody writes.
   */
  test('pieces stay whole', () => {
    const rows = itemsRows(buildQuotationPdf(makeQuotation([{ price: 26, pcs: 20000 }])));
    assert.deepEqual(column(rows, 'Total Qty'), ['20,000']);
  });
});
