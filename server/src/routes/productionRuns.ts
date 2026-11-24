import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { requireAuth, requirePermission, type AuthedRequest } from '../middleware/auth.js';
import { scopeClause } from '../middleware/scope.js';
import { runError, writeRun, runsFor, jobFacts, allocatedByJob, type RunInput }
  from '../services/runPlan.js';
import { plannedDateError } from '../services/orderJobs.js';
import { productionLines, SHIFTS, shutdownDates, SHIFT_KEYS } from '../services/shifts.js';
import { layOutShifts, summariseShifts, slotKey, type ShiftJob, type LineSpec }
  from '../services/shiftPlan.js';
import { shiftRates } from '../services/outputRate.js';
import { SORTS, type SortKey } from '../services/jobPlan.js';
import { LIVE_OK, ORDER_DUE, ORDER_DUE_SOURCE } from '../services/production.js';
import type { DueSource } from '../services/jobPlan.js';
import { syncOrderStatus } from '../services/orderStatus.js';

/**
 * The shift plan — what each line is making, in each shift, on each day
 * (2026-11-24, phase three of the product-wise planning system).
 *
 * **Its own router, mounted on `requireAuth` with a guard per route.** The
 * mount cannot be `requirePermission('work_order')` for the reason
 * `routes/workOrders.ts` records at length: a mount runs before the router, so
 * an exception inside it is impossible, and this one already serves two cells
 * — planning a run is `work_order: full`, where simply *reading* the board is
 * what the floor, the desk and logistics all do.
 */
export const productionRunsRouter = Router();
productionRunsRouter.use(requireAuth);

/**
 * What a screen needs before it can draw a board: the lines and the shifts.
 *
 * **Sent rather than copied onto the client**, the rule `/auth/me` follows
 * about the permission vocabulary — so a picker can never offer a line that is
 * retired or a shift this build does not run. Declared **above `/:id`**, or
 * Express reads "setup" as a run id.
 */
productionRunsRouter.get('/setup', requirePermission('work_order'), (_req, res) => {
  res.json({ lines: productionLines(), shifts: SHIFTS });
});

/**
 * The board. `work_order: view`, which is what the floor holds — reading what
 * is planned is not planning it.
 */
productionRunsRouter.get('/', requirePermission('work_order'), (req: AuthedRequest, res) => {
  const scope = scopeClause(req, 'customer_id');
  res.json(runsFor({
    from: req.query.from ? String(req.query.from) : undefined,
    to: req.query.to ? String(req.query.to) : undefined,
    machineId: Number(req.query.machine_id) > 0 ? Number(req.query.machine_id) : undefined,
    shift: req.query.shift ? String(req.query.shift) : undefined,
    scopeSql: scope.sql || undefined,
    scopeParams: scope.params,
  }));
});

/**
 * What a run could be made of: the live jobs of one product and colour, with
 * how much of each is still unplanned.
 *
 * **Measured on the server**, because the picker has to offer what the save
 * will accept — a client-side filter over a page of the job list would offer
 * jobs of the wrong colour and hide the ones somebody is looking for, which is
 * the form-offers-what-the-API-refuses trap this codebase records twice.
 *
 * Narrowed to the **product and colour of the job named**, since a run is one
 * of each: offering anything else would be offering a refusal.
 */
productionRunsRouter.get('/options', requirePermission('work_order', 'full'), (req: AuthedRequest, res) => {
  const like = Number(req.query.like);
  const scope = scopeClause(req, 'customer_id');
  const seed = jobFacts([like], scope).get(like);
  if (!seed) return res.status(404).json({ error: 'Work order not found' });

  const rows = db.prepare(
    `SELECT w.id FROM work_orders w
       JOIN orders o ON o.id = w.order_id
      WHERE w.status NOT IN ('done','cancelled')
        AND COALESCE(w.product_id, 0) = ?
        ${scope.sql ? `AND ${scope.sql}` : ''}`
  ).all(...([seed.product_id ?? 0, ...scope.params] as never[])) as Record<string, unknown>[];

  const ids = rows.map((r) => Number(r.id));
  const facts = jobFacts(ids, scope);
  const committed = allocatedByJob(ids, Number(req.query.except) || undefined);

  const options = ids
    .map((id) => facts.get(id)!)
    // The colour is the second half of "one run is one changeover", and is
    // read here rather than in SQL so this and the guard ask one function.
    .filter((j) => j && j.color === seed.color)
    .map((j) => {
      const left = Math.max(0, j.qty_planned - j.made);
      return {
        work_order_id: j.id, number: j.number, order_id: j.order_id,
        qty_planned: j.qty_planned, made: j.made,
        left, unplanned: Math.max(0, left - (committed.get(j.id) ?? 0)),
      };
    })
    .sort((a, b) => b.unplanned - a.unplanned || a.number.localeCompare(b.number));

  res.json({ product_id: seed.product_id, product_name: seed.product_name, color: seed.color, options });
});

/**
 * The queue a shift plan is worked out over: every open job with something
 * left to make, scoped to the caller.
 *
 * Reads the **balance** rather than `qty_planned`, the figure `layOutQueue`
 * plans and `progressFor` reports: a job half made needs half the shifts, and
 * planning the whole instruction again would push everything behind it out by
 * shifts nobody is going to work.
 *
 * **And less what runs already hold**, which is what makes a second press
 * honest. Without it the planner proposed the whole book again — `busy` kept
 * the new runs off the committed slots, so it looked right — and `runError`
 * then refused every one of them on *never exceed the work order*: a preview
 * offering what the press refuses, which is the form-offers-what-the-API-
 * refuses trap. Found by pressing twice. It is the same figure
 * `/production-runs/options` calls `unplanned`, so the planner and the picker
 * answer one question.
 */
function queueJobs(req: AuthedRequest, ids?: number[]): ShiftJob[] {
  const scope = scopeClause(req, 'customer_id');
  const want = [...new Set((ids ?? []).filter((n) => Number.isInteger(n) && n > 0))];
  const rows = db.prepare(
    `SELECT w.id, w.number, w.product_id, w.order_id, w.planned_start, w.planned_end,
            w.revised_start, w.revised_end,
            COALESCE(p.name, w.description, '') AS product_name,
            COALESCE(NULLIF(oi.color, ''), p.color, '') AS color,
            o.number AS order_number, c.name AS customer_name,
            ${ORDER_DUE('o')} AS due, ${ORDER_DUE_SOURCE('o')} AS due_source,
            w.qty_planned
              - COALESCE((SELECT SUM(${LIVE_OK('e')}) FROM production_entries e
                           WHERE e.work_order_id = w.id), 0)
              - COALESCE((SELECT SUM(a.qty_planned) FROM run_allocations a
                           WHERE a.work_order_id = w.id), 0) AS pieces
       FROM work_orders w
       JOIN orders o ON o.id = w.order_id
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN products p ON p.id = w.product_id
       LEFT JOIN (
         SELECT order_id, color,
                ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY sort_order, id) - 1 AS pos
           FROM order_items
       ) oi ON oi.order_id = w.order_id AND oi.pos = w.order_line
      WHERE w.status NOT IN ('done','cancelled')
        ${want.length ? `AND w.id IN (${want.map(() => '?').join(',')})` : ''}
        ${scope.sql ? `AND ${scope.sql}` : ''}`
  ).all(...([...want, ...scope.params] as never[])) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: Number(r.id),
    number: String(r.number ?? ''),
    product_id: r.product_id === null ? null : Number(r.product_id),
    product_name: String(r.product_name ?? ''),
    color: String(r.color ?? ''),
    customer_name: String(r.customer_name ?? ''),
    order_id: Number(r.order_id),
    order_number: String(r.order_number ?? ''),
    pieces: Math.max(0, Number(r.pieces) || 0),
    due: String(r.due ?? '') || null,
    due_source: String(r.due_source ?? 'none') as DueSource,
    current: {
      planned_start: String(r.planned_start ?? ''),
      planned_end: String(r.planned_end ?? ''),
      revised_start: String(r.revised_start ?? ''),
      revised_end: String(r.revised_end ?? ''),
    },
  }));
}

/** Slots something is already committed to, so a press never plans on top. */
function committedSlots(): Set<string> {
  const rows = db.prepare(
    'SELECT date, machine_id, shift FROM production_runs'
  ).all() as Record<string, unknown>[];
  return new Set(rows.map((r) => slotKey(String(r.date ?? ''), Number(r.machine_id), String(r.shift ?? ''))));
}

/** Work the plan out, shared by the preview and the press that applies it. */
function workOutPlan(req: AuthedRequest, body: Record<string, unknown>) {
  const lines: LineSpec[] = productionLines().map((l) => ({
    id: l.id, name: l.name, shifts_per_day: l.shifts_per_day, changeover_mins: l.changeover_mins,
  }));
  const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).map(Number) : undefined;
  const jobs = queueJobs(req, ids);

  /*
   * The order the queue opens in is a **policy, not a drag** -- `SORTS`' own
   * reasoning, and the same four rules the day planner offers, asked here of
   * the same four fields. A rule this build does not know reads as the
   * default rather than being refused, which is how every vocabulary arriving
   * from a client is treated here.
   */
  const sort = String(body.sort ?? 'due') as SortKey;
  const cmp = SORTS[sort] ?? SORTS.due;
  const ordered = body.keep_order === true ? jobs : [...jobs].sort(cmp as never);

  // One rate lookup for the whole press. `shiftRates` is per line, since a
  // typed day rate divides by the shifts THAT line runs -- so it is asked once
  // per line rather than once, and a line running one shift makes a day's
  // worth in it.
  const byLine = new Map<number, Map<number, number>>();
  for (const l of lines) {
    const rates = shiftRates(ordered.map((j) => j.product_id ?? 0), l.shifts_per_day);
    byLine.set(l.id, new Map([...rates].map(([id, r]) => [id, r.pcs_per_day])));
  }
  const rateFor = (productId: number | null, lineId: number) =>
    (productId ? byLine.get(lineId)?.get(productId) ?? null : null);

  const start = String(body.start ?? '');
  const plan = layOutShifts(ordered, lines, rateFor, start, {
    shiftKeys: [...SHIFT_KEYS],
    shutdowns: shutdownDates(),
    busy: committedSlots(),
  });
  return { plan, lines, start };
}

/**
 * Work out a shift plan, **writing nothing** (2026-11-24).
 *
 * A POST rather than a GET because a queue of eighty ids does not belong in a
 * query string; the rule that a read never writes is untouched, which is why
 * the prefill endpoints in this app are GETs and this one still saves nothing.
 * Declared **above `/:id`** like its siblings.
 */
productionRunsRouter.post('/plan/preview', requirePermission('work_order', 'full'), (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.start ?? ''))) {
    return res.status(400).json({ error: 'Give the plan a date to start from' });
  }
  const { plan } = workOutPlan(req, body);
  res.json({
    start: String(body.start),
    runs: plan.runs,
    jobs: plan.jobs,
    summary: summariseShifts(plan),
  });
});

/**
 * Apply a worked-out plan: write its runs, and date the jobs they are for.
 *
 * **One transaction**, because a plan is one act -- the rule `POST
 * /work-orders/plan` states about a press that dates eighty jobs. The plan is
 * **worked out again here rather than taken from the body**: a client that
 * sent its own rows could send any rows at all, and the guard would then be
 * the only thing between a press and a plan nobody computed. So the body says
 * *what to plan and from when*, exactly as the preview does, and what is
 * written is what the same function produced.
 *
 * Every run still goes through **`runError`**, unchanged -- the bulk press
 * changes what wraps the write, never what is allowed. A refusal leaves the
 * whole press unwritten, the rule the planning grid already follows.
 *
 * **The jobs are dated in the same transaction**, from the span of their own
 * runs, through `plannedDateError`'s column rule: the first dates a job ever
 * takes are its plan and every later one is a revision, so the slip stays
 * visible. Without this the board and the Work Orders grid would be two plans
 * for one floor, which is the disagreement this codebase refuses everywhere.
 */
productionRunsRouter.post('/plan/apply', requirePermission('work_order', 'full'), (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.start ?? ''))) {
    return res.status(400).json({ error: 'Give the plan a date to start from' });
  }
  const { plan } = workOutPlan(req, body);
  if (!plan.runs.length) {
    return res.status(409).json({
      error: 'That plan has nothing to write. Every job in the queue is finished, '
        + 'has no output rate, or has no line that can make it.',
    });
  }

  const scope = scopeClause(req, 'customer_id');
  // Guarded **before** anything is written, so one refused run leaves the
  // press unwritten rather than half a plan on the board.
  for (const r of plan.runs) {
    const refused = runError({
      date: r.date, machine_id: r.machine_id, shift: r.shift, notes: '',
      lines: r.allocations.map((a) => ({ work_order_id: a.work_order_id, qty_planned: a.qty_planned })),
    }, undefined, { sql: scope.sql, params: scope.params });
    if (refused) return res.status(409).json({ error: `${r.line_name}, ${r.date} ${r.shift}: ${refused}` });
  }

  // The dates each job's own runs come to, routed into the column its state
  // allows — `jobDateField`'s rule, asked on the server because this press
  // never passes through the grid.
  const dated = plan.jobs.filter((j) => !j.blocked && j.planned_start && j.planned_end);
  for (const j of dated) {
    const virgin = !j.current.planned_start && !j.current.planned_end;
    const err = plannedDateError({ number: j.number, ...j.current },
      virgin ? { planned_start: j.planned_start, planned_end: j.planned_end }
             : { revised_start: j.planned_start, revised_end: j.planned_end });
    if (err) return res.status(409).json({ error: err });
  }

  transaction(() => {
    for (const r of plan.runs) {
      writeRun({
        date: r.date, machine_id: r.machine_id, shift: r.shift, notes: '',
        lines: r.allocations.map((a) => ({ work_order_id: a.work_order_id, qty_planned: a.qty_planned })),
      }, req.user?.id ?? null);
    }
    for (const j of dated) {
      const virgin = !j.current.planned_start && !j.current.planned_end;
      db.prepare(
        virgin
          ? 'UPDATE work_orders SET planned_start = ?, planned_end = ? WHERE id = ?'
          : 'UPDATE work_orders SET revised_start = ?, revised_end = ? WHERE id = ?'
      ).run(j.planned_start, j.planned_end, j.id);
    }
    if (body.release === true) {
      // Forward only, `POST /work-orders/plan`'s own rule: a job already
      // released, running or paused stays where it is.
      const ids = dated.map((j) => j.id);
      if (ids.length) {
        db.prepare(
          `UPDATE work_orders SET status = 'released' WHERE status = 'planned' AND id IN (${ids.map(() => '?').join(',')})`
        ).run(...(ids as never[]));
      }
    }
  });

  // A start date or a release is what schedules the order, so every order
  // touched is asked again — once each, however many of its jobs were planned.
  for (const orderId of new Set(dated.map((j) => j.order_id))) syncOrderStatus(orderId);

  res.json({ runs: plan.runs.length, jobs: dated.length, summary: summariseShifts(plan) });
});

productionRunsRouter.post('/', requirePermission('work_order', 'full'), (req: AuthedRequest, res) => {
  const input = read(req.body);
  const scope = scopeClause(req, 'customer_id');
  const refused = runError(input, undefined, { sql: scope.sql, params: scope.params });
  if (refused) return res.status(409).json({ error: refused });
  const id = transaction(() => writeRun(input, req.user?.id ?? null));
  res.status(201).json(one(id));
});

productionRunsRouter.put('/:id', requirePermission('work_order', 'full'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!exists(id, req)) return res.status(404).json({ error: 'Run not found' });
  const input = read(req.body);
  const scope = scopeClause(req, 'customer_id');
  // `id` is excluded from what is already committed, or a run re-saved
  // unchanged would count itself and refuse its own replacement — the defect
  // the dispatch dialog shipped with.
  const refused = runError(input, id, { sql: scope.sql, params: scope.params });
  if (refused) return res.status(409).json({ error: refused });
  transaction(() => writeRun(input, req.user?.id ?? null, id));
  res.json(one(id));
});

productionRunsRouter.delete('/:id', requirePermission('work_order', 'full'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!exists(id, req)) return res.status(404).json({ error: 'Run not found' });
  // The allocations cascade. Nothing else references a run — the shift book
  // records what was *made*, which is a different record and is not touched.
  db.prepare('DELETE FROM production_runs WHERE id = ?').run(id);
  res.json({ ok: true });
});

/** Read a body into the shape the guard and the writer both take. */
function read(body: Record<string, unknown> | undefined): RunInput {
  const b = body ?? {};
  const lines = Array.isArray(b.lines) ? b.lines : [];
  return {
    date: String(b.date ?? ''),
    machine_id: Number(b.machine_id),
    shift: String(b.shift ?? ''),
    notes: String(b.notes ?? ''),
    lines: lines.map((l) => {
      const row = (l ?? {}) as Record<string, unknown>;
      return { work_order_id: Number(row.work_order_id), qty_planned: Number(row.qty_planned) };
    }),
  };
}

/** One run, as the board reads it — so a save answers in the board's shape. */
const one = (id: number) => runsFor({ from: undefined, to: undefined }).find((r) => r.id === id) ?? null;

/**
 * Whether this caller may act on this run at all.
 *
 * Asked through `runsFor`'s own scope clause, so *which runs exist for me* has
 * one answer rather than two: a run whose every job is out of scope is a 404,
 * never a 403, and an id cannot be probed for.
 */
function exists(id: number, req: AuthedRequest): boolean {
  const scope = scopeClause(req, 'customer_id');
  return runsFor({ scopeSql: scope.sql || undefined, scopeParams: scope.params })
    .some((r) => r.id === id);
}
