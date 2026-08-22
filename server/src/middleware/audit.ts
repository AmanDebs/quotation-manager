import type { Response, NextFunction } from 'express';
import { db } from '../db/connection.js';
import type { AuthedRequest } from './auth.js';
import { record, diffRows, labelOf, type Change } from '../services/audit.js';
import { defaultCompanyId } from '../services/companies.js';

/**
 * The audit trail, captured once for the whole API rather than route by route.
 *
 * Thirty-odd routes mutate something here, and a trail assembled by adding a
 * call to each of them is a trail with holes — worse than none, because the
 * gaps look exactly like "nothing happened". So this sits above the routers
 * and works from the shape every route already has: an entity in the path, an
 * id where there is one, and a row in a table underneath.
 *
 * It reads the row **before** the handler runs and again **after** the
 * response, and records the difference. A route added tomorrow is covered the
 * day it is added, without anybody remembering.
 *
 * **It never touches `req.body`.** That is what makes it structurally
 * impossible for a password to reach the log: the only things this reads are
 * database rows and the `id` of a response. Sign-in events, which have no row
 * to diff, are recorded by `routes/auth.ts` naming the one field it wants.
 *
 * What it cannot see: whether the change was saved for a good reason. That is
 * what `note` on a document is for.
 */

/** URL segment → the table its `:id` refers to. */
const TABLES: Record<string, string> = {
  customers: 'customers',
  products: 'products',
  enquiries: 'enquiries',
  quotations: 'quotations',
  orders: 'orders',
  proformas: 'proforma_invoices',
  invoices: 'commercial_invoices',
  'packing-lists': 'packing_lists',
  followups: 'followups',
  payments: 'payments',
  'work-orders': 'work_orders',
  despatches: 'despatches',
  'purchase-orders': 'purchase_orders',
  companies: 'companies',
  users: 'users',
  // The six masters, mounted at their own paths by routes/masters.ts.
  locations: 'locations',
  suppliers: 'suppliers',
  transporters: 'transporters',
  materials: 'materials',
  machines: 'machines',
  moulds: 'moulds',
};

/**
 * Line items live in a child table, so a header diff alone would call an edit
 * that only touched the lines "no change". The snapshot carries a rendering of
 * the child rows as one synthetic `items` field: it is compared like any other
 * value and, being in the service's bulky list, is reported as changed without
 * its content. "The lines changed" is the honest amount to say here — the
 * lines themselves are on the document.
 */
const ITEM_TABLES: Record<string, { table: string; fk: string }> = {
  quotations: { table: 'quotation_items', fk: 'quotation_id' },
  orders: { table: 'order_items', fk: 'order_id' },
  proformas: { table: 'pi_items', fk: 'pi_id' },
  invoices: { table: 'invoice_items', fk: 'invoice_id' },
  'packing-lists': { table: 'packing_list_items', fk: 'packing_list_id' },
  'purchase-orders': { table: 'po_items', fk: 'po_id' },
  despatches: { table: 'despatch_items', fk: 'despatch_id' },
};

/**
 * The few routes shaped `/<entity>/<sub-resource>/<id>`, where the id belongs
 * to a child row and the entry should still hang off its parent.
 *
 * Written out one by one rather than inferred. Getting this wrong does not
 * fail loudly — it files a real event under the wrong record, and the reader
 * has no way to tell.
 */
const SUB_PARENT: Record<string, { sql: string; entity: string }> = {
  'work-orders/qc-checks': {
    sql: 'SELECT work_order_id AS parent FROM qc_checks WHERE id = ?',
    entity: 'work-orders',
  },
  'work-orders/entries': {
    sql: 'SELECT work_order_id AS parent FROM production_entries WHERE id = ?',
    entity: 'work-orders',
  },
};

/**
 * `/api/settings` has no id in its URL and — the part that matters — does not
 * edit a table called `settings` at all. It is the view of the **default
 * company**, kept under the old name so the parts of the app that only ever
 * mean "us" did not all have to change when the group gained a second entity.
 *
 * Pointed at a `settings` table with a hardcoded id 1, this recorded nothing,
 * because it was diffing a row nobody had touched. Rewriting the entity here
 * means a theme change shows up as what it is — an edit to that company — and
 * lands in the same history the Companies page shows.
 */
const REWRITE: Record<string, () => { entity: string; id: number }> = {
  settings: () => ({ entity: 'companies', id: defaultCompanyId() }),
};

/**
 * Its own records, and sign-in, are not captured here — the first would be a
 * loop and the second is the one place a request body must never be read.
 */
const SKIP = new Set(['audit', 'auth']);

/**
 * Routes that write their own entry, and must not also get one from here.
 *
 * There is exactly one so far: moving a numbering counter. `sequences` is
 * keyed on (company, series) rather than an id, so this middleware has no row
 * to diff and would file a bare "someone did something to the company" beside
 * the route's own entry saying which counter moved and to what. Two entries
 * for one act, one of them useless.
 */
const SELF_RECORDED = new Set(['settings/sequences']);

interface Parsed {
  entity: string;
  /** Only set where the id sits in the usual place, `/api/<entity>/<id>`. */
  id: number | null;
  action: string;
}

/**
 * Read the path the way the routers do.
 *
 * The id is taken **only** from the segment straight after the entity. A route
 * like `/api/work-orders/qc-checks/5` numbers a QC check, not a work order,
 * and diffing work order 5 against itself would invent changes that never
 * happened. Where the shape is unfamiliar the event is still recorded — with
 * no diff, which is the truthful amount to claim.
 */
export function parsePath(method: string, url: string): Parsed | null {
  const segs = url.split('?')[0].split('/').filter(Boolean);
  if (segs[0] !== 'api' || segs.length < 2) return null;
  const [entity, ...rest] = segs.slice(1);
  if (SELF_RECORDED.has(`${entity}/${rest[0] ?? ''}`)) return null;
  const id = rest[0] && /^\d+$/.test(rest[0]) ? Number(rest[0]) : null;
  const verb = id === null ? rest[0] : rest[1];

  let action: string;
  if (verb) action = method === 'DELETE' ? `${verb} delete` : verb;
  else if (method === 'POST') action = 'create';
  else if (method === 'DELETE') action = 'delete';
  else action = 'update';

  const rewrite = id === null ? REWRITE[entity]?.() : undefined;
  if (rewrite) return { entity: rewrite.entity, id: rewrite.id, action };

  // A child row's id, resolved to the parent it belongs to. Read here, before
  // the handler deletes it — afterwards there is nothing left to ask.
  if (id === null && verb && rest[1] && /^\d+$/.test(rest[1])) {
    const sub = SUB_PARENT[`${entity}/${verb}`];
    if (sub) {
      const row = db.prepare(sub.sql).get(Number(rest[1])) as { parent: number } | undefined;
      if (row) return { entity: sub.entity, id: row.parent, action };
    }
  }
  return { entity, id, action };
}

/** The row as it stands, plus its lines rendered into one comparable field. */
function snapshot(entity: string, id: number): Record<string, unknown> | undefined {
  const table = TABLES[entity];
  if (!table) return undefined;
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as
    Record<string, unknown> | undefined;
  if (!row) return undefined;
  const child = ITEM_TABLES[entity];
  if (child) {
    const lines = db.prepare(
      `SELECT * FROM ${child.table} WHERE ${child.fk} = ? ORDER BY sort_order, id`
    ).all(id) as Record<string, unknown>[];
    // Without the id and the foreign key. Every save here deletes the lines and
    // reinserts them, so their ids are new each time even when nothing about
    // them is — comparing those made re-saving an untouched document report
    // that its lines had changed, which is a lie told in the one place people
    // would go to find out whether they had.
    row.items = lines
      .map((l) => JSON.stringify(l, (k, v) => (k === 'id' || k === child.fk ? undefined : v)))
      .join('|');
  }
  return row;
}

interface Pending {
  entity: string;
  id: number | null;
  action: string;
  before?: Record<string, unknown>;
}

export function auditMiddleware(req: AuthedRequest, res: Response, next: NextFunction) {
  // A read changes nothing, and logging every list view would bury the entries
  // that matter under the ones that do not.
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

  const parsed = parsePath(req.method, req.originalUrl);
  if (!parsed || SKIP.has(parsed.entity)) return next();

  const pending: Pending = { entity: parsed.entity, id: parsed.id, action: parsed.action };
  if (parsed.id !== null) pending.before = snapshot(parsed.entity, parsed.id);

  // A create announces its id in the response and nowhere else, so the
  // response is read — but **only for a create**. Reading it for anything else
  // was a live bug for the length of one test run: deleting QC check 1 through
  // `/work-orders/qc-checks/1` returned a body carrying `id: 1`, which was
  // taken for a newly created work order 1 and logged the whole job as though
  // it had just appeared. An audit trail that invents an event is worse than
  // one that misses it.
  let createdId: number | null = null;
  if (pending.action === 'create') {
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      const id = (body as { id?: unknown } | null)?.id;
      if (typeof id === 'number') createdId = id;
      return json(body);
    };
  }

  res.on('finish', () => {
    // Only a change that took. A 404 or a refused status transition is an
    // answer, not an event.
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    const id = pending.id ?? createdId;
    const after = pending.action === 'delete' || id === null
      ? undefined
      : snapshot(pending.entity, id);
    const changes: Change[] = TABLES[pending.entity] && (pending.before || after)
      ? diffRows(pending.before, after)
      : [];

    // A save that moved nothing is not an event — except where the action
    // names something in its own right (an approval, a status, an import),
    // which is worth recording even when the row happens to read the same.
    const namedAction = !['create', 'update', 'delete'].includes(pending.action);
    if (!changes.length && !namedAction && pending.action !== 'delete') return;

    record({
      user: req.user,
      entity: pending.entity,
      entity_id: id,
      action: pending.action,
      label: labelOf(after ?? pending.before),
      changes,
    });
  });

  next();
}
