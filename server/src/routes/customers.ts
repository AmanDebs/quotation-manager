import { Router } from 'express';
import { db } from '../db/connection.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { scopeClause, canAccessCustomer } from '../middleware/scope.js';
import { listBody } from '../services/pagination.js';
import { customerSummary } from '../services/customerSummary.js';
import { searchClause } from '../services/search.js';

export const customersRouter = Router();

const fields = ['name', 'contact_person', 'email', 'phone', 'address', 'city', 'country', 'gstin', 'currency', 'consignee', 'notify_party', 'notify_party_2', 'notes'];

const listSql = `
  SELECT c.*, u.name AS owner_name
  FROM customers c LEFT JOIN users u ON u.id = c.owner_id`;

customersRouter.get('/', (req: AuthedRequest, res) => {
  const q = String(req.query.q ?? '').trim();
  const exportFilter = req.query.export;
  const where: string[] = [];
  const params: unknown[] = [];

  const scope = scopeClause(req, 'c.id');
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  // The same helper the document lists use. The hand-written clause was
  // already bracketed — which matters, since `scopeClause` shares this WHERE
  // and an unbracketed OR would have been a way straight past data scoping —
  // so what changes is that `%` and `_` are now escaped rather than treated as
  // LIKE's wildcards.
  const search = searchClause(['c.name', 'c.contact_person', 'c.country'], q);
  if (search.sql) { where.push(search.sql); params.push(...search.params); }
  if (exportFilter === '1' || exportFilter === '0') {
    where.push('c.is_export = ?');
    params.push(Number(exportFilter));
  }
  res.json(listBody(req.query, {
    sql: `${listSql}${where.length ? ' WHERE ' + where.join(' AND ') : ''}`,
    order: 'ORDER BY c.name, c.id',
    params,
  }));
});

customersRouter.get('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!canAccessCustomer(req, id)) return res.status(404).json({ error: 'Customer not found' });
  const row = db.prepare(`${listSql} WHERE c.id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'Customer not found' });
  res.json(row);
});

/*
 * Everything about one customer on one screen.
 *
 * The sections it answers with are chosen by the caller's own permissions, in
 * `services/customerSummary.ts` — a Production login holds `customer: view`
 * and `quotation: none`, and must not read a price through a route mounted on
 * the customer function. Scoping is the same 404 every other detail route
 * gives, so an id cannot be probed for.
 */
customersRouter.get('/:id/summary', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!canAccessCustomer(req, id)) return res.status(404).json({ error: 'Customer not found' });
  const exists = db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'Customer not found' });
  res.json(customerSummary(req, id));
});

/** Blank means "the group default" — stored as NULL, resolved when a document is raised. */
const companyId = (v: unknown): number | null => (Number(v) > 0 ? Number(v) : null);

customersRouter.post('/', (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  if (!body.name) return res.status(400).json({ error: 'Customer name is required' });
  // Managers may assign an owner; employees always own what they create.
  const ownerId = req.user!.role === 'manager' && body.owner_id ? Number(body.owner_id) : req.user!.id;
  const companyId = ((v: unknown) => (Number(v) > 0 ? Number(v) : null))(body.company_id);
  const isExport = body.is_export !== undefined
    ? (body.is_export ? 1 : 0)
    : (String(body.country ?? '').trim().toLowerCase() !== 'india' && body.country ? 1 : 0);
  const info = db
    .prepare(`INSERT INTO customers (${fields.join(', ')}, owner_id, is_export, company_id) VALUES (${fields.map(() => '?').join(', ')}, ?, ?, ?)`)
    .run(
      ...(fields.map((f) => String(body[f] ?? (f === 'country' ? 'India' : f === 'currency' ? 'INR' : ''))) as never[]),
      ownerId,
      isExport,
      companyId
    );
  res.status(201).json(db.prepare(`${listSql} WHERE c.id = ?`).get(Number(info.lastInsertRowid)));
});

customersRouter.put('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  if (!canAccessCustomer(req, id)) return res.status(404).json({ error: 'Customer not found' });
  const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return res.status(404).json({ error: 'Customer not found' });
  if (!body.name) return res.status(400).json({ error: 'Customer name is required' });
  const ownerId = req.user!.role === 'manager' && body.owner_id ? Number(body.owner_id) : (existing.owner_id as number | null);
  db.prepare(
    `UPDATE customers SET ${fields.map((f) => `${f} = ?`).join(', ')}, owner_id = ?, is_export = ?, company_id = ? WHERE id = ?`
  ).run(
    ...(fields.map((f) => String(body[f] ?? '')) as never[]),
    ownerId,
    body.is_export !== undefined ? (body.is_export ? 1 : 0) : Number(existing.is_export ?? 0),
    'company_id' in body ? companyId(body.company_id) : (existing.company_id as number | null),
    id
  );
  res.json(db.prepare(`${listSql} WHERE c.id = ?`).get(id));
});

customersRouter.delete('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!canAccessCustomer(req, id)) return res.status(404).json({ error: 'Customer not found' });
  // Anything referencing the customer blocks the delete — including follow-ups,
  // payments and orders, which are foreign keys too and would otherwise fail
  // inside SQLite and reach the user as "Internal server error".
  const used = db.prepare(
    `SELECT (SELECT COUNT(*) FROM quotations WHERE customer_id = ?) +
            (SELECT COUNT(*) FROM orders WHERE customer_id = ?) +
            (SELECT COUNT(*) FROM proforma_invoices WHERE customer_id = ?) +
            (SELECT COUNT(*) FROM commercial_invoices WHERE customer_id = ?) +
            (SELECT COUNT(*) FROM packing_lists WHERE customer_id = ?) AS c`
  ).get(id, id, id, id, id) as { c: number };
  if (used.c > 0) return res.status(409).json({ error: 'Customer has documents and cannot be deleted' });
  const linked = db.prepare(
    `SELECT (SELECT COUNT(*) FROM followups WHERE customer_id = ?) +
            (SELECT COUNT(*) FROM payments WHERE customer_id = ?) +
            (SELECT COUNT(*) FROM enquiries WHERE customer_id = ?) AS c`
  ).get(id, id, id) as { c: number };
  if (linked.c > 0) return res.status(409).json({ error: 'Customer has follow-ups or payments recorded and cannot be deleted' });
  db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  res.json({ ok: true });
});
