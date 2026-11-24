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
 * 2026-09-25 at their word).
 *
 * **But the plant runs more than one job at a time**, and until 2026-11-17
 * this file assumed it ran exactly one. That assumption is what made the
 * plan unusable at the size of a real book rather than a fixture: at the
 * rates their own shift book reports, the open order book on the client's
 * screen is something over two years of work on a single line. `lanes` is
 * how many jobs the plant carries at once — **measured** from the shift book
 * by `plantLanes()`, never guessed — and it takes nothing back from the
 * removal of the Machine field: one number about the whole plant, nothing
 * stored on a job, and no queue per machine.
 *
 * It defaults to **one**, which is this function exactly as it was, so every
 * figure measured before it existed still holds.
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
  /**
   * The job's own four date columns as it holds them **now**.
   *
   * The screen stages each computed date into the column the job's state
   * allows — `planned_X` while that column is blank and `revised_X` after,
   * which is the rule `plannedDateError` guards with — and it decided that
   * from the row it had drawn. Once the queue is the whole plant's rather
   * than the page's, **most of these jobs are not on screen**, so the row
   * travels with the plan. It is the same rule applied by the same function
   * on the same four values, not a second opinion about where a date goes.
   */
  current: JobDates;
}

export interface JobDates {
  planned_start: string;
  planned_end: string;
  revised_start: string;
  revised_end: string;
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
  /**
   * Pieces the plan commits to making, and the **line-days** to make them —
   * the sum of each job's own duration, which on a plant of several lines is
   * longer than the span below rather than equal to it. Two different facts,
   * and the screen names them differently: how much line time the work costs,
   * and how long the calendar takes to absorb it.
   */
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
    // A minimum rather than the first row's, for the reason `to` is a
    // maximum: on a plant of several lines the first job in the queue is the
    // one on the line that frees first, and taking either off the ends of the
    // list would be true only of a queue laid on one line.
    from: dated.reduce((first, p) => (!first || p.planned_start < first ? p.planned_start : first), ''),
    // The last **finish**, which on a queue laid end to end is the last row's
    // — but taken as a maximum rather than off the tail, so this stays true
    // of any order the rows arrive in.
    to: dated.reduce((last, p) => (p.planned_end > last ? p.planned_end : last), ''),
  };
}

/**
 * How big the plant is, and what is already on it. Both default to the single
 * empty line this function assumed before 2026-11-17, so a caller that says
 * nothing gets exactly the behaviour every earlier measurement was taken
 * against.
 */
export interface QueueShape {
  /** Jobs the plant runs at once — `plantLanes()`'s measured figure. */
  lanes?: number;
  /**
   * When each line comes free from the work already committed —
   * `linesFreeFrom()`. **This is what stops a second press planning on top of
   * the first**, which is the defect that made the planner unusable on a book
   * of more than one page: it laid every queue from the date it was given and
   * knew nothing about the dates already on the floor.
   */
  freeFrom?: string[];
  /**
   * Days the plant does not run (`shutdownDates()`), which a job's duration
   * steps over rather than counting.
   *
   * **Passed in rather than read**, so this file stays a pure function over
   * rows the route has already gathered — the same reason `lanes` and
   * `freeFrom` are arguments. And **empty by default**, which is what makes
   * it safe to land on a live book: with nothing in the set every date this
   * produces is the date it produced before, so the client's own answer that
   * the plant runs seven days (2026-11-16) still holds until somebody enters
   * a shut-down.
   */
  shutdowns?: Set<string>;
}

/** Nothing shut, which is the plant as the client described it. */
const OPEN: Set<string> = new Set();

/**
 * The first day from `d` the plant is actually open.
 *
 * Capped at a year's worth of steps: a calendar with every day shut is a
 * mistake somebody can make on one screen, and a scheduler that spins on it
 * would take the whole press down rather than reporting it. Past the cap the
 * day is returned as it stands, which lands the plan on a shut day — visibly
 * wrong, where a hang is not.
 */
function openFrom(d: string, closed: Set<string>): string {
  // Normalised through `addDaysIso` first, which answers '' to anything that
  // is not a date — so a start nobody can read goes on dating nothing rather
  // than being carried through as itself and printed as a plan. Caught by the
  // case that already asserted it, which is what that case is for.
  let day = addDaysIso(d, 0);
  for (let i = 0; i < 366 && day && closed.has(day); i++) day = addDaysIso(day, 1);
  return day;
}

/**
 * Where a run of `days` **production** days starting on an open day finishes.
 *
 * A shut-down inside a run pushes its finish out by a calendar day without
 * adding to the work, which is the whole point of the list: the job still
 * takes the days it takes. With nothing shut this is `start + days - 1`
 * exactly, which is what it has always been.
 */
function runEnd(start: string, days: number, closed: Set<string>): string {
  let day = start;
  for (let left = days - 1; left > 0; left--) day = openFrom(addDaysIso(day, 1), closed);
  return day;
}

/**
 * Lay the jobs out across the plant's lines from `start`, in the order given.
 *
 * `endᵢ = startᵢ + daysᵢ − 1`, and the next job on a line begins the morning
 * after the last one on it ended — no gap and no overlap **on any line**,
 * which is the invariant the tests assert across the whole queue rather than
 * per row. On one line that is a single chain, which is what this was.
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
  shape: QueueShape = {},
): PlannedJob[] {
  const lanes = Math.max(1, Math.floor(shape.lanes ?? 1) || 1);
  /*
   * One cursor per line: the day that line can take work, which is the day it
   * comes free from what is already committed, or the queue's own start where
   * that is later. A line nothing is committed to is free from the start, and
   * with one line and nothing committed this is `[start]` — the single cursor
   * this function used to carry.
   */
  const closed = shape.shutdowns ?? OPEN;
  const cursor = Array.from({ length: lanes }, (_, i) => {
    const free = shape.freeFrom?.[i] ?? '';
    return free > start ? free : start;
  });
  return jobs.map((j) => {
    const rate = j.product_id ? rates.get(j.product_id) ?? null : null;
    const base = { ...j, rate, days: null, planned_start: '', planned_end: '', late: false, late_days: 0 };
    if (!(j.pieces > 0)) return { ...base, blocked: 'nothing-left' as const };
    if (!rate || !(rate.pcs_per_day > 0)) return { ...base, blocked: 'no-rate' as const };

    // At least a day: a job of two hundred pieces still occupies the machine
    // for a setup and a run, and a duration of zero would put two jobs on one
    // day in a queue that is one at a time by construction.
    const days = Math.max(1, Math.ceil(j.pieces / rate.pcs_per_day));
    /*
     * **The line that frees first**, which is the whole of what `lanes` adds:
     * list scheduling, the way a planner reads a board. Ties take the lowest
     * index, so one book in one order always lays out the same way — the
     * total-ordering rule `SORTS` follows for its own reason.
     */
    let lane = 0;
    for (let i = 1; i < lanes; i++) if (cursor[i] < cursor[lane]) lane = i;
    // The line is free on that day, but the plant may not be open on it.
    const planned_start = openFrom(cursor[lane], closed);
    const planned_end = runEnd(planned_start, days, closed);
    cursor[lane] = addDaysIso(planned_end, 1);
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
