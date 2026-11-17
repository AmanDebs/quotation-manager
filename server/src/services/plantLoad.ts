import { db } from '../db/connection.js';
import { JOB_END } from './production.js';
import { addDaysIso } from './months.js';
import { round2 } from './totals.js';

/**
 * What the plant itself is doing — how many jobs it runs at once, and how far
 * ahead it is already committed (2026-11-17, the client with the Work Orders
 * grid in front of them, asking for the whole process to be made fit for a
 * large organisation).
 *
 * `outputRate.ts` answers *how fast is this product*; this answers *how big is
 * the plant and what is already on it*. Both are measured from the same shift
 * book and nothing here is stored, so both get truer every time a shift is
 * logged.
 *
 * **Why this had to exist.** `layOutQueue` laid a queue end to end from a date
 * — one job at a time, starting wherever it was told — and the planner was
 * handed one page of the list. Measured on a planted book of 63 jobs over two
 * pages: planning page one gave 27 jobs over **17 Nov → 24 May**, and planning
 * page two afterwards gave 8 jobs over **17 Nov → 8 Feb**, on top of them. Of
 * the 196 days the book then covered, **84 carried two or three jobs on a
 * plant the model says runs one at a time**, and the clashes began on day one.
 * Every press looked right on its own, which is what made it invisible.
 */

/**
 * How many jobs the floor has in progress on one day.
 *
 * **Measured, not assumed.** The planner was built on the client's own answer
 * that the plant is one queue, and one queue is what `layOutQueue` laid — but
 * a single line makes the open book on their own screen (4,71,31,353 pieces at
 * the rates their shift book reports) something over two years of work, which
 * is not a plan anybody will work to. The shift book already says otherwise:
 * `production_entries` records which job each day's output was booked
 * against, so **how many jobs the plant actually carries at once is a fact we
 * hold**, the same way a product's rate is.
 *
 * It takes nothing back from the 2026-09-25 removal of the Machine field:
 * this is one number about the whole plant, not a queue per machine, and
 * nothing is stored on a job.
 */
/**
 * A ceiling on the lines a caller may ask for. Not a statement about any
 * plant — it is what stops a typed figure turning one press into a thousand
 * cursors, the rule every number arriving from a client here is held to.
 */
export const MAX_LANES = 50;

export interface PlantLanes {
  /** Jobs at once — the **median** day, floored at one. */
  lanes: number;
  /**
   * The plain average over the same days, and the busiest single one. Carried
   * for the reason `Measured` carries its own pair: the screen prints the
   * evidence beside the figure so a planner can disbelieve it.
   */
  mean: number;
  busiest: number;
  /** Days of shift book behind it. Zero means there is nothing to measure. */
  days: number;
}

/**
 * The **median** of the jobs booked per day, for the reason the output rate is
 * a median: one day of catch-up entries — a week of back-dated shifts keyed to
 * one date — would pull an average up hard, and on a plant sized by that
 * average every job would be planned to run sooner than it can.
 *
 * Deliberately **not windowed**, like the rate: a plant that has grown will
 * read low for a while, which is the safe direction, and `days` rides along so
 * the screen can say how much is behind the figure rather than this file
 * deciding what is too old to count.
 */
export function plantLanes(): PlantLanes {
  const rows = db.prepare(
    `SELECT COUNT(DISTINCT e.work_order_id) AS jobs
       FROM production_entries e
      WHERE e.date <> ''
      GROUP BY e.date`
  ).all() as Record<string, unknown>[];
  const days = rows.map((r) => Number(r.jobs) || 0).filter((n) => n > 0).sort((a, b) => a - b);
  if (!days.length) return { lanes: 1, mean: 0, busiest: 0, days: 0 };
  const mid = days.length >> 1;
  const med = days.length % 2 ? days[mid] : (days[mid - 1] + days[mid]) / 2;
  return {
    // Floored at one: a plant that has run at all runs at least one job.
    lanes: Math.max(1, Math.round(med)),
    mean: round2(days.reduce((sum, n) => sum + n, 0) / days.length),
    busiest: days[days.length - 1],
    days: days.length,
  };
}

/** When each line next comes free, and what the plant is committed to. */
export interface LineAvailability {
  /**
   * One date per line — the day that line can take new work. Shorter than
   * `lanes` where fewer jobs are committed than the plant has lines, which is
   * the caller's signal that the rest are free now.
   */
  free_from: string[];
  /** The latest finish anywhere on the committed book, or '' if nothing is. */
  committed_to: string;
  /** Open jobs carrying a plan that this queue is not about to re-write. */
  jobs: number;
}

/**
 * When the plant's lines come free, over every open job carrying dates that
 * this queue is **not** about to re-write.
 *
 * **The N latest finishes are the N lines' free days**, which is exact under
 * the lane model whenever each line holds a run of jobs — the last job on a
 * line is the latest finish on it — and conservative otherwise, never
 * optimistic. Being conservative is the safe direction here: the failure this
 * replaces was a plan laid on top of work already committed, and a line
 * reported free a day or two late costs a day or two, where one reported free
 * early costs a promise.
 *
 * `exceptIds` is what makes a **re-plan** honest: a job in the queue is about
 * to be given new dates, so the dates it holds now are not a commitment and
 * must not push its own replacement outwards.
 */
export function linesFreeFrom(lanes: number, exceptIds: number[] = []): LineAvailability {
  const n = Math.max(1, Math.floor(lanes) || 1);
  const skip = [...new Set(exceptIds.filter((v) => Number.isInteger(v) && v > 0))];
  const rows = db.prepare(
    `SELECT ${JOB_END('w')} AS ends
       FROM work_orders w
      WHERE w.status NOT IN ('done','cancelled')
        AND ${JOB_END('w')} <> ''
        ${skip.length ? `AND w.id NOT IN (${skip.map(() => '?').join(',')})` : ''}
      ORDER BY ends DESC
      LIMIT ?`
  ).all(...([...skip, n] as never[])) as Record<string, unknown>[];
  const ends = rows.map((r) => String(r.ends ?? '')).filter(Boolean);
  return {
    // The day **after** the finish: a job ending on the 10th occupies the
    // 10th, so the line takes new work on the 11th. `layOutQueue`'s own
    // `endᵢ = startᵢ + daysᵢ − 1` read from the other side.
    free_from: ends.map((d) => addDaysIso(d, 1)),
    committed_to: ends[0] ?? '',
    jobs: countCommitted(skip),
  };
}

/** How many open jobs carry a plan, excluding the ones being re-planned. */
function countCommitted(skip: number[]): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM work_orders w
      WHERE w.status NOT IN ('done','cancelled') AND ${JOB_END('w')} <> ''
      ${skip.length ? `AND w.id NOT IN (${skip.map(() => '?').join(',')})` : ''}`
  ).get(...(skip as never[])) as Record<string, unknown>;
  return Number(row?.n ?? 0);
}
