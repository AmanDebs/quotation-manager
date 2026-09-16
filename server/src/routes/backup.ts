import { Router } from 'express';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { listSnapshots, writeSnapshot } from '../services/backup.js';
import { bookCounts, resetBook } from '../services/resetBook.js';
import type { AuthedRequest } from '../middleware/auth.js';

export const backupRouter = Router();

// Mounted in index.ts behind requireAuth + requireManager. This endpoint hands
// out the entire database, so it must never sit under a router that lets GETs
// through unguarded.

/** Recent automatic snapshots, for the Settings page to show. */
backupRouter.get('/', (_req, res) => {
  res.json({ snapshots: listSnapshots() });
});

/** A fresh snapshot, downloaded now. */
backupRouter.get('/download', (_req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const temp = path.join(tmpdir(), `quotation-backup-${stamp}.db`);
  try {
    writeSnapshot(temp);
  } catch (err) {
    console.error('Backup download failed:', err);
    return res.status(500).json({ error: 'Could not create a backup just now' });
  }
  res.download(temp, `quotation-manager-${stamp}.db`, () => rmSync(temp, { force: true }));
});

/*
 * Starting the book again, from Settings (2026-09-16). The mount is
 * `backup: full`, which the System Administrator also holds — and that row
 * is *user management only* on the client's own matrix, so both routes ask
 * for the Super Admin by name rather than leaning on the mount. There is no
 * cell for "may empty the book" and adding one would be a cell nobody has
 * filled in.
 */
const superAdminOnly = (req: AuthedRequest, res: import('express').Response): boolean => {
  if (req.user?.team_role === 'super_admin') return true;
  res.status(403).json({ error: 'Only the Super Admin can reset the book' });
  return false;
};

/** What a reset would empty and what it would keep, for the dialog to show. */
backupRouter.get('/reset-book', (req, res) => {
  if (!superAdminOnly(req as AuthedRequest, res)) return;
  res.json(bookCounts());
});

/**
 * Empty the book. The body must carry the word RESET, typed — a click on a
 * confirm is how a wipe gets pressed by mistake, and there is no undo but the
 * snapshot this takes first.
 */
backupRouter.post('/reset-book', (req, res) => {
  if (!superAdminOnly(req as AuthedRequest, res)) return;
  if (String((req.body as { confirm?: unknown })?.confirm ?? '') !== 'RESET') {
    return res.status(400).json({ error: 'Type RESET to confirm' });
  }
  const user = (req as AuthedRequest).user;
  try {
    const snapshot = resetBook({ user, origin: `From Settings by ${user?.name ?? 'unknown'}` });
    res.json({ ok: true, snapshot: path.basename(snapshot) });
  } catch (err) {
    console.error('Reset failed:', err);
    res.status(500).json({ error: 'The reset failed and was rolled back; nothing changed' });
  }
});
