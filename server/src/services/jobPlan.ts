import { addDaysIso } from './months.js';
import type { OutputRate } from './outputRate.js';

/**
 * Laying a queue of jobs out on the calendar (2026-11-16, the client: *"look
 * a better way to plan our production"*).
 *
 * The planner says **what runs in what order and from when**; this works out
 * the dates. That is the whole reversal: filling in the grid asked somebody
 * to know how long each job takes and then do eighty-four small sums, which
 * is why 65 of 84 jobs on the live book carry no dates at all.
 *
 * **One queue for the whole plant** — the client's own answer when asked,
 * over a queue per machine. Nothing here knows about a machine, so nothing
 * had to come back onto a job (plant, machine, mould and process left it on
 * 2026-09-25 at their word), and two jobs never run at once.
 *
 * **Seven production days a week**, also their answer, which is why there is
 * no working-day calendar anywhere in this file: the arithmetic is plain
 * `addDaysIso`. A shut-down list is a later decision and is deliberately not
 * guessed at.
 *
 * A **pure function** over rows the route has already gathered — no `db`
 * import — so the rules are testable without the HTTP harness this codebase
 * does not have, the shape `computeTotals` and `fitmentPlan` already take.
 */

export interface QueueJob {
  id: number;
  number: string;
  product_id: number | null;
  customer_name: string;
  item: string;
  order_id: number;
  order_number: string;
  /**
   * Pieces **still to make** — `progressFor`'s balance, not `qty_planned`.
   * A job half made needs half the days, and planning the whole figure again
   * would push everything behind it out by days nobody is going to work.
   */
  pieces: number;
  /** When the customer needs it (`ORDER_DUE`), or null where nothing says. */
  due: string | null;
}

/** Why a job could not be dated. Null means it was. */
export type PlanBlock = 'no-rate' | 'nothing-left';

export interface PlannedJob extends QueueJob {
  rate: OutputRate | null;
  /** Production days, or null where the job could not be dated. */
  days: number | null;
  planned_start: string;
  planned_end: string;
  /** The plan finishes after the customer's own date. */
  late: boolean;
  blocked: PlanBlock | null;
}

/**
 * Lay the jobs out end to end from `start`, in the order given.
 *
 * `endᵢ = startᵢ + daysᵢ − 1` and `startᵢ₊₁ = endᵢ + 1`, so a one-day job
 * starts and finishes on the same day and the next one begins the morning
 * after — no gap and no overlap, which is the invariant the tests assert
 * across the whole queue rather than per row.
 *
 * **A job that cannot be dated takes no slot.** With no rate there is no
 * honest duration to give it (`hasRecipe: false`'s rule — never a guess,
 * never zero), and with nothing left to make there is no work to schedule;
 * either way the jobs after it keep the dates they would have had. Blocking
 * the queue on one unmeasured product would stall a whole press, and the
 * screen names these rows instead so somebody can state a rate or date them
 * by hand.
 *
 * **`late` is the reason this is worth building.** The app already knows when
 * every order is due (`ORDER_DUE`), so laying out a plan is also the first
 * screen in this app that can say *which promises it breaks* — the question a
 * planner actually has and which no amount of typing dates into a grid ever
 * answered. Finishing **on** the due date is not late.
 */
export function layOutQueue(
  jobs: QueueJob[],
  rates: Map<number, OutputRate>,
  start: string,
): PlannedJob[] {
  let cursor = start;
  return jobs.map((j) => {
    const rate = j.product_id ? rates.get(j.product_id) ?? null : null;
    const base = { ...j, rate, days: null, planned_start: '', planned_end: '', late: false };
    if (!(j.pieces > 0)) return { ...base, blocked: 'nothing-left' as const };
    if (!rate || !(rate.pcs_per_day > 0)) return { ...base, blocked: 'no-rate' as const };

    // At least a day: a job of two hundred pieces still occupies the machine
    // for a setup and a run, and a duration of zero would put two jobs on one
    // day in a queue that is one at a time by construction.
    const days = Math.max(1, Math.ceil(j.pieces / rate.pcs_per_day));
    const planned_start = cursor;
    const planned_end = addDaysIso(planned_start, days - 1);
    cursor = addDaysIso(planned_end, 1);
    return {
      ...base,
      days,
      planned_start,
      planned_end,
      late: !!j.due && !!planned_end && planned_end > j.due,
      blocked: null,
    };
  });
}

/** Soonest customer date first; an order nobody has dated sorts last. */
export const byDue = (a: QueueJob, b: QueueJob): number =>
  (a.due || '9999').localeCompare(b.due || '9999') || a.number.localeCompare(b.number);
