import { Router } from 'express';
import { db } from '../db/connection.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { scopeClause, canAccessCustomer } from '../middleware/scope.js';
import { listBody } from '../services/pagination.js';

export const followupsRouter = Router();

const listSql = `
  SELECT f.*, c.name AS customer_name, u.name AS created_by_name,
    CASE f.doc_type
      WHEN 'quotation' THEN (SELECT number || ' R' || revision FROM quotations WHERE id = f.doc_id)
      WHEN 'proforma' THEN (SELECT number FROM proforma_invoices WHERE id = f.doc_id)
      WHEN 'invoice' THEN (SELECT number FROM commercial_invoices WHERE id = f.doc_id)
      ELSE NULL
    END AS doc_number
  FROM followups f
  LEFT JOIN customers c ON c.id = f.customer_id
  LEFT JOIN users u ON u.id = f.created_by`;

followupsRouter.get('/', (req: AuthedRequest, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  const scope = scopeClause(req, 'f.customer_id');
  if (scope.sql) { where.push(`(${scope.sql})`); params.push(...scope.params); }
  if (req.query.pending === '1') where.push('f.done = 0');
  res.json(listBody(req.query, {
    sql: `${listSql}${where.length ? ' WHERE ' + where.join(' AND ') : ''}`,
    order: 'ORDER BY f.done, f.due_date, f.id',
    params,
  }));
});

followupsRouter.post('/', (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  if (!body.due_date) return res.status(400).json({ error: 'Due date is required' });
  // A follow-up attached to a customer is only creatable by someone who may
  // see that customer — otherwise it would surface on their dashboard.
  if (body.customer_id != null && !canAccessCustomer(req, Number(body.customer_id))) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  const info = db.prepare(
    `INSERT INTO followups (doc_type, doc_id, customer_id, due_date, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    String(body.doc_type ?? 'general'),
    body.doc_id ? Number(body.doc_id) : null,
    body.customer_id ? Number(body.customer_id) : null,
    String(body.due_date),
    String(body.note ?? ''),
    // Taken from the session, never from the body: who did this is not
    // something the caller gets to assert.
    req.user?.id ?? null
  );
  res.status(201).json(db.prepare(`${listSql} WHERE f.id = ?`).get(Number(info.lastInsertRowid)));
});

followupsRouter.put('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  const existing = db.prepare('SELECT * FROM followups WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return res.status(404).json({ error: 'Follow-up not found' });
  if (existing.customer_id != null && !canAccessCustomer(req, Number(existing.customer_id))) {
    return res.status(404).json({ error: 'Follow-up not found' });
  }
  const done = body.done != null ? (body.done ? 1 : 0) : (existing.done as number);
  /*
   * `done_at` is the day it was closed, and it moves **both ways**: re-opening
   * a follow-up clears it, so the activity report can never credit somebody
   * with a chase that was undone. It is only stamped on the transition, so
   * editing the note of an already-closed follow-up does not move it to today.
   *
   * `date('now')` is UTC, as everywhere else in this app — a follow-up closed
   * after 6:30pm IST lands on the next day's activity. Stated rather than
   * worked around: the alternative is a timezone the server does not know.
   */
  const doneAt = done === (existing.done as number)
    ? String(existing.done_at ?? '')
    : done
      ? String((db.prepare("SELECT date('now') AS d").get() as { d: string }).d)
      : '';
  db.prepare('UPDATE followups SET due_date = ?, note = ?, done = ?, done_at = ? WHERE id = ?').run(
    String(body.due_date ?? existing.due_date),
    String(body.note ?? existing.note ?? ''),
    done,
    doneAt,
    id
  );
  res.json(db.prepare(`${listSql} WHERE f.id = ?`).get(id));
});

followupsRouter.delete('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT customer_id FROM followups WHERE id = ?').get(id) as
    | { customer_id: number | null } | undefined;
  if (!existing) return res.status(404).json({ error: 'Follow-up not found' });
  if (existing.customer_id != null && !canAccessCustomer(req, Number(existing.customer_id))) {
    return res.status(404).json({ error: 'Follow-up not found' });
  }
  db.prepare('DELETE FROM followups WHERE id = ?').run(id);
  res.json({ ok: true });
});
