import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../db/connection.js';
import { JWT_SECRET, COOKIE_NAME, requireAuth, type AuthedRequest } from '../middleware/auth.js';

export const authRouter = Router();

const cookieOpts = { httpOnly: true, sameSite: 'lax' as const, maxAge: 30 * 24 * 3600 * 1000 };

// True until the first user registers; the client shows a setup screen then.
authRouter.get('/status', (_req, res) => {
  const row = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
  res.json({ needsSetup: row.c === 0 });
});

authRouter.post('/register', (req, res) => {
  const { name, email, password } = req.body ?? {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).toLowerCase());
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });
  const hash = bcrypt.hashSync(String(password), 10);
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .run(String(name), String(email).toLowerCase(), hash);
  const token = jwt.sign({ userId: Number(info.lastInsertRowid) }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE_NAME, token, cookieOpts);
  res.json({ id: Number(info.lastInsertRowid), name, email });
});

authRouter.post('/login', (req, res) => {
  const { email, password } = req.body ?? {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email ?? '').toLowerCase()) as
    | { id: number; name: string; email: string; password_hash: string }
    | undefined;
  if (!user || !bcrypt.compareSync(String(password ?? ''), user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE_NAME, token, cookieOpts);
  res.json({ id: user.id, name: user.name, email: user.email });
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req: AuthedRequest, res) => {
  const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(req.userId!) as
    | { id: number; name: string; email: string }
    | undefined;
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json(user);
});
