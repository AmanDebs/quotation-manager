import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR lets deployments (and tests) relocate the database.
export const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '../../data');
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'app.db'));

const schema = readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);

// Additive migrations for databases created before these columns existed.
function addColumnIfMissing(table: string, column: string, definition: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumnIfMissing('proforma_invoices', 'po_number', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('proforma_invoices', 'po_date', "TEXT NOT NULL DEFAULT ''");

// Aglo-format rework (2026-07): packaging-based items, extra parties/shipping fields,
// fiscal-year numbering patterns, theme color.
for (const table of ['quotation_items', 'pi_items', 'invoice_items']) {
  addColumnIfMissing(table, 'color', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(table, 'packs', 'REAL');
  addColumnIfMissing(table, 'pcs_per_pack', 'REAL');
  addColumnIfMissing(table, 'total_pcs', 'REAL');
}
addColumnIfMissing('packing_list_items', 'hsn_code', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('quotations', 'freight', 'REAL NOT NULL DEFAULT 0');
addColumnIfMissing('quotations', 'insurance', 'REAL NOT NULL DEFAULT 0');
addColumnIfMissing('quotations', 'inco_terms', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('quotations', 'container_count', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('quotations', 'prepared_by', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('proforma_invoices', 'notify_party_2', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('proforma_invoices', 'method_of_despatch', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('proforma_invoices', 'quantity_tolerance', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('proforma_invoices', 'hs_code', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('proforma_invoices', 'prepared_by', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('commercial_invoices', 'notify_party_2', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('commercial_invoices', 'method_of_despatch', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('commercial_invoices', 'lot_no', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('commercial_invoices', 'prepared_by', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('packing_lists', 'lot_no', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('customers', 'notify_party_2', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('settings', 'arn_ref', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('settings', 'theme_color', "TEXT NOT NULL DEFAULT '#8b1a1a'");
addColumnIfMissing('settings', 'quote_pattern', "TEXT NOT NULL DEFAULT 'QT/{FY}/{SEQ}'");
addColumnIfMissing('settings', 'pi_pattern', "TEXT NOT NULL DEFAULT 'PI/{FY}/{SEQ}'");
addColumnIfMissing('settings', 'pi_export_pattern', "TEXT NOT NULL DEFAULT 'EX-PI/{FY}/{SEQ}'");
addColumnIfMissing('settings', 'inv_pattern', "TEXT NOT NULL DEFAULT 'INV/{FY}/{SEQ}'");
addColumnIfMissing('settings', 'inv_export_pattern', "TEXT NOT NULL DEFAULT 'EX/{FY}/{SEQ}'");
addColumnIfMissing('settings', 'pl_pattern', "TEXT NOT NULL DEFAULT 'PL/{FY}/{SEQ}'");

/** Run fn inside a transaction; rolls back on any thrown error. */
export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
