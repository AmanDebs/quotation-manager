import { Router } from 'express';
import { db } from '../db/connection.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { requireManager } from '../middleware/auth.js';
import { canAccessCustomer } from '../middleware/scope.js';
import { listBody } from '../services/pagination.js';

/**
 * Reading the audit trail.
 *
 * Two doors, deliberately different.
 *
 * `GET /api/audit` is the whole log and is **manager-only** — how much the
 * group trades, who works here and what they have been doing is not an
 * employee's business, the same call `/api/settings/sequences` makes about
 * how many invoices have been raised.
 *
 * `GET /api/audit/:entity/:id` is one record's own history, and follows the
 * record: whoever may open the quotation may read what happened to it. That
 * needs a way to ask "whose customer is this row", which is what `OWNER_SQL`
 * is; an entity absent from it has no customer and is manager-only, which is
 * the safe direction to fail in.
 *
 * There is no write route, and no delete route. The log is append-only, and a
 * log with an eraser is not one.
 */
export const auditRouter = Router();

/**
 * How to find the customer a logged row belonged to, per entity.
 *
 * Deliberately verbose rather than derived: getting one of these wrong shows
 * one owner another owner's history, so each is written out where it can be
 * read and checked. `null` means the entity has no customer at all.
 */
const OWNER_SQL: Record<string, string | null> = {
  customers: 'SELECT id AS customer_id FROM customers WHERE id = ?',
  enquiries: 'SELECT customer_id FROM enquiries WHERE id = ?',
  quotations: 'SELECT customer_id FROM quotations WHERE id = ?',
  orders: 'SELECT customer_id FROM orders WHERE id = ?',
  proformas: 'SELECT customer_id FROM proforma_invoices WHERE id = ?',
  invoices: 'SELECT customer_id FROM commercial_invoices WHERE id = ?',
  'packing-lists': 'SELECT customer_id FROM packing_lists WHERE id = ?',
  followups: 'SELECT customer_id FROM followups WHERE id = ?',
  payments: 'SELECT customer_id FROM payments WHERE id = ?',
  'work-orders': 'SELECT o.customer_id FROM work_orders w JOIN orders o ON o.id = w.order_id WHERE w.id = ?',
  despatches: 'SELECT o.customer_id FROM despatches d JOIN orders o ON o.id = d.order_id WHERE d.id = ?',
  // No customer of their own, so manager-only. Products and the masters are
  // group-wide; purchasing, users and companies are manager-only elsewhere
  // too. Anything missing from this map is refused outright — an entity nobody
  // has thought about must not become readable by being named in a URL.
  products: null,
  'purchase-orders': null,
  users: null,
  companies: null,
  auth: null,
  locations: null,
  suppliers: null,
  transporters: null,
  materials: null,
  machines: null,
  moulds: null,
};

const listSql = `
  SELECT a.*, u.name AS current_user_name
  FROM audit_log a
  -- LEFT, and the name is stored on the row as well: the entry has to survive
  -- the account it describes being deleted, which is when it matters most.
  LEFT JOIN users u ON u.id = a.user_id`;

const parse = (rows: unknown[]) =>
  (rows as Record<string, unknown>[]).map((r) => ({
    ...r,
    changes: JSON.parse(String(r.changes || '[]')),
  }));

auditRouter.get('/', requireManager, (req: AuthedRequest, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (req.query.entity) { where.push('a.entity = ?'); params.push(String(req.query.entity)); }
  if (Number(req.query.user) > 0) { where.push('a.user_id = ?'); params.push(Number(req.query.user)); }
  if (req.query.action) { where.push('a.action = ?'); params.push(String(req.query.action)); }
  /**
   * Entries are stamped by `datetime('now')`, which is **UTC**. A caller who
   * knows that sends its bounds already converted, as full timestamps; a
   * caller who sends a bare date gets it read as UTC midnight.
   *
   * The distinction matters more than it looks. The desk this runs on is five
   * and a half hours ahead, so "today" in Kolkata begins at 18:30 the previous
   * day in the stored values: a bare-date filter would drop everything done
   * before half past five in the morning and pull in yesterday evening
   * instead. The Activity page therefore does the conversion, and this accepts
   * either — a bare date is still better than a 400, and is right on a server
   * and a desk that agree.
   */
  const bound = (v: unknown, endOfDay: boolean) => {
    const s = String(v).trim();
    return s.includes(' ') || s.includes('T')
      ? s.replace('T', ' ').slice(0, 19)
      : `${s} ${endOfDay ? '23:59:59' : '00:00:00'}`;
  };
  if (req.query.from) { where.push('a.at >= ?'); params.push(bound(req.query.from, false)); }
  if (req.query.to) { where.push('a.at <= ?'); params.push(bound(req.query.to, true)); }
  if (req.query.q) {
    where.push('(a.label LIKE ? OR a.user_name LIKE ? OR a.entity LIKE ?)');
    const like = `%${String(req.query.q)}%`;
    params.push(like, like, like);
  }
  res.json(listBody(req.query, {
    sql: `${listSql}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
    // Newest first, and by id rather than by timestamp: two entries in the same
    // second are ordered by which happened first, which the id knows and the
    // timestamp does not.
    order: 'ORDER BY a.id DESC',
    params,
  }, parse));
});

/** The distinct values actually present, so the filters offer only real ones. */
auditRouter.get('/facets', requireManager, (_req, res) => {
  res.json({
    entities: (db.prepare('SELECT DISTINCT entity FROM audit_log ORDER BY entity').all() as { entity: string }[])
      .map((r) => r.entity),
    actions: (db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all() as { action: string }[])
      .map((r) => r.action),
    users: db.prepare(
      `SELECT user_id AS id, MAX(user_name) AS name FROM audit_log
        WHERE user_id IS NOT NULL GROUP BY user_id ORDER BY name`
    ).all(),
  });
});

auditRouter.get('/:entity/:id', (req: AuthedRequest, res) => {
  const entity = String(req.params.entity);
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(404).json({ error: 'Not found' });

  // An entity nobody has described is not readable by guesswork.
  if (!(entity in OWNER_SQL)) return res.status(404).json({ error: 'Not found' });
  const ownerSql = OWNER_SQL[entity];

  if (ownerSql === null) {
    if (req.user?.role !== 'manager') return res.status(404).json({ error: 'Not found' });
  } else {
    const row = db.prepare(ownerSql).get(id) as { customer_id: number | null } | undefined;
    // The row may be gone — the history of a deleted document is exactly what
    // somebody would come looking for — so a manager may still read it, while
    // an employee cannot, since there is no longer an owner to check against.
    if (!row) {
      if (req.user?.role !== 'manager') return res.status(404).json({ error: 'Not found' });
    } else if (row.customer_id !== null && !canAccessCustomer(req, row.customer_id)) {
      return res.status(404).json({ error: 'Not found' });
    }
  }

  res.json(listBody(req.query, {
    sql: `${listSql} WHERE a.entity = ? AND a.entity_id = ?`,
    order: 'ORDER BY a.id DESC',
    params: [entity, id],
  }, parse));
});
