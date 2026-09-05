import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { db, dataDir } from '../db/connection.js';
import { can, legacyRole, type Fn, type Level, type TeamRole } from '../services/permissions.js';

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
  /**
   * The legacy role, and **derived** rather than read from the row: it is
   * `manager` for a super admin and `employee` for everyone else.
   *
   * It stays because every guard written before `team_role` reads it, so each
   * one keeps meaning *super admin* until it is converted, and anything missed
   * fails closed rather than open. Deriving rather than storing is what makes
   * the two impossible to disagree — see `legacyRole` in services/permissions.
   */
  role: 'manager' | 'employee';
  /** Which team this person is on. Blank on a row the backfill has not reached. */
  team_role: TeamRole | '';
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
    // team_role is on this SELECT and must stay on it: without it every
    // capability check denies, and the whole app locks out at once.
    const user = db
      .prepare('SELECT id, name, email, team_role, active, token_version FROM users WHERE id = ?')
      .get(payload.userId) as
      | { id: number; name: string; email: string; team_role: TeamRole | ''; active: number; token_version: number }
      | undefined;
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (!user.active) return res.status(403).json({ error: 'This account has been deactivated' });
    // A token signed before this claim existed reads as version 0, which is
    // where every existing row starts — so adding the check signs nobody out.
    // It only bites once a password has actually been changed.
    if ((payload.tv ?? 0) !== user.token_version) {
      return res.status(401).json({ error: 'Your password was changed — please sign in again' });
    }
    req.user = {
      id: user.id, name: user.name, email: user.email,
      team_role: user.team_role,
      role: legacyRole(user.team_role),
    };
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

/**
 * Guard a route by function rather than by role.
 *
 * 403 with the reason, matching `requireManager` — the 404-rather-than-403 rule
 * this codebase follows elsewhere is about not confirming that a *record*
 * exists to somebody who may not see it, which is a different question from
 * whether a whole screen is yours. Routes that answer about one record keep
 * using `can()` directly and keep answering 404.
 */
export function requirePermission(fn: Fn, level: Level = 'view') {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!can(req.user?.team_role, fn, level === 'full' ? 'full' : 'view')) {
      return res.status(403).json({
        error: level === 'full'
          ? 'Your team does not have permission to change this'
          : 'Your team does not have access to this',
      });
    }
    next();
  };
}

/**
 * Read it with `view`, change it with `full`.
 *
 * The shape most document routers want: a team given *view* on something can
 * open it and cannot touch it. Mounting `requirePermission(fn)` alone would
 * have let Logistics — which may only view an order — edit one, and Sales
 * raise a commercial invoice it is supposed to read and download.
 *
 * Not used on the routers that serve more than one function (work orders,
 * stock, products, masters): there a write is not always the mounted
 * function's, and Quality writing a QC check holds only `work_order: view`.
 */
export function requireFunction(fn: Fn) {
  const read = requirePermission(fn, 'view');
  const write = requirePermission(fn, 'full');
  return (req: AuthedRequest, res: Response, next: NextFunction) =>
    (req.method === 'GET' ? read : write)(req, res, next);
}

/** Whether the signed-in user may do this — for routes that answer 404 instead. */
export const allows = (req: AuthedRequest, fn: Fn, level: 'view' | 'full' = 'view') =>
  can(req.user?.team_role, fn, level);
