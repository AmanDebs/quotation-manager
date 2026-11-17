import { db } from '../db/connection.js';
import { LIVE_OK } from './production.js';
import { round2 } from './totals.js';

/**
 * How fast a product is made — the fact the whole production plan was missing
 * (2026-11-16, the client: *"My team is finding it [hard] to fill the planned
 * dates for production in the current format, look a better way to plan our
 * production."*).
 *
 * Filling in a job's dates means knowing how long the job takes, and until
 * now **nothing in this app held that**: no cycle time, no capacity, and
 * `moulds.cavities` carries a comment saying it is deliberately not used for
 * any capacity arithmetic. So the planner did the arithmetic in their head,
 * once per job, eighty-odd times — which is why 65 of 84 jobs on the live
 * book carry no dates at all. This is the figure that lets the app do it.
 *
 * **The answer was already in the database.** `production_entries` is every
 * shift the floor has ever booked, and `work_orders.product_id` says what
 * each of them was making — so for any product that has run before, how fast
 * it goes is **measured, with nobody typing anything**, and it gets truer
 * every time a shift is logged. That measurement is the **default**; a figure
 * typed on the product overrides it, for the reasons `outputRates` gives.
 */

export interface Measured {
  /**
   * The rate itself: the **median** of the days booked, not their average.
   * See `measuredRates` for why the average could not be used.
   */
  pcs_per_day: number;
  /**
   * The plain average over the same days. Carried so the screen can print the
   * two against each other: a mean far above the median *is* the signal that
   * the shift book holds a bulk or back-dated entry, which is worth correcting
   * at the source rather than working around here.
   */
  mean_per_day: number;
  /** The best single day booked -- how far the tail reaches. */
  best_day: number;
  /** Days of shift book behind it, and the last of them. */
  days: number;
  last_run: string;
}

export interface OutputRate {
  product_id: number;
  /** Good pieces a production day. */
  pcs_per_day: number;
  /** Where the figure came from — the screen says which, so it can be judged. */
  source: 'measured' | 'stated';
  /** Days of shift book behind a measured rate; 0 for a stated one. */
  days: number;
  /** The last day booked, so a stale measurement can be seen to be stale. */
  last_run: string;
  /**
   * On a **measured** rate, the same two figures `Measured` carries — the
   * plain average over those days and the best single one — so the screen can
   * show what the median was taken over. A **stated** rate has no average of
   * its own; its evidence is under `measured`, exactly as `days` and
   * `last_run` already work.
   */
  mean_per_day?: number;
  best_day?: number;
  /**
   * What the shift book says, where a **stated** figure is being used instead
   * — so an override can be read against the thing it overrides rather than
   * silently replacing it. Absent on a measured rate, where it *is* the rate.
   */
  measured?: Measured;
}

/**
 * **Good pieces per production day**, pooled over every job of that product.
 *
 * Four decisions, each of which is wrong in a way that would be invisible:
 *
 * **`LIVE_OK`, not raw `qty_ok`.** A job's target is *good* pieces — the
 * balance `progressFor` reports is `qty_planned − LIVE_OK` — so the rate has
 * to be in the same currency or every duration computed from it is short. A
 * scrapped lot must not flatter the rate it is measured by.
 *
 * **A day, not a shift.** The rows are folded to one figure per date however
 * many shifts were booked on it, which is what a plan is in: this plant runs
 * two shifts (their own COA reads *05032026A+B*), and a rate per shift would
 * halve every duration.
 *
 * **The median of those days, not their average** (2026-11-17). This shipped
 * as a mean, and the client's own first screenful is what disproved it: a
 * 28mm preform read **3,57,500/day** and a cap **25,01,125/day**, against
 * neighbouring products at 48,666 and 52,336. The cause is structural rather
 * than one bad row — an average is `total ÷ days`, so **one** bulk or
 * back-dated entry (a week's output keyed to a single date) adds a week to
 * the numerator and **one** to the denominator and drags the figure up
 * severalfold. Measured on a planted book: four honest days of 40,000 beside
 * one entry of 15,00,000 averages **3,32,000/day**, so a job of a lakh is
 * planned at one day where it takes two and a half — and every job behind it
 * in the queue inherits the error, because they are laid end to end. The
 * median of those same five days is **40,000**, which is what the floor
 * actually does in a day. A planning rate has to be the typical day rather
 * than the arithmetic mean of a skewed distribution.
 *
 * **Not windowed**, deliberately. A rate from a year ago is still the best
 * evidence there is, and dropping it would leave a product that ran last
 * season with no rate at all. `days` and `last_run` ride the answer instead,
 * so the screen can say how much is behind it and how old it is, and the
 * person reading can disagree. `mean_per_day` rides it too, because the gap
 * between the two is exactly the evidence that the shift book holds a bulk
 * entry worth correcting at the source.
 */
const MEASURED_SQL = `
  SELECT w.product_id AS product_id,
         e.date       AS date,
         SUM(${LIVE_OK('e')}) AS pieces
    FROM production_entries e
    JOIN work_orders w ON w.id = e.work_order_id
   WHERE w.product_id IS NOT NULL AND e.date <> ''`;

/**
 * The middle of a list of day figures — the textbook median, averaging the
 * two middles on an even count. Taking the lower instead would bias every
 * duration long for a reason nobody could read off the screen.
 */
function median(sorted: number[]): number {
  const n = sorted.length;
  if (!n) return 0;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** What the shift book says about each product named, where it says anything. */
export function measuredRates(productIds: number[]): Map<number, Measured> {
  const ids = [...new Set(productIds.filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map<number, Measured>();
  if (!ids.length) return out;
  /*
   * One row per product per day, folded here rather than in SQL: SQLite has no
   * median aggregate, and the alternative — a window function over a row
   * count and an offset — would state the rule in a form nobody can check by
   * reading it. The row count is bounded by the products asked about (a page
   * of the catalogue, or the products in one planning queue) times the days
   * each has run, and both are small on any book this app will see.
   */
  const rows = db.prepare(
    `${MEASURED_SQL} AND w.product_id IN (${ids.map(() => '?').join(',')})
      GROUP BY w.product_id, e.date`
  ).all(...(ids as never[])) as Record<string, unknown>[];

  const byProduct = new Map<number, { days: number[]; last: string }>();
  for (const r of rows) {
    /*
     * **A day whose output was all condemned counts, as a zero.** It is a real
     * day on which the plant ran and produced no good pieces, and the rate is
     * in good pieces — so dropping it would raise the figure on exactly the
     * evidence that should lower it, and every duration computed from it would
     * come out short. This was wrong in the first cut of the median and the
     * scrapped-lot case is what caught it.
     */
    const id = Number(r.product_id);
    const bucket = byProduct.get(id) ?? { days: [], last: '' };
    bucket.days.push(Math.max(0, Number(r.pieces) || 0));
    const d = String(r.date ?? '');
    if (d > bucket.last) bucket.last = d;
    byProduct.set(id, bucket);
  }

  for (const [id, { days, last }] of byProduct) {
    const sorted = [...days].sort((a, b) => a - b);
    const mid = round2(median(sorted));
    /*
     * A typical day of nothing is no rate at all, not a rate of zero — the
     * `hasRecipe: false` rule, and the one figure that would make a job take
     * for ever. The product reads as unmeasured and the screen asks for a
     * figure, which is the honest answer when the shift book does not support
     * one.
     */
    if (!(mid > 0)) continue;
    const total = sorted.reduce((sum, n) => sum + n, 0);
    out.set(id, {
      pcs_per_day: mid,
      mean_per_day: round2(total / sorted.length),
      best_day: round2(sorted[sorted.length - 1]),
      days: sorted.length,
      last_run: last,
    });
  }
  return out;
}

/**
 * The rate for each product named, or no entry at all where the record is
 * silent — **never a guess and never 0**, the rule `hasRecipe: false` states
 * about an uncosted product and `products.weight_grams` about an unrecorded
 * weight. A job whose product has no rate is one the planner dates by hand,
 * and the screen says so; a zero would be a duration of infinity.
 *
 * **A stated figure wins, and the measurement is the default under it**
 * (2026-11-16, the client, having read a measured 3,57,500/day off their own
 * book: *"Yes, make the typed figure win"*). It shipped the other way round
 * that morning, on their own answer when asked, and the first screenful
 * showed why that was wrong: the measurement is a **mean over the days a
 * shift was booked**, so one bulk or back-dated entry — a week's output keyed
 * to a single date — pulls it up hard, and under measured-first there was no
 * way to say so. A box that is ignored wherever it would matter is not an
 * override.
 *
 * So this is the rule the rest of this codebase already follows about a
 * derived figure: **what somebody typed beats what was worked out**. The
 * packing weights, the box counts and the shipping marks all say the same
 * thing — what the scale said beats what the catalogue guessed. And the
 * measurement is still what fills the box for every product nobody has typed
 * one for, which on this catalogue is nearly all of them.
 *
 * Where a stated figure overrides a real measurement, **the measurement rides
 * along** so the screen can print the override against the thing it overrides
 * rather than quietly replacing it.
 */
export function outputRates(productIds: number[]): Map<number, OutputRate> {
  const ids = [...new Set(productIds.filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map<number, OutputRate>();
  if (!ids.length) return out;

  const measured = measuredRates(ids);
  const stated = db.prepare(
    `SELECT id, pcs_per_day FROM products WHERE pcs_per_day IS NOT NULL AND pcs_per_day > 0 AND id IN (${ids.map(() => '?').join(',')})`
  ).all(...(ids as never[])) as Record<string, unknown>[];
  for (const r of stated) {
    const id = Number(r.id);
    const evidence = measured.get(id);
    out.set(id, {
      product_id: id,
      pcs_per_day: round2(Number(r.pcs_per_day) || 0),
      source: 'stated',
      days: 0,
      last_run: '',
      ...(evidence ? { measured: evidence } : {}),
    });
  }
  for (const [id, m] of measured) {
    if (out.has(id)) continue;
    out.set(id, { product_id: id, source: 'measured', ...m });
  }
  return out;
}

/** One product's rate, for a screen that is about one product. */
export const outputRateFor = (productId: number | null): OutputRate | null =>
  (productId ? outputRates([productId]).get(productId) ?? null : null);

/**
 * How many products the catalogue could state a rate for and does not — the
 * figure behind the Products page's *N with no output rate* chip, in the
 * shape of the three gap counts beside it.
 */
export const NO_RATE_SQL =
  `products.pcs_per_day IS NULL AND NOT EXISTS (
     SELECT 1 FROM production_entries e JOIN work_orders w ON w.id = e.work_order_id
      WHERE w.product_id = products.id AND e.date <> '' AND ${LIVE_OK('e')} > 0)`;
