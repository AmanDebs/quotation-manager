import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { db, dataDir } from '../db/connection.js';

const secretFile = path.join(dataDir, 'jwt-secret');

// Persist a random secret so logins survive server restarts.
function loadSecret(): string {
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

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: number };
    const user = db
      .prepare('SELECT id, name, email, role, active FROM users WHERE id = ?')
      .get(payload.userId) as (SessionUser & { active: number }) | undefined;
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (!user.active) return res.status(403).json({ error: 'This account has been deactivated' });
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
