import { Router } from 'express';
import { db } from '../db/connection.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { scopeClause, canAccessCustomer } from '../middleware/scope.js';

/**
 * Enquiries — a customer asking before there is anything to quote.
 *
 * **Not mounted.** `index.ts` does not register this router and there is no
 * client page, so nothing reaches it today. The table is real: the seed writes
 * to it, `quotations.enquiry_id` points at it, follow-ups have an `enquiry`
 * doc type, and deleting a customer counts them.
 *
 * It is scoped anyway. Every route here was written before data scoping
 * existed and had none of it — no `scopeClause`, no `canAccessCustomer` — so
 * whoever mounts it would have shipped a hole that looked finished, in a file
 * with nothing to suggest anything was missing. Scoping it now costs a few
 * lines and removes that trap; the rules are the same ones every other
 * document route follows, including answering **404** rather than 403 for an
 * id out of scope, so an employee cannot probe for another owner's records.
 */
export const enquiriesRouter = Router();

const withCustomer = `
  SELECT e.*, c.name AS customer_name, c.country AS customer_country
  FROM enquiries e JOIN customers c ON c.id = e.customer_id`;

enquiriesRouter.get('/', (req: AuthedRequest, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  const scope = scopeClause(req, 'e.customer_id');
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  if (req.query.status) { where.push('e.status = ?'); params.push(String(req.query.status)); }
  res.json(db.prepare(
    `${withCustomer}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY e.date DESC, e.id DESC`
  ).all(...(params as never[])));
});

enquiriesRouter.get('/:id', (req: AuthedRequest, res) => {
  const row = db.prepare(`${withCustomer} WHERE e.id = ?`).get(Number(req.params.id)) as
    { customer_id: number } | undefined;
  if (!row || !canAccessCustomer(req, row.customer_id)) return res.status(404).json({ error: 'Enquiry not found' });
  res.json(row);
});

enquiriesRouter.post('/', (req: AuthedRequest, res) => {
  const { customer_id, date, notes } = req.body ?? {};
  if (!customer_id) return res.status(400).json({ error: 'Customer is required' });
  if (!canAccessCustomer(req, Number(customer_id))) {
    return res.status(403).json({ error: 'That customer is not assigned to you' });
  }
  const info = db
    .prepare('INSERT INTO enquiries (customer_id, date, notes) VALUES (?, ?, ?)')
    .run(Number(customer_id), String(date ?? new Date().toISOString().slice(0, 10)), String(notes ?? ''));
  res.status(201).json(db.prepare(`${withCustomer} WHERE e.id = ?`).get(Number(info.lastInsertRowid)));
});

enquiriesRouter.put('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const { customer_id, date, notes, status } = req.body ?? {};
  const existing = db.prepare('SELECT customer_id FROM enquiries WHERE id = ?').get(id) as
    { customer_id: number } | undefined;
  if (!existing || !canAccessCustomer(req, existing.customer_id)) {
    return res.status(404).json({ error: 'Enquiry not found' });
  }
  // Moving it to a customer the caller does not own would push it out of their
  // own scope — the same one-way door the document routes guard against.
  const nextCustomer = customer_id === undefined ? existing.customer_id : Number(customer_id);
  if (nextCustomer !== existing.customer_id && !canAccessCustomer(req, nextCustomer)) {
    return res.status(403).json({ error: 'That customer is not assigned to you' });
  }
  db.prepare('UPDATE enquiries SET customer_id = ?, date = ?, notes = ?, status = ? WHERE id = ?').run(
    nextCustomer, String(date ?? ''), String(notes ?? ''), String(status ?? 'open'), id
  );
  res.json(db.prepare(`${withCustomer} WHERE e.id = ?`).get(id));
});

enquiriesRouter.delete('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT customer_id FROM enquiries WHERE id = ?').get(id) as
    { customer_id: number } | undefined;
  if (!existing || !canAccessCustomer(req, existing.customer_id)) {
    return res.status(404).json({ error: 'Enquiry not found' });
  }
  const used = db.prepare('SELECT COUNT(*) AS c FROM quotations WHERE enquiry_id = ?').get(id) as { c: number };
  if (used.c > 0) return res.status(409).json({ error: 'Enquiry has quotations and cannot be deleted' });
  db.prepare('DELETE FROM enquiries WHERE id = ?').run(id);
  res.json({ ok: true });
});
