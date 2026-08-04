import { mkdirSync, readdirSync, statSync, unlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { db, dataDir } from '../db/connection.js';

/**
 * Snapshots of the database.
 *
 * `VACUUM INTO` is the only correct way to copy a live SQLite database: it
 * writes a single consistent file even while WAL has uncommitted pages, which
 * is why copying `app.db` on its own yields an almost-empty backup. It also
 * needs no extra process, no dump format and no dependency.
 *
 * On a host with one disk, backups are the real risk — not SQLite. These run
 * daily and are also downloadable on demand by a manager, so recovery never
 * depends on someone remembering to check a cron job.
 */

const backupDir = path.join(dataDir, 'backups');
const RETAIN_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Write a consistent snapshot and return its path. */
export function writeSnapshot(target?: string): string {
  mkdirSync(backupDir, { recursive: true });
  const file = target ?? path.join(backupDir, `app-${new Date().toISOString().slice(0, 10)}.db`);
  // VACUUM INTO refuses to overwrite, so clear any snapshot from earlier today.
  rmSync(file, { force: true });
  // The path is interpolated because SQLite does not accept a parameter here;
  // it is server-derived, never user input.
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}

/** Delete snapshots older than the retention window. */
export function pruneSnapshots(): number {
  let removed = 0;
  const cutoff = Date.now() - RETAIN_DAYS * DAY_MS;
  try {
    for (const name of readdirSync(backupDir)) {
      if (!name.startsWith('app-') || !name.endsWith('.db')) continue;
      const full = path.join(backupDir, name);
      if (statSync(full).mtimeMs < cutoff) { unlinkSync(full); removed++; }
    }
  } catch { /* no backup directory yet */ }
  return removed;
}

export function listSnapshots(): { name: string; size: number; modified: string }[] {
  try {
    return readdirSync(backupDir)
      .filter((n) => n.startsWith('app-') && n.endsWith('.db'))
      .map((name) => {
        const s = statSync(path.join(backupDir, name));
        return { name, size: s.size, modified: new Date(s.mtimeMs).toISOString() };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch {
    return [];
  }
}

function runOnce() {
  try {
    const file = writeSnapshot();
    const pruned = pruneSnapshots();
    console.log(`Backup written: ${file}${pruned ? ` (pruned ${pruned} old snapshot${pruned === 1 ? '' : 's'})` : ''}`);
  } catch (err) {
    // A failed backup must never take the server down with it.
    console.error('Backup failed:', err);
  }
}

/** Snapshot on boot, then daily. Deliberately no cron dependency. */
export function startBackupSchedule() {
  if (process.env.DISABLE_BACKUPS === '1') return;
  runOnce();
  const timer = setInterval(runOnce, DAY_MS);
  timer.unref?.(); // never hold the process open on its own
}
