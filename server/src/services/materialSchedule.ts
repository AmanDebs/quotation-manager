import { db } from '../db/connection.js';
import { requirementForJob } from './recipe.js';
import { LIVE_OK } from './production.js';
import { round2 } from './totals.js';

/**
 * Raw material required, by the day it is needed — the sheet the client drew
 * (2026-09-14): one row per material, a *Total* column, and a column per
 * start date carrying what the jobs starting that day will consume.
 *
 * It is the jobs-basis shortfall spread along the calendar, and it reads the
 * same record: every open job, what it has **left to make** (planned − live
 * output, so material for pieces already moulded is not counted twice — the
 * rule `stock.ts` states), and the recipe **the job was raised on**
 * (`requirementForJob`, the snapshot, so a recipe corrected later does not
 * restate an instruction already issued). Nothing here is stored.
 *
 * The date is the job's `planned_start`. A job with none is not on any day,
 * and it is not on *today* either — silence is not a date — so it lands in
 * a **Not scheduled** bucket that the page draws as its own column, since
 * material a job will need on a day nobody has set is still material that
 * has to be bought. `uncosted` names the jobs whose product has no recipe,
 * for the reason every reader of `hasRecipe: false` names them: their need
 * is unknown, not nothing.
 *
 * Each row also carries the **jobs behind its figure** (2026-09-16, the client
 * with the sheet in front of them: *"by clicking the raw material line we get
 * the product which requires that material and customer"*) — the job, the
 * product, the customer and the sales order, with what that job alone will
 * consume and the pieces it still has to make. Derived in the same pass as
 * the totals, so the two cannot disagree: a row's total is exactly the sum
 * of its jobs' figures.
 */

/** One job's share of a material's figure. */
export interface ScheduleJob {
  work_order_id: number;
  number: string;
  product_name: string | null;
  customer_name: string;
  order_id: number;
  order_number: string;
  /** The job's start date, or '' when it has none. */
  day: string;
  /** Of this material, for the pieces still to make. */
  qty: number;
  /** The pieces still to make. */
  pieces: number;
}

export interface ScheduleRow {
  material_id: number;
  material_name: string;
  unit: string;
  total: number;
  /** ISO date → quantity. */
  by_date: Record<string, number>;
  /** Needed by jobs with no start date. */
  unscheduled: number;
  /** The jobs this figure is made of, in start-date order; their qty sums to `total`. */
  jobs: ScheduleJob[];
}

export interface MaterialSchedule {
  /** The start dates in play, ascending. */
  dates: string[];
  rows: ScheduleRow[];
  uncosted: { id: number; number: string; description: string }[];
  /** True when some row carries an unscheduled figure, so the page knows to draw the column. */
  has_unscheduled: boolean;
}

export function materialSchedule(locationId?: number | null): MaterialSchedule {
  const jobs = db.prepare(
    `SELECT w.id, w.number, w.description, w.product_id, w.qty_planned, w.planned_start,
            p.name AS product_name, o.id AS order_id, o.number AS order_number, c.name AS customer_name,
            COALESCE((SELECT SUM(${LIVE_OK('e')}) FROM production_entries e WHERE e.work_order_id = w.id), 0) AS made
       FROM work_orders w
       JOIN orders o ON o.id = w.order_id
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN products p ON p.id = w.product_id
      WHERE w.status NOT IN ('done','cancelled')
        ${locationId ? 'AND w.location_id = ?' : ''}
      ORDER BY w.planned_start, w.id`
  ).all(...(locationId ? [locationId] : []) as never[]) as {
    id: number; number: string; description: string; product_id: number | null;
    product_name: string | null; order_id: number; order_number: string; customer_name: string;
    qty_planned: number; planned_start: string; made: number;
  }[];

  const rows = new Map<number, ScheduleRow>();
  const dates = new Set<string>();
  const uncosted: MaterialSchedule['uncosted'] = [];

  for (const job of jobs) {
    const remaining = Math.max(0, Number(job.qty_planned) - Number(job.made));
    if (remaining <= 0) continue;
    const { hasRecipe, lines } = requirementForJob(job.id, job.product_id, remaining);
    if (!hasRecipe) {
      uncosted.push({ id: job.id, number: job.number, description: job.description });
      continue;
    }
    const day = String(job.planned_start ?? '').trim();
    if (day) dates.add(day);
    for (const line of lines) {
      let row = rows.get(line.material_id);
      if (!row) {
        row = { material_id: line.material_id, material_name: line.name, unit: line.unit, total: 0, by_date: {}, unscheduled: 0, jobs: [] };
        rows.set(line.material_id, row);
      }
      row.jobs.push({
        work_order_id: job.id, number: job.number,
        product_name: job.product_name ?? (job.description || null),
        customer_name: job.customer_name, order_id: job.order_id, order_number: job.order_number,
        day, qty: round2(line.qty), pieces: remaining,
      });
      row.total = round2(row.total + line.qty);
      if (day) row.by_date[day] = round2((row.by_date[day] ?? 0) + line.qty);
      else row.unscheduled = round2(row.unscheduled + line.qty);
    }
  }

  const list = [...rows.values()].sort((a, b) => a.material_name.localeCompare(b.material_name));
  return {
    dates: [...dates].sort(),
    rows: list,
    uncosted,
    has_unscheduled: list.some((r) => r.unscheduled > 0),
  };
}
