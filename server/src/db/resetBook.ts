import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { db, dataDir } from './connection.js';
import { writeSnapshot } from '../services/backup.js';
import { record } from '../services/audit.js';

/**
 * Start the book again.
 *
 * Asked for on 2026-09-16, once the app had been driven for a few weeks with
 * trial documents: *"delete all quotations, proforma, sales order, commercial
 * invoices, work orders and start from fresh"*. Every transaction goes and
 * every master stays — customers, products (with their recipes and QC
 * specifications), the factory masters, the companies and their settings,
 * and the accounts. Numbering restarts at 001.
 *
 * It runs where the database is — the Render shell, or a terminal beside
 * `server/data` — for the reason `resetPassword.ts` gives: the person who
 * can reach the disk is the person who may empty it, and there is no
 * button in the app for something this final.
 *
 *     npm run reset-book            -- show what would go, change nothing
 *     npm run reset-book -- --yes   -- do it
 *
 * Three things it does that a row of DELETEs would not:
 *
 * - **A snapshot first**, `backups/app-before-reset-<time>.db`, by the same
 *   `VACUUM INTO` the nightly backup uses. There is no undo other than this.
 * - **One transaction**, foreign keys off for its duration (SQLite refuses to
 *   toggle them inside one, so it is done before BEGIN), and a
 *   `foreign_key_check` afterwards that has to come back empty — a half-wiped
 *   book with a payment pointing at nothing is worse than either whole state.
 * - **A first entry in the emptied audit log** saying this happened, from the
 *   command line, with the snapshot's name — the one path that bypasses HTTP
 *   entirely, and the one act somebody will most want to find afterwards.
 */

/** Every table that is a transaction, not reference data. Order is cosmetic. */
const CLEARED = [
  'enquiries', 'followups',
  'quotations', 'quotation_items',
  'proforma_invoices', 'pi_items',
  'orders', 'order_items',
  'commercial_invoices', 'invoice_items',
  'packing_lists', 'packing_list_items',
  'credit_notes', 'credit_note_items', 'credit_note_batches',
  'payments',
  'work_orders', 'work_order_materials',
  'production_entries', 'batches',
  'qc_checks', 'qc_results',
  'despatches', 'despatch_items', 'despatch_batches',
  'purchase_orders', 'po_items', 'po_receipts',
  'material_moves', 'fg_adjustments',
  'audit_log', 'sequences',
] as const;

/** What stays, said out loud so the operator can check the list before typing yes. */
const KEPT = [
  'users', 'companies', 'settings', 'customers', 'products', 'product_materials', 'product_qc_params',
  'locations', 'suppliers', 'transporters', 'materials', 'machines', 'moulds', 'processes',
] as const;

const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

async function main() {
  console.log('\nERP Tool — reset the book');
  console.log(`Database: ${dataDir}\n`);

  // Every table named above must exist, or the wipe would stop half way.
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
  const missing = [...CLEARED, ...KEPT].filter((t) => !tables.has(t));
  if (missing.length) {
    console.error(`Tables not found in this database: ${missing.join(', ')}. Is this the right one?`);
    process.exitCode = 1;
    return;
  }

  console.log('Would be emptied:');
  let total = 0;
  for (const t of CLEARED) {
    const n = count(t);
    total += n;
    if (n) console.log(`  ${t.padEnd(22)} ${String(n).padStart(7)}`);
  }
  if (total === 0) console.log('  (nothing — the book is already empty)');
  console.log('\nKept as they are:');
  console.log('  ' + KEPT.map((t) => `${t} (${count(t)})`).join(', '));
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

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const snapshot = writeSnapshot(path.join(dataDir, 'backups', `app-before-reset-${stamp}.db`));
  console.log(`\nSnapshot written: ${snapshot}`);

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    for (const t of CLEARED) db.exec(`DELETE FROM ${t}`);
    const broken = db.prepare('PRAGMA foreign_key_check').all();
    if (broken.length) throw new Error(`foreign_key_check reports ${broken.length} dangling reference(s); rolled back`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  record({
    user: undefined,
    entity: 'settings',
    entity_id: 1,
    action: 'reset_book',
    label: 'The book was emptied',
    note: `From the command line (npm run reset-book). Snapshot: ${path.basename(snapshot)}`,
  });

  // Reclaim the space; outside the transaction, as VACUUM must be.
  db.exec('VACUUM');

  console.log('Done. Every document, job, dispatch, payment and log entry is gone;');
  console.log('customers, products, masters, companies and accounts are untouched.');
  console.log('Restart the app if it is running, so its boot passes see the empty book.\n');
}

main().catch((err) => {
  console.error('\nFailed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
