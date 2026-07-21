import { Router } from 'express';
import { db } from '../db/connection.js';

export const productsRouter = Router();

const fields = ['name', 'description', 'hsn_code', 'unit', 'unit_price', 'country_of_origin'];

productsRouter.get('/', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const rows = q
    ? db.prepare('SELECT * FROM products WHERE name LIKE ? OR hsn_code LIKE ? ORDER BY name').all(`%${q}%`, `%${q}%`)
    : db.prepare('SELECT * FROM products ORDER BY name').all();
  res.json(rows);
});

productsRouter.post('/', (req, res) => {
  const body = req.body ?? {};
  if (!body.name) return res.status(400).json({ error: 'Product name is required' });
  const info = db
    .prepare(`INSERT INTO products (name, description, hsn_code, unit, unit_price, country_of_origin) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      String(body.name),
      String(body.description ?? ''),
      String(body.hsn_code ?? ''),
      String(body.unit ?? 'unit'),
      Number(body.unit_price ?? 0),
      String(body.country_of_origin ?? 'India')
    );
  res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(Number(info.lastInsertRowid)));
});

productsRouter.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  if (!db.prepare('SELECT id FROM products WHERE id = ?').get(id)) return res.status(404).json({ error: 'Product not found' });
  if (!body.name) return res.status(400).json({ error: 'Product name is required' });
  db.prepare('UPDATE products SET name = ?, description = ?, hsn_code = ?, unit = ?, unit_price = ?, country_of_origin = ? WHERE id = ?').run(
    String(body.name),
    String(body.description ?? ''),
    String(body.hsn_code ?? ''),
    String(body.unit ?? 'unit'),
    Number(body.unit_price ?? 0),
    String(body.country_of_origin ?? 'India'),
    id
  );
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
});

productsRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});
