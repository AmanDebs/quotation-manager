import { Router } from 'express';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { listSnapshots, writeSnapshot } from '../services/backup.js';

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
