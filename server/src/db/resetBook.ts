import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { dataDir } from './connection.js';
import { CLEARED, KEPT, bookCounts, missingTables, resetBook } from '../services/resetBook.js';

/**
 * The shell door to `services/resetBook.ts` — run in `server/` where the
 * database is (the Render shell, or a terminal beside `server/data`), for
 * the reason `resetPassword.ts` gives: the person who can reach the disk is
 * the person who may empty it. The Settings page offers the same act to the
 * Super Admin.
 *
 *     npm run reset-book            -- show what would go, change nothing
 *     npm run reset-book -- --yes   -- do it
 */
async function main() {
  console.log('\nERP Tool — reset the book');
  console.log(`Database: ${dataDir}\n`);

  const missing = missingTables();
  if (missing.length) {
    console.error(`Tables not found in this database: ${missing.join(', ')}. Is this the right one?`);
    process.exitCode = 1;
    return;
  }

  const counts = bookCounts();
  console.log('Would be emptied:');
  let total = 0;
  for (const t of CLEARED) {
    const n = counts.cleared[t];
    total += n;
    if (n) console.log(`  ${t.padEnd(22)} ${String(n).padStart(7)}`);
  }
  if (total === 0) console.log('  (nothing — the book is already empty)');
  console.log('\nKept as they are:');
  console.log('  ' + KEPT.map((t) => `${t} (${counts.kept[t]})`).join(', '));
  console.log('\nNumbering restarts at 001 for every series.');

  if (!process.argv.includes('--yes')) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    const answer = (await rl.question(`\nEmpty ${total} rows across ${CLEARED.length} tables? There is no undo but the snapshot. [y/N] `)).trim();
    rl.close();
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      console.log('Nothing changed.\n');
      return;
    }
  }

  const snapshot = resetBook({ user: undefined, origin: 'From the command line (npm run reset-book)' });
  console.log(`\nSnapshot written: ${snapshot}`);
  console.log('Done. Every document, job, dispatch, payment and log entry is gone;');
  console.log('customers, products, masters, companies and accounts are untouched.');
  console.log('Restart the app if it is running, so its boot passes see the empty book.\n');
}

main().catch((err) => {
  console.error('\nFailed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
