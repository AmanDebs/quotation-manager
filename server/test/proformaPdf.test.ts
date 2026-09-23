import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildProformaPdf } from '../src/services/pdf.js';
import { proformaAdvance } from '../src/services/receivables.js';
import { db } from '../src/db/connection.js';
import { makeCustomer, makeProforma, makePayment } from './helpers/factory.js';

/**
 * The buyer pays the advance against the proforma, so a proforma that states a
 * grand total and says nothing about the money already banked asks for the
 * whole sum a second time. These build the document definition and read it,
 * like `invoicePdf.test.ts`; they do not render.
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

/** The items table's rows, as arrays of cells. */
function itemsBody(def: any): any[][] {
  const found: any[][] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.table?.body && Array.isArray(n.table.body) && n.table.body.length > 1) found.push(n.table.body);
    for (const k of ['stack', 'columns', 'content', 'table', 'body']) if (n[k]) walk(n[k]);
  };
  walk(def.content);
  // The widest table on the page is the items table.
  return found.sort((a, b) => (b[0]?.length ?? 0) - (a[0]?.length ?? 0))[0] ?? [];
}

const addItem = (piId: number, description: string, qty: number, price: number, packs: number) =>
  db.prepare(
    `INSERT INTO pi_items (pi_id, description, qty, unit, unit_price, tax_pct, amount, packs, total_pcs, sort_order)
     VALUES (?, ?, ?, 'per 1000', ?, 18, ?, ?, ?, 0)`
  ).run(piId, description, qty, price, qty * price, packs, qty * 1000);

function proformaWith(total: number, paid: number, payCurrency = 'INR'): number {
  const c = makeCustomer();
  const pi = makeProforma({ customerId: c, currency: 'INR', total });
  addItem(pi, '28mm Preform 119g', 20, 2700, 20);
  // The stored figures a real proforma carries, so the round-off line is the
  // rounding rather than the whole document.
  db.prepare('UPDATE proforma_invoices SET subtotal = ?, tax_total = ?, tax_type = ? WHERE id = ?')
    .run(54000, 9720, 'igst', pi);
  if (paid) makePayment({ customerId: c, piId: pi, amount: paid, currency: payCurrency });
  return pi;
}

describe('the advance on a proforma', () => {
  test('is stated, with what is left to pay', () => {
    const texts = textsOf(buildProformaPdf(proformaWith(91420, 27426)));
    assert.ok(texts.includes('Advance Received'), 'no advance row');
    assert.ok(texts.includes('Balance Payable'), 'no balance row');
    assert.ok(texts.some((t) => t.includes('27,426')), 'the advance figure is not printed');
    // 91,420 − 27,426 = 63,994.
    assert.ok(texts.some((t) => t.includes('63,994')), 'the balance is not printed');
  });

  /**
   * A proforma nobody has paid against prints exactly what it always did —
   * the rows appear because there is something to say, not because the
   * feature exists.
   */
  test('nothing paid prints no payment rows at all', () => {
    const texts = textsOf(buildProformaPdf(proformaWith(91420, 0)));
    assert.ok(!texts.includes('Advance Received'));
    assert.ok(!texts.includes('Balance Payable'));
    assert.ok(texts.some((t) => t.includes('91,420')), 'the grand total should still be there');
  });

  /**
   * Money only adds up within one currency. A payment in another is credited
   * to nothing and reported rather than converted — there is no rate stored
   * anywhere, and inventing one would put a fiction on the document.
   */
  test('a payment in another currency is not counted', () => {
    const pi = proformaWith(91420, 1000, 'USD');
    const texts = textsOf(buildProformaPdf(pi));
    assert.ok(!texts.includes('Advance Received'), 'a USD payment was credited to an INR proforma');
    assert.equal(proformaAdvance(pi).amount_received, 0);
    assert.deepEqual(proformaAdvance(pi).currency_mismatch, [{ currency: 'USD', amount: 1000 }]);
  });

  /**
   * The subtle one. `itemsTable` puts the column totals on the row marked
   * `sums`, defaulting to the last — so adding rows after the grand total
   * would slide the boxes-and-pieces totals onto Balance Payable, which is not
   * a property of what is being shipped.
   */
  test('the column totals stay on the grand total, not on the balance', () => {
    const body = itemsBody(buildProformaPdf(proformaWith(91420, 27426)));
    const cellText = (c: any): string => (typeof c === 'string' ? c : String(c?.text ?? ''));
    const rowOf = (label: string) => body.find((r) => r.some((c) => cellText(c).startsWith(label)));
    // Every row is padded to the table's width, so "carries the totals" means
    // the middle columns have figures in them, not that the row is longer.
    const middle = (r: any[]) => r.slice(1, -1).map(cellText).filter(Boolean);

    const grand = rowOf('GRAND TOTAL') ?? rowOf('TOTAL');
    const balance = rowOf('Balance Payable');
    assert.ok(grand && balance, 'expected both rows');
    assert.deepEqual(middle(grand), ['20', '20,000'], 'the grand total lost the column totals');
    assert.deepEqual(middle(balance), [], 'the balance row carried the column totals');
  });

  /**
   * A custom column sits before Amount (2026-09-23, the client: *"The amount
   * column should be the last column even if I add a custom column"*).
   * Appended, it took the last slot — and a money row puts its figure in the
   * last column, so the grand total printed under the custom heading while
   * Amount carried the sum of the lines above it.
   */
  test('a custom column goes before Amount, which stays last', () => {
    const pi = proformaWith(91420, 0);
    db.prepare("UPDATE proforma_invoices SET column_config = ? WHERE id = ?")
      .run(JSON.stringify({ hidden: [], custom: ['Custom'] }), pi);
    const body = itemsBody(buildProformaPdf(pi));
    const cellText = (c: any): string => (typeof c === 'string' ? c : String(c?.text ?? ''));
    // The header row that carries the labels: an ungrouped column spans both
    // rows and states its own there, so this is the one the order reads from.
    const heads = (body.find((r) => r.some((c) => cellText(c) === 'Custom')) ?? body[0]).map(cellText);
    const last = heads[heads.length - 1];
    assert.ok(/AMOUNT/i.test(last), `Amount should close the table, got ${last}`);
    assert.ok(heads.some((h) => h === 'Custom'), `the custom column is missing: ${heads.join(' | ')}`);
    assert.ok(heads.indexOf('Custom') < heads.length - 1, 'the custom column took the last slot');

    // And the grand total lands in Amount rather than in the custom column.
    const grand = body[body.length - 1];
    assert.ok(cellText(grand[0]).includes('TOTAL'), `expected the total to close the table, got ${cellText(grand[0])}`);
    assert.ok(cellText(grand[grand.length - 1]).includes('91,420'), 'the grand total is not in the last column');
  });
});
