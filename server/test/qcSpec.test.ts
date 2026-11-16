import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import {
  paramsFor, specOwner, specOverrides, withResolvedParams, checksForWorkOrder,
} from '../src/services/qc.js';
import type { QcCheck } from '../src/services/qc.js';
import { makeCustomer, makeOrder } from './helpers/factory.js';

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

function addParam(
  productId: number, customerId: number | null, name: string,
  min: number, max: number, kind = 'numeric',
) {
  db.prepare(
    `INSERT INTO product_qc_params (product_id, customer_id, name, kind, unit, min_value, max_value, sort_order)
     VALUES (?, ?, ?, ?, 'mm', ?, ?, 0)`
  ).run(productId, customerId, name, kind, min, max);
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

/** A job to hang an inspection off; nothing here reads anything but its id. */
function makeJob(productId: number): number {
  const order = makeOrder({ customerId: makeCustomer(), currency: 'INR' });
  return Number(db.prepare(
    `INSERT INTO work_orders (number, order_id, order_line, product_id, qty_planned)
     VALUES (?, ?, 0, ?, 10000)`
  ).run(`WO/T/${++seq}`, order, productId).lastInsertRowid);
}

/**
 * **Which characteristic a reading is of**, when the link was broken.
 *
 * 2026-11-15, the client on a correction page drawing each of their
 * characteristics twice. The specification used to be deleted and reinserted
 * whole on every edit and `qc_results.param_id` is `ON DELETE SET NULL`, so
 * adding one characteristic orphaned every reading on file for that product —
 * and the correction page reads an unlinked reading as a check nobody
 * specified. The write keeps a surviving characteristic's id now; this is how
 * the readings already on file are read back.
 *
 * Most of these are about what it must **not** claim: a reading wrongly
 * adopted by a characteristic is a reading drawn in the wrong row, and two
 * landing in one row is one of them the form keeps.
 */
describe('a reading whose link to the specification was broken', () => {
  /** One inspection of this job, with its readings in the order given. */
  function inspect(
    jobId: number,
    rows: { param_id: number | null; name: string; value: number; kind?: string }[],
  ): QcCheck {
    const checkId = Number(db.prepare(
      "INSERT INTO qc_checks (work_order_id, date, inspector) VALUES (?, '2026-11-14', 'QC')"
    ).run(jobId).lastInsertRowid);
    rows.forEach((r, i) => {
      db.prepare(
        `INSERT INTO qc_results (check_id, param_id, name, kind, unit, value, min_value, max_value, sort_order)
         VALUES (?, ?, ?, ?, 'mm', ?, 20, 22, ?)`
      ).run(checkId, r.param_id, r.name, r.kind ?? 'numeric', r.value, i);
    });
    return checksForWorkOrder(jobId)[0];
  }

  const links = (c: QcCheck) => c.results.map((r) => r.param_id);

  test('is read back against the characteristic of that name', () => {
    const p = makeProduct();
    const job = makeJob(p);
    addParam(p, null, 'Neck diameter', 20.7, 21.1);
    const [param] = paramsFor(p, null);

    const out = withResolvedParams(paramsFor(p, null), [inspect(job, [
      { param_id: null, name: 'Neck diameter', value: 20.9 },
    ])]);
    assert.deepEqual(links(out[0]), [param.id]);
  });

  test('...whatever the tolerance now says, that being the point of copying it', () => {
    /* A specification corrected after an inspection leaves the reading
       carrying what it was really judged against, which is why the window is
       copied onto it — and it is still the same characteristic, so matching
       on the window would refuse exactly the case this exists for. */
    const p = makeProduct();
    const job = makeJob(p);
    addParam(p, null, 'Neck diameter', 19, 23);
    const [param] = paramsFor(p, null);

    const out = withResolvedParams(paramsFor(p, null), [inspect(job, [
      { param_id: null, name: 'Neck diameter', value: 20.9 },
    ])]);
    assert.equal(out[0].results[0].param_id, param.id);
    assert.equal(out[0].results[0].min_value, 20, 'the reading kept its own tolerance');
  });

  test('a reading of a characteristic nobody specifies is left alone', () => {
    /* Which is what a check added on the spot has always been, and what the
       correction page draws as a row of its own. */
    const p = makeProduct();
    const job = makeJob(p);
    addParam(p, null, 'Neck diameter', 20.7, 21.1);

    const out = withResolvedParams(paramsFor(p, null), [inspect(job, [
      { param_id: null, name: 'Ovality', value: 0.2 },
    ])]);
    assert.deepEqual(links(out[0]), [null]);
  });

  test('and so is one whose kind no longer matches', () => {
    /* A characteristic re-typed from a measurement to a pass/fail is not the
       row a number was recorded in. */
    const p = makeProduct();
    const job = makeJob(p);
    addParam(p, null, 'Appearance', 0, 0, 'boolean');

    const out = withResolvedParams(paramsFor(p, null), [inspect(job, [
      { param_id: null, name: 'Appearance', value: 1 },
    ])]);
    assert.deepEqual(links(out[0]), [null]);
  });

  test('a characteristic two readings answer to is taken by the first alone', () => {
    /* Two answers in one row is a row the form draws once and an answer it
       keeps one of — so the second stays what it is and is drawn on its own. */
    const p = makeProduct();
    const job = makeJob(p);
    addParam(p, null, 'Neck diameter', 20.7, 21.1);
    const [param] = paramsFor(p, null);

    const out = withResolvedParams(paramsFor(p, null), [inspect(job, [
      { param_id: null, name: 'Neck diameter', value: 20.9 },
      { param_id: null, name: 'Neck diameter', value: 21 },
    ])]);
    assert.deepEqual(links(out[0]), [param.id, null]);
  });

  test('...and one a reading already holds is never taken from it', () => {
    const p = makeProduct();
    const job = makeJob(p);
    addParam(p, null, 'Neck diameter', 20.7, 21.1);
    const [param] = paramsFor(p, null);

    const out = withResolvedParams(paramsFor(p, null), [inspect(job, [
      { param_id: param.id, name: 'Neck diameter', value: 20.9 },
      { param_id: null, name: 'Neck diameter', value: 21 },
    ])]);
    assert.deepEqual(links(out[0]), [param.id, null]);
  });

  test('a name the specification carries twice claims nothing', () => {
    /* There is no way to say which, and guessing would draw the reading in a
       row it may not belong to. */
    const p = makeProduct();
    const job = makeJob(p);
    addParam(p, null, 'Neck diameter', 20.7, 21.1);
    addParam(p, null, 'Neck diameter', 22, 23);

    const out = withResolvedParams(paramsFor(p, null), [inspect(job, [
      { param_id: null, name: 'Neck diameter', value: 20.9 },
    ])]);
    assert.deepEqual(links(out[0]), [null]);
  });

  test('and a product with no specification at all changes nothing', () => {
    const p = makeProduct();
    const job = makeJob(p);
    const out = withResolvedParams(paramsFor(p, null), [inspect(job, [
      { param_id: null, name: 'Neck diameter', value: 20.9 },
    ])]);
    assert.deepEqual(links(out[0]), [null]);
  });

  test('the verdict is the readings’ own, never the link', () => {
    /* Nothing downstream reads `param_id` — the certificate, the dispatch
       gate and the register all read the window copied onto the reading — so
       resolving one must move no figure. */
    const p = makeProduct();
    const job = makeJob(p);
    addParam(p, null, 'Neck diameter', 20.7, 21.1);
    const check = inspect(job, [{ param_id: null, name: 'Neck diameter', value: 20.9 }]);

    const out = withResolvedParams(paramsFor(p, null), [check]);
    assert.equal(out[0].passed, check.passed);
    assert.equal(out[0].failed_count, check.failed_count);
    assert.equal(out[0].results[0].ok, check.results[0].ok);
  });
});

/**
 * **Who has their own list for this product**, which is what the editor's
 * *copy from another customer* picker offers (2026-11-16, the client: *"Add
 * option to copy from customer like there is option to copy from another
 * product"*).
 *
 * The point of asking the server at all is that it answers with **real**
 * options: on a book of several hundred buyers a picker built from the
 * customer list would say *"they have no specification to copy"* to almost
 * every press.
 */
describe('who has their own specification for a product', () => {
  test('names each buyer who holds one, and how long it is', () => {
    const p = makeProduct();
    const a = makeCustomer('Acme Maschinenbau GmbH');
    const b = makeCustomer('Bharat Engineering Works');
    addParam(p, null, 'Wall thickness', 0.3, 0.5);
    addParam(p, a, 'Wall thickness', 0.38, 0.42);
    addParam(p, b, 'Wall thickness', 0.35, 0.45);
    addParam(p, b, 'Flatness', 0, 0.1);

    assert.deepEqual(specOverrides(p), [
      { customer_id: a, customer_name: 'Acme Maschinenbau GmbH', count: 1 },
      { customer_id: b, customer_name: 'Bharat Engineering Works', count: 2 },
    ]);
  });

  test('and the default is not one of them', () => {
    /* It is a list this product always has rather than a buyer who happens to
       hold one, so the editor offers it separately. */
    const p = makeProduct();
    addParam(p, null, 'Wall thickness', 0.3, 0.5);
    assert.deepEqual(specOverrides(p), []);
  });

  test('a product nobody has overridden offers nothing, and so the picker is not drawn', () => {
    assert.deepEqual(specOverrides(makeProduct()), []);
    assert.deepEqual(specOverrides(null), []);
  });

  test('another product’s overrides are not this one’s', () => {
    const mine = makeProduct();
    const theirs = makeProduct();
    addParam(theirs, makeCustomer(), 'Wall thickness', 0.38, 0.42);
    assert.deepEqual(specOverrides(mine), []);
    assert.equal(specOverrides(theirs).length, 1);
  });

  test('and a buyer put back on the default leaves the list', () => {
    /* Removing every row is how an override is undone, so the picker has to
       stop offering a list that is no longer there. */
    const p = makeProduct();
    const c = makeCustomer();
    addParam(p, c, 'Wall thickness', 0.38, 0.42);
    assert.equal(specOverrides(p).length, 1);

    db.prepare('DELETE FROM product_qc_params WHERE product_id = ? AND customer_id = ?').run(p, c);
    assert.deepEqual(specOverrides(p), []);
  });
});
