import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { nextNumber } from '../services/numbering.js';
import { progressFor, progressForMany } from '../services/production.js';
import { materialCostByWorkOrder } from '../services/costing.js';
import { paramsFor, checksForWorkOrder, summaryForWorkOrder, specOwner, RESULT_FAILED_SQL } from '../services/qc.js';
import { requirementFor } from '../services/recipe.js';
import { syncOrderStatus } from '../services/orderStatus.js';
import { requirePermission, type AuthedRequest } from '../middleware/auth.js';
import { scopeClause, canAccessCustomer } from '../middleware/scope.js';
import { resolveCompanyId } from '../services/companies.js';
import { listBody } from '../services/pagination.js';

export const workOrdersRouter = Router();

/**
 * Jobs on the floor.
 *
 * A work order always belongs to a sales order, and that is what decides who
 * may see it: the customer scope runs through `orders.customer_id`, so an
 * employee sees jobs for their own customers and nobody else's. Out-of-scope
 * ids answer **404**, never 403 — a 403 would confirm the row exists.
 *
 * There is no approval workflow here. A work order is an instruction to
 * ourselves, not an offer to a customer, which is the same reason orders carry
 * none and their PDFs are never watermarked.
 */

const listSql = `
  SELECT w.*, o.number AS order_number, o.customer_id,
         c.name AS customer_name,
         p.name AS product_name,
         l.name AS location_name, m.name AS machine_name, md.name AS mould_name, pr.name AS process_name,
         u.name AS created_by_name
  FROM work_orders w
  JOIN orders o ON o.id = w.order_id
  JOIN customers c ON c.id = o.customer_id
  LEFT JOIN products p ON p.id = w.product_id
  LEFT JOIN locations l ON l.id = w.location_id
  LEFT JOIN machines m ON m.id = w.machine_id
  LEFT JOIN moulds md ON md.id = w.mould_id
  LEFT JOIN processes pr ON pr.id = w.process_id
  LEFT JOIN users u ON u.id = w.created_by`;

const fields = [
  'order_id', 'order_line', 'product_id', 'description', 'qty_planned',
  'location_id', 'machine_id', 'mould_id', 'process_id', 'planned_start', 'planned_end', 'notes',
] as const;

const STATUSES = ['planned', 'released', 'running', 'paused', 'done', 'cancelled'];

const numOrNull = (v: unknown) =>
  v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);

/** The row plus its order, or undefined when the caller may not see it. */
function accessible(req: AuthedRequest, id: number) {
  const row = db.prepare(`${listSql} WHERE w.id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row || !canAccessCustomer(req, Number(row.customer_id))) return undefined;
  return row;
}

function getFull(req: AuthedRequest, id: number) {
  const wo = accessible(req, id);
  if (!wo) return undefined;
  wo.entries = db.prepare(
    `SELECT e.*, u.name AS created_by_name FROM production_entries e
     LEFT JOIN users u ON u.id = e.created_by
     WHERE e.work_order_id = ? ORDER BY e.date, e.id`
  ).all(id);
  wo.progress = progressFor(id, Number(wo.qty_planned) || 0);
  // What the material issued to this job has cost, at the moving average in
  // force when each issue was made. Zero means nothing has been issued yet,
  // which is a real answer — unlike an uncosted product, whose need is
  // unknown rather than nil.
  wo.material_cost = materialCostByWorkOrder().get(id) ?? 0;
  // The product's QC specification and every inspection against this job.
  // `has_spec: false` means nobody has said what to measure — not that
  // everything passed, the same distinction `has_recipe` draws for material.
  // Whose specification applies is part of the answer, not a detail: the same
  // part is measured to different tolerances for different customers.
  const forCustomer = wo.customer_id as number | null;
  wo.qc = {
    params: paramsFor(wo.product_id as number | null, forCustomer),
    spec_owner: specOwner(wo.product_id as number | null, forCustomer),
    checks: checksForWorkOrder(id),
    summary: summaryForWorkOrder(id, wo.product_id as number | null, forCustomer),
  };
  // What this job will eat, if the product has a recipe at all. `has_recipe`
  // false means unanswerable, which the screen shows as "not costed" — never
  // as a requirement of zero.
  const req_ = requirementFor(wo.product_id as number | null, Number(wo.qty_planned) || 0);
  // Issued so far, so the screen can show planned against actual consumption —
  // the point of having a recipe at all.
  const issued = db.prepare(
    `SELECT material_id, COALESCE(SUM(-qty), 0) AS q FROM material_moves
     WHERE work_order_id = ? AND source = 'issue' GROUP BY material_id`
  ).all(id) as { material_id: number; q: number }[];
  const byMaterial = new Map(issued.map((r) => [r.material_id, r.q]));
  wo.material = {
    has_recipe: req_.hasRecipe,
    lines: req_.lines.map((l) => ({ ...l, issued: byMaterial.get(l.material_id) ?? 0 })),
    // Anything issued that the recipe never mentioned still has to show up.
    extra: issued
      .filter((r) => !req_.lines.some((l) => l.material_id === r.material_id))
      .map((r) => ({ material_id: r.material_id, issued: r.q })),
  };
  return wo;
}

/**
 * Jobs, planned pieces and pieces made across every job matching the filters.
 * Derived from `production_entries` here exactly as `progressForMany` derives
 * it per job — nothing about progress is stored, at either scale.
 */
function jobSummary(sql: string, params: unknown[]) {
  return db.prepare(
    `WITH f AS (${sql})
     SELECT (SELECT COUNT(*) FROM f) AS jobs,
            COALESCE((SELECT SUM(qty_planned) FROM f), 0) AS planned,
            COALESCE((SELECT SUM(e.qty_ok) FROM production_entries e
                       WHERE e.work_order_id IN (SELECT id FROM f)), 0) AS made`
  ).get(...(params as never[])) as { jobs: number; planned: number; made: number };
}

workOrdersRouter.get('/', (req: AuthedRequest, res) => {
  const scope = scopeClause(req, 'o.customer_id');
  const where: string[] = [];
  const params: unknown[] = [];
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  if (req.query.order_id) { where.push('w.order_id = ?'); params.push(Number(req.query.order_id)); }
  if (req.query.status) { where.push('w.status = ?'); params.push(String(req.query.status)); }
  if (req.query.machine_id) { where.push('w.machine_id = ?'); params.push(Number(req.query.machine_id)); }
  if (req.query.location_id) { where.push('w.location_id = ?'); params.push(Number(req.query.location_id)); }
  // "Open" is everything still to finish — the default view of a shop floor.
  if (req.query.open === '1') where.push("w.status NOT IN ('done','cancelled')");

  const sql = `${listSql} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const body = listBody<Record<string, unknown>>(req.query, {
    sql,
    order: "ORDER BY CASE WHEN w.planned_start = '' THEN 1 ELSE 0 END, w.planned_start, w.id DESC",
    params,
  }, (rows) => {
    const progress = progressForMany(
      rows.map((r) => ({ id: Number(r.id), qty_planned: Number(r.qty_planned) || 0 }))
    );
    return rows.map((r) => ({ ...r, progress: progress.get(Number(r.id)) }));
  });
  // "N jobs, X of Y pcs made" is a statement about the floor, not about the
  // page, so it is measured over every job matching the filters.
  res.json(Array.isArray(body) ? body : { ...body, summary: jobSummary(sql, params) });
});

/* ------------------------------------------------------------------ *
 * The QC register
 * ------------------------------------------------------------------ */

/*
 * The verdict is derived in the database here, not after the fetch, because
 * this list is paged — `RESULT_FAILED_SQL` is `resultOk` restated, and lives
 * beside it in `services/qc.ts` with the test that keeps the two honest.
 */
const RESULT_FAILED = RESULT_FAILED_SQL;
const HAS_FAILURE = `EXISTS (SELECT 1 FROM qc_results r WHERE r.check_id = q.id AND (${RESULT_FAILED}))`;
const HAS_READING = 'EXISTS (SELECT 1 FROM qc_results r WHERE r.check_id = q.id AND r.value IS NOT NULL)';

const registerSql = `
  SELECT q.id, q.work_order_id, q.date, q.shift, q.sample_size, q.inspector, q.notes,
         w.number AS work_order_number, w.order_line, w.product_id, w.description,
         p.name AS product_name, pr.name AS process_name,
         o.id AS order_id, o.number AS order_number, o.customer_id, c.name AS customer_name,
         (SELECT COUNT(*) FROM qc_results r WHERE r.check_id = q.id) AS readings,
         (SELECT COUNT(*) FROM qc_results r WHERE r.check_id = q.id AND r.value IS NOT NULL) AS measured,
         (SELECT COUNT(*) FROM qc_results r WHERE r.check_id = q.id AND (${RESULT_FAILED})) AS failed_count
    FROM qc_checks q
    JOIN work_orders w ON w.id = q.work_order_id
    JOIN orders o ON o.id = w.order_id
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN products p ON p.id = w.product_id
    LEFT JOIN processes pr ON pr.id = w.process_id`;

function registerWhere(req: AuthedRequest) {
  const scope = scopeClause(req, 'o.customer_id');
  const where: string[] = [];
  const params: unknown[] = [];
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  const eq = (key: string, col: string) => {
    if (req.query[key]) { where.push(`${col} = ?`); params.push(Number(req.query[key])); }
  };
  eq('work_order_id', 'q.work_order_id');
  eq('order_id', 'w.order_id');
  eq('product_id', 'w.product_id');
  eq('customer_id', 'o.customer_id');
  eq('process_id', 'w.process_id');
  if (req.query.from) { where.push('q.date >= ?'); params.push(String(req.query.from)); }
  if (req.query.to) { where.push('q.date <= ?'); params.push(String(req.query.to)); }
  if (req.query.shift) { where.push('q.shift = ?'); params.push(String(req.query.shift)); }
  // The verdict is a filter like any other, and has to be one the *database*
  // can apply — see `RESULT_FAILED`. The three values are the three a check can
  // be: a failure, a clean sheet, or nothing measured at all.
  const result = String(req.query.result ?? '');
  if (result === 'fail') where.push(HAS_FAILURE);
  else if (result === 'pass') where.push(`${HAS_READING} AND NOT ${HAS_FAILURE}`);
  else if (result === 'unmeasured') where.push(`NOT ${HAS_READING}`);
  return { sql: `${registerSql} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, params };
}

/**
 * Every inspection recorded, newest first — the register the quality desk works
 * from, as against the per-job panel on a work order.
 *
 * It lives in this router rather than one of its own because it is the `qc`
 * function on a record that hangs off a work order: the mount, the scope
 * clause and the customer join are all already here. It must stay declared
 * **above `/:id`**, or Express reads "qc-checks" as a work order id.
 */
workOrdersRouter.get('/qc-checks', requirePermission('qc'), (req: AuthedRequest, res) => {
  const { sql, params } = registerWhere(req);
  const body = listBody<Record<string, unknown>>(req.query, {
    sql,
    order: 'ORDER BY q.date DESC, q.id DESC',
    params,
  }, (rows) => rows.map((r) => ({
    ...r,
    // Derived here for exactly the reason it is derived everywhere else: a
    // check with nothing measured is **not** a pass.
    passed: Number(r.measured) === 0 ? null : Number(r.failed_count) === 0,
  })));
  // Measured over the whole filtered set, never the page — the rule the
  // despatch and work-order lists already follow.
  const summary = db.prepare(
    `WITH f AS (${sql})
     SELECT COUNT(*) AS checks,
            COALESCE(SUM(CASE WHEN measured = 0 THEN 1 ELSE 0 END), 0) AS unmeasured,
            COALESCE(SUM(CASE WHEN measured > 0 AND failed_count = 0 THEN 1 ELSE 0 END), 0) AS passed,
            COALESCE(SUM(CASE WHEN failed_count > 0 THEN 1 ELSE 0 END), 0) AS failed
       FROM f`
  ).get(...(params as never[]));
  res.json(Array.isArray(body) ? body : { ...body, summary });
});

workOrdersRouter.get('/:id', (req: AuthedRequest, res) => {
  const wo = getFull(req, Number(req.params.id));
  if (!wo) return res.status(404).json({ error: 'Work order not found' });
  res.json(wo);
});

workOrdersRouter.post('/', requirePermission('work_order', 'full'), (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  const order = db.prepare('SELECT id, customer_id, company_id FROM orders WHERE id = ?')
    .get(Number(body.order_id)) as { id: number; customer_id: number; company_id: number } | undefined;
  // Not "order is required": an order the caller cannot see must look the same
  // as one that does not exist.
  if (!order || !canAccessCustomer(req, order.customer_id)) {
    return res.status(404).json({ error: 'Order not found' });
  }
  if (!(Number(body.qty_planned) > 0)) {
    return res.status(400).json({ error: 'Planned quantity must be more than zero' });
  }

  const id = transaction(() => {
    // The job is numbered by the company that sold the order, so one series
    // covers everything that entity does.
    const companyId = resolveCompanyId(order.company_id, order.customer_id);
    const number = String(body.number ?? '').trim() || nextNumber('work_order', { companyId });
    const info = db.prepare(
      `INSERT INTO work_orders (number, company_id, ${fields.join(', ')}, status, created_by)
       VALUES (?, ?, ${fields.map(() => '?').join(', ')}, ?, ?)`
    ).run(
      number, companyId,
      order.id,
      Number(body.order_line) || 0,
      numOrNull(body.product_id),
      String(body.description ?? ''),
      Number(body.qty_planned) || 0,
      numOrNull(body.location_id),
      numOrNull(body.machine_id),
      numOrNull(body.mould_id),
      numOrNull(body.process_id),
      String(body.planned_start ?? ''),
      String(body.planned_end ?? ''),
      String(body.notes ?? ''),
      STATUSES.includes(String(body.status)) ? String(body.status) : 'planned',
      req.user!.id
    );
    return Number(info.lastInsertRowid);
  });

  // Raising a job is a fact about the order, so the order's status follows it.
  syncOrderStatus(order.id);
  res.status(201).json(getFull(req, id));
});

workOrdersRouter.put('/:id', requirePermission('work_order', 'full'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = accessible(req, id);
  if (!existing) return res.status(404).json({ error: 'Work order not found' });
  const body = req.body ?? {};
  const v = (f: string, def: unknown = '') => body[f] ?? existing[f] ?? def;
  if (!(Number(v('qty_planned', 0)) > 0)) {
    return res.status(400).json({ error: 'Planned quantity must be more than zero' });
  }
  // The order a job belongs to is not editable: moving it would silently move
  // the production figures onto another customer's line.
  db.prepare(
    `UPDATE work_orders SET number = ?, order_line = ?, product_id = ?, description = ?, qty_planned = ?,
       location_id = ?, machine_id = ?, mould_id = ?, process_id = ?, planned_start = ?, planned_end = ?, notes = ?
     WHERE id = ?`
  ).run(
    String(v('number')),
    Number(v('order_line', 0)) || 0,
    numOrNull(v('product_id', null)),
    String(v('description')),
    Number(v('qty_planned', 0)) || 0,
    numOrNull(v('location_id', null)),
    numOrNull(v('machine_id', null)),
    numOrNull(v('mould_id', null)),
    numOrNull(v('process_id', null)),
    String(v('planned_start')),
    String(v('planned_end')),
    String(v('notes')),
    id
  );
  res.json(getFull(req, id));
});

workOrdersRouter.post('/:id/status', requirePermission('work_order', 'full'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!accessible(req, id)) return res.status(404).json({ error: 'Work order not found' });
  const status = String(req.body?.status ?? '');
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
  db.prepare('UPDATE work_orders SET status = ? WHERE id = ?').run(status, id);
  res.json(getFull(req, id));
});

workOrdersRouter.delete('/:id', requirePermission('work_order', 'full'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!accessible(req, id)) return res.status(404).json({ error: 'Work order not found' });
  // Output already booked against the job is a record of what the floor made.
  // Cancelling keeps it; deleting would quietly erase a day's production.
  const entries = db.prepare('SELECT COUNT(*) AS c FROM production_entries WHERE work_order_id = ?')
    .get(id) as { c: number };
  if (entries.c > 0) {
    return res.status(409).json({
      error: `This job has ${entries.c} production ${entries.c === 1 ? 'entry' : 'entries'} against it — cancel it instead of deleting`,
    });
  }
  // Material issued to it is stock that physically left the store. Deleting the
  // job would leave those movements pointing at nothing.
  const issued = db.prepare('SELECT COUNT(*) AS c FROM material_moves WHERE work_order_id = ?')
    .get(id) as { c: number };
  if (issued.c > 0) {
    return res.status(409).json({
      error: 'Material has been issued to this job — cancel it instead of deleting',
    });
  }
  db.prepare('DELETE FROM work_orders WHERE id = ?').run(id);
  res.json({ ok: true });
});

/* ---------------- production entries ---------------- */

workOrdersRouter.post('/:id/entries', requirePermission('output', 'full'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!accessible(req, id)) return res.status(404).json({ error: 'Work order not found' });
  const body = req.body ?? {};
  const ok = Number(body.qty_ok) || 0;
  const reject = Number(body.qty_reject) || 0;
  if (ok < 0 || reject < 0) return res.status(400).json({ error: 'Quantities cannot be negative' });
  if (ok === 0 && reject === 0) return res.status(400).json({ error: 'Record some output — good or rejected' });
  if (!String(body.date ?? '').trim()) return res.status(400).json({ error: 'Date is required' });

  db.prepare(
    `INSERT INTO production_entries (work_order_id, date, shift, qty_ok, qty_reject, operator, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, String(body.date), String(body.shift ?? ''), ok, reject,
    String(body.operator ?? ''), String(body.notes ?? ''), req.user!.id);

  const job = db.prepare('SELECT order_id FROM work_orders WHERE id = ?').get(id) as { order_id: number };
  syncOrderStatus(job.order_id);
  res.status(201).json(getFull(req, id));
});

/* ---------------- quality control ---------------- */

/**
 * Record an inspection: a few pieces off the machine, measured.
 *
 * The tolerance for each measurement is **copied from the product's parameter
 * as the check is saved**, so tightening a spec later cannot retroactively
 * fail a batch that met the spec in force at the time — the same reasoning
 * that stamps a purchase rate onto a stock movement. Pass and fail are never
 * stored; `services/qc.ts` derives them from the measurement and the copy.
 *
 * Scoped through the job's own order, like every other floor action.
 */
workOrdersRouter.post('/:id/qc-checks', requirePermission('qc', 'full'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const wo = accessible(req, id);
  if (!wo) return res.status(404).json({ error: 'Work order not found' });
  const body = req.body ?? {};
  const date = String(body.date ?? '').trim();
  if (!date) return res.status(400).json({ error: 'Date is required' });

  // Recorded against the tolerances in force for *this* job's customer — and
  // copied onto the result below, so a batch stays readable when a spec moves.
  const specCustomer = (db.prepare('SELECT customer_id FROM orders WHERE id = ?')
    .get(Number(wo.order_id)) as { customer_id: number } | undefined)?.customer_id ?? null;
  const spec = new Map(paramsFor(wo.product_id as number | null, specCustomer).map((p) => [p.id, p]));
  const rows = Array.isArray(body.results) ? (body.results as Record<string, unknown>[]) : [];
  // A parameter left blank was not measured; it is not a failure, and it is
  // not recorded as one. Only what somebody actually read is stored.
  const measured = rows.filter((r) => r.value !== '' && r.value !== null && r.value !== undefined);
  if (!measured.length) {
    return res.status(400).json({ error: 'Record at least one measurement' });
  }
  const stray = measured.find((r) => !spec.has(Number(r.param_id)));
  if (stray) return res.status(400).json({ error: 'That check is not on the specification for this product' });

  let checkId = 0;
  transaction(() => {
    const info = db.prepare(
      `INSERT INTO qc_checks (work_order_id, date, shift, sample_size, inspector, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, date, String(body.shift ?? ''), numOrNull(body.sample_size),
      String(body.inspector ?? ''), String(body.notes ?? ''), req.user!.id);
    checkId = Number(info.lastInsertRowid);

    const ins = db.prepare(
      `INSERT INTO qc_results (check_id, param_id, name, kind, unit, value, min_value, max_value, notes, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    measured.forEach((r, i) => {
      const param = spec.get(Number(r.param_id))!;
      ins.run(
        checkId, param.id, param.name, param.kind, param.unit,
        // A visual check comes in as true/false and is stored as 1/0, so one
        // column holds both kinds and `resultOk` reads them the same way.
        param.kind === 'boolean' ? (r.value ? 1 : 0) : Number(r.value),
        param.min_value, param.max_value, String(r.notes ?? ''), i
      );
    });
  });
  res.status(201).json(getFull(req, id));
});

workOrdersRouter.delete('/qc-checks/:checkId', requirePermission('qc', 'full'), (req: AuthedRequest, res) => {
  const checkId = Number(req.params.checkId);
  const check = db.prepare('SELECT work_order_id FROM qc_checks WHERE id = ?')
    .get(checkId) as { work_order_id: number } | undefined;
  // Checked through the parent job, so an employee cannot delete an inspection
  // on somebody else's order.
  if (!check || !accessible(req, check.work_order_id)) {
    return res.status(404).json({ error: 'Check not found' });
  }
  // Results cascade on the foreign key; a deleted check simply stops counting,
  // because the verdicts were never stored to go stale.
  db.prepare('DELETE FROM qc_checks WHERE id = ?').run(checkId);
  res.json(getFull(req, check.work_order_id));
});

workOrdersRouter.delete('/entries/:entryId', requirePermission('output', 'full'), (req: AuthedRequest, res) => {
  const entryId = Number(req.params.entryId);
  const entry = db.prepare('SELECT work_order_id FROM production_entries WHERE id = ?')
    .get(entryId) as { work_order_id: number } | undefined;
  // Checked through the parent job, so an employee cannot delete a shift on
  // another owner's order by guessing an id.
  if (!entry || !accessible(req, entry.work_order_id)) {
    return res.status(404).json({ error: 'Entry not found' });
  }
  db.prepare('DELETE FROM production_entries WHERE id = ?').run(entryId);
  res.json(getFull(req, entry.work_order_id));
});
