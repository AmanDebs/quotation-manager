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
 */

export interface ScheduleRow {
  material_id: number;
  material_name: string;
  unit: string;
  total: number;
  /** ISO date → quantity. */
  by_date: Record<string, number>;
  /** Needed by jobs with no start date. */
  unscheduled: number;
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
            COALESCE((SELECT SUM(${LIVE_OK('e')}) FROM production_entries e WHERE e.work_order_id = w.id), 0) AS made
       FROM work_orders w
      WHERE w.status NOT IN ('done','cancelled')
        ${locationId ? 'AND w.location_id = ?' : ''}
      ORDER BY w.planned_start, w.id`
  ).all(...(locationId ? [locationId] : []) as never[]) as {
    id: number; number: string; description: string; product_id: number | null;
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
        row = { material_id: line.material_id, material_name: line.name, unit: line.unit, total: 0, by_date: {}, unscheduled: 0 };
        rows.set(line.material_id, row);
      }
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
