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
 * every time a shift is logged.
 */

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
}

/**
 * **Good pieces per production day**, pooled over every job of that product.
 *
 * Three decisions, each of which is wrong in a way that would be invisible:
 *
 * **`LIVE_OK`, not raw `qty_ok`.** A job's target is *good* pieces — the
 * balance `progressFor` reports is `qty_planned − LIVE_OK` — so the rate has
 * to be in the same currency or every duration computed from it is short. A
 * scrapped lot must not flatter the rate it is measured by.
 *
 * **A day, not a shift.** `COUNT(DISTINCT e.date)` counts a day however many
 * shifts were booked on it, which is what a plan is in: this plant runs two
 * shifts (their own COA reads *05032026A+B*), and a rate per shift would
 * halve every duration.
 *
 * **Not windowed**, deliberately. A rate from a year ago is still the best
 * evidence there is, and dropping it would leave a product that ran last
 * season with no rate at all. `days` and `last_run` ride the answer instead,
 * so the screen can say how much is behind it and how old it is, and the
 * person reading can disagree.
 */
const MEASURED_SQL = `
  SELECT w.product_id AS product_id,
         SUM(${LIVE_OK('e')}) AS pieces,
         COUNT(DISTINCT e.date) AS days,
         MAX(e.date) AS last_run
    FROM production_entries e
    JOIN work_orders w ON w.id = e.work_order_id
   WHERE w.product_id IS NOT NULL AND e.date <> ''`;

/**
 * The rate for each product named, or no entry at all where the record is
 * silent — **never a guess and never 0**, the rule `hasRecipe: false` states
 * about an uncosted product and `products.weight_grams` about an unrecorded
 * weight. A job whose product has no rate is one the planner dates by hand,
 * and the screen says so; a zero would be a duration of infinity.
 *
 * **Measured beats stated** (the client's own answer when asked): the shift
 * book is what the plant did, where the typed figure is what somebody
 * believes. The typed one is what covers a product that has never run — a new
 * mould, or the first order for an item — which is the gap measurement cannot
 * fill by its nature. One line here to flip the precedence if that is ever
 * wanted.
 */
export function outputRates(productIds: number[]): Map<number, OutputRate> {
  const ids = [...new Set(productIds.filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map<number, OutputRate>();
  if (!ids.length) return out;
  const marks = ids.map(() => '?').join(',');

  const measured = db.prepare(
    `${MEASURED_SQL} AND w.product_id IN (${marks}) GROUP BY w.product_id`
  ).all(...(ids as never[])) as Record<string, unknown>[];
  for (const r of measured) {
    const days = Number(r.days) || 0;
    const pieces = Number(r.pieces) || 0;
    // Output booked and then entirely condemned is a real day with nothing to
    // show for it; a rate of zero would make every job infinitely long, so the
    // product reads as unmeasured and falls through to its stated figure.
    if (days <= 0 || pieces <= 0) continue;
    out.set(Number(r.product_id), {
      product_id: Number(r.product_id),
      pcs_per_day: round2(pieces / days),
      source: 'measured',
      days,
      last_run: String(r.last_run ?? ''),
    });
  }

  const stated = db.prepare(
    `SELECT id, pcs_per_day FROM products WHERE pcs_per_day IS NOT NULL AND pcs_per_day > 0 AND id IN (${marks})`
  ).all(...(ids as never[])) as Record<string, unknown>[];
  for (const r of stated) {
    const id = Number(r.id);
    if (out.has(id)) continue;
    out.set(id, {
      product_id: id,
      pcs_per_day: round2(Number(r.pcs_per_day) || 0),
      source: 'stated',
      days: 0,
      last_run: '',
    });
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
