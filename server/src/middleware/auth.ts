import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { db, dataDir } from '../db/connection.js';

const secretFile = path.join(dataDir, 'jwt-secret');

/**
 * The signing secret must be stable across restarts, or every deploy signs
 * everyone out. A hosted deployment sets JWT_SECRET; locally we fall back to a
 * random secret persisted next to the database.
 */
function loadSecret(): string {
  const fromEnv = process.env.JWT_SECRET?.trim();
  if (fromEnv) {
    if (fromEnv.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters — generate one with: openssl rand -hex 32');
    }
    return fromEnv;
  }
  if (process.env.NODE_ENV === 'production') {
    console.warn('JWT_SECRET is not set — falling back to a file-based secret. Sessions will not survive a redeploy on a host with an ephemeral disk.');
  }
  mkdirSync(path.dirname(secretFile), { recursive: true });
  if (existsSync(secretFile)) return readFileSync(secretFile, 'utf-8');
  const secret = crypto.randomBytes(32).toString('hex');
  writeFileSync(secretFile, secret);
  return secret;
}

export const JWT_SECRET = loadSecret();
export const COOKIE_NAME = 'qm_token';

export interface SessionUser {
  id: number;
  name: string;
  email: string;
  role: 'manager' | 'employee';
}

export interface AuthedRequest extends Request {
  user?: SessionUser;
}

/**
 * Signs a session for this user at their current token version.
 *
 * Every token carries the version it was signed under; `requireAuth` compares
 * it against the row. Raising the row's version therefore ends every session
 * issued before it, which is what makes a password change mean something —
 * see `bumpTokenVersion`.
 */
export function signToken(userId: number): string {
  const row = db.prepare('SELECT token_version FROM users WHERE id = ?').get(userId) as
    { token_version: number } | undefined;
  return jwt.sign({ userId, tv: row?.token_version ?? 0 }, JWT_SECRET, { expiresIn: '30d' });
}

/** Ends every session this user currently holds. Returns the new version. */
export function bumpTokenVersion(userId: number): number {
  const row = db
    .prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ? RETURNING token_version')
    .get(userId) as { token_version: number } | undefined;
  return row?.token_version ?? 0;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: number; tv?: number };
    const user = db
      .prepare('SELECT id, name, email, role, active, token_version FROM users WHERE id = ?')
      .get(payload.userId) as (SessionUser & { active: number; token_version: number }) | undefined;
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (!user.active) return res.status(403).json({ error: 'This account has been deactivated' });
    // A token signed before this claim existed reads as version 0, which is
    // where every existing row starts — so adding the check signs nobody out.
    // It only bites once a password has actually been changed.
    if ((payload.tv ?? 0) !== user.token_version) {
      return res.status(401).json({ error: 'Your password was changed — please sign in again' });
    }
    req.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired' });
  }
}

/** Manager-only guard for settings, team management and approvals. */
export function requireManager(req: AuthedRequest, res: Response, next: NextFunction) {
  if (req.user?.role !== 'manager') {
    return res.status(403).json({ error: 'Only a manager can do this' });
  }
  next();
}

export const isManager = (req: AuthedRequest) => req.user?.role === 'manager';
