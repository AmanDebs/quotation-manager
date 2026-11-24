import { addDaysIso, daysBetweenIso } from './months.js';
import type { DueSource, JobDates } from './jobPlan.js';

/**
 * Laying a queue of jobs out **as shifts on named lines** (2026-11-24, phase
 * four of the product-wise planning system).
 *
 * `layOutQueue` beside this lays whole jobs end to end across interchangeable
 * lanes and answers in **days**: *this job runs the 17th to the 24th*. That is
 * the right answer for the Work Orders grid, which is read down a list of
 * jobs, and it is untouched — every figure it has ever produced still holds.
 *
 * This answers the question that grid cannot: **which line, in which shift, is
 * making what**. The difference is not granularity for its own sake. A shift
 * is the unit the floor actually works in, a line is a thing with a rate of
 * its own, and a **colour change costs time on the line it happens on** — none
 * of which a day-level queue over anonymous lanes can express.
 *
 * A **pure function** over rows the route has already gathered — no `db`
 * import, and the rate arrives as a lookup — so the rules are testable without
 * the HTTP harness this codebase does not have, the shape `layOutQueue`,
 * `computeTotals` and `fitmentPlan` already take.
 */

/** A job waiting to be laid out. */
export interface ShiftJob {
  id: number;
  number: string;
  product_id: number | null;
  product_name: string;
  /** The order line's colour. Half of what makes two jobs shareable. */
  color: string;
  customer_name: string;
  order_id: number;
  order_number: string;
  /** Pieces **still to make** — the balance, never `qty_planned`. */
  pieces: number;
  due: string | null;
  due_source: DueSource;
  /** The job's own four date columns, so the caller can route a date. */
  current: JobDates;
}

/** A line, as the scheduler reads it. */
export interface LineSpec {
  id: number;
  name: string;
  shifts_per_day: number;
  changeover_mins: number;
}

/** What one shift on one line is making. */
export interface PlannedRun {
  date: string;
  machine_id: number;
  line_name: string;
  shift: string;
  product_id: number | null;
  product_name: string;
  color: string;
  /** Pieces this run is for, and what the slot could take. */
  qty_planned: number;
  capacity: number;
  /** Whether this run opens with a colour or product change on that line. */
  changeover: boolean;
  allocations: { work_order_id: number; number: string; qty_planned: number }[];
}

/** Why a job could not be laid out. Null means it was. */
export type ShiftBlock = 'no-rate' | 'nothing-left' | 'no-line';

export interface PlannedShiftJob extends ShiftJob {
  /** Shifts this job occupies, and the pieces actually placed. */
  shifts: number;
  placed: number;
  planned_start: string;
  planned_end: string;
  late: boolean;
  late_days: number;
  blocked: ShiftBlock | null;
}

export interface ShiftPlanResult {
  runs: PlannedRun[];
  jobs: PlannedShiftJob[];
}

export interface ShiftPlanShape {
  /** Days the plant does not run — stepped over, never counted. */
  shutdowns?: Set<string>;
  /** `date|line|shift` of slots already committed, which are not planned onto. */
  busy?: Set<string>;
  /** The shift vocabulary, in the order a day runs them. */
  shiftKeys: string[];
}

/** The key a slot is identified by, and the one `busy` is built from. */
export const slotKey = (date: string, lineId: number, shift: string) =>
  `${date}|${lineId}|${shift}`;

/** What makes two jobs shareable: one product and one colour. */
const runKey = (j: ShiftJob) => `${j.product_id ?? 0}|${j.color}`;

/**
 * The first day from `d` the plant is open. `layOutQueue`'s own helper, and
 * capped for its reason: a calendar with every day shut is a mistake somebody
 * can make on one screen, and a scheduler that spun on it would take the whole
 * press down rather than reporting it.
 */
function openFrom(d: string, closed: Set<string>): string {
  let day = addDaysIso(d, 0);
  for (let i = 0; i < 366 && day && closed.has(day); i++) day = addDaysIso(day, 1);
  return day;
}

/** Where a line is up to, and the slot it is currently filling. */
interface Cursor {
  line: LineSpec;
  date: string;
  idx: number;
  /** What this line last ran — what a changeover is measured against. */
  lastKey: string | null;
  open: PlannedRun | null;
  /** Room left in the open slot. */
  left: number;
}

/**
 * Lay the jobs out across the plant's lines, shift by shift, in the order
 * given.
 *
 * **Three rules carry it.**
 *
 * *A slot holds one product and one colour*, which is what a run is — so two
 * jobs of the same thing **share** a slot and their shares are two allocations
 * rather than one quantity, exactly as `run_allocations` stores it.
 *
 * *The line that frees first takes the work*, which is list scheduling and the
 * way a planner reads a board — `layOutQueue`'s own rule, read per shift.
 *
 * *A changeover costs the slot it happens in*, and a line already running this
 * product and colour is **preferred over an equally free one**, which is the
 * whole of what *"minimise unnecessary changeovers"* can honestly mean without
 * inventing a cost model nobody has measured. It is a tie-break rather than a
 * reordering: pushing a job back to avoid a changeover would trade a promise
 * for some minutes, and which of those matters is the planner's call, not
 * this function's.
 */
export function layOutShifts(
  jobs: ShiftJob[],
  lines: LineSpec[],
  /** Good pieces this line makes of this product in one whole shift. */
  rateFor: (productId: number | null, lineId: number) => number | null,
  start: string,
  shape: ShiftPlanShape,
): ShiftPlanResult {
  const closed = shape.shutdowns ?? new Set<string>();
  const busy = shape.busy ?? new Set<string>();
  const keys = shape.shiftKeys;
  const from = openFrom(start, closed);

  // A line that runs no shifts is not a line to plan onto — reading nought as
  // the default two would put work on a line somebody switched off.
  const live = lines.filter((l) => l.shifts_per_day > 0 && keys.length > 0);
  const cursors: Cursor[] = live.map((line) => ({
    line, date: from, idx: 0, lastKey: null, open: null, left: 0,
  }));

  const runs: PlannedRun[] = [];
  const out: PlannedShiftJob[] = [];

  /**
   * The next slot a line has after this one, skipping the days it does not
   * run and the slots something is already committed to.
   *
   * **Pure**, which is what lets a line be *scored* where its next run would
   * actually land rather than where its cursor happens to sit. That gap was a
   * real defect: a line holding an open slot of the wrong colour was scored at
   * that slot, won the tie, and then stepped — so the work landed a shift
   * later than an equally-free line beside it would have taken it. Found by
   * asking why the tie-break case did not fail when the tie-break was removed.
   */
  const nextFree = (c: Cursor): { date: string; idx: number } => {
    let date = c.date;
    let idx = c.idx;
    const perDay = Math.min(c.line.shifts_per_day, keys.length);
    for (let guard = 0; guard < 4000; guard++) {
      idx += 1;
      if (idx >= perDay) { idx = 0; date = openFrom(addDaysIso(date, 1), closed); }
      if (!busy.has(slotKey(date, c.line.id, keys[idx]))) return { date, idx };
    }
    return { date, idx };
  };

  /** Where a run that cannot share this line's open slot would land. */
  const landing = (c: Cursor) => (c.open ? nextFree(c) : { date: c.date, idx: c.idx });

  /** Move a cursor on, which also closes whatever slot it was filling. */
  const step = (c: Cursor) => {
    const to = nextFree(c);
    c.date = to.date;
    c.idx = to.idx;
    c.open = null;
    c.left = 0;
  };

  // The cursors start on the first slot each line actually has free.
  for (const c of cursors) {
    if (busy.has(slotKey(c.date, c.line.id, keys[c.idx]))) step(c);
  }

  for (const job of jobs) {
    const base: PlannedShiftJob = {
      ...job, shifts: 0, placed: 0, planned_start: '', planned_end: '',
      late: false, late_days: 0, blocked: null,
    };
    if (!(job.pieces > 0)) { out.push({ ...base, blocked: 'nothing-left' }); continue; }

    // Lines that can make it at all. A product with **no rate** has no honest
    // duration, so the job is named rather than guessed at — `hasRecipe:
    // false`'s rule, and the same answer `layOutQueue` gives.
    const able = cursors.filter((c) => (rateFor(job.product_id, c.line.id) ?? 0) > 0);
    if (!cursors.length) { out.push({ ...base, blocked: 'no-line' }); continue; }
    if (!able.length) { out.push({ ...base, blocked: 'no-rate' }); continue; }

    const key = runKey(job);
    let remaining = job.pieces;
    let first = '', last = '', slots = 0, placed = 0;

    for (let guard = 0; remaining > 0 && guard < 4000; guard++) {
      /*
       * Pick the line. A slot already open on this product and colour is
       * **free room**: it costs nothing and needs no changeover, so it beats an
       * equally-dated empty slot. Otherwise the earliest slot wins, ties going
       * to the lowest line index so one book in one order always lays out the
       * same way — the total-ordering rule the paged lists follow.
       */
      let pick: Cursor | null = null;
      let pickScore = '';
      for (const c of able) {
        const sharing = !!c.open && c.left > 0
          && `${c.open.product_id ?? 0}|${c.open.color}` === key;
        // Where this line's next piece of *this* job would actually go: the
        // open slot when it can be shared, otherwise the slot after it.
        const at = sharing ? { date: c.date, idx: c.idx } : landing(c);
        /*
         * Day, then shift, then whether the line is already running this.
         *
         * **That last term binds on nobody today, and is kept for the reason
         * `exportOnlyInvoice` is kept**: the rule lives where the answer is
         * decided. A sharing line is scored at its *current* slot while a
         * non-sharing one is scored at the slot after its open one, so a
         * sharing line is always at least as early — and an exact tie already
         * goes to the lower index, which is the sharing line in every
         * arrangement these rules can reach. It would decide something if the
         * ordering rules ever let a line be passed over, and it costs a
         * character to leave correct. Measured: removing it fails nothing.
         */
        const score = `${at.date}|${String(at.idx).padStart(2, '0')}|${sharing ? '0' : '1'}`;
        if (!pick || score < pickScore) { pick = c; pickScore = score; }
      }
      if (!pick) break;

      const rate = rateFor(job.product_id, pick.line.id) ?? 0;
      const sharing = !!pick.open && pick.left > 0
        && `${pick.open.product_id ?? 0}|${pick.open.color}` === key;

      if (!sharing) {
        // Open a fresh slot on that line. A changeover is charged when the line
        // was running something else — never on its very first slot, where
        // there is nothing to change from.
        if (pick.open) step(pick);
        const changeover = pick.lastKey !== null && pick.lastKey !== key;
        const hours = 12;
        const usable = changeover
          ? Math.max(0, hours * 60 - pick.line.changeover_mins) / (hours * 60)
          : 1;
        const capacity = Math.max(0, Math.round(rate * usable));
        if (!(capacity > 0)) {
          // A changeover that swallows the whole shift leaves nothing to plan
          // into. Said rather than looped on.
          break;
        }
        pick.open = {
          date: pick.date, machine_id: pick.line.id, line_name: pick.line.name,
          shift: keys[pick.idx],
          product_id: job.product_id, product_name: job.product_name, color: job.color,
          qty_planned: 0, capacity, changeover, allocations: [],
        };
        pick.left = capacity;
        pick.lastKey = key;
        runs.push(pick.open);
      }

      const slot = pick.open!;
      const take = Math.min(remaining, pick.left);
      slot.allocations.push({ work_order_id: job.id, number: job.number, qty_planned: take });
      slot.qty_planned += take;
      pick.left -= take;
      remaining -= take;
      placed += take;
      slots += 1;
      if (!first || slot.date < first) first = slot.date;
      if (slot.date > last) last = slot.date;
      // A full slot is done with; the next job starts the line's next one.
      if (pick.left <= 0) step(pick);
    }

    const late = !!job.due && !!last && last > job.due;
    out.push({
      ...base,
      shifts: slots,
      placed,
      planned_start: first,
      planned_end: last,
      late,
      late_days: late ? daysBetweenIso(job.due as string, last) : 0,
      // Everything placed, or the queue ran out of calendar — which is
      // reported as a dated job rather than a silent short-fall, the
      // `unplanned` rule one level up.
      blocked: placed > 0 ? null : 'no-rate',
    });
  }

  return { runs, jobs: out };
}

/** What a whole shift plan comes to, so the decision sits above the rows. */
export interface ShiftPlanSummary {
  jobs: number;
  blocked: number;
  late: number;
  undated: number;
  runs: number;
  /** Pieces the plan commits, and the shifts it spends doing it. */
  pieces: number;
  shifts: number;
  /** Slots that open with a colour or product change on their line. */
  changeovers: number;
  from: string;
  to: string;
}

export function summariseShifts(plan: ShiftPlanResult): ShiftPlanSummary {
  const dated = plan.jobs.filter((j) => !j.blocked);
  return {
    jobs: dated.length,
    blocked: plan.jobs.length - dated.length,
    late: dated.filter((j) => j.late).length,
    // Counted over the dated rows alone: a job nobody can plan is already
    // named for its own reason, and counting it here would report one problem
    // twice — `summarise`'s own rule.
    undated: dated.filter((j) => !j.due).length,
    runs: plan.runs.length,
    pieces: dated.reduce((sum, j) => sum + j.placed, 0),
    shifts: plan.runs.length,
    changeovers: plan.runs.filter((r) => r.changeover).length,
    from: plan.runs.reduce((first, r) => (!first || r.date < first ? r.date : first), ''),
    to: plan.runs.reduce((last, r) => (r.date > last ? r.date : last), ''),
  };
}
