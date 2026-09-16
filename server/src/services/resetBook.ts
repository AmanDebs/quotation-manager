import path from 'node:path';
import { db, dataDir } from '../db/connection.js';
import { writeSnapshot } from './backup.js';
import { record } from './audit.js';
import type { SessionUser } from '../middleware/auth.js';

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
 * One function with two doors: `npm run reset-book` from a shell beside the
 * database, and a button in Settings for the Super Admin alone (asked for
 * the same day, the shell being one step too many). Both do exactly this.
 *
 * Three things it does that a row of DELETEs would not:
 *
 * - **A snapshot first**, `backups/app-before-reset-<time>.db`, by the same
 *   `VACUUM INTO` the nightly backup uses. There is no undo other than this.
 * - **One transaction**, foreign keys off for its duration (SQLite refuses to
 *   toggle them inside one, so it is done before BEGIN), and a
 *   `foreign_key_check` afterwards that has to come back empty — a half-wiped
 *   book with a payment pointing at nothing is worse than either whole state.
 *   Safe under a live server: `DatabaseSync` is synchronous and Node runs
 *   one request at a time, so nothing interleaves with the pragma being off.
 * - **A first entry in the emptied audit log** saying who did it, from where,
 *   with the snapshot's name — the one act somebody will most want to find
 *   afterwards.
 */

/** Every table that is a transaction, not reference data. Order is cosmetic. */
export const CLEARED = [
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

/** What stays, said out loud so whoever presses the button can check the list first. */
export const KEPT = [
  'users', 'companies', 'settings', 'customers', 'products', 'product_materials', 'product_qc_params',
  'locations', 'suppliers', 'transporters', 'materials', 'machines', 'moulds', 'processes',
] as const;

const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

/** Row counts per table, both lists; the dialog and the script show them before asking. */
export function bookCounts(): { cleared: Record<string, number>; kept: Record<string, number> } {
  const tally = (names: readonly string[]) => Object.fromEntries(names.map((t) => [t, count(t)]));
  return { cleared: tally(CLEARED), kept: tally(KEPT) };
}

/** The tables named above that this database does not have — none, on a current one. */
export function missingTables(): string[] {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
  return [...CLEARED, ...KEPT].filter((t) => !tables.has(t));
}

/** Empty the book. Returns the snapshot's path. Throws, having rolled back, on anything wrong. */
export function resetBook(by: { user: SessionUser | undefined; origin: string }): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const snapshot = writeSnapshot(path.join(dataDir, 'backups', `app-before-reset-${stamp}.db`));

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
    user: by.user,
    entity: 'settings',
    entity_id: 1,
    action: 'reset_book',
    label: 'The book was emptied',
    note: `${by.origin}. Snapshot: ${path.basename(snapshot)}`,
  });

  // Reclaim the space; outside the transaction, as VACUUM must be.
  db.exec('VACUUM');
  return snapshot;
}
