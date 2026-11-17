import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { outputRates, outputRateFor, NO_RATE_SQL } from '../src/services/outputRate.js';
import { makeCustomer, makeOrder } from './helpers/factory.js';

/**
 * How fast a product is made — the figure the production planner computes a
 * job's length from (2026-11-16).
 *
 * Most of these are about the two ways a rate can be quietly wrong: measured
 * in the wrong currency, which makes every duration short, or measured per
 * shift rather than per day, which halves them on a plant that runs two.
 */

let seq = 0;
const product = (name = `Rate product ${++seq}`, pcsPerDay: number | null = null): number =>
  Number((db.prepare('INSERT INTO products (name, pcs_per_day) VALUES (?, ?) RETURNING id')
    .get(name, pcsPerDay) as { id: number }).id);

function job(productId: number | null, qty = 1_00_000): number {
  const order = makeOrder({ customerId: makeCustomer(), currency: 'INR' });
  return Number((db.prepare(
    `INSERT INTO work_orders (number, order_id, order_line, product_id, qty_planned)
     VALUES (?, ?, 0, ?, ?) RETURNING id`
  ).get(`WO/R-${++seq}`, order, productId, qty) as { id: number }).id);
}

/** A shift booked against a job, optionally into a lot. */
function shift(jobId: number, date: string, ok: number, o: Partial<{ shift: string; reject: number; batchId: number }> = {}) {
  db.prepare(
    `INSERT INTO production_entries (work_order_id, batch_id, date, shift, qty_ok, qty_reject)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(jobId, o.batchId ?? null, date, o.shift ?? 'A', ok, o.reject ?? 0);
}

/** A lot on that job, scrapped and never dispatched — so its output is gone. */
function scrappedLot(jobId: number): number {
  return Number((db.prepare(
    `INSERT INTO batches (work_order_id, number, date, disposition) VALUES (?, ?, '2026-11-01', 'scrapped') RETURNING id`
  ).get(jobId, `B/R-${++seq}`) as { id: number }).id);
}

const rateOf = (p: number) => outputRates([p]).get(p) ?? null;

describe('the measured output rate', () => {
  test('is good pieces over the days they were booked on', () => {
    const p = product();
    const w = job(p);
    shift(w, '2026-11-01', 20_000);
    shift(w, '2026-11-02', 30_000);
    const r = rateOf(p)!;
    assert.equal(r.pcs_per_day, 25_000);
    assert.equal(r.source, 'measured');
    assert.equal(r.days, 2);
    assert.equal(r.last_run, '2026-11-02');
  });

  /**
   * The plant runs two shifts a day — their own COA reads *05032026A+B* — so
   * counting entries rather than days would halve every duration computed
   * from this.
   */
  test('two shifts on one day are one day', () => {
    const p = product();
    const w = job(p);
    shift(w, '2026-11-01', 20_000, { shift: 'A' });
    shift(w, '2026-11-01', 20_000, { shift: 'B' });
    const r = rateOf(p)!;
    assert.equal(r.days, 1);
    assert.equal(r.pcs_per_day, 40_000);
  });

  /*
   * **The median, not the mean**, and these are the cases that say why
   * (2026-11-17). The client's first screenful of the planner read
   * 3,57,500/day for a 28mm preform and 25,01,125/day for a cap beside
   * neighbours at 48,666 — the signature of one bulk or back-dated entry in
   * an average, which adds a week to the numerator and one day to the
   * denominator.
   */
  test('one bulk entry does not drag the rate up', () => {
    const p = product();
    const w = job(p);
    for (const d of ['01', '02', '03', '04']) shift(w, `2026-11-${d}`, 40_000);
    shift(w, '2026-11-05', 15_00_000);           // a week keyed to one date
    const r = rateOf(p)!;
    assert.equal(r.pcs_per_day, 40_000, 'the bulk day set the rate');
    // The average rides along, because the gap between the two *is* the
    // evidence that the shift book holds an entry worth correcting.
    assert.equal(r.mean_per_day, 3_32_000);
    assert.equal(r.best_day, 15_00_000);
    assert.equal(r.days, 5);
  });

  /** On a book with nothing odd in it the two agree, so nothing moves. */
  test('and on an honest shift book it is the average', () => {
    const p = product();
    const w = job(p);
    for (const d of ['01', '02', '03']) shift(w, `2026-11-${d}`, 50_000);
    const r = rateOf(p)!;
    assert.equal(r.pcs_per_day, 50_000);
    assert.equal(r.mean_per_day, 50_000);
  });

  /** An even count takes the middle of the two middles. */
  test('an even number of days takes the middle pair', () => {
    const p = product();
    const w = job(p);
    shift(w, '2026-11-01', 10_000);
    shift(w, '2026-11-02', 20_000);
    shift(w, '2026-11-03', 30_000);
    shift(w, '2026-11-04', 1_00_000);
    assert.equal(rateOf(p)!.pcs_per_day, 25_000);
  });

  /**
   * A day that produced nothing good is evidence **against** the rate, so it
   * counts as a zero rather than being dropped — dropping it would raise the
   * figure on the very evidence that should lower it.
   */
  test('a day with nothing good to show counts as a zero', () => {
    const p = product();
    const w = job(p);
    shift(w, '2026-11-01', 60_000);
    shift(w, '2026-11-02', 50_000, { batchId: scrappedLot(w) });
    shift(w, '2026-11-03', 40_000);
    assert.equal(rateOf(p)!.pcs_per_day, 40_000, 'the condemned day was dropped rather than counted');
  });

  /**
   * And where the typical day is nothing there is **no rate**, not a rate of
   * zero — the `hasRecipe: false` rule, and the one figure that would make a
   * job take for ever. The planner names the row and asks for a figure.
   */
  test('a product whose typical day yields nothing has no rate at all', () => {
    const p = product();
    const w = job(p);
    const lot = scrappedLot(w);
    shift(w, '2026-11-01', 50_000, { batchId: lot });
    shift(w, '2026-11-02', 50_000, { batchId: lot });
    shift(w, '2026-11-03', 90_000);
    assert.equal(rateOf(p), null);
  });

  /** It is the product's rate, not one job's: the same item pools. */
  test('every job of the product pools into one rate', () => {
    const p = product();
    shift(job(p), '2026-11-01', 10_000);
    shift(job(p), '2026-11-02', 30_000);
    assert.equal(rateOf(p)!.pcs_per_day, 20_000);
  });

  /**
   * **The currency has to match the target.** A job's balance is
   * `qty_planned − LIVE_OK`, so a rate measured over output a later decision
   * condemned would be a rate of pieces that no longer exist — and every
   * duration computed from it short.
   */
  test('a scrapped lot does not flatter it', () => {
    const p = product();
    const w = job(p);
    shift(w, '2026-11-01', 20_000);
    shift(w, '2026-11-02', 80_000, { batchId: scrappedLot(w) });
    const r = rateOf(p)!;
    assert.equal(r.pcs_per_day, 10_000, 'the condemned 80,000 was counted');
    assert.equal(r.days, 2, 'the day it was booked on still happened');
  });

  /** Rejects are not good pieces, and a rate of good pieces leaves them out. */
  test('rejects are not counted', () => {
    const p = product();
    shift(job(p), '2026-11-01', 9_000, { reject: 1_000 });
    assert.equal(rateOf(p)!.pcs_per_day, 9_000);
  });

  /**
   * Never a guess and never zero — the `hasRecipe: false` rule. A zero would
   * make every job of it infinitely long rather than undatable, which is the
   * worse of the two failures because it looks like an answer.
   */
  test('a product that has never run and states nothing has no rate at all', () => {
    const p = product();
    assert.equal(rateOf(p), null);
    assert.equal(outputRateFor(p), null);
    assert.equal(outputRateFor(null), null);
  });

  test('and a day that produced nothing good is not a rate of zero', () => {
    const p = product();
    const w = job(p);
    shift(w, '2026-11-01', 5_000, { batchId: scrappedLot(w) });
    assert.equal(rateOf(p), null, 'a rate of 0 would be a job that never finishes');
  });
});

describe('the stated output rate', () => {
  test('fills the gap for a product that has never run', () => {
    const p = product(`Stated ${++seq}`, 50_000);
    const r = rateOf(p)!;
    assert.equal(r.pcs_per_day, 50_000);
    assert.equal(r.source, 'stated');
    assert.equal(r.days, 0);
  });

  /**
   * **It wins over the measurement** (2026-11-16, the client having read a
   * measured 3,57,500/day off their own book: *"Yes, make the typed figure
   * win"*). It shipped the other way round that morning; the measurement is a
   * mean over the days a shift was booked, so one bulk or back-dated entry
   * pulls it up hard, and measured-first left no way to say so.
   */
  test('and it beats the shift book, which is what makes it an override', () => {
    const p = product(`Both ${++seq}`, 50_000);
    shift(job(p), '2026-11-01', 12_000);
    const r = rateOf(p)!;
    assert.equal(r.pcs_per_day, 50_000);
    assert.equal(r.source, 'stated');
  });

  /**
   * And the measurement rides along, so the screen can print the override
   * against the thing it overrides rather than quietly replacing it.
   */
  test('carrying what the shift book said, so the override can be read against it', () => {
    const p = product(`Evidence ${++seq}`, 50_000);
    const w = job(p);
    shift(w, '2026-11-01', 10_000);
    shift(w, '2026-11-02', 30_000);
    const r = rateOf(p)!;
    assert.equal(r.pcs_per_day, 50_000);
    assert.deepEqual(r.measured, {
      pcs_per_day: 20_000, mean_per_day: 20_000, best_day: 30_000, days: 2, last_run: '2026-11-02',
    });
  });

  /** A product nobody has run has nothing to show beside the typed figure. */
  test('and nothing to show beside it where the product has never run', () => {
    const p = product(`Alone ${++seq}`, 50_000);
    assert.equal(rateOf(p)!.measured, undefined);
  });

  /** A measured rate *is* the measurement — there is nothing to say twice. */
  test('a measured rate carries no second copy of itself', () => {
    const p = product();
    shift(job(p), '2026-11-01', 7_000);
    const r = rateOf(p)!;
    assert.equal(r.source, 'measured');
    assert.equal(r.measured, undefined);
  });

  /** Blank is not zero — the rule `masters.ts` states about `cavities`. */
  test('a blank figure is no answer rather than a rate of nothing', () => {
    const p = product();
    db.prepare('UPDATE products SET pcs_per_day = NULL WHERE id = ?').run(p);
    assert.equal(rateOf(p), null);
    db.prepare('UPDATE products SET pcs_per_day = 0 WHERE id = ?').run(p);
    assert.equal(rateOf(p), null, 'a stated zero is not a rate either');
  });

  /**
   * The one thing a stated figure must not do is bring a product back from
   * *no rate*: blank and zero are both *not stated*, so a product with
   * neither falls through to nothing at all rather than to a job that never
   * finishes.
   */
  test('several products are answered in one call, and one with nothing is simply absent', () => {
    const measured = product();
    shift(job(measured), '2026-11-01', 7_000);
    const stated = product(`Stated ${++seq}`, 3_000);
    const neither = product();
    const got = outputRates([measured, stated, neither, 0, -1]);
    assert.deepEqual([...got.keys()].sort((a, b) => a - b), [measured, stated].sort((a, b) => a - b));
  });
});

/** The clause behind the Products page's *N with no output rate* chip. */
describe('which products the catalogue cannot date a job for', () => {
  const noRate = (id: number) => Number((db.prepare(
    `SELECT COUNT(*) AS c FROM products WHERE id = ? AND ${NO_RATE_SQL}`
  ).get(id) as { c: number }).c) === 1;

  test('names the ones with neither a measurement nor a figure', () => {
    const bare = product();
    const stated = product(`Stated ${++seq}`, 1_000);
    const run = product();
    shift(job(run), '2026-11-01', 1_000);
    assert.equal(noRate(bare), true);
    assert.equal(noRate(stated), false);
    assert.equal(noRate(run), false, 'a product the floor has run needs no typed figure');
  });
});
