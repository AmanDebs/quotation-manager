import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/connection.js';
import { COOKIE_NAME, requireAuth, signToken, bumpTokenVersion, type AuthedRequest } from '../middleware/auth.js';
import { loginRateLimit } from '../middleware/rateLimit.js';
import { record } from '../services/audit.js';

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
  res.cookie(COOKIE_NAME, signToken(id), cookieOpts);
  const created = { id, name: String(name), email: String(email), role: 'manager' as const };
  record({ user: created, entity: 'users', entity_id: id, action: 'register', label: String(email) });
  res.json(created);
});

authRouter.post('/login', loginRateLimit, (req, res) => {
  const { email, password } = req.body ?? {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email ?? '').toLowerCase()) as
    | { id: number; name: string; email: string; password_hash: string; role: string; active: number }
    | undefined;
  // Sign-in is the one place the audit middleware deliberately does not reach,
  // because it is the one place a request body holds a secret. The entries are
  // written here instead, naming the single field worth keeping.
  const attempted = String(email ?? '').toLowerCase().slice(0, 120);
  if (!user || !bcrypt.compareSync(String(password ?? ''), user.password_hash)) {
    // A refused sign-in is worth more than an accepted one: a run of them
    // against one address is the thing somebody would want to look back for.
    record({ user: undefined, entity: 'auth', action: 'login_failed', label: attempted });
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (!user.active) {
    record({ user: undefined, entity: 'auth', action: 'login_refused', label: attempted,
      note: 'account deactivated' });
    return res.status(403).json({ error: 'This account has been deactivated' });
  }
  res.cookie(COOKIE_NAME, signToken(user.id), cookieOpts);
  const session = { id: user.id, name: user.name, email: user.email, role: user.role as 'manager' | 'employee' };
  record({ user: session, entity: 'auth', entity_id: user.id, action: 'login', label: attempted });
  res.json(session);
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
  // Every session signed under the old password stops here — that is the point
  // of changing it. The caller keeps working: they are handed a fresh cookie at
  // the new version, so the browser doing the changing is the one that stays in.
  bumpTokenVersion(req.user!.id);
  res.cookie(COOKIE_NAME, signToken(req.user!.id), cookieOpts);
  record({
    user: req.user, entity: 'users', entity_id: req.user!.id, action: 'change-password',
    label: req.user!.email, note: 'every other session signed out',
  });
  res.json({ ok: true });
});
