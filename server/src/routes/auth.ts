import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../db/connection.js';
import { JWT_SECRET, COOKIE_NAME, requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { loginRateLimit } from '../middleware/rateLimit.js';

export const authRouter = Router();

// `secure` only in production: over plain http://localhost a secure cookie is
// silently dropped, which would make local development impossible to log into.
const cookieOpts = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  maxAge: 30 * 24 * 3600 * 1000,
};

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
authRouter.post('/register', loginRateLimit, (req, res) => {
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

authRouter.post('/login', loginRateLimit, (req, res) => {
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
  // Must repeat the attributes the cookie was set with, or the browser keeps it.
  const { maxAge: _maxAge, ...clearOpts } = cookieOpts;
  res.clearCookie(COOKIE_NAME, clearOpts);
  res.json({ ok: true });
});

/**
 * The session, plus the caller's own dashboard layout.
 *
 * The layout rides along here rather than on a request of its own because the
 * dashboard needs it before it can draw anything, and `/auth/me` is already
 * the gate every page waits on. It is not part of `SessionUser`: the session
 * is an identity, and every route that reads `req.user` would then be carrying
 * a display preference it has no use for.
 */
authRouter.get('/me', requireAuth, (req: AuthedRequest, res) => {
  const row = db.prepare('SELECT dashboard_layout FROM users WHERE id = ?').get(req.user!.id) as
    { dashboard_layout: string } | undefined;
  res.json({ ...req.user, dashboard_layout: readLayout(row?.dashboard_layout) });
});

/**
 * Which dashboard cards this person keeps, and in what order.
 *
 * Card ids are the client's vocabulary, so the server cannot check a list
 * against the real one — but it does not have to store whatever arrives
 * either. What is written is a **normalised** `{hidden, order}` of plausible
 * ids: an unknown id is harmless (the dashboard simply never draws it) while
 * an unbounded blob on a user row is a junk drawer that grows forever.
 *
 * The layout is the caller's own and nobody else's, so there is no role check
 * here; a manager cannot set an employee's, which is the right way round.
 */
const ID = /^[a-z0-9_-]{1,40}$/;
const MAX_IDS = 60;

function cleanIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const v of value) {
    const id = String(v ?? '').trim();
    if (ID.test(id)) seen.add(id);
    if (seen.size >= MAX_IDS) break;
  }
  return [...seen];
}

export interface DashboardLayout { hidden: string[]; order: string[] }

/** Blank, or anything that stopped being valid JSON, reads as "the default". */
function readLayout(raw: string | null | undefined): DashboardLayout {
  if (!String(raw ?? '').trim()) return { hidden: [], order: [] };
  try {
    const parsed = JSON.parse(String(raw));
    return { hidden: cleanIds(parsed?.hidden), order: cleanIds(parsed?.order) };
  } catch {
    return { hidden: [], order: [] };
  }
}

authRouter.put('/dashboard-layout', requireAuth, (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  const layout: DashboardLayout = { hidden: cleanIds(body.hidden), order: cleanIds(body.order) };
  // An empty layout is stored as '' rather than '{"hidden":[],"order":[]}',
  // so "reset to the default" and "never customised" are the same row value
  // and a later change to the built-in order reaches both.
  const json = layout.hidden.length || layout.order.length ? JSON.stringify(layout) : '';
  db.prepare('UPDATE users SET dashboard_layout = ? WHERE id = ?').run(json, req.user!.id);
  res.json(layout);
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
