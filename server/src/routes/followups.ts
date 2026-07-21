import { Router } from 'express';
import { db } from '../db/connection.js';

export const followupsRouter = Router();

const listSql = `
  SELECT f.*, c.name AS customer_name,
    CASE f.doc_type
      WHEN 'quotation' THEN (SELECT number || ' R' || revision FROM quotations WHERE id = f.doc_id)
      WHEN 'proforma' THEN (SELECT number FROM proforma_invoices WHERE id = f.doc_id)
      WHEN 'invoice' THEN (SELECT number FROM commercial_invoices WHERE id = f.doc_id)
      ELSE NULL
    END AS doc_number
  FROM followups f
  LEFT JOIN customers c ON c.id = f.customer_id`;

followupsRouter.get('/', (req, res) => {
  const pending = req.query.pending === '1';
  const rows = pending
    ? db.prepare(`${listSql} WHERE f.done = 0 ORDER BY f.due_date`).all()
    : db.prepare(`${listSql} ORDER BY f.done, f.due_date`).all();
  res.json(rows);
});

followupsRouter.post('/', (req, res) => {
  const body = req.body ?? {};
  if (!body.due_date) return res.status(400).json({ error: 'Due date is required' });
  const info = db.prepare(
    'INSERT INTO followups (doc_type, doc_id, customer_id, due_date, note) VALUES (?, ?, ?, ?, ?)'
  ).run(
    String(body.doc_type ?? 'general'),
    body.doc_id ? Number(body.doc_id) : null,
    body.customer_id ? Number(body.customer_id) : null,
    String(body.due_date),
    String(body.note ?? '')
  );
  res.status(201).json(db.prepare(`${listSql} WHERE f.id = ?`).get(Number(info.lastInsertRowid)));
});

followupsRouter.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  const existing = db.prepare('SELECT * FROM followups WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return res.status(404).json({ error: 'Follow-up not found' });
  db.prepare('UPDATE followups SET due_date = ?, note = ?, done = ? WHERE id = ?').run(
    String(body.due_date ?? existing.due_date),
    String(body.note ?? existing.note ?? ''),
    body.done != null ? (body.done ? 1 : 0) : (existing.done as number),
    id
  );
  res.json(db.prepare(`${listSql} WHERE f.id = ?`).get(id));
});

followupsRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM followups WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});
