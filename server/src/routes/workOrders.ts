import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { nextNumber } from '../services/numbering.js';
import { progressFor, progressForMany } from '../services/production.js';
import { materialCostByWorkOrder } from '../services/costing.js';
import { paramsFor, checksForWorkOrder, summaryForWorkOrder } from '../services/qc.js';
import { requirementFor } from '../services/recipe.js';
import { syncOrderStatus } from '../services/orderStatus.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { scopeClause, canAccessCustomer } from '../middleware/scope.js';
import { resolveCompanyId } from '../services/companies.js';

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
         l.name AS location_name, m.name AS machine_name, md.name AS mould_name,
         u.name AS created_by_name
  FROM work_orders w
  JOIN orders o ON o.id = w.order_id
  JOIN customers c ON c.id = o.customer_id
  LEFT JOIN products p ON p.id = w.product_id
  LEFT JOIN locations l ON l.id = w.location_id
  LEFT JOIN machines m ON m.id = w.machine_id
  LEFT JOIN moulds md ON md.id = w.mould_id
  LEFT JOIN users u ON u.id = w.created_by`;

const fields = [
  'order_id', 'order_line', 'product_id', 'description', 'qty_planned',
  'location_id', 'machine_id', 'mould_id', 'planned_start', 'planned_end', 'notes',
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
  wo.qc = {
    params: paramsFor(wo.product_id as number | null),
    checks: checksForWorkOrder(id),
    summary: summaryForWorkOrder(id, wo.product_id as number | null),
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

  const rows = db.prepare(
    `${listSql} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE WHEN w.planned_start = '' THEN 1 ELSE 0 END, w.planned_start, w.id DESC`
  ).all(...(params as never[])) as Record<string, unknown>[];

  const progress = progressForMany(
    rows.map((r) => ({ id: Number(r.id), qty_planned: Number(r.qty_planned) || 0 }))
  );
  res.json(rows.map((r) => ({ ...r, progress: progress.get(Number(r.id)) })));
});

workOrdersRouter.get('/:id', (req: AuthedRequest, res) => {
  const wo = getFull(req, Number(req.params.id));
  if (!wo) return res.status(404).json({ error: 'Work order not found' });
  res.json(wo);
});

workOrdersRouter.post('/', (req: AuthedRequest, res) => {
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

workOrdersRouter.put('/:id', (req: AuthedRequest, res) => {
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
       location_id = ?, machine_id = ?, mould_id = ?, planned_start = ?, planned_end = ?, notes = ?
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
    String(v('planned_start')),
    String(v('planned_end')),
    String(v('notes')),
    id
  );
  res.json(getFull(req, id));
});

workOrdersRouter.post('/:id/status', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!accessible(req, id)) return res.status(404).json({ error: 'Work order not found' });
  const status = String(req.body?.status ?? '');
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
  db.prepare('UPDATE work_orders SET status = ? WHERE id = ?').run(status, id);
  res.json(getFull(req, id));
});

workOrdersRouter.delete('/:id', (req: AuthedRequest, res) => {
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

workOrdersRouter.post('/:id/entries', (req: AuthedRequest, res) => {
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
workOrdersRouter.post('/:id/qc-checks', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const wo = accessible(req, id);
  if (!wo) return res.status(404).json({ error: 'Work order not found' });
  const body = req.body ?? {};
  const date = String(body.date ?? '').trim();
  if (!date) return res.status(400).json({ error: 'Date is required' });

  const spec = new Map(paramsFor(wo.product_id as number | null).map((p) => [p.id, p]));
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

workOrdersRouter.delete('/qc-checks/:checkId', (req: AuthedRequest, res) => {
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

workOrdersRouter.delete('/entries/:entryId', (req: AuthedRequest, res) => {
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
