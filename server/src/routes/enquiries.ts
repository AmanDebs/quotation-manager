import { Router } from 'express';
import { db } from '../db/connection.js';

export const enquiriesRouter = Router();

const withCustomer = `
  SELECT e.*, c.name AS customer_name, c.country AS customer_country
  FROM enquiries e JOIN customers c ON c.id = e.customer_id`;

enquiriesRouter.get('/', (req, res) => {
  const status = String(req.query.status ?? '');
  const rows = status
    ? db.prepare(`${withCustomer} WHERE e.status = ? ORDER BY e.date DESC, e.id DESC`).all(status)
    : db.prepare(`${withCustomer} ORDER BY e.date DESC, e.id DESC`).all();
  res.json(rows);
});

enquiriesRouter.get('/:id', (req, res) => {
  const row = db.prepare(`${withCustomer} WHERE e.id = ?`).get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Enquiry not found' });
  res.json(row);
});

enquiriesRouter.post('/', (req, res) => {
  const { customer_id, date, notes } = req.body ?? {};
  if (!customer_id) return res.status(400).json({ error: 'Customer is required' });
  const info = db
    .prepare('INSERT INTO enquiries (customer_id, date, notes) VALUES (?, ?, ?)')
    .run(Number(customer_id), String(date ?? new Date().toISOString().slice(0, 10)), String(notes ?? ''));
  res.status(201).json(db.prepare(`${withCustomer} WHERE e.id = ?`).get(Number(info.lastInsertRowid)));
});

enquiriesRouter.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const { customer_id, date, notes, status } = req.body ?? {};
  if (!db.prepare('SELECT id FROM enquiries WHERE id = ?').get(id)) return res.status(404).json({ error: 'Enquiry not found' });
  db.prepare('UPDATE enquiries SET customer_id = ?, date = ?, notes = ?, status = ? WHERE id = ?').run(
    Number(customer_id), String(date ?? ''), String(notes ?? ''), String(status ?? 'open'), id
  );
  res.json(db.prepare(`${withCustomer} WHERE e.id = ?`).get(id));
});

enquiriesRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const used = db.prepare('SELECT COUNT(*) AS c FROM quotations WHERE enquiry_id = ?').get(id) as { c: number };
  if (used.c > 0) return res.status(409).json({ error: 'Enquiry has quotations and cannot be deleted' });
  db.prepare('DELETE FROM enquiries WHERE id = ?').run(id);
  res.json({ ok: true });
});
