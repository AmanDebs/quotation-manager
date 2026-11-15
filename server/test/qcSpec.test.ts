import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { paramsFor, specOwner } from '../src/services/qc.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * Whose tolerances a job is judged against.
 *
 * These were written beside the quality report's own cases and outlived it:
 * the report was withdrawn on 2026-11-15 (*"in my company only COA is made
 * after production"*) and `paramsFor`/`specOwner` are untouched by that —
 * the inspection page, the products page and the certificate all read them.
 */

let seq = 0;

const makeProduct = () => Number(db.prepare(
  "INSERT INTO products (name, unit) VALUES (?, 'per 1000')"
).run(`Product ${++seq}`).lastInsertRowid);

function addParam(productId: number, customerId: number | null, name: string, min: number, max: number) {
  db.prepare(
    `INSERT INTO product_qc_params (product_id, customer_id, name, kind, unit, min_value, max_value, sort_order)
     VALUES (?, ?, ?, 'numeric', 'mm', ?, ?, 0)`
  ).run(productId, customerId, name, min, max);
}

describe('whose specification applies', () => {
  test('a customer with their own gets theirs, and it replaces the default', () => {
    const p = makeProduct();
    const mine = makeCustomer();
    addParam(p, null, 'Wall thickness', 0.3, 0.5);
    addParam(p, mine, 'Wall thickness', 0.38, 0.42);
    addParam(p, mine, 'Flatness', 0, 0.1);

    const theirs = paramsFor(p, mine);
    // Replaced, not merged: two rows, both theirs. A merge would give three.
    assert.equal(theirs.length, 2);
    assert.equal(theirs[0].min_value, 0.38);
    assert.equal(specOwner(p, mine), 'customer');
  });

  test('a customer without their own falls back to the product’s', () => {
    const p = makeProduct();
    const mine = makeCustomer();
    const other = makeCustomer();
    addParam(p, null, 'Wall thickness', 0.3, 0.5);
    addParam(p, other, 'Wall thickness', 0.38, 0.42);

    const fallback = paramsFor(p, mine);
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].min_value, 0.3);
    assert.equal(specOwner(p, mine), 'default');
  });

  /** One customer's tighter tolerance must not quietly become everybody's. */
  test('and the default is untouched by anyone else’s', () => {
    const p = makeProduct();
    addParam(p, null, 'Wall thickness', 0.3, 0.5);
    addParam(p, makeCustomer(), 'Wall thickness', 0.38, 0.42);

    const base = paramsFor(p);
    assert.equal(base.length, 1);
    assert.equal(base[0].max_value, 0.5);
    assert.equal(specOwner(p), 'default');
  });

  /**
   * The rule qc.ts states twice about itself: no specification is *no opinion*,
   * never "everything passed".
   */
  test('a product nobody has specified has none, for anyone', () => {
    const p = makeProduct();
    assert.deepEqual(paramsFor(p), []);
    assert.deepEqual(paramsFor(p, makeCustomer()), []);
    assert.equal(specOwner(p, makeCustomer()), 'none');
    assert.equal(specOwner(null), 'none');
  });
});

