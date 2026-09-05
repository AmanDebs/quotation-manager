import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { orderLines, orderSearchClause } from '../src/services/orderLines.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * The order book is read three ways over one search box, so the term has to
 * mean the same thing in each. `orderSearchClause` is what guarantees that,
 * and these are the two shapes it has to produce from one rule: against a
 * line table that is joined, and against an order row that has none.
 */

let seq = 0;

function makeOrder(o: {
  customerId: number; number: string; poNumber?: string;
  items?: { description: string; code?: string; color?: string }[];
}): number {
  const id = Number(db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, po_number, status)
     VALUES (?, '2026-08-01', ?, 1, 'INR', ?, 'confirmed')`
  ).run(o.number, o.customerId, o.poNumber ?? '').lastInsertRowid);
  (o.items ?? []).forEach((it, i) => {
    db.prepare(
      `INSERT INTO order_items (order_id, description, code, color, qty, unit_price, sort_order)
       VALUES (?, ?, ?, ?, 100, 1, ?)`
    ).run(id, it.description, it.code ?? '', it.color ?? '', i);
  });
  return id;
}

/** The per-order half, run for real — the shape with no line table in scope. */
function findOrders(q: string): string[] {
  const s = orderSearchClause(q);
  const rows = db.prepare(
    `SELECT o.number FROM orders o JOIN customers c ON c.id = o.customer_id
     ${s.sql ? `WHERE ${s.sql}` : ''} ORDER BY o.number`
  ).all(...(s.params as never[])) as { number: string }[];
  return rows.map((r) => r.number);
}

/** The per-line half, through the service the lines view actually calls. */
const findLines = (q: string) => [...new Set(orderLines({ q }).map((l) => l.order_number))].sort();

describe('one box, one meaning', () => {
  const cust = makeCustomer(`Emeraude Trading ${++seq}`);
  const other = makeCustomer(`Sanya Plastics ${++seq}`);
  makeOrder({
    customerId: cust, number: 'SO/26-27/001', poNumber: 'PO-4471',
    items: [{ description: '28mm Preform', code: 'PRF28', color: 'Natural' }],
  });
  makeOrder({
    customerId: other, number: 'SO/26-27/002', poNumber: 'ACME-99',
    items: [{ description: 'Flip-top Cap', code: 'CAP01', color: 'Blue' }],
  });

  /*
   * The point of the whole exercise: whatever is typed, both views agree on
   * which orders it found. They are built from one rule but two statements —
   * one joins the lines, the other asks EXISTS — so nothing but a measurement
   * proves they answer the same.
   */
  for (const [what, term] of [
    ['our own number', '001'],
    ['the customer’s PO number', 'PO-4471'],
    ['the customer’s name', 'Emeraude'],
    ['an item description', 'Preform'],
    ['an item code', 'PRF28'],
    ['an item colour', 'Natural'],
  ] as const) {
    test(`${what} finds the order on both views`, () => {
      assert.deepEqual(findOrders(term), ['SO/26-27/001'], 'the per-order list');
      assert.deepEqual(findLines(term), ['SO/26-27/001'], 'the order-lines view');
    });
  }

  test('and something in neither finds nothing on either', () => {
    assert.deepEqual(findOrders('nonesuch'), []);
    assert.deepEqual(findLines('nonesuch'), []);
  });

  test('a blank term filters nothing at all', () => {
    assert.equal(orderSearchClause('').sql, '');
    assert.equal(orderSearchClause('   ').sql, '');
    assert.equal(orderSearchClause(undefined).sql, '');
    assert.equal(findOrders('').length, 2, 'so a caller can push it unconditionally');
  });
});

describe('LIKE’s own wildcards are characters, not patterns', () => {
  test('a percent sign matches a percent sign, not everything', () => {
    const c = makeCustomer(`Wildcard Co ${++seq}`);
    makeOrder({ customerId: c, number: 'SO/W/001', items: [{ description: '50% Recycled Resin' }] });
    makeOrder({ customerId: c, number: 'SO/W/002', items: [{ description: 'Virgin Resin' }] });

    // Unescaped, '%' is "match anything" and would return both.
    assert.deepEqual(findOrders('50%'), ['SO/W/001']);
    assert.deepEqual(findLines('50%'), ['SO/W/001']);
  });

  test('and an underscore matches an underscore', () => {
    const c = makeCustomer(`Underscore Co ${++seq}`);
    makeOrder({ customerId: c, number: 'SO/U/001', items: [{ code: 'PRF_28', description: 'Preform' }] });
    makeOrder({ customerId: c, number: 'SO/U/002', items: [{ code: 'PRF128', description: 'Preform' }] });

    // Unescaped, '_' is "any single character" and would match PRF128 too.
    assert.deepEqual(findOrders('PRF_28'), ['SO/U/001']);
    assert.deepEqual(findLines('PRF_28'), ['SO/U/001']);
  });
});

describe('the clause a caller pushes onto its own WHERE', () => {
  test('is bracketed, so it cannot escape an AND beside it', () => {
    /*
     * `scopeClause` and the status filter share this WHERE. Without the
     * brackets, "scope AND number LIKE ? OR c.name LIKE ?" binds as
     * "(scope AND number) OR name" — a search that reaches past data scoping,
     * which is the reason services/search.ts has the same test.
     */
    const s = orderSearchClause('x');
    assert.ok(s.sql.startsWith('(') && s.sql.endsWith(')'), s.sql);
    const withAlias = orderSearchClause('x', 'l');
    assert.ok(withAlias.sql.startsWith('(') && withAlias.sql.endsWith(')'), withAlias.sql);
  });

  test('binds one parameter per column it names', () => {
    // Three header columns, three item columns — either shape.
    assert.equal(orderSearchClause('x').params.length, 6);
    assert.equal(orderSearchClause('x', 'l').params.length, 6);
  });
});
