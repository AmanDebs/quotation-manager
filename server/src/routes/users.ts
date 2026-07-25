import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/connection.js';
import type { AuthedRequest } from '../middleware/auth.js';

export const usersRouter = Router();

const publicFields = 'id, name, email, role, active, created_at';

usersRouter.get('/', (_req, res) => {
  const users = db.prepare(`SELECT ${publicFields} FROM users ORDER BY role DESC, name`).all() as Record<string, unknown>[];
  // Show each employee how much they are responsible for.
  const counts = db.prepare('SELECT owner_id, COUNT(*) AS c FROM customers GROUP BY owner_id').all() as { owner_id: number; c: number }[];
  const byOwner = new Map(counts.map((r) => [r.owner_id, r.c]));
  res.json(users.map((u) => ({ ...u, customer_count: byOwner.get(Number(u.id)) ?? 0 })));
});

usersRouter.post('/', (req, res) => {
  const { name, email, password, role } = req.body ?? {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).toLowerCase());
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(String(name), String(email).toLowerCase(), bcrypt.hashSync(String(password), 10), role === 'manager' ? 'manager' : 'employee');
  res.status(201).json(db.prepare(`SELECT ${publicFields} FROM users WHERE id = ?`).get(Number(info.lastInsertRowid)));
});

usersRouter.put('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!user) return res.status(404).json({ error: 'User not found' });

  // The last active manager must stay a manager, or nobody can administer the app.
  if ((body.role === 'employee' || body.active === false) && user.role === 'manager') {
    const others = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'manager' AND active = 1 AND id <> ?").get(id) as { c: number };
    if (others.c === 0) return res.status(409).json({ error: 'There must always be at least one active manager' });
  }

  db.prepare('UPDATE users SET name = ?, email = ?, role = ?, active = ? WHERE id = ?').run(
    String(body.name ?? user.name),
    String(body.email ?? user.email).toLowerCase(),
    body.role === 'manager' || body.role === 'employee' ? body.role : String(user.role),
    body.active === undefined ? Number(user.active) : body.active ? 1 : 0,
    id
  );
  if (body.password) {
    if (String(body.password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(body.password), 10), id);
  }
  res.json(db.prepare(`SELECT ${publicFields} FROM users WHERE id = ?`).get(id));
});

usersRouter.delete('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (id === req.user!.id) return res.status(409).json({ error: 'You cannot delete your own account' });
  const owned = db.prepare('SELECT COUNT(*) AS c FROM customers WHERE owner_id = ?').get(id) as { c: number };
  if (owned.c > 0) {
    return res.status(409).json({ error: 'Reassign this user\'s customers first, or deactivate the account instead' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});
