import { db } from '../db/connection.js';
import { LIVE_OK } from './production.js';
import { shiftRates } from './outputRate.js';
import { normaliseShift, shutdownDates, SHIFT_KEYS } from './shifts.js';
import { round2 } from './totals.js';

/**
 * The shift plan: **what one line is making, in one shift, on one day**
 * (2026-11-24, phase three of the product-wise planning system).
 *
 * Everything above this in the hierarchy is derived — a product's demand is
 * the sum of its colours' and a job *is* one order line, so those reconcile by
 * construction. This is the first thing that is **stored**, because it is the
 * first thing no existing record could answer: which line runs what, when.
 *
 * **A run's product and colour are derived from its allocations**, never
 * written down. `runError` refuses a run whose jobs disagree about either, so
 * *one run is one changeover* is true by construction rather than by a column
 * somebody keeps in step — the rule the Work Orders grid already follows about
 * reading a colour off the order line.
 */

/** One job's share of a run. */
export interface Allocation {
  work_order_id: number;
  qty_planned: number;
}

/** What a caller asks for. */
export interface RunInput {
  date: string;
  machine_id: number;
  shift: string;
  notes?: string;
  lines: Allocation[];
}

/** The planning facts about a job that every guard here reads. */
export interface JobFacts {
  id: number;
  number: string;
  status: string;
  order_id: number;
  customer_id: number;
  product_id: number | null;
  product_name: string;
  /** The order line's colour, catalogue colour behind it — the grid's rule. */
  color: string;
  qty_planned: number;
  made: number;
}

/**
 * The jobs named, with everything a guard needs, **scoped by the caller**.
 *
 * A job out of scope simply does not come back, and every guard then refuses
 * the run for naming a job that is not on file — the rule this codebase
 * follows about an out-of-scope id being a 404 rather than a 403, so an id
 * cannot be probed for.
 *
 * The colour is read **by position** through the same `ROW_NUMBER()` walk
 * `LINE_AT_POSITION` uses, falling back to the catalogue's: a second reading
 * of a line's colour is how a run and the grid would come to disagree about
 * what is being made.
 */
export function jobFacts(ids: number[], scope?: { sql: string; params: unknown[] }): Map<number, JobFacts> {
  const want = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map<number, JobFacts>();
  if (!want.length) return out;

  const rows = db.prepare(
    `SELECT w.id, w.number, w.status, w.order_id, w.qty_planned, w.product_id,
            o.customer_id,
            COALESCE(p.name, '') AS product_name,
            COALESCE(NULLIF(oi.color, ''), p.color, '') AS color,
            COALESCE((SELECT SUM(${LIVE_OK('e')}) FROM production_entries e
                       WHERE e.work_order_id = w.id), 0) AS made
       FROM work_orders w
       JOIN orders o ON o.id = w.order_id
       LEFT JOIN products p ON p.id = w.product_id
       LEFT JOIN (
         SELECT order_id, color,
                ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY sort_order, id) - 1 AS pos
           FROM order_items
       ) oi ON oi.order_id = w.order_id AND oi.pos = w.order_line
      WHERE w.id IN (${want.map(() => '?').join(',')})
        ${scope?.sql ? `AND ${scope.sql}` : ''}`
  ).all(...([...want, ...(scope?.params ?? [])] as never[])) as Record<string, unknown>[];

  for (const r of rows) {
    out.set(Number(r.id), {
      id: Number(r.id),
      number: String(r.number ?? ''),
      status: String(r.status ?? ''),
      order_id: Number(r.order_id),
      customer_id: Number(r.customer_id),
      product_id: r.product_id === null ? null : Number(r.product_id),
      product_name: String(r.product_name ?? ''),
      color: String(r.color ?? ''),
      qty_planned: round2(Number(r.qty_planned) || 0),
      made: round2(Number(r.made) || 0),
    });
  }
  return out;
}

/**
 * How much of each job is already committed to a run.
 *
 * `exceptRunId` is what makes an **edit** honest: the run being re-saved is
 * about to be replaced, so the quantities it holds now are not a second
 * commitment and must not refuse their own replacement. The same rule
 * `despatchLimitError` states about re-saving an unchanged trip, and
 * `linesFreeFrom` about re-planning a job.
 */
export function allocatedByJob(jobIds: number[], exceptRunId?: number): Map<number, number> {
  const want = [...new Set(jobIds.filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map<number, number>();
  if (!want.length) return out;
  const rows = db.prepare(
    `SELECT work_order_id, SUM(qty_planned) AS qty
       FROM run_allocations
      WHERE work_order_id IN (${want.map(() => '?').join(',')})
        ${exceptRunId ? 'AND run_id <> ?' : ''}
      GROUP BY work_order_id`
  ).all(...([...want, ...(exceptRunId ? [exceptRunId] : [])] as never[])) as Record<string, unknown>[];
  for (const r of rows) out.set(Number(r.work_order_id), round2(Number(r.qty) || 0));
  return out;
}

/** One line of the plant, as a run is judged against it. */
interface LineFacts {
  id: number;
  name: string;
  shifts_per_day: number;
  changeover_mins: number;
}

const lineFacts = (id: number): LineFacts | null => {
  const r = db.prepare(
    `SELECT id, name, shifts_per_day, changeover_mins FROM machines WHERE id = ? AND active = 1`
  ).get(id) as Record<string, unknown> | undefined;
  return r ? {
    id: Number(r.id),
    name: String(r.name ?? ''),
    shifts_per_day: Math.max(0, Number(r.shifts_per_day) || 0),
    changeover_mins: Math.max(0, Number(r.changeover_mins) || 0),
  } : null;
};

/**
 * What a line can make of a product in one shift, or null where the record
 * does not say.
 *
 * **Null is not zero**, the `hasRecipe: false` rule: a product nobody has run
 * and nobody has typed a figure for has no capacity to be judged against, and
 * a capacity of nought would refuse every run of it. So such a run is
 * **allowed and reported** rather than refused — which is the only answer that
 * does not stop a desk planning a product the first time it is made.
 */
export function shiftCapacity(productId: number | null, line: LineFacts): number | null {
  if (!productId) return null;
  const rate = shiftRates([productId], line.shifts_per_day).get(productId);
  if (!rate || !(rate.pcs_per_day > 0)) return null;
  /*
   * **The changeover is deliberately not charged here**, which reverses how
   * this shipped on 2026-11-24 and is worth the words.
   *
   * It first took `changeover_mins` off every shift, on the reasoning that a
   * colour change costs the shift it happens in — true, and not something this
   * function can know. Whether a run changes anything over depends on **what
   * that line ran before it**, which is a property of the *sequence* rather
   * than of the run; charging it unconditionally made this guard refuse the
   * scheduler's own plans, including a line's very first slot, where there is
   * nothing to change from. Found by measuring: `plan/apply` was refused
   * *"makes about 45,000 … and this run is for 50,000"* over a run `layOutShifts`
   * had just worked out at the full rate.
   *
   * So the two are one rule again, each owning what it can see: **the
   * scheduler charges the changeover**, because it knows the order the slots
   * run in, and **this guard answers what the line can physically make**,
   * which is the question a single run can be asked on its own. The
   * alternative — making the guard read its neighbours — is a check another
   * row's edit can silently invalidate, with nothing to re-run it.
   */
  return round2(rate.pcs_per_day);
}

/**
 * Whether this run may be saved, as the sentence to refuse it with.
 *
 * The sixth guard of this shape in the codebase — after `lockError`,
 * `qcBlockError`, `incompleteError`, `renameError` and `plannedDateError` — so
 * the rule is testable without the HTTP harness this codebase does not have,
 * and the screen can **explain** it rather than keep a copy.
 *
 * Ordered **most specific first**, the rule every guard here follows: the
 * reason worth reading is the narrowest true one.
 */
export function runError(input: RunInput, exceptRunId?: number,
  scope?: { sql: string; params: unknown[] }): string | null {

  /* ---- the run itself ---------------------------------------------- */
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.date ?? ''))) {
    return 'A run needs a date.';
  }
  const shift = normaliseShift(input.shift);
  if (!SHIFT_KEYS.includes(shift)) {
    return `${shift || 'That'} is not a shift this plant runs. Use ${SHIFT_KEYS.join(' or ')}.`;
  }
  const line = lineFacts(Number(input.machine_id));
  if (!line) return 'That production line is not on file.';

  // A line running one shift has no second one to plan into. Said rather than
  // silently allowed, or a plan would commit work to a shift nobody works.
  const position = SHIFT_KEYS.indexOf(shift);
  if (position >= line.shifts_per_day) {
    return line.shifts_per_day === 0
      ? `${line.name} is not running — it is set to no shifts a day.`
      : `${line.name} runs ${line.shifts_per_day} shift${line.shifts_per_day === 1 ? '' : 's'} a day, `
        + `so there is no ${shift} shift on it.`;
  }

  if (shutdownDates().has(input.date)) {
    return `The plant is shut on ${input.date}, so nothing can be planned to run then.`;
  }

  /* ---- the allocations --------------------------------------------- */
  const lines = input.lines ?? [];
  if (!lines.length) {
    // A run is defined by what it makes, which comes from its allocations: one
    // with none has no product, no colour and nothing to do. Deleting is how a
    // run is cleared, which is a different act and has its own route.
    return 'A run has to be making something — name at least one work order.';
  }

  const ids = lines.map((l) => Number(l.work_order_id));
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    return 'One of those work orders is not a valid id.';
  }
  if (new Set(ids).size !== ids.length) {
    // Refused rather than merged. Two rows for one job on one run makes
    // "how much of this run is for that order" unanswerable, and quietly
    // adding them would hide a double entry somebody meant to correct.
    return 'The same work order is on this run twice.';
  }

  const facts = jobFacts(ids, scope);
  for (const l of lines) {
    const job = facts.get(Number(l.work_order_id));
    if (!job) return 'One of those work orders is not on file.';
    const qty = Number(l.qty_planned);
    if (!Number.isFinite(qty) || qty <= 0) {
      return `${job.number} is on this run for nothing. Give it a quantity or take it off.`;
    }
    if (job.status === 'cancelled' || job.status === 'done') {
      return `${job.number} is ${job.status === 'done' ? 'finished' : 'cancelled'}, `
        + 'so nothing more can be planned against it.';
    }
  }

  /* ---- one run is one changeover ----------------------------------- */
  const first = facts.get(ids[0])!;
  for (const id of ids) {
    const job = facts.get(id)!;
    if (Number(job.product_id ?? 0) !== Number(first.product_id ?? 0)) {
      return `${job.number} is making ${job.product_name || 'a different product'} and `
        + `${first.number} is making ${first.product_name || 'another'}. `
        + 'One run is one product — plan them as two runs.';
    }
    if (job.color !== first.color) {
      return `${job.number} is ${job.color || 'stated with no colour'} and ${first.number} is `
        + `${first.color || 'stated with no colour'}. One run is one colour — `
        + 'a colour change is a second run.';
    }
  }

  /* ---- never exceed the work order (rule 5) ------------------------ */
  const already = allocatedByJob(ids, exceptRunId);
  for (const l of lines) {
    const job = facts.get(Number(l.work_order_id))!;
    const committed = round2((already.get(job.id) ?? 0) + Number(l.qty_planned));
    // Measured against what is **left to make**, not the whole instruction:
    // pieces already made are not waiting to be planned, which is
    // `progressFor`'s own balance and the figure `layOutQueue` plans.
    const left = round2(Math.max(0, job.qty_planned - job.made));
    if (committed > left) {
      return `${job.number} has ${fmt(left)} left to make and ${fmt(committed)} would be planned. `
        + 'A run cannot commit more than the work order asks for.';
    }
  }

  /* ---- capacity (rule 9) ------------------------------------------- */
  const total = round2(lines.reduce((sum, l) => sum + Number(l.qty_planned), 0));
  const cap = shiftCapacity(first.product_id, line);
  if (cap !== null && total > cap) {
    return `${line.name} makes about ${fmt(cap)} of ${first.product_name || 'this'} in one shift, `
      + `and this run is for ${fmt(total)}. Split it across shifts, or correct the output rate.`;
  }

  return null;
}

/** Indian grouping, as every figure on these screens is read. */
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });

/* ------------------------------------------------------------- writing */

/**
 * Write a run and its allocations, replacing what the run held.
 *
 * Delete-and-reinsert inside one transaction, `saveItems`' own shape: a run is
 * read whole and saved whole, and a partial write would leave a plan nobody
 * asked for. **The guard is asked before this is called**, never inside it, so
 * a refusal costs nothing and this stays the one place a run is written.
 */
export function writeRun(input: RunInput, userId: number | null, runId?: number): number {
  const id = runId ?? Number((db.prepare(
    `INSERT INTO production_runs (date, machine_id, shift, notes, created_by)
     VALUES (?, ?, ?, ?, ?) RETURNING id`
  ).get(input.date, input.machine_id, normaliseShift(input.shift),
    String(input.notes ?? ''), userId) as { id: number }).id);

  if (runId) {
    db.prepare(
      `UPDATE production_runs SET date = ?, machine_id = ?, shift = ?, notes = ? WHERE id = ?`
    ).run(input.date, input.machine_id, normaliseShift(input.shift), String(input.notes ?? ''), runId);
    db.prepare('DELETE FROM run_allocations WHERE run_id = ?').run(runId);
  }

  const ins = db.prepare(
    'INSERT INTO run_allocations (run_id, work_order_id, qty_planned) VALUES (?, ?, ?)'
  );
  for (const l of input.lines) ins.run(id, Number(l.work_order_id), round2(Number(l.qty_planned)));
  return id;
}

/* ------------------------------------------------------------- reading */

/** A run as a screen reads it, with what it is making worked out. */
export interface RunRow {
  id: number;
  date: string;
  machine_id: number;
  line_name: string;
  shift: string;
  notes: string;
  /** Derived from the allocations — a run states neither of its own. */
  product_id: number | null;
  product_name: string;
  color: string;
  /** Pieces this run is for, and what the line can do in that shift. */
  qty_planned: number;
  capacity: number | null;
  allocations: {
    work_order_id: number;
    number: string;
    order_id: number;
    order_number: string;
    customer_name: string;
    qty_planned: number;
  }[];
}

export interface RunFilters {
  from?: string;
  to?: string;
  machineId?: number;
  shift?: string;
  scopeSql?: string;
  scopeParams?: unknown[];
}

/**
 * The runs in a window, with their allocations.
 *
 * **Scoped through the allocations' own orders**: a run is visible where the
 * caller can see a job on it, which is the only reading that does not either
 * hide a line's own plan from the floor or show one desk another's customers.
 * Read in two statements rather than one join, so a run with three
 * allocations is one row rather than three — the defect a plain join would
 * produce silently.
 */
export function runsFor(f: RunFilters = {}): RunRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.from) { where.push('r.date >= ?'); params.push(f.from); }
  if (f.to) { where.push('r.date <= ?'); params.push(f.to); }
  if (f.machineId) { where.push('r.machine_id = ?'); params.push(f.machineId); }
  if (f.shift) { where.push('r.shift = ?'); params.push(normaliseShift(f.shift)); }
  if (f.scopeSql) {
    where.push(`EXISTS (SELECT 1 FROM run_allocations a
                          JOIN work_orders w ON w.id = a.work_order_id
                          JOIN orders o ON o.id = w.order_id
                         WHERE a.run_id = r.id AND ${f.scopeSql})`);
    params.push(...(f.scopeParams ?? []));
  }

  const runs = db.prepare(
    `SELECT r.id, r.date, r.machine_id, r.shift, r.notes, COALESCE(m.name, '') AS line_name
       FROM production_runs r
       LEFT JOIN machines m ON m.id = r.machine_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.date, m.name, r.shift, r.id`
  ).all(...(params as never[])) as Record<string, unknown>[];
  if (!runs.length) return [];

  const ids = runs.map((r) => Number(r.id));
  const allocs = db.prepare(
    `SELECT a.run_id, a.work_order_id, a.qty_planned,
            w.number, w.order_id, o.number AS order_number, c.name AS customer_name
       FROM run_allocations a
       JOIN work_orders w ON w.id = a.work_order_id
       JOIN orders o ON o.id = w.order_id
       JOIN customers c ON c.id = o.customer_id
      WHERE a.run_id IN (${ids.map(() => '?').join(',')})
      ORDER BY a.id`
  ).all(...(ids as never[])) as Record<string, unknown>[];

  const byRun = new Map<number, RunRow['allocations']>();
  const jobIds: number[] = [];
  for (const a of allocs) {
    const list = byRun.get(Number(a.run_id)) ?? [];
    list.push({
      work_order_id: Number(a.work_order_id),
      number: String(a.number ?? ''),
      order_id: Number(a.order_id),
      order_number: String(a.order_number ?? ''),
      customer_name: String(a.customer_name ?? ''),
      qty_planned: round2(Number(a.qty_planned) || 0),
    });
    byRun.set(Number(a.run_id), list);
    jobIds.push(Number(a.work_order_id));
  }

  const facts = jobFacts(jobIds);
  return runs.map((r) => {
    const mine = byRun.get(Number(r.id)) ?? [];
    const first = mine.length ? facts.get(mine[0].work_order_id) : undefined;
    const line = lineFacts(Number(r.machine_id));
    return {
      id: Number(r.id),
      date: String(r.date ?? ''),
      machine_id: Number(r.machine_id),
      line_name: String(r.line_name ?? ''),
      shift: String(r.shift ?? ''),
      notes: String(r.notes ?? ''),
      product_id: first?.product_id ?? null,
      product_name: first?.product_name ?? '',
      color: first?.color ?? '',
      qty_planned: round2(mine.reduce((sum, a) => sum + a.qty_planned, 0)),
      capacity: line ? shiftCapacity(first?.product_id ?? null, line) : null,
      allocations: mine,
    };
  });
}
