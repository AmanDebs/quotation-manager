import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Point this process at a throwaway database.
 *
 * **Import this first, before anything that touches the app.**
 * `db/connection.ts` opens the file at import time and reads `DATA_DIR` as it
 * does, so the variable has to be set before that module is evaluated. ES
 * modules are evaluated in import order, so a side-effecting import at the top
 * of a test file runs first and this works — but move it down the list, or let
 * a formatter sort the imports alphabetically, and every test in the file will
 * quietly run against `server/data/app.db`. That is the live database.
 *
 * Node's test runner gives each file its own process, so each file gets its
 * own directory and they cannot interfere with one another.
 *
 * The directory is deliberately left behind rather than cleaned up: the OS
 * clears its temp folder, and a failing test whose database has been deleted
 * is much harder to look into.
 */
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'qm-test-'));
process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';
process.env.DISABLE_BACKUPS = '1';
