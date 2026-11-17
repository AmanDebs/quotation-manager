import { addDaysIso, daysBetweenIso } from './months.js';
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
  /**
   * Where that date came from, so the screen can say whether it is reading a
   * promise or the plant's own plan, and can tell *nobody has dated this
   * order* from *this column does not work* — which is what an em-dash on
   * every row reads as.
   */
  due_source: DueSource;
}

/** @see ORDER_DUE_SOURCE */
export type DueSource = 'order' | 'line' | 'jobs' | 'none';

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
  /**
   * By how many days — 0 where it is not late. *Three days* and *seven weeks*
   * are different problems and a planner sorting out a queue has to be able to
   * tell them apart without subtracting two dates in their head, which is the
   * same complaint the order book's own slip column answers.
   */
  late_days: number;
  blocked: PlanBlock | null;
}

/**
 * What the whole plan comes to, so the decision does not sit below however
 * many rows the queue happens to have. Every figure here is over the jobs
 * that **can** be dated; the blocked ones are counted and nothing else, since
 * they occupy no time and commit nothing.
 */
export interface PlanSummary {
  /** Jobs the plan dates, and jobs it cannot. */
  jobs: number;
  blocked: number;
  /** Of the dated ones, how many finish after the customer's date. */
  late: number;
  /** How many have no customer date to be judged against at all. */
  undated: number;
  /** Pieces the plan commits to making, and the production days to make them. */
  pieces: number;
  days: number;
  /** The span the plan occupies — blank where it dates nothing. */
  from: string;
  to: string;
}

/** Fold a laid-out queue into the figures the planner decides on. */
export function summarise(plan: PlannedJob[]): PlanSummary {
  const dated = plan.filter((p) => !p.blocked);
  return {
    jobs: dated.length,
    blocked: plan.length - dated.length,
    late: dated.filter((p) => p.late).length,
    // Counted over the dated rows alone: a job nobody can date is already
    // named for its own reason, and counting it here too would report one
    // problem twice.
    undated: dated.filter((p) => !p.due).length,
    pieces: dated.reduce((sum, p) => sum + p.pieces, 0),
    days: dated.reduce((sum, p) => sum + (p.days ?? 0), 0),
    from: dated[0]?.planned_start ?? '',
    // The last **finish**, which on a queue laid end to end is the last row's
    // — but taken as a maximum rather than off the tail, so this stays true
    // of any order the rows arrive in.
    to: dated.reduce((last, p) => (p.planned_end > last ? p.planned_end : last), ''),
  };
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
    const base = { ...j, rate, days: null, planned_start: '', planned_end: '', late: false, late_days: 0 };
    if (!(j.pieces > 0)) return { ...base, blocked: 'nothing-left' as const };
    if (!rate || !(rate.pcs_per_day > 0)) return { ...base, blocked: 'no-rate' as const };

    // At least a day: a job of two hundred pieces still occupies the machine
    // for a setup and a run, and a duration of zero would put two jobs on one
    // day in a queue that is one at a time by construction.
    const days = Math.max(1, Math.ceil(j.pieces / rate.pcs_per_day));
    const planned_start = cursor;
    const planned_end = addDaysIso(planned_start, days - 1);
    cursor = addDaysIso(planned_end, 1);
    const late = !!j.due && !!planned_end && planned_end > j.due;
    return {
      ...base,
      days,
      planned_start,
      planned_end,
      late,
      late_days: late ? daysBetweenIso(j.due as string, planned_end) : 0,
      blocked: null,
    };
  });
}

/** Soonest customer date first; an order nobody has dated sorts last. */
export const byDue = (a: QueueJob, b: QueueJob): number =>
  (a.due || '9999').localeCompare(b.due || '9999') || a.number.localeCompare(b.number);

/**
 * How to open the queue.
 *
 * **A policy, not a drag.** Nudging a row a place at a time is right for the
 * last correction and no use at all for the first pass: the client's own
 * screen opens on **47** jobs, and moving the fortieth to the front is
 * thirty-nine presses. A planner picks a rule — by what the customer needs,
 * by what clears the floor fastest, by keeping one sales order together —
 * and then nudges the two rows the rule got wrong.
 *
 * The rules live here beside `layOutQueue` rather than on the screen, because
 * a comparator on the client would be a second opinion about the order the
 * dates were computed in, and the two would be read off one table.
 */
export type SortKey = 'due' | 'shortest' | 'longest' | 'order';

/**
 * Jobs with nothing left to make have no size to be sorted by, and sort last
 * under either size rule rather than first — a zero is an absence here, not
 * the smallest job on the book.
 */
const size = (j: QueueJob) => (j.pieces > 0 ? j.pieces : Number.MAX_SAFE_INTEGER);

export const SORTS: Record<SortKey, (a: QueueJob, b: QueueJob) => number> = {
  due: byDue,
  // Ties break on the job number throughout, so the same book in the same
  // order always lays out the same way — the total-ordering rule the paged
  // lists in this app already follow, for the same reason.
  shortest: (a, b) => size(a) - size(b) || a.number.localeCompare(b.number),
  longest: (a, b) => size(b) - size(a) || a.number.localeCompare(b.number),
  order: (a, b) => a.order_number.localeCompare(b.order_number) || a.number.localeCompare(b.number),
};
