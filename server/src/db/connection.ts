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

// Team roles, approval workflow, flexible columns (2026-07).
addColumnIfMissing('users', 'role', "TEXT NOT NULL DEFAULT 'employee'");
addColumnIfMissing('users', 'active', 'INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('customers', 'owner_id', 'INTEGER');
addColumnIfMissing('customers', 'is_export', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('products', 'image', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('products', 'color', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('settings', 'note_presets', "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing('quotations', 'is_export', 'INTEGER NOT NULL DEFAULT 0');
for (const table of ['quotations', 'proforma_invoices', 'commercial_invoices']) {
  addColumnIfMissing(table, 'created_by', 'INTEGER');
  addColumnIfMissing(table, 'approval_status', "TEXT NOT NULL DEFAULT 'not_submitted'");
  addColumnIfMissing(table, 'approved_by', 'INTEGER');
  addColumnIfMissing(table, 'approved_at', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(table, 'approval_note', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(table, 'column_config', "TEXT NOT NULL DEFAULT '{}'");
}
addColumnIfMissing('packing_lists', 'created_by', 'INTEGER');
addColumnIfMissing('packing_lists', 'column_config', "TEXT NOT NULL DEFAULT '{}'");
for (const table of ['quotation_items', 'pi_items', 'invoice_items', 'packing_list_items']) {
  addColumnIfMissing(table, 'custom1', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(table, 'custom2', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(table, 'custom3', "TEXT NOT NULL DEFAULT ''");
}

// Order book (2026-07): orders sit between quotation and proforma invoice.
addColumnIfMissing('settings', 'order_pattern', "TEXT NOT NULL DEFAULT 'SO/{FY}/{SEQ}'");
addColumnIfMissing('settings', 'order_export_pattern', "TEXT NOT NULL DEFAULT 'SO-EX/{FY}/{SEQ}'");
addColumnIfMissing('proforma_invoices', 'order_id', 'INTEGER');
addColumnIfMissing('commercial_invoices', 'order_id', 'INTEGER');

// One-off backfill: the founding account becomes the manager and inherits
// ownership of everything that pre-dates the roles feature.
const founder = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number } | undefined;
if (founder) {
  const managers = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'manager'").get() as { c: number };
  if (managers.c === 0) {
    db.prepare("UPDATE users SET role = 'manager' WHERE id = ?").run(founder.id);
  }
  db.prepare('UPDATE customers SET owner_id = ? WHERE owner_id IS NULL').run(founder.id);
  for (const table of ['quotations', 'proforma_invoices', 'commercial_invoices', 'packing_lists']) {
    db.prepare(`UPDATE ${table} SET created_by = ? WHERE created_by IS NULL`).run(founder.id);
  }
  // Documents that already went out predate approvals — treat them as approved.
  db.prepare(
    "UPDATE quotations SET approval_status = 'approved' WHERE approval_status = 'not_submitted' AND status <> 'draft'"
  ).run();
  db.prepare(
    "UPDATE proforma_invoices SET approval_status = 'approved' WHERE approval_status = 'not_submitted' AND status <> 'draft'"
  ).run();
  db.prepare(
    "UPDATE commercial_invoices SET approval_status = 'approved' WHERE approval_status = 'not_submitted' AND status <> 'draft'"
  ).run();
}

// Customers created before the export flag get it from their country.
db.prepare("UPDATE customers SET is_export = 1 WHERE is_export = 0 AND lower(trim(country)) <> 'india' AND country <> ''").run();
db.prepare('UPDATE quotations SET is_export = 1 WHERE is_export = 0 AND customer_id IN (SELECT id FROM customers WHERE is_export = 1)').run();

// Starter note presets so the feature is useful immediately.
const presetRow = db.prepare('SELECT note_presets FROM settings WHERE id = 1').get() as { note_presets: string } | undefined;
if (presetRow && (!presetRow.note_presets || presetRow.note_presets === '[]')) {
  db.prepare('UPDATE settings SET note_presets = ? WHERE id = 1').run(JSON.stringify([
    { label: 'Freight & insurance clause', body: 'Price is subject to change in freight & insurance billed at actual at the time of booking and dispatch.' },
    { label: 'Quantity tolerance', body: 'Quantity Tolerance: (±) 10% in value and quantity. Packing details are subject to change.' },
    { label: 'Production plan', body: 'Production and transit plan to be finalized at the time of order placement.' },
    { label: 'Force majeure', body: "Quotation is subject to force majeure clause and subject to changes in case of any unforeseen situation which is beyond supplier's control." },
    { label: 'Jurisdiction', body: 'All disputes subject to Kolkata jurisdiction.' },
    { label: 'Billing basis', body: 'Product will be billed in tonnage as per standard weight of each product; tolerance weight is acceptable to buyer as mentioned in each product description.' },
  ]));
}

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
