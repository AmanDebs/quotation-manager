import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import {
  requirementFor, requirementForJob, snapshotRecipe, recipeForJob, recipeDiffers,
} from '../src/services/recipe.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * The recipe a job was raised against.
 *
 * One rule, and everything here is a consequence of it: **a job is costed
 * against the recipe as it stood when it was raised**, so correcting a recipe
 * in March cannot silently restate what every open job needs. The same rule
 * `qc_results` follows for a tolerance and `material_moves.rate` for a cost.
 *
 * The half that needs the most protecting is what happens when there is **no**
 * snapshot: it must fall back to the live recipe rather than read as a
 * requirement of zero, because that is every job raised before this existed
 * and every job whose product had no recipe at the time.
 */

let seq = 0;

const material = (name: string) => Number((db.prepare(
  "INSERT INTO materials (name, unit, category) VALUES (?, 'kg', 'resin') RETURNING id"
).get(`${name} ${++seq}`) as { id: number }).id);

const product = () => Number((db.prepare(
  "INSERT INTO products (name, unit, unit_price) VALUES (?, 'per 1000', 10) RETURNING id"
).get(`Cap ${++seq}`) as { id: number }).id);

/** Rewrite a product's recipe whole, as the route does. */
function recipe(productId: number, lines: [number, number, number?][]) {
  db.prepare('DELETE FROM product_materials WHERE product_id = ?').run(productId);
  lines.forEach(([mat, per1000, wastage], i) => db.prepare(
    `INSERT INTO product_materials (product_id, material_id, qty_per_1000, wastage_pct, sort_order)
     VALUES (?, ?, ?, ?, ?)`
  ).run(productId, mat, per1000, wastage ?? 0, i));
}

function job(productId: number | null, planned = 100000): number {
  const orderId = Number((db.prepare(
    `INSERT INTO orders (number, date, customer_id, currency, tax_type, status)
     VALUES (?, '2026-09-01', ?, 'INR', 'igst', 'confirmed') RETURNING id`
  ).get(`SO/RS-${++seq}`, makeCustomer()) as { id: number }).id);
  return Number((db.prepare(
    `INSERT INTO work_orders (number, order_id, order_line, product_id, qty_planned, status)
     VALUES (?, ?, 0, ?, ?, 'released') RETURNING id`
  ).get(`WO/RS-${seq}`, orderId, productId, planned) as { id: number }).id);
}

const qtyOf = (r: { lines: { qty: number }[] }) => r.lines.map((l) => l.qty);

describe('a job keeps the recipe it was raised on', () => {
  test('editing the product afterwards does not restate what the job needs', () => {
    const m = material('HDPE');
    const p = product();
    recipe(p, [[m, 119]]);
    const w = job(p);
    snapshotRecipe(w, p);
    assert.deepEqual(qtyOf(requirementForJob(w, p, 100000)), [11900]);

    // Somebody corrects the recipe in March.
    recipe(p, [[m, 130]]);
    assert.deepEqual(qtyOf(requirementForJob(w, p, 100000)), [11900], 'the open job drifted with the recipe');
    // The product itself, asked directly, of course moves.
    assert.deepEqual(qtyOf(requirementFor(p, 100000)), [13000]);
  });

  test('and that includes a material being added to or dropped from it', () => {
    const [a, b] = [material('HDPE'), material('Masterbatch')];
    const p = product();
    recipe(p, [[a, 119]]);
    const w = job(p);
    snapshotRecipe(w, p);
    recipe(p, [[a, 119], [b, 4]]);
    assert.equal(requirementForJob(w, p, 100000).lines.length, 1, 'a material added later reached an open job');
    recipe(p, []);
    assert.equal(requirementForJob(w, p, 100000).hasRecipe, true, 'emptying the recipe uncosted an open job');
  });

  test('wastage rides along with the figures', () => {
    const m = material('HDPE');
    const p = product();
    recipe(p, [[m, 100, 5]]);
    const w = job(p);
    snapshotRecipe(w, p);
    assert.deepEqual(qtyOf(requirementForJob(w, p, 100000)), [10500]);
    recipe(p, [[m, 100, 20]]);
    assert.deepEqual(qtyOf(requirementForJob(w, p, 100000)), [10500]);
  });
});

describe('no snapshot falls back, and never reads as zero', () => {
  /** Every job raised before this existed. */
  test('a job with nothing stamped is answered by the live recipe', () => {
    const m = material('HDPE');
    const p = product();
    recipe(p, [[m, 119]]);
    const w = job(p);                       // deliberately not snapshotted
    const got = requirementForJob(w, p, 100000);
    assert.equal(got.snapshot, false);
    assert.deepEqual(qtyOf(got), [11900]);
    // ...and it tracks the live recipe, which is right: it never had one taken.
    recipe(p, [[m, 130]]);
    assert.deepEqual(qtyOf(requirementForJob(w, p, 100000)), [13000]);
  });

  /**
   * A job raised for a product that had no recipe stamps nothing — so a recipe
   * recorded later still reaches it. Reading the empty stamp as the answer
   * would leave such a job uncosted for ever.
   */
  test('a product with no recipe stamps nothing, and picks one up later', () => {
    const p = product();
    const w = job(p);
    snapshotRecipe(w, p);
    assert.equal(recipeForJob(w).length, 0);
    assert.equal(requirementForJob(w, p, 100000).hasRecipe, false, 'an uncosted job claimed a requirement');

    const m = material('HDPE');
    recipe(p, [[m, 119]]);
    const got = requirementForJob(w, p, 100000);
    assert.equal(got.hasRecipe, true, 'a recipe recorded later never reached the job that had none');
    assert.equal(got.snapshot, false);
    assert.deepEqual(qtyOf(got), [11900]);
  });

  test('a job naming no product at all is unanswerable, not zero', () => {
    const w = job(null);
    snapshotRecipe(w, null);
    assert.equal(requirementForJob(w, null, 100000).hasRecipe, false);
  });
});

describe('saying when the two have parted', () => {
  test('a stamped job that still matches does not differ', () => {
    const m = material('HDPE');
    const p = product();
    recipe(p, [[m, 119]]);
    const w = job(p);
    snapshotRecipe(w, p);
    assert.equal(recipeDiffers(w, p), false);
  });

  test('and one whose product has moved does', () => {
    const m = material('HDPE');
    const p = product();
    recipe(p, [[m, 119]]);
    const w = job(p);
    snapshotRecipe(w, p);
    recipe(p, [[m, 130]]);
    assert.equal(recipeDiffers(w, p), true);
    // Re-stamping is the way back, and is the only thing that moves a job on.
    snapshotRecipe(w, p);
    assert.equal(recipeDiffers(w, p), false);
    assert.deepEqual(qtyOf(requirementForJob(w, p, 100000)), [13000]);
  });

  /** Order is not a difference: the same lines written in another sequence. */
  test('re-ordering the same lines is not a difference', () => {
    const [a, b] = [material('HDPE'), material('Masterbatch')];
    const p = product();
    recipe(p, [[a, 119], [b, 4]]);
    const w = job(p);
    snapshotRecipe(w, p);
    recipe(p, [[b, 4], [a, 119]]);
    assert.equal(recipeDiffers(w, p), false);
  });

  /** A job reading the live recipe is not stale — it never had one stamped. */
  test('a job with no snapshot never differs', () => {
    const m = material('HDPE');
    const p = product();
    recipe(p, [[m, 119]]);
    const w = job(p);
    recipe(p, [[m, 130]]);
    assert.equal(recipeDiffers(w, p), false);
  });
});
