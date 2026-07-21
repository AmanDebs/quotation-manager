import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from '../db/connection.js';

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

export interface AuthedRequest extends Request {
  userId?: number;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: number };
    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired' });
  }
}
