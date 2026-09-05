import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { qcBlockError } from '../src/services/qc.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * "Only after QC it should be available for dispatch" — the one business rule
 * carried by the client's access matrix.
 *
 * What is worth pinning is not the happy path but the three ways this gate can
 * be silently wrong: a product with no specification, a check where nothing was
 * measured, and the line position, which counts charge lines.
 */

let seq = 0;

function makeProduct(withSpec: boolean): number {
  const id = Number(db.prepare(
    "INSERT INTO products (name, unit) VALUES (?, 'per 1000')"
  ).run(`Product ${++seq}`).lastInsertRowid);
  if (withSpec) {
    db.prepare(
      `INSERT INTO product_qc_params (product_id, name, kind, unit, min_value, max_value, sort_order)
       VALUES (?, 'Wall thickness', 'numeric', 'mm', 0.3, 0.5, 0)`
    ).run(id);
  }
  return id;
}

/** An order whose lines are given in position order. `null` means a charge. */
function makeOrder(lines: (number | null)[]): number {
  const orderId = Number(db.prepare(
    "INSERT INTO orders (number, date, customer_id, currency) VALUES (?, '2026-09-05', ?, 'INR')"
  ).run(`SO/T/${++seq}`, makeCustomer()).lastInsertRowid);
  lines.forEach((productId, i) => {
    db.prepare(
      `INSERT INTO order_items (order_id, product_id, description, qty, unit, is_charge, sort_order)
       VALUES (?, ?, ?, 1000, 'per 1000', ?, ?)`
    ).run(orderId, productId, productId === null ? 'Freight' : `Line ${i}`, productId === null ? 1 : 0, i);
  });
  return orderId;
}

function makeJob(orderId: number, line: number, productId: number | null): number {
  return Number(db.prepare(
    `INSERT INTO work_orders (number, order_id, order_line, product_id, qty_planned, status)
     VALUES (?, ?, ?, ?, 1000, 'released')`
  ).run(`WO/T/${++seq}`, orderId, line, productId).lastInsertRowid);
}

/** A check whose single reading is in tolerance, out of it, or absent. */
function makeCheck(workOrderId: number, value: number | null): number {
  const checkId = Number(db.prepare(
    "INSERT INTO qc_checks (work_order_id, date, inspector) VALUES (?, '2026-09-05', 'QC')"
  ).run(workOrderId).lastInsertRowid);
  db.prepare(
    `INSERT INTO qc_results (check_id, name, kind, unit, value, min_value, max_value, sort_order)
     VALUES (?, 'Wall thickness', 'numeric', 'mm', ?, 0.3, 0.5, 0)`
  ).run(checkId, value);
  return checkId;
}

const send = (line: number) => [{ order_line: line }];

describe('what the gate refuses', () => {
  test('a spec’d line with no passing check', () => {
    const p = makeProduct(true);
    const order = makeOrder([p]);
    makeJob(order, 0, p);
    assert.match(String(qcBlockError(order, send(0))), /has not passed QC/);
  });

  test('and lets it through once one passes', () => {
    const p = makeProduct(true);
    const order = makeOrder([p]);
    const job = makeJob(order, 0, p);
    makeCheck(job, 0.4);
    assert.equal(qcBlockError(order, send(0)), null);
  });

  /**
   * A check with nothing measured is `passed: null`, not a pass — the trap
   * `decorate` exists to avoid, and the easiest way for a gate to end up
   * toothless.
   */
  test('a check where nothing was measured is not a pass', () => {
    const p = makeProduct(true);
    const order = makeOrder([p]);
    const job = makeJob(order, 0, p);
    makeCheck(job, null);
    assert.match(String(qcBlockError(order, send(0))), /has not passed QC/);
  });

  test('a failed check is not a pass, and a later passing one clears it', () => {
    const p = makeProduct(true);
    const order = makeOrder([p]);
    const job = makeJob(order, 0, p);
    makeCheck(job, 0.9); // out of tolerance
    assert.match(String(qcBlockError(order, send(0))), /has not passed QC/);
    makeCheck(job, 0.4); // re-inspected
    assert.equal(qcBlockError(order, send(0)), null);
  });

  /**
   * Not raising a job would otherwise be the way around the gate entirely.
   * This is the decision most likely to want revisiting — bought-in goods have
   * no work order by nature.
   */
  test('a spec’d line with no work order at all', () => {
    const p = makeProduct(true);
    const order = makeOrder([p]);
    assert.match(String(qcBlockError(order, send(0))), /has not passed QC/);
  });
});

describe('what the gate never refuses', () => {
  /**
   * The rule confirmed with the user: `has_spec: false` means nobody has said
   * what to measure, which is not a failure. Blocking these would have stopped
   * every despatch on the day this shipped.
   */
  test('a product with no specification', () => {
    const p = makeProduct(false);
    const order = makeOrder([p]);
    assert.equal(qcBlockError(order, send(0)), null);
  });

  test('a charge line, which is a fee and not goods', () => {
    const order = makeOrder([null]);
    assert.equal(qcBlockError(order, send(0)), null);
  });

  test('and a despatch naming no lines at all', () => {
    const order = makeOrder([makeProduct(true)]);
    assert.equal(qcBlockError(order, []), null);
  });
});

describe('the line position', () => {
  /**
   * The off-by-one, and the reason it is invisible in an ordinary fixture:
   * `order_line` is numbered over **all** order items and charge lines are
   * dropped afterwards, so an order that opens with freight has its first
   * goods line at position 1. Numbering after the filter gates the wrong line.
   */
  test('counts charge lines, so freight-first puts the goods at 1', () => {
    const p = makeProduct(true);
    const order = makeOrder([null, p]);
    const job = makeJob(order, 1, p);
    makeCheck(job, 0.4);
    // Position 1 is the preform, and it has passed.
    assert.equal(qcBlockError(order, send(1)), null);
    // Position 0 is the freight, which is never gated.
    assert.equal(qcBlockError(order, send(0)), null);
  });

  test('a check against the wrong position does not clear the right one', () => {
    const p = makeProduct(true);
    const order = makeOrder([p, p]);
    makeCheck(makeJob(order, 0, p), 0.4);
    assert.equal(qcBlockError(order, send(0)), null);
    assert.match(String(qcBlockError(order, send(1))), /has not passed QC/);
  });

  /**
   * Order lines are rewritten wholesale on every save and `order_line` is a
   * stale integer rather than a reference, so an index can outlive its line.
   * Refused rather than silently passed.
   */
  test('an index past the end of the order is refused', () => {
    const order = makeOrder([makeProduct(true)]);
    assert.match(String(qcBlockError(order, send(7))), /not on this order/);
  });

  test('and a despatch line that says nothing about which line it is', () => {
    const order = makeOrder([makeProduct(true)]);
    assert.match(String(qcBlockError(order, [{}])), /must say which order line/);
  });
});
