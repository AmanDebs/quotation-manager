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

/**
 * First-run setup only — creates the manager account. Once any user exists,
 * further accounts are created by a manager via /api/users, so nobody can
 * sign themselves up.
 */
authRouter.post('/register', (req, res) => {
  const existingUsers = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
  if (existingUsers.c > 0) {
    return res.status(403).json({ error: 'Accounts are created by your manager. Please ask them for a login.' });
  }
  const { name, email, password } = req.body ?? {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const hash = bcrypt.hashSync(String(password), 10);
  const info = db
    .prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'manager')")
    .run(String(name), String(email).toLowerCase(), hash);
  const id = Number(info.lastInsertRowid);
  const token = jwt.sign({ userId: id }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE_NAME, token, cookieOpts);
  res.json({ id, name, email, role: 'manager' });
});

authRouter.post('/login', (req, res) => {
  const { email, password } = req.body ?? {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email ?? '').toLowerCase()) as
    | { id: number; name: string; email: string; password_hash: string; role: string; active: number }
    | undefined;
  if (!user || !bcrypt.compareSync(String(password ?? ''), user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (!user.active) return res.status(403).json({ error: 'This account has been deactivated' });
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE_NAME, token, cookieOpts);
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req: AuthedRequest, res) => {
  res.json(req.user);
});

authRouter.post('/change-password', requireAuth, (req: AuthedRequest, res) => {
  const { current_password, new_password } = req.body ?? {};
  if (!new_password || String(new_password).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user!.id) as { password_hash: string };
  if (!bcrypt.compareSync(String(current_password ?? ''), row.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(new_password), 10), req.user!.id);
  res.json({ ok: true });
});
