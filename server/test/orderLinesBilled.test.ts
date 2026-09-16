import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { orderLines } from '../src/services/orderLines.js';
import { makeCustomer, makeInvoice } from './helpers/factory.js';

/**
 * `billed` on an order line is in pieces, like `ordered` and `sent` beside
 * it. An invoice line is billed in its own basis — 3,245 per 1000 — and
 * summing that against a piece count read a fully billed line as 0.1%
 * shipped, *Part shipped* over an order the ladder had already closed
 * (found on the live book, 2026-09-16).
 */
describe('billed on an order line is in pieces', () => {
  const customerId = makeCustomer();
  const orderId = Number((db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status)
     VALUES ('SO/BILLED-1', '2026-09-01', ?, 1, 'USD', 'none', 'pending') RETURNING id`
  ).get(customerId) as { id: number }).id);
  // Line 0: per 1000 with no packing figures, the live book's shape.
  // Line 1: per 1000 with a stated piece count. Line 2: weight-billed.
  db.prepare(`INSERT INTO order_items (order_id, description, qty, unit, unit_price, amount, total_pcs, is_charge, sort_order)
              VALUES (?, 'Two Piece', 3245, 'per 1000', 10, 32450, NULL, 0, 0)`).run(orderId);
  db.prepare(`INSERT INTO order_items (order_id, description, qty, unit, unit_price, amount, total_pcs, is_charge, sort_order)
              VALUES (?, 'Cap', 100, 'per 1000', 10, 1000, 100000, 0, 1)`).run(orderId);
  db.prepare(`INSERT INTO order_items (order_id, description, qty, unit, unit_price, amount, total_pcs, is_charge, sort_order)
              VALUES (?, 'Regrind', 500, 'kg', 1, 500, NULL, 0, 2)`).run(orderId);
  const inv = makeInvoice({ customerId, currency: 'USD', total: 33950 });
  db.prepare("UPDATE commercial_invoices SET order_id = ? WHERE id = ?").run(orderId, inv);
  db.prepare(`INSERT INTO invoice_items (invoice_id, description, qty, unit, unit_price, amount, total_pcs, sort_order)
              VALUES (?, 'Two Piece', 3245, 'per 1000', 10, 32450, NULL, 0)`).run(inv);
  db.prepare(`INSERT INTO invoice_items (invoice_id, description, qty, unit, unit_price, amount, total_pcs, sort_order)
              VALUES (?, 'Cap', 40, 'per 1000', 10, 400, 40000, 1)`).run(inv);
  db.prepare(`INSERT INTO invoice_items (invoice_id, description, qty, unit, unit_price, amount, total_pcs, sort_order)
              VALUES (?, 'Regrind', 200, 'kg', 1, 200, NULL, 2)`).run(inv);

  const lines = orderLines({}).filter((l) => l.order_id === orderId).sort((a, b) => a.order_line - b.order_line);

  test('a per-1000 line billed in full reads fully shipped, not 0.1%', () => {
    assert.equal(lines[0].ordered, 3245000);
    assert.equal(lines[0].billed, 3245000);
    assert.equal(lines[0].state, 'shipped');
  });
  test('a stated piece count on the invoice line is what counts', () => {
    assert.equal(lines[1].ordered, 100000);
    assert.equal(lines[1].billed, 40000);
    assert.equal(lines[1].state, 'part_shipped');
  });
  test('a weight-billed line stays in its own unit', () => {
    assert.equal(lines[2].ordered, 500);
    assert.equal(lines[2].billed, 200);
  });
});
