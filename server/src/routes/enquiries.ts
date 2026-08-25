import { Router } from 'express';
import { db } from '../db/connection.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { scopeClause, canAccessCustomer } from '../middleware/scope.js';
import { listBody } from '../services/pagination.js';

/**
 * Enquiries — a customer asking before there is anything to quote.
 *
 * Mounted at `/api/enquiries`. It sat written-but-unregistered for a long
 * while; the table was always real (the seed writes it, `quotations.enquiry_id`
 * points at it, follow-ups have an `enquiry` doc type, and deleting a customer
 * counts them) and only the HTTP surface was missing.
 *
 * Every route here was written before data scoping existed and had none of it.
 * It was scoped ahead of being mounted, precisely so wiring it up could not
 * ship a hole that looked finished in a file with nothing to suggest anything
 * was missing. The rules are the ones every other document route follows,
 * including answering **404** rather than 403 for an id out of scope, so an
 * employee cannot probe for another owner's records.
 *
 * `quotation_count` is derived, never stored: how many live quotations answer
 * this enquiry is a question about the quotations, and superseded revisions are
 * excluded so a renegotiated quote does not read as two answers.
 *
 * The contact block the list shows — city, country, contact person, phone,
 * email and the team member responsible — is **joined from the customer, not
 * copied onto the enquiry**. Somebody chasing an open enquiry needs the number
 * to ring without opening another page, but a phone number copied at the
 * moment the enquiry was logged is a phone number that goes stale, and an
 * enquiry is not the place a contact detail is corrected. The team member is
 * `customers.owner_id`, which is already how the app models who is
 * responsible for a customer, so the column agrees with what scoping enforces
 * rather than being a second opinion about it.
 */
export const enquiriesRouter = Router();

const withCustomer = `
  SELECT e.*, c.name AS customer_name, c.city AS customer_city, c.country AS customer_country,
         c.contact_person AS customer_contact, c.phone AS customer_phone,
         c.email AS customer_email, u.name AS owner_name,
         (SELECT COUNT(*) FROM quotations q
           WHERE q.enquiry_id = e.id AND q.superseded_by IS NULL) AS quotation_count
  FROM enquiries e
  JOIN customers c ON c.id = e.customer_id
  LEFT JOIN users u ON u.id = c.owner_id`;

enquiriesRouter.get('/', (req: AuthedRequest, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  const scope = scopeClause(req, 'e.customer_id');
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  if (req.query.status) { where.push('e.status = ?'); params.push(String(req.query.status)); }
  res.json(listBody(req.query, {
    sql: `${withCustomer}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
    order: 'ORDER BY e.date DESC, e.id DESC',
    params,
  }));
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
