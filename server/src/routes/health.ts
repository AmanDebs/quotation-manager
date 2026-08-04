import { Router } from 'express';
import { db } from '../db/connection.js';

export const healthRouter = Router();

/**
 * Liveness probe for the host (Render polls this). Unauthenticated by design —
 * it reveals nothing but whether the process can still reach its database.
 */
healthRouter.get('/', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false, error: 'Database unavailable' });
  }
});
