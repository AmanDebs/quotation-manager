import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrderPdf } from '../src/services/pdf.js';
import { db } from '../src/db/connection.js';
import { makeCustomer } from './helpers/factory.js';
import { assertFits, descriptionShare, itemsTable, MIN_DESCRIPTION } from './helpers/pdfFit.js';

/**
 * A line on an order can fall due on its own date, and the order is the
 * instruction the floor works from — so the date has to print. The rule that
 * matters is that an order not using per-line dates prints exactly what it
 * printed before, which is `itemsTable`'s auto-hide doing its job.
 *
 * Builds the document definition and reads it, like `proformaPdf.test.ts`;
 * nothing here renders a PDF.
 */

type Node = Record<string, any>;

/** The items table's rows, as arrays of cells — the widest table on the page. */
function itemsBody(def: any): any[][] {
  const found: any[][] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.table?.body && Array.isArray(n.table.body) && n.table.body.length > 1) found.push(n.table.body);
    for (const k of ['stack', 'columns', 'content', 'table', 'body']) if (n[k]) walk(n[k]);
  };
  walk(def.content);
  return found.sort((a, b) => (b[0]?.length ?? 0) - (a[0]?.length ?? 0))[0] ?? [];
}

const cellText = (c: Node): string => (typeof c === 'string' ? c : String(c?.text ?? ''));
const headers = (def: any): string[] => (itemsBody(def)[0] ?? []).map(cellText);

let seq = 0;

function makeOrder(items: { description: string; qty: number; scheduled_date?: string }[]): number {
  const customerId = makeCustomer(`Order PDF ${++seq}`);
  const id = Number(db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, status)
     VALUES (?, '2026-09-01', ?, 1, 'INR', 'confirmed')`
  ).run(`SO/PDF/${seq}`, customerId).lastInsertRowid);
  items.forEach((it, i) => {
    db.prepare(
      `INSERT INTO order_items (order_id, description, qty, unit, unit_price, amount, scheduled_date, sort_order)
       VALUES (?, ?, ?, 'unit', 1, ?, ?, ?)`
    ).run(id, it.description, it.qty, it.qty, it.scheduled_date ?? '', i);
  });
  return id;
}

describe('the per-line promised date on the order PDF', () => {
  test('prints when a line carries one', async () => {
    const id = makeOrder([
      { description: '28mm Preform', qty: 30_000, scheduled_date: '2026-10-16' },
      { description: 'Flip-top Cap', qty: 20_000, scheduled_date: '2026-11-20' },
    ]);
    const def = await buildOrderPdf(id) as any;
    assert.ok(headers(def).includes('Promised'), headers(def).join(' | '));
    const rows = itemsBody(def).slice(1).map((r) => r.map(cellText));
    // Rendered through this module's own `fmtDate` — DD-MM-YYYY, as every
    // other date on these documents prints. The ISO string is not what
    // anybody at this desk reads.
    assert.ok(rows[0].includes('16-10-2026'), rows[0].join(' | '));
    assert.ok(rows[1].includes('20-11-2026'), rows[1].join(' | '));
  });

  /**
   * The half that protects every order already on file. `itemsTable` drops a
   * column with no data anywhere, so adding this spec entry cannot change a
   * document that does not use it.
   */
  test('and is absent entirely when no line does', async () => {
    const id = makeOrder([{ description: 'Plain line', qty: 100 }]);
    const def = await buildOrderPdf(id) as any;
    assert.equal(headers(def).includes('Promised'), false, headers(def).join(' | '));
  });

  test('one dated line among several is enough to bring the column back', async () => {
    const id = makeOrder([
      { description: 'No date', qty: 10 },
      { description: 'Dated', qty: 20, scheduled_date: '2026-12-01' },
    ]);
    const def = await buildOrderPdf(id) as any;
    assert.ok(headers(def).includes('Promised'));
    const rows = itemsBody(def).slice(1).map((r) => r.map(cellText));
    // The undated line leaves the cell blank rather than printing a dash or
    // today — `fmtDate('')` is the empty string, which is what a column that
    // auto-hides on emptiness needs it to be.
    assert.ok(rows[0].includes(''), rows[0].join(' | '));
    assert.ok(rows[1].includes('01-12-2026'), rows[1].join(' | '));
  });
});

/**
 * The order carries the most columns in the app — eleven with Code, Supplier
 * and per-line Promised all drawn — and its fixed widths came to 460pt, which
 * left Description less than nothing (2026-09-29, found by running the
 * quotation's own arithmetic across every builder after the client reported
 * *"alignment is not coming properly"* on that document).
 *
 * The rule and the figures behind it live in `helpers/pdfFit.ts`, shared with
 * `quotationPdf.test.ts`.
 */
describe('the items table fits the page', () => {
  /** Fills in every optional column so the shape under test is the real one. */
  function orderWith(over: Record<string, unknown>, taxPct = 18): number {
    const customerId = makeCustomer(`Order fit ${++seq}`);
    const id = Number(db.prepare(
      `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, is_export, status)
       VALUES (?, '2026-09-01', ?, 1, 'INR', ?, 0, 'confirmed')`
    ).run(`SO/FIT/${seq}`, customerId, taxPct ? 'igst' : 'none').lastInsertRowid);
    const cols = ['order_id', 'description', 'qty', 'unit', 'unit_price', 'amount', 'tax_pct', 'sort_order'];
    const vals: unknown[] = [id, '5 Gallon preform-700gm', 1000, 'per 1000', 139, 139000, taxPct, 0];
    for (const [k, v] of Object.entries(over)) { cols.push(k); vals.push(v); }
    db.prepare(
      `INSERT INTO order_items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    ).run(...(vals as never[]));
    return id;
  }

  /** What almost every order prints: HSN and colour beside the money. */
  test('the everyday order', () => {
    assertFits(buildOrderPdf(orderWith({ hsn_code: '39235010', color: 'Transparent' })), 'everyday order');
  });

  test('one using per-line promised dates as well', () => {
    assertFits(
      buildOrderPdf(orderWith({ hsn_code: '39235010', color: 'Transparent', scheduled_date: '2026-10-06' })),
      'order with per-line dates'
    );
  });

  /** Ten columns — the widest shape that still fits, and only just. */
  test('and one adding the per-line code on top of that', () => {
    const def = buildOrderPdf(orderWith({
      hsn_code: '39235010', color: 'Transparent', scheduled_date: '2026-10-06', code: 'PRF-28-SPEC',
    }));
    assert.equal(itemsTable(def).widths.length, 10, 'every optional column but Supplier is drawn');
    assertFits(def, 'order with code and dates');
  });

  /**
   * Stated rather than left to be discovered: eleven columns and a legible
   * description do not both fit A4 portrait at any widths, so this asserts the
   * shortfall rather than pretending it is fixed. The order form's Columns
   * picker offers Code, Supplier and Promised, which is the way out.
   */
  test('all eleven at once does not fit, and the picker is the way out', () => {
    const def = buildOrderPdf(orderWith({
      hsn_code: '39235010', color: 'Transparent', scheduled_date: '2026-10-06',
      code: 'PRF-28-SPEC', supplier: 'Northern Engineering',
    }));
    assert.equal(itemsTable(def).widths.length, 11);
    assert.ok(descriptionShare(def) < MIN_DESCRIPTION, 'if this ever passes, drop the caveat from the docs');
  });
});
