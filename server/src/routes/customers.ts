import { Router } from 'express';
import { db } from '../db/connection.js';

export const customersRouter = Router();

const fields = ['name', 'contact_person', 'email', 'phone', 'address', 'city', 'country', 'gstin', 'currency', 'consignee', 'notify_party', 'notify_party_2', 'notes'];

customersRouter.get('/', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const rows = q
    ? db.prepare(`SELECT * FROM customers WHERE name LIKE ? OR contact_person LIKE ? OR country LIKE ? ORDER BY name`).all(`%${q}%`, `%${q}%`, `%${q}%`)
    : db.prepare('SELECT * FROM customers ORDER BY name').all();
  res.json(rows);
});

customersRouter.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Customer not found' });
  res.json(row);
});

customersRouter.post('/', (req, res) => {
  const body = req.body ?? {};
  if (!body.name) return res.status(400).json({ error: 'Customer name is required' });
  const info = db
    .prepare(`INSERT INTO customers (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`)
    .run(...(fields.map((f) => String(body[f] ?? (f === 'country' ? 'India' : f === 'currency' ? 'INR' : ''))) as never[]));
  res.status(201).json(db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(info.lastInsertRowid)));
});

customersRouter.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(id)) return res.status(404).json({ error: 'Customer not found' });
  if (!body.name) return res.status(400).json({ error: 'Customer name is required' });
  db.prepare(`UPDATE customers SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`).run(
    ...(fields.map((f) => String(body[f] ?? '')) as never[]),
    id
  );
  res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(id));
});

customersRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const used = db.prepare(
    `SELECT (SELECT COUNT(*) FROM quotations WHERE customer_id = ?) +
            (SELECT COUNT(*) FROM proforma_invoices WHERE customer_id = ?) +
            (SELECT COUNT(*) FROM commercial_invoices WHERE customer_id = ?) +
            (SELECT COUNT(*) FROM enquiries WHERE customer_id = ?) AS c`
  ).get(id, id, id, id) as { c: number };
  if (used.c > 0) return res.status(409).json({ error: 'Customer has documents and cannot be deleted' });
  db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  res.json({ ok: true });
});
