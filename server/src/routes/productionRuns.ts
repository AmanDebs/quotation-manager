import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { requireAuth, requirePermission, type AuthedRequest } from '../middleware/auth.js';
import { scopeClause } from '../middleware/scope.js';
import { runError, writeRun, runsFor, jobFacts, allocatedByJob, type RunInput }
  from '../services/runPlan.js';
import { productionLines, SHIFTS } from '../services/shifts.js';

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
