import { Router, type Response } from 'express';
import { db, transaction } from '../db/connection.js';
import { nextNumber } from '../services/numbering.js';
import { batchesFor, batchById, coaBlockError, coaGroupError, renameError, dispositionError, isDisposition, DISPOSITIONS }
  from '../services/batch.js';
import { progressFor, progressForMany, LIVE_OK } from '../services/production.js';
import { despatchedByOrder, lastTripForLine } from '../services/despatch.js';
import { materialCostByWorkOrder } from '../services/costing.js';
import { paramsFor, checksForWorkOrder, summaryForWorkOrder, specOwner, RESULT_FAILED_SQL } from '../services/qc.js';
import { requirementForJob, snapshotRecipe, recipeDiffers } from '../services/recipe.js';
import { insertJob, plannedDateError, type OrderRef } from '../services/orderJobs.js';
import { syncOrderStatus } from '../services/orderStatus.js';
import { syncJobStatus, DUE_TO_START } from '../services/jobStatus.js';
import { requirePermission, type AuthedRequest } from '../middleware/auth.js';
import { readyLines } from '../services/dispatchReady.js';
import { notifyAwaitingRelease } from '../services/handoffMail.js';
import { scopeClause, canAccessCustomer } from '../middleware/scope.js';
import { resolveCompanyId } from '../services/companies.js';
import { listBody } from '../services/pagination.js';
import {
  listSql, jobListWhere, jobSummary, jobFacet, readJobFilters, isJobFilterColumn,
  JOB_ORDER, JOB_FILTERABLE, type JobFilters,
} from '../services/workOrderList.js';
import { buildXlsx, attachmentName, type Column } from '../services/xlsx.js';

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

const fields = [
  'order_id', 'order_line', 'product_id', 'description', 'qty_planned',
  'location_id', 'machine_id', 'mould_id', 'process_id', 'planned_start', 'planned_end',
  'revised_start', 'revised_end', 'notes',
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

/**
 * Everything about one job. `costs` is an optional pre-built map: building it
 * replays the whole material ledger, so a caller answering about many jobs at
 * once builds it once and hands it in rather than replaying per job. Omitted,
 * it is built here as it always was.
 */
function getFull(req: AuthedRequest, id: number, costs?: Map<number, number>) {
  const wo = accessible(req, id);
  if (!wo) return undefined;
  wo.entries = db.prepare(
    `SELECT e.*, u.name AS created_by_name FROM production_entries e
     LEFT JOIN users u ON u.id = e.created_by
     WHERE e.work_order_id = ? ORDER BY e.date, e.id`
  ).all(id);
  wo.progress = progressFor(id, Number(wo.qty_planned) || 0);
  /*
   * What has physically gone against this job's order line — the reverse of
   * the *Ready to dispatch* queue, and the other half of what the client meant
   * by connecting the two (2026-10-08).
   *
   * **Read, never stored, and deliberately not a Dispatch tab.** `despatches`
   * has no `work_order_id` and a lorry carries lines from several jobs at
   * once, which is the reason this page has never had one; what it can honestly
   * say is how much of *this line* has left and under which paper. Keyed on the
   * order line, the chain's own index rule, so a split run's two jobs both
   * report the line's shipment rather than inventing a split of it.
   */
  const line = Number(wo.order_line);
  const sent = despatchedByOrder(Number(wo.order_id)).get(line);
  wo.dispatched = sent
    ? { ...sent, last_trip: lastTripForLine(Number(wo.order_id), line) }
    : { qty: 0, packs: 0, trips: 0, last_date: '', last_trip: null };
  // The lots this job has made, each with what was booked into it, its final
  // check and its certificate. Derived on read like the progress above it.
  wo.batches = batchesFor(id);
  // What the material issued to this job has cost, at the moving average in
  // force when each issue was made. Zero means nothing has been issued yet,
  // which is a real answer — unlike an uncosted product, whose need is
  // unknown rather than nil.
  wo.material_cost = (costs ?? materialCostByWorkOrder()).get(id) ?? 0;
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
  const req_ = requirementForJob(id, wo.product_id as number | null, Number(wo.qty_planned) || 0);
  // Issued so far, so the screen can show planned against actual consumption —
  // the point of having a recipe at all.
  const issued = db.prepare(
    `SELECT material_id, COALESCE(SUM(-qty), 0) AS q FROM material_moves
     WHERE work_order_id = ? AND source = 'issue' GROUP BY material_id`
  ).all(id) as { material_id: number; q: number }[];
  const byMaterial = new Map(issued.map((r) => [r.material_id, r.q]));
  wo.material = {
    has_recipe: req_.hasRecipe,
    // Which recipe answered, and whether the product's has moved since — so
    // the screen can say the job is costed against an older one rather than
    // letting the two quietly disagree.
    snapshot: req_.snapshot,
    recipe_differs: recipeDiffers(id, wo.product_id as number | null),
    lines: req_.lines.map((l) => ({ ...l, issued: byMaterial.get(l.material_id) ?? 0 })),
    // Anything issued that the recipe never mentioned still has to show up.
    extra: issued
      .filter((r) => !req_.lines.some((l) => l.material_id === r.material_id))
      .map((r) => ({ material_id: r.material_id, issued: r.q })),
  };
  return wo;
}

/** The list's filters as the request states them. */
function jobFilters(req: AuthedRequest): JobFilters {
  const scope = scopeClause(req, 'o.customer_id');
  return {
    scopeSql: scope.sql || undefined,
    scopeParams: scope.params,
    orderId: Number(req.query.order_id) > 0 ? Number(req.query.order_id) : undefined,
    machineId: Number(req.query.machine_id) > 0 ? Number(req.query.machine_id) : undefined,
    locationId: Number(req.query.location_id) > 0 ? Number(req.query.location_id) : undefined,
    awaiting: req.query.awaiting === '1',
    openOnly: req.query.open === '1',
    // The sales order book's own three, read under the same keys — `export`,
    // `company` and `q` — so a habit learned on one list works on the other
    // and a link copied between them means the same thing.
    isExport: req.query.export === '1' ? 1 : req.query.export === '0' ? 0 : undefined,
    companyId: Number(req.query.company) > 0 ? Number(req.query.company) : undefined,
    q: String(req.query.q ?? '').trim() || undefined,
    columns: readJobFilters(req.query as Record<string, unknown>),
  };
}

workOrdersRouter.get('/', requirePermission('work_order'), (req: AuthedRequest, res) => {
  const f = jobFilters(req);
  const { sql, params } = jobListWhere(f);
  const body = listBody<Record<string, unknown>>(req.query, { sql, order: JOB_ORDER, params }, (rows) => {
    const progress = progressForMany(
      rows.map((r) => ({ id: Number(r.id), qty_planned: Number(r.qty_planned) || 0 }))
    );
    return rows.map((r) => ({ ...r, progress: progress.get(Number(r.id)) }));
  });
  // "N jobs, X of Y pcs made" is a statement about the floor, not about the
  // page, so it is measured over every job matching the filters.
  res.json(Array.isArray(body) ? body : { ...body, summary: jobSummary(f) });
});

/**
 * What one column's tick list should offer, over the whole filtered list.
 *
 * Declared **above `/:id`**, the rule every sibling here follows, or Express
 * reads "facet" as a work order id. Scoped by `jobListWhere` like the list it
 * describes, so a dropdown names the customers that login can already see — a
 * facet is a list of real values off real rows, and an unscoped one would be a
 * customer book handed out through a filter control.
 */
workOrdersRouter.get('/facet', requirePermission('work_order'), (req: AuthedRequest, res) => {
  const column = String(req.query.column ?? '');
  if (!isJobFilterColumn(column)) {
    return res.status(400).json({ error: `Not a filterable column: ${column}` });
  }
  if (JOB_FILTERABLE[column].kind !== 'values') {
    return res.status(400).json({ error: `${column} is filtered by range, not by a list of values` });
  }
  res.json(jobFacet(jobFilters(req), column, { search: String(req.query.search ?? '') }));
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

/**
 * The QC register as a spreadsheet.
 *
 * Declared above `/:id` like the register itself, and gated on the same `qc`
 * permission — an export is a read, and one mounted without its own guard is
 * how a whole list escapes through a route nobody thinks of as part of the
 * module. It shares `registerWhere`, so the download can never hold rows the
 * table above it did not, and it exports the **whole filtered set, never a
 * page**.
 *
 * The verdict is written out as a word rather than left as three counts,
 * because that is what somebody reconciling in Excel filters on — and it keeps
 * the file honest about the one distinction that matters here: **nothing
 * measured is not a pass**.
 */
const qcColumns: Column<Record<string, unknown>>[] = [
  { header: 'Date', value: (r) => String(r.date ?? ''), type: 'date' },
  { header: 'Shift', value: (r) => String(r.shift ?? '') },
  { header: 'Work order', value: (r) => String(r.work_order_number ?? '') },
  { header: 'Order', value: (r) => String(r.order_number ?? '') },
  { header: 'Customer', value: (r) => String(r.customer_name ?? '') },
  { header: 'Product', value: (r) => String(r.product_name ?? r.description ?? '') },
  { header: 'Inspector', value: (r) => String(r.inspector ?? '') },
  { header: 'Sample size', value: (r) => (r.sample_size == null ? null : Number(r.sample_size)), type: 'number' },
  { header: 'Readings', value: (r) => Number(r.readings ?? 0), type: 'number' },
  { header: 'Measured', value: (r) => Number(r.measured ?? 0), type: 'number' },
  { header: 'Failed', value: (r) => Number(r.failed_count ?? 0), type: 'number' },
  {
    header: 'Verdict',
    value: (r) => (Number(r.measured) === 0 ? 'Not measured' : Number(r.failed_count) === 0 ? 'Pass' : 'Fail'),
  },
  { header: 'Notes', value: (r) => String(r.notes ?? '') },
];

workOrdersRouter.get('/qc-checks/export', requirePermission('qc'), (req: AuthedRequest, res) => {
  const { sql, params } = registerWhere(req);
  const rows = db.prepare(`${sql} ORDER BY q.date DESC, q.id DESC`)
    .all(...(params as never[])) as Record<string, unknown>[];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${attachmentName('QC checks')}"`);
  res.send(buildXlsx('QC checks', qcColumns, rows));
});

/**
 * What is waiting on a check — Quality's own queue (2026-10-20, the client,
 * looking at a Held list full of *"has not passed QC yet"*: *"QC not done
 * should be shown in quality tab as pending"*).
 *
 * **The same rows, read from the other side.** It is `readyLines` filtered to
 * those its QC gate is holding, never a second question about what needs
 * inspecting — a queue with its own rule would be a second definition of a
 * pass, which `qc.ts` says twice it must not have. So a line leaves this list
 * the moment the check that unblocks it is recorded, by construction.
 *
 * It therefore inherits that function's shape exactly: a line is here only
 * when goods **exist and cannot ship** (`outstanding > 0` — made, within what
 * was ordered, not yet sent), which is the actionable set. A job with nothing
 * made yet has nothing to measure, and a product with no specification is
 * never blocked at all — `has_spec: false` means nobody has said what to
 * measure, the rule that module states about itself.
 *
 * `qc: view` rather than `full`, so the four teams that read a certificate
 * can see what is outstanding; recording the check is still `qc: full` on the
 * route that does it. Declared **above `/:id`**, or Express reads
 * "qc-pending" as a work order id — the trap `/qc-checks` already sits above
 * that route for.
 */
workOrdersRouter.get('/qc-pending', requirePermission('qc'), (req: AuthedRequest, res) => {
  const rows = readyLines(req).rows.filter((r) => r.qc_hold);
  res.json({ rows, pending: rows.length });
});

workOrdersRouter.get('/:id', requirePermission('work_order'), (req: AuthedRequest, res) => {
  const wo = getFull(req, Number(req.params.id));
  if (!wo) return res.status(404).json({ error: 'Work order not found' });
  res.json(wo);
});

/*
 * `insertJob` and `productOfLine` live in `services/orderJobs.ts` now: the
 * sales order raises its own jobs on booking, so the one place a job is
 * written is a service both this router and the order's route can reach.
 *
 * `POST /bulk` went with the Production tab it served — see that file.
 */
/**
 * Plan several jobs at once: machine, mould, process, plant, dates — and
 * release them, which is what moves them *Not planned → Scheduled*.
 *
 * The step the order-raised job created a need for (2026-09-11): every job now
 * arrives with nothing set, and filling six of them in one at a time on the
 * job page was the day's chore. This is one press over a ticked set on the
 * Work Orders list.
 *
 * **Two shapes, one act** (2026-09-29). `ids` plus shared fields is the
 * dialog's: one date across a ticked set. `jobs` is the list's planning grid's:
 * `[{ id, planned_start, … }]`, a date **per job**, typed down the page and
 * saved in one press. They share the guards, the transaction and the single
 * re-sync per order because they are the same act — the dialog cannot express a
 * date per job, and the grid must not be one request per row, but neither is a
 * reason for a second route that would then have to be kept in step with this
 * one.
 *
 * **A field omitted is left alone; a field sent blank clears it** — the
 * despatch `batch_ids` contract. So planning the mould on four jobs does not
 * wipe the machine two of them already had, and clearing a date is a thing
 * somebody can actually do. `release` is separate from the fields because it
 * is a different act: setting a machine says where, releasing says go. A job
 * that is already past `planned` is never moved back by this — releasing a
 * running job is a no-op, not a demotion.
 *
 * One request, one transaction: six jobs planned is one act, and six separate
 * PUTs would leave half a shift planned when the fourth failed. Every job is
 * checked for scope before anything is written. Cancelled and completed jobs
 * are refused by name rather than silently skipped: a plan that quietly left
 * one out reads as success.
 *
 * `work_order: full`, like editing a job — Production and the super admin.
 */
workOrdersRouter.post('/plan', requirePermission('work_order', 'full'), (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  const perJob = Array.isArray(body.jobs);
  // One shape inside: an id and the patch that applies to it. For `ids` every
  // row takes the same patch, which is the body itself.
  const rows: { id: number; patch: Record<string, unknown> }[] = perJob
    ? (body.jobs as Record<string, unknown>[]).map((r) => ({ id: Number(r?.id), patch: r ?? {} }))
    : (Array.isArray(body.ids) ? body.ids : []).map((n: unknown) => ({ id: Number(n), patch: body }));

  if (!rows.length) {
    return res.status(400).json({ error: perJob ? 'Send at least one job to plan' : 'Tick at least one job to plan' });
  }
  /*
   * A malformed id is **refused, not dropped**. Filtering it out is right for a
   * writer and wrong for a guard: the press then succeeds with the job somebody
   * meant to plan silently absent from it, which is the quiet loss
   * `despatchBatchError` records finding the same way.
   */
  if (rows.some((r) => !Number.isInteger(r.id) || r.id <= 0)) {
    return res.status(400).json({ error: 'Every job to plan needs an id' });
  }
  const ids = rows.map((r) => r.id);
  if (new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: 'The same job was sent twice' });
  }

  const jobs = ids.map((id) => accessible(req, id));
  const missing = jobs.findIndex((j) => !j);
  if (missing >= 0) return res.status(404).json({ error: 'Work order not found' });
  const closed = (jobs as Record<string, unknown>[]).filter((j) => ['done', 'cancelled'].includes(String(j.status)));
  if (closed.length) {
    return res.status(409).json({
      error: `${closed.map((j) => j.number).join(', ')} ${closed.length === 1 ? 'is' : 'are'} already ${closed.length === 1 ? String(closed[0].status) === 'done' ? 'completed' : 'cancelled' : 'completed or cancelled'} and cannot be planned.`,
    });
  }

  // The original plan is recorded once. Checked before anything is written, so
  // one refused row leaves the whole press unwritten like the closed-job check
  // above it.
  for (let i = 0; i < rows.length; i++) {
    const err = plannedDateError(jobs[i] as { number: string; planned_start?: string; planned_end?: string }, rows[i].patch);
    if (err) return res.status(409).json({ error: err });
  }

  // Only what was sent is written, per job. `undefined` means "not in the
  // patch" and is left alone; blank clears.
  const patches = rows.map(({ id, patch }) => {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const f of ['location_id', 'machine_id', 'mould_id', 'process_id'] as const) {
      if (f in patch) { sets.push(`${f} = ?`); params.push(numOrNull(patch[f])); }
    }
    for (const f of ['planned_start', 'planned_end', 'revised_start', 'revised_end'] as const) {
      if (f in patch) { sets.push(`${f} = ?`); params.push(String(patch[f] ?? '')); }
    }
    return { id, sets, params };
  });
  const release = body.release === true;
  if (!patches.some((p) => p.sets.length) && !release) {
    return res.status(400).json({ error: 'Nothing to plan: send at least one field, or release' });
  }

  transaction(() => {
    for (const p of patches) {
      if (!p.sets.length) continue;
      db.prepare(`UPDATE work_orders SET ${p.sets.join(', ')} WHERE id = ?`).run(...(p.params as never[]), p.id);
    }
    // Forward only: a job already released, running or paused stays where it is.
    if (release) db.prepare(`UPDATE work_orders SET status = 'released' WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'planned'`).run(...ids);
  });
  // A start date or a release is what schedules the order, so every order
  // touched is asked again — once each, however many of its jobs were ticked.
  for (const orderId of new Set((jobs as Record<string, unknown>[]).map((j) => Number(j.order_id)))) syncOrderStatus(orderId);
  // Once for the answer, not once per job: a page of the grid can carry eighty.
  const costs = materialCostByWorkOrder();
  res.json({ planned: ids.length, jobs: ids.map((id) => getFull(req, id, costs)) });
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

  /*
   * A job inherits its order line's product when the caller does not name one.
   *
   * `product_id` came from the body alone, and the two readers of it disagree:
   * `qcBlockError` asks whether the **order line's** product carries a
   * specification, while `POST /:id/qc-checks` builds the allowed parameters
   * from the **job's**. A job raised without one against a spec'd line was
   * therefore blocked with no way out — the gate said a check was needed and
   * the check route answered "not on the specification for this product".
   *
   * Latent while only the despatch register asked, and reachable the moment
   * the commercial invoice began asking too, so it is closed here. Strictly a
   * fallback: a body naming a product still wins, and the order page has
   * always sent one.
   */
  const id = transaction(() => insertJob(order, body, req.user!.id));

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
  // A save that sends the row back unchanged is never refused — the guard asks
  // whether the body *moves* an original that was already recorded.
  const fixed = plannedDateError(existing as { number: string; planned_start?: string; planned_end?: string }, body);
  if (fixed) return res.status(409).json({ error: fixed });
  // The order a job belongs to is not editable: moving it would silently move
  // the production figures onto another customer's line.
  db.prepare(
    `UPDATE work_orders SET number = ?, order_line = ?, product_id = ?, description = ?, qty_planned = ?,
       location_id = ?, machine_id = ?, mould_id = ?, process_id = ?, planned_start = ?, planned_end = ?,
       revised_start = ?, revised_end = ?, notes = ?
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
    String(v('revised_start')),
    String(v('revised_end')),
    String(v('notes')),
    id
  );
  /*
   * A start date is one of the two things that schedule an order, so editing
   * one moves a rung and the order has to be asked again.
   *
   * Unlike the despatch PUT, which deliberately calls nothing: that one edits
   * a trip's lines, dates and references, and `impliedStatus` reads only the
   * despatch *count* — so a call there would be symmetry rather than
   * correctness. Here it is correctness, because `planned_start` is an input.
   */
  // `qty_planned` is what "everything made" is measured against, so correcting
  // it can complete a job or re-open one.
  syncJobStatus(id);
  syncOrderStatus(Number(existing.order_id));
  res.json(getFull(req, id));
});

workOrdersRouter.post('/:id/status', requirePermission('work_order', 'full'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!accessible(req, id)) return res.status(404).json({ error: 'Work order not found' });
  const status = String(req.body?.status ?? '');
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
  /*
   * A status set by hand **is** the floor, so the memory is cleared with it:
   * a job somebody marked Completed on a short run stays completed however the
   * shift book later adds up, and one they paused is left alone entirely. The
   * same call `POST /orders/:id/status` makes about its own memory.
   */
  db.prepare("UPDATE work_orders SET status = ?, status_before_auto = '' WHERE id = ?").run(status, id);
  /*
   * Releasing a job schedules the order, and **cancelling one un-does
   * whatever it had raised** — `impliedStatus` counts only live jobs, so
   * without this the last job on an order could be cancelled while the order
   * went on claiming Scheduled over an empty floor. That half was wrong before
   * the release rung existed: the ladder rework of 2026-09-10 found the three
   * *delete* routes that never synced and missed this one, which cancels.
   */
  syncOrderStatus(Number(accessible(req, id)!.order_id));
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
  const job = db.prepare('SELECT order_id FROM work_orders WHERE id = ?').get(id) as { order_id: number };
  db.prepare('DELETE FROM work_orders WHERE id = ?').run(id);
  // Raising the job advanced the order, so deleting it has to be able to undo
  // that — never below whatever status a person set themselves.
  syncOrderStatus(job.order_id);
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
  // Which lot this shift's output went into, when the job is being batched.
  // Nullable, so a job that is not batched records exactly as it always did.
  const entryBatch = numOrNull(body.batch_id);
  if (entryBatch !== null) {
    const owned = db.prepare('SELECT id FROM batches WHERE id = ? AND work_order_id = ?')
      .get(entryBatch, id) as { id: number } | undefined;
    if (!owned) return res.status(400).json({ error: 'That batch is not on this work order' });
  }

  const job = db.prepare('SELECT order_id, order_line FROM work_orders WHERE id = ?')
    .get(id) as { order_id: number; order_line: number };

  /*
   * What the desk was already waiting on, **before** this shift is written.
   *
   * The client's own choice (2026-10-19): Sales hears when a line *joins*
   * their release queue, not on every shift entry — a line is booked against
   * several times a day, and an email apiece would be dozens about one order
   * to the same people. So the notification below fires only on the crossing
   * from nothing-waiting to something-waiting, and stays quiet until the line
   * is released and the floor books more.
   *
   * Asked of `readyLines` narrowed to this order rather than summed here: one
   * definition of what is awaiting, so the email and the queue it points at
   * can never disagree about whether there is anything to look at.
   */
  const lineOf = (r: { order_line: number }) => r.order_line === job.order_line;
  const was = readyLines(req, { orderId: job.order_id }).rows.find(lineOf)?.awaiting ?? 0;

  db.prepare(
    `INSERT INTO production_entries (work_order_id, batch_id, date, shift, qty_ok, qty_reject, operator, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, entryBatch, String(body.date), String(body.shift ?? ''), ok, reject,
    String(body.operator ?? ''), String(body.notes ?? ''), req.user!.id);

  // The job first: booked output is what moves it to Running, and the order's
  // own ladder reads job statuses in turn.
  syncJobStatus(id);
  syncOrderStatus(job.order_id);
  res.status(201).json(getFull(req, id));

  const now = readyLines(req, { orderId: job.order_id }).rows.find(lineOf);
  if (was <= 0 && now && now.awaiting > 0) {
    notifyAwaitingRelease(
      job.order_id,
      job.order_line,
      now.product_name || now.description || 'this line',
      now.awaiting,
      req.user?.id ?? null,
    );
  }
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
/* ---------------- batches and their certificates ---------------- */

/**
 * A lot on this job.
 *
 * `output: full` rather than `qc`: opening a batch is a statement about what
 * the floor is making, and it is Production that makes it. Issuing the
 * certificate below is the Quality act, and the two are deliberately held by
 * different roles — the client's ERP specification gives *Final COA Approval*
 * to the QC Inspector and no access to the shop log at all.
 *
 * Declared **above `/:id`** like every sub-resource here, or Express reads
 * "batches" as a work order id.
 */
workOrdersRouter.post('/:id/batches', requirePermission('output', 'full'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const wo = accessible(req, id);
  if (!wo) return res.status(404).json({ error: 'Work order not found' });
  const body = req.body ?? {};
  const date = String(body.date ?? '').trim();
  if (!date) return res.status(400).json({ error: 'Date is required' });

  // Numbered by the company that sold the order, like the job itself — one
  // series covers everything that entity makes.
  const order = db.prepare('SELECT company_id, customer_id FROM orders WHERE id = ?')
    .get(Number(wo.order_id)) as { company_id: number; customer_id: number };
  const companyId = resolveCompanyId(order.company_id, order.customer_id);
  const number = String(body.number ?? '').trim() || nextNumber('batch', { companyId, date });

  const info = db.prepare(
    `INSERT INTO batches (number, work_order_id, date, notes, created_by) VALUES (?, ?, ?, ?, ?)`
  ).run(number, id, date, String(body.notes ?? ''), req.user!.id);
  res.status(201).json(batchById(Number(info.lastInsertRowid)));
});

workOrdersRouter.put('/batches/:batchId', requirePermission('output', 'full'), (req: AuthedRequest, res) => {
  const batchId = Number(req.params.batchId);
  const b = db.prepare('SELECT work_order_id FROM batches WHERE id = ?').get(batchId) as
    { work_order_id: number } | undefined;
  // Reached through the parent job, so nobody edits another owner's lot by
  // guessing an id — the rule the shift entries follow.
  if (!b || !accessible(req, Number(b.work_order_id))) {
    return res.status(404).json({ error: 'Batch not found' });
  }
  const body = req.body ?? {};
  // A lot on a certificate, a challan or a credit note keeps its number.
  const renamed = renameError(batchId, body.number);
  if (renamed) return res.status(409).json({ error: renamed });
  const existing = batchById(batchId)!;
  db.prepare('UPDATE batches SET number = ?, date = ?, notes = ? WHERE id = ?').run(
    String(body.number ?? existing.number).trim() || existing.number,
    String(body.date ?? existing.date).trim() || existing.date,
    String(body.notes ?? existing.notes),
    batchId
  );
  res.json(batchById(batchId));
});

workOrdersRouter.delete('/batches/:batchId', requirePermission('output', 'full'), (req: AuthedRequest, res) => {
  const batchId = Number(req.params.batchId);
  const b = db.prepare('SELECT work_order_id FROM batches WHERE id = ?').get(batchId) as
    { work_order_id: number } | undefined;
  if (!b || !accessible(req, Number(b.work_order_id))) {
    return res.status(404).json({ error: 'Batch not found' });
  }
  const full = batchById(batchId)!;
  /*
   * A lot that has left the plant is the least deletable of the three, so it
   * is asked first — the most specific refusal is the one worth reading.
   *
   * In practice a shipped lot is always a certified one, since a trip may only
   * name a lot that carries a COA — but this is stated rather than left to
   * that implication, because a delete guard that covers a foreign key only by
   * transitivity is one that stops covering it the moment the other rule
   * moves, and a missed reference reaches the user as "Internal server error".
   */
  if (full.trips.length) {
    const where = full.trips.map((t) => t.reference || t.order_number).filter(Boolean).join(', ');
    return res.status(409).json({
      error: `Batch ${full.number} has been dispatched${where ? ` on ${where}` : ''} and cannot be deleted.`,
    });
  }
  // And the link the other way: a lot named as returned on a credit note.
  if (full.returns.length) {
    return res.status(409).json({
      error: `Batch ${full.number} is named as returned on ${full.returns.map((n) => n.number).join(', ')} and cannot be deleted.`,
    });
  }
  // A certified lot is on paper with the customer; a lot with output behind it
  // is a day's production. Neither is deleted to tidy up — the entries are
  // moved off it first, which is a decision somebody makes on purpose.
  if (full.cleared) {
    return res.status(409).json({ error: `Batch ${full.number} has been certified as ${full.coa_no} and cannot be deleted.` });
  }
  if (full.entries > 0) {
    return res.status(409).json({
      error: `Batch ${full.number} has ${full.entries} production ${full.entries === 1 ? 'entry' : 'entries'} against it — move those off it first.`,
    });
  }
  db.prepare('DELETE FROM batches WHERE id = ?').run(batchId);
  res.json({ ok: true });
});

/**
 * Issue the Certificate of Analysis.
 *
 * **`qc: full`, which is the whole point of the endpoint**: the specification
 * gives *Final COA Approval* to the QC Inspector, and Production — which
 * opened the batch and booked its output — holds no `qc` at all. So the lot is
 * made by one team and cleared by another, which is what a certificate is for.
 *
 * `coaBlockError` owns why it may be refused. The number is claimed **here**,
 * inside the same statement that records the issue, and never at print time:
 * `/api/pdf` is a GET, and a GET that consumed a number would issue a fresh
 * certificate every time somebody opened the file.
 */
workOrdersRouter.post('/batches/:batchId/coa', requirePermission('qc', 'full'), (req: AuthedRequest, res) =>
  issueCoa(req, res, [Number(req.params.batchId)]));

/**
 * The same certificate over **several** lots, which is how Aglo issue theirs:
 * *Batch No: 05032026A+B TO 09032026A+B*, five days of two shifts under one
 * number. Per lot that consignment would be ten documents where the buyer
 * has one.
 *
 * One number, written to every named lot in **one transaction**, so a group
 * refused for one bad lot writes nothing at all — a half-issued certificate
 * being worse than none. `coaGroupError` owns the two rules that are about the
 * group (something named, one sales order) and asks `coaBlockError` about each
 * lot, so the single-lot door above and this one refuse for the same reasons
 * in the same words.
 *
 * Declared **above** nothing in particular, but it must not be reachable as
 * `/batches/:batchId/coa` — it is not, the paths differing in shape.
 */
workOrdersRouter.post('/batches/coa', requirePermission('qc', 'full'), (req: AuthedRequest, res) => {
  const raw = Array.isArray(req.body?.batch_ids) ? (req.body.batch_ids as unknown[]) : [];
  const ids = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length !== raw.length) {
    return res.status(400).json({ error: 'Every batch must be named by its id, once' });
  }
  return issueCoa(req, res, ids);
});

/**
 * Claim one certificate number and write it to every lot named.
 *
 * The number is claimed **here**, inside the same statement that records the
 * issue, and never at print time: `/api/pdf` is a GET, and a GET that consumed
 * a number would issue a fresh certificate every time somebody opened the
 * file.
 *
 * `approved_by` is the second signatory — the one field of the header that
 * cannot be derived from anything the app holds. Both of Aglo's certificates
 * carry *Prepared by* and *Approved by*; the first is the account that issued
 * it, which is already recorded.
 */
function issueCoa(req: AuthedRequest, res: Response, ids: number[]) {
  // Scope first, so an id on somebody else's order cannot be probed for
  // through a refusal that names the batch.
  for (const id of ids) {
    const b = db.prepare('SELECT work_order_id FROM batches WHERE id = ?').get(id) as
      { work_order_id: number } | undefined;
    if (!b || !accessible(req, Number(b.work_order_id))) {
      return res.status(404).json({ error: 'Batch not found' });
    }
  }
  const refused = coaGroupError(ids);
  if (refused) return res.status(409).json({ error: refused });

  const first = db.prepare('SELECT work_order_id FROM batches WHERE id = ?').get(ids[0]) as
    { work_order_id: number };
  const wo = accessible(req, Number(first.work_order_id))!;
  const order = db.prepare('SELECT company_id, customer_id FROM orders WHERE id = ?')
    .get(Number(wo.order_id)) as { company_id: number; customer_id: number };
  const companyId = resolveCompanyId(order.company_id, order.customer_id);
  const date = String(req.body?.date ?? '').trim() || new Date().toISOString().slice(0, 10);
  const approvedBy = String(req.body?.approved_by ?? '').trim();

  writeCoa(ids, date, req.user!.id, approvedBy, companyId);
  res.status(201).json(ids.map((id) => batchById(id)));
}

/**
 * One number written to every lot named, in one transaction — the act itself,
 * split out when `certify` became its second caller. A lot is certified once,
 * so this is the only place that writes `coa_no`.
 */
function writeCoa(ids: number[], date: string, userId: number, approvedBy: string, companyId: number): string {
  let number = '';
  transaction(() => {
    number = nextNumber('coa', { companyId, date });
    const set = db.prepare(
      'UPDATE batches SET coa_no = ?, coa_date = ?, coa_issued_by = ?, coa_approved_by = ? WHERE id = ?'
    );
    for (const id of ids) set.run(number, date, userId, approvedBy, id);
  });
  return number;
}

/**
 * What to do with a lot that failed — the specification's *"initiating rework
 * or scrap procedures"*.
 *
 * **`qc: full`, like the certificate**, and for the same reason: the spec has
 * QC initiate this, it follows directly from a failed final check, and it is
 * the one act that can condemn a day's output. Production, which opened the
 * lot and booked its shifts, holds no `qc` and cannot.
 *
 * Recorded the way the COA is — who, when, and why — with the note kept
 * because *why* is the only part of a scrap decision nobody can reconstruct
 * afterwards. The vocabulary is checked here rather than by a CHECK constraint,
 * the rule `products.product_type` states: SQLite cannot ALTER one, and the
 * answer names the accepted values so a typo cannot become a state nothing
 * filters for.
 */
workOrdersRouter.post('/batches/:batchId/disposition', requirePermission('qc', 'full'), (req: AuthedRequest, res) => {
  const batchId = Number(req.params.batchId);
  const b = db.prepare('SELECT work_order_id FROM batches WHERE id = ?').get(batchId) as
    { work_order_id: number } | undefined;
  if (!b || !accessible(req, Number(b.work_order_id))) {
    return res.status(404).json({ error: 'Batch not found' });
  }
  const wanted = req.body?.disposition ?? '';
  if (!isDisposition(wanted)) {
    return res.status(400).json({ error: `Disposition must be one of: ${DISPOSITIONS.join(', ')} — or blank to withdraw one.` });
  }
  const refused = dispositionError(batchId, wanted);
  if (refused) return res.status(409).json({ error: refused });

  const date = String(req.body?.date ?? '').trim() || new Date().toISOString().slice(0, 10);
  // Withdrawing clears the whole record rather than leaving a date and an
  // author attached to a decision that no longer stands.
  db.prepare(
    `UPDATE batches SET disposition = ?, disposition_date = ?, disposition_by = ?, disposition_note = ?
      WHERE id = ?`
  ).run(
    wanted,
    wanted ? date : '',
    wanted ? req.user!.id : null,
    wanted ? String(req.body?.note ?? '') : '',
    batchId
  );
  /*
   * Condemned output stops counting as made, so the order's own status has to
   * be asked again — a line that read *made* on the strength of a lot that has
   * just been scrapped is exactly the status-contradicting-the-record failure
   * `orderStatus.ts` exists to prevent.
   */
  const wo = accessible(req, Number(b.work_order_id))!;
  // Condemned output stops counting as made, so a job held at Running or
  // Completed by a lot that has just been scrapped has to come back down too.
  syncJobStatus(Number(b.work_order_id));
  syncOrderStatus(Number(wo.order_id));
  res.json(batchById(batchId));
});

/**
 * Bring a job's stamped recipe up to the product's current one.
 *
 * The escape from what would otherwise be a trap: a job is costed against the
 * recipe it was raised on, which is the point — but a recipe raised **in
 * error** would then be stuck on every job that took it, and a job carrying
 * output cannot be deleted and re-raised. This codebase has built exactly one
 * such trap already (`work_orders.product_id`) and does not intend to build a
 * second.
 *
 * `work_order: full`, like editing the job itself: it changes what the job is
 * said to need, which is a planning figure rather than a quality one.
 * Deliberately **not** automatic on a recipe edit — that would be the drift
 * this whole thing exists to stop, arriving through the back door.
 */
workOrdersRouter.post('/:id/recipe-snapshot', requirePermission('work_order', 'full'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const wo = accessible(req, id);
  if (!wo) return res.status(404).json({ error: 'Work order not found' });
  snapshotRecipe(id, wo.product_id as number | null);
  res.json(getFull(req, id));
});

/** The tolerances in force for this job's customer, by parameter id. */
function specFor(wo: Record<string, unknown>) {
  const specCustomer = (db.prepare('SELECT customer_id FROM orders WHERE id = ?')
    .get(Number(wo.order_id)) as { customer_id: number } | undefined)?.customer_id ?? null;
  return new Map(paramsFor(wo.product_id as number | null, specCustomer).map((p) => [p.id, p]));
}

/**
 * What a check has to be before it is one, in words — the guard shape this
 * codebase uses for every rule somebody has to be told about.
 *
 * **Extracted when `certify` became its second caller** (2026-10-21). Two
 * copies of *what counts as an inspection* is how the shortcut would come to
 * accept a check the ordinary route refuses, which on a document that clears
 * goods is the worst way for two things to disagree.
 */
function checkError(wo: Record<string, unknown>, body: Record<string, unknown>): string | null {
  if (!String(body.date ?? '').trim()) return 'Date is required';
  const spec = specFor(wo);
  const rows = Array.isArray(body.results) ? (body.results as Record<string, unknown>[]) : [];
  const given = (v: unknown) => v !== '' && v !== null && v !== undefined;
  const recorded = rows.filter((r) => given(r.value) || r.na);
  const measured = recorded.filter((r) => !r.na && given(r.value));
  if (!measured.length) return 'Record at least one measurement';
  if (recorded.some((r) => !spec.has(Number(r.param_id)))) {
    return 'That check is not on the specification for this product';
  }
  for (const r of measured) {
    const param = spec.get(Number(r.param_id))!;
    if (!param.ranged || param.kind === 'boolean') continue;
    if (!given(r.value_max)) {
      return `${param.name} is observed as a range — record the highest as well as the lowest`;
    }
    if (Number(r.value_max) < Number(r.value)) {
      return `${param.name}: the highest observed is below the lowest`;
    }
  }
  return null;
}

/** Write it. Assumes `checkError` has already passed; wrap in a transaction. */
function insertCheck(req: AuthedRequest, jobId: number, wo: Record<string, unknown>, body: Record<string, unknown>, batchId: number | null): number {
  const spec = specFor(wo);
  const rows = Array.isArray(body.results) ? (body.results as Record<string, unknown>[]) : [];
  const given = (v: unknown) => v !== '' && v !== null && v !== undefined;
  const recorded = rows.filter((r) => given(r.value) || r.na);
  const info = db.prepare(
    `INSERT INTO qc_checks (work_order_id, batch_id, date, shift, sample_size, inspector, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(jobId, batchId, String(body.date), String(body.shift ?? ''), numOrNull(body.sample_size),
    String(body.inspector ?? ''), String(body.notes ?? ''), req.user!.id);
  const checkId = Number(info.lastInsertRowid);
  const ins = db.prepare(
    `INSERT INTO qc_results (check_id, param_id, name, kind, section, unit, value, value_max, ranged, na,
                             min_value, max_value, notes, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  recorded.forEach((r, i) => {
    const param = spec.get(Number(r.param_id))!;
    const na = r.na ? 1 : 0;
    const ranged = !na && param.ranged && param.kind !== 'boolean' ? 1 : 0;
    ins.run(
      checkId, param.id, param.name, param.kind, param.section ?? '', param.unit,
      na ? null : param.kind === 'boolean' ? (r.value ? 1 : 0) : Number(r.value),
      ranged ? Number(r.value_max) : null,
      ranged, na,
      param.min_value, param.max_value, String(r.notes ?? ''), i
    );
  });
  return checkId;
}

workOrdersRouter.post('/:id/qc-checks', requirePermission('qc', 'full'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const wo = accessible(req, id);
  if (!wo) return res.status(404).json({ error: 'Work order not found' });
  const body = req.body ?? {};
  const refused = checkError(wo, body);
  if (refused) return res.status(400).json({ error: refused });

  /*
   * Naming a batch is what makes this a **final** check rather than an
   * in-process one — the specification's two QC levels over one column. The
   * lot must be on *this* job: a certificate is issued against the check, and
   * one filed against somebody else's lot would clear goods nobody inspected.
   */
  const batchId = numOrNull(body.batch_id);
  if (batchId !== null) {
    const owned = db.prepare('SELECT id FROM batches WHERE id = ? AND work_order_id = ?')
      .get(batchId, id) as { id: number } | undefined;
    if (!owned) return res.status(400).json({ error: 'That batch is not on this work order' });
  }

  transaction(() => { insertCheck(req, id, wo, body, batchId); });
  res.status(201).json(getFull(req, id));
});

/**
 * Open a lot, inspect it and certify it, in one press.
 *
 * Asked for 2026-10-21 (*"Since our company is small only final COA is
 * required and is issued"*). The three steps exist for a plant that runs many
 * lots per job and certifies them separately; on a desk that runs one lot per
 * job, opening the batch by hand is pure overhead between the inspection and
 * the certificate.
 *
 * **It is the three routes, not a fourth way of doing what they do.** The
 * check goes through `checkError` and `insertCheck` — the same pair the
 * ordinary route uses, extracted for this — and the certificate through
 * `coaGroupError` and `writeCoa`. Two definitions of *what counts as an
 * inspection*, on a document that clears goods, is the worst way for two
 * things to disagree.
 *
 * **The lot covers what the job has made and nobody has lotted**, which is
 * the only answer that cannot be wrong: it is every shift booked and not yet
 * assigned, so a job already part-lotted is refused rather than quietly
 * certified twice, and a job with nothing booked has nothing to certify.
 *
 * **`qc: full`, not `output: full`.** Opening a lot is ordinarily a
 * production act and keeps that cell on its own route; the lot opened *here*
 * is not a plan but the scope of a certificate — derived entirely from output
 * already booked, by the team that certifies. Requiring both cells would
 * leave this usable by the super admin alone, since Production holds no `qc`
 * and Quality no `output`.
 *
 * **A failing inspection keeps the lot and the check and issues nothing.**
 * Rolling back would destroy the record of an inspection that really
 * happened; what it leaves is a failed lot awaiting a disposition, which is
 * exactly the state `dispositionError` exists for.
 */
workOrdersRouter.post('/:id/certify', requirePermission('qc', 'full'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const wo = accessible(req, id);
  if (!wo) return res.status(404).json({ error: 'Work order not found' });
  const body = (req.body ?? {}) as Record<string, unknown>;

  const loose = db.prepare(
    `SELECT COUNT(*) AS n, MAX(date) AS last FROM production_entries
      WHERE work_order_id = ? AND batch_id IS NULL`
  ).get(id) as { n: number; last: string | null };
  if (!Number(loose.n)) {
    return res.status(409).json({
      error: 'Nothing here to certify: every shift booked on this job is already in a lot. '
        + 'Issue the certificate from the lot itself.',
    });
  }

  const refused = checkError(wo, body);
  if (refused) return res.status(400).json({ error: refused });

  const order = db.prepare('SELECT company_id, customer_id FROM orders WHERE id = ?')
    .get(Number(wo.order_id)) as { company_id: number; customer_id: number };
  const companyId = resolveCompanyId(order.company_id, order.customer_id);
  const lotDate = String(loose.last ?? body.date);

  let batchId = 0;
  transaction(() => {
    const number = String(body.batch_number ?? '').trim() || nextNumber('batch', { companyId, date: lotDate });
    batchId = Number(db.prepare(
      'INSERT INTO batches (number, work_order_id, date, notes, created_by) VALUES (?, ?, ?, ?, ?)'
    ).run(number, id, lotDate, String(body.batch_notes ?? ''), req.user!.id).lastInsertRowid);
    // What the certificate is about: every shift not already spoken for.
    db.prepare(
      'UPDATE production_entries SET batch_id = ? WHERE work_order_id = ? AND batch_id IS NULL'
    ).run(batchId, id);
    insertCheck(req, id, wo, body, batchId);
  });

  // Asked rather than assumed, so the one definition of what may be certified
  // decides here too — notably a reading that failed.
  const cannot = coaGroupError([batchId]);
  if (cannot) {
    return res.status(409).json({
      error: cannot,
      batch: batchById(batchId),
      certified: false,
    });
  }

  const date = String(body.coa_date ?? '').trim() || String(body.date);
  writeCoa([batchId], date, req.user!.id, String(body.approved_by ?? '').trim(), companyId);
  res.status(201).json({ batch: batchById(batchId), certified: true });
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
  // A mis-keyed shift is corrected by deleting it, which is exactly why both
  // statuses must be able to follow it back down.
  const owner = db.prepare('SELECT order_id FROM work_orders WHERE id = ?')
    .get(entry.work_order_id) as { order_id: number };
  syncJobStatus(entry.work_order_id);
  syncOrderStatus(owner.order_id);
  res.json(getFull(req, entry.work_order_id));
});
