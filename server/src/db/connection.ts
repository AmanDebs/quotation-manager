import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// Pure, no db import — see the note at the top of that file for why it is not
// part of services/numbering.ts, which imports `db` from here.
import { defaultPatternsFor, PATTERN_COLUMNS, SCHEMA_DEFAULT_PATTERNS } from '../services/companyPatterns.js';

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
// A private note on a quotation (2026-08). Distinct from `notes`, which is
// printed to the customer — this one never reaches a PDF.
addColumnIfMissing('quotations', 'internal_notes', "TEXT NOT NULL DEFAULT ''");

// Per-line loadability (2026-08). Copied from the catalogue when a product is
// picked, then owned by the document — editing products must not rewrite the
// figures an old quotation was sent out with. Carried on all four item tables
// so a conversion down the chain does not silently drop them.
for (const table of ['quotation_items', 'order_items', 'pi_items', 'invoice_items']) {
  addColumnIfMissing(table, 'qty_20ft', 'REAL');
  addColumnIfMissing(table, 'qty_40ft', 'REAL');
}
// Charge lines (2026-08). A line that is a fee rather than goods — freight,
// insurance, tooling — bills at its own price and stays out of the quantity
// totals. Defaulting to 0 means every existing line stays goods, which it is.
for (const table of ['quotation_items', 'order_items', 'pi_items', 'invoice_items', 'packing_list_items']) {
  addColumnIfMissing(table, 'is_charge', 'INTEGER NOT NULL DEFAULT 0');
}

// The invoice's status now follows what has actually been received (2026-08).
// This remembers what the status was before the payment record promoted it, so
// deleting a mis-keyed payment restores it instead of guessing.
addColumnIfMissing('commercial_invoices', 'status_before_paid', "TEXT NOT NULL DEFAULT ''");
// And an order's `completed` follows the shipping record, with the same memory
// so that re-opening one puts back what was there. Empty means a human closed
// it, which is deliberately never undone.
addColumnIfMissing('orders', 'status_before_completed', "TEXT NOT NULL DEFAULT ''");
// Where to put a lapsed quotation back if its validity is extended (2026-08).
// Only an automatic expiry is automatically undone, so an empty value means
// "somebody set this by hand" and the row stays where they put it.
addColumnIfMissing('quotations', 'status_before_expired', "TEXT NOT NULL DEFAULT ''");
// And where to put a proforma back when the order booked from it is deleted
// (2026-09). Same rule as the three above: filled only when the code moved it,
// so a row that reached 'in_production' by hand — every one of them, before
// booking started setting it — has nothing remembered and is left alone.
addColumnIfMissing('proforma_invoices', 'status_before_ordered', "TEXT NOT NULL DEFAULT ''");

// Work orders (2026-08). Their own series per company, like every other
// numbered document; `settings` gets it too so the old single-company row
// stays a faithful view of company 1.
addColumnIfMissing('settings', 'wo_pattern', "TEXT NOT NULL DEFAULT 'WO/{FY}/{SEQ}'");
addColumnIfMissing('companies', 'wo_pattern', "TEXT NOT NULL DEFAULT 'WO/{FY}/{SEQ}'");
addColumnIfMissing('settings', 'po_pattern', "TEXT NOT NULL DEFAULT 'PO/{FY}/{SEQ}'");
addColumnIfMissing('companies', 'po_pattern', "TEXT NOT NULL DEFAULT 'PO/{FY}/{SEQ}'");
addColumnIfMissing('packing_list_items', 'hsn_code', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('quotations', 'freight', 'REAL NOT NULL DEFAULT 0');
addColumnIfMissing('quotations', 'insurance', 'REAL NOT NULL DEFAULT 0');
addColumnIfMissing('quotations', 'inco_terms', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('quotations', 'container_count', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('quotations', 'prepared_by', "TEXT NOT NULL DEFAULT ''");
// The team's own commentary on a proforma. Quotations have had this since the
// beginning; proformas never did, so the notes about a negotiation stopped at
// the point it turned into a document.
addColumnIfMissing('proforma_invoices', 'internal_notes', "TEXT NOT NULL DEFAULT ''");
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
// The LUT/ARN moved onto the document: a fresh reference is obtained for each
// export consignment, so it is not a property of the company. The company's
// value stays as the default an invoice starts from.
addColumnIfMissing('commercial_invoices', 'arn_ref', "TEXT NOT NULL DEFAULT ''");
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
// Per-user dashboard layout (2026-08). Blank means the built-in order.
addColumnIfMissing('users', 'dashboard_layout', "TEXT NOT NULL DEFAULT ''");
// Session invalidation on password change (2026-08). Existing sessions were
// signed without the claim; they read as version 0, which is what every
// existing row starts at, so nobody is signed out by the migration itself.
addColumnIfMissing('users', 'token_version', 'INTEGER NOT NULL DEFAULT 0');
// Material costing (2026-08). Nullable on purpose: an existing receipt has no
// rate recorded, and treating that as zero would value the shed at nothing.
addColumnIfMissing('material_moves', 'rate', 'REAL');
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

// Product packing defaults (2026-08), matching the columns the user keeps in
// their own catalogue sheet: pieces per box, and boxes per container.
addColumnIfMissing('products', 'pcs_per_pack', 'REAL');
addColumnIfMissing('products', 'qty_20ft', 'REAL');
addColumnIfMissing('products', 'qty_40ft', 'REAL');

// Per-line photo (2026-08). Added to every item table, not just quotations:
// the line-items editor is shared, so a column missing from one table would
// mean the upload silently vanished on save there. Only the quotation PDF
// prints it; downstream documents simply carry it.
for (const table of ['quotation_items', 'order_items', 'pi_items', 'invoice_items']) {
  addColumnIfMissing(table, 'image', "TEXT NOT NULL DEFAULT ''");
}

/* ------------------------------------------------------------------ */
/* Multiple companies in the group (2026-08)                           */
/* ------------------------------------------------------------------ */

/**
 * The old single `settings` row becomes company 1, once.
 *
 * Copied column by column from whatever `settings` actually has, rather than a
 * fixed list: the two tables were written years apart and `settings` on an old
 * database may be missing columns that later migrations added.
 */
const companyCount = db.prepare('SELECT COUNT(*) AS c FROM companies').get() as { c: number };
if (companyCount.c === 0) {
  const old = db.prepare('SELECT * FROM settings WHERE id = 1').get() as Record<string, unknown> | undefined;
  const carried = (db.prepare('PRAGMA table_info(companies)').all() as { name: string }[])
    .map((c) => c.name)
    .filter((n) => !['id', 'created_at', 'is_default', 'active'].includes(n))
    .filter((n) => old && n in old);
  if (carried.length) {
    db.prepare(
      `INSERT INTO companies (id, is_default, active, ${carried.join(', ')})
       VALUES (1, 1, 1, ${carried.map(() => '?').join(', ')})`
    ).run(...carried.map((n) => old![n] as never));
    console.warn(`companies: seeded company 1 from the old settings row (${carried.length} fields).`);
  } else {
    db.prepare('INSERT INTO companies (id, is_default, active) VALUES (1, 1, 1)').run();
  }
}
// Exactly one company has to be the fallback, or documents have nowhere to land.
const defaults = db.prepare('SELECT COUNT(*) AS c FROM companies WHERE is_default = 1').get() as { c: number };
if (defaults.c === 0) {
  db.prepare('UPDATE companies SET is_default = 1 WHERE id = (SELECT MIN(id) FROM companies)').run();
}

/**
 * Every document records the company that issued it. DEFAULT 1 is the backfill:
 * there has only ever been one company, so every existing row belongs to it.
 *
 * No REFERENCES clause here, unlike schema.sql — SQLite refuses to add a column
 * with a foreign key unless its default is NULL, and a nullable company on a
 * document would be worse than a missing constraint. Fresh installs get the
 * real foreign key; migrated ones rely on the routes.
 */
for (const table of ['quotations', 'orders', 'proforma_invoices', 'commercial_invoices', 'packing_lists']) {
  addColumnIfMissing(table, 'company_id', 'INTEGER NOT NULL DEFAULT 1');
}
addColumnIfMissing('customers', 'company_id', 'INTEGER');

/**
 * `sequences` was keyed (doc_type, year); it has to become
 * (company_id, doc_type, year), and SQLite cannot alter a primary key in place.
 *
 * This is the one migration that could corrupt live numbering: lose these rows
 * and every series restarts at 001, colliding with documents already issued. So
 * the rebuild happens in one transaction and refuses to drop the old table
 * unless every row arrived in the new one.
 */
const seqCols = db.prepare('PRAGMA table_info(sequences)').all() as { name: string }[];
if (!seqCols.some((c) => c.name === 'company_id')) {
  transaction(() => {
    const before = (db.prepare('SELECT COUNT(*) AS c FROM sequences').get() as { c: number }).c;
    db.exec(`CREATE TABLE sequences_new (
      company_id INTEGER NOT NULL DEFAULT 1,
      doc_type TEXT NOT NULL,
      year INTEGER NOT NULL,
      next_num INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (company_id, doc_type, year)
    )`);
    db.exec(
      'INSERT INTO sequences_new (company_id, doc_type, year, next_num) SELECT 1, doc_type, year, next_num FROM sequences'
    );
    const after = (db.prepare('SELECT COUNT(*) AS c FROM sequences_new').get() as { c: number }).c;
    if (after !== before) {
      throw new Error(`sequences rebuild copied ${after} of ${before} rows — refusing to drop the original`);
    }
    db.exec('DROP TABLE sequences');
    db.exec('ALTER TABLE sequences_new RENAME TO sequences');
    console.warn(`sequences: rebuilt per company; ${after} existing counter(s) assigned to company 1.`);
  });
}

/**
 * One-off: give an additional company that was never configured its own
 * numbering patterns.
 *
 * The counters have been per company since multi-company landed, and each
 * entity has always started at 001. What did not follow was the pattern: a
 * company added through `POST /api/companies` took the `companies` table's
 * column defaults, which are *Aglo's* paperwork, so the second entity's first
 * proforma printed `AGLO/PI/26-27/001` — the same string as the first
 * entity's, with another company's name in it. Nothing rejected it, and
 * nothing could: uniqueness is deliberately per company so that both may hold
 * a 001. The restart worked and was invisible.
 *
 * The route derives patterns from now on; this is for the companies already on
 * file. Two conditions, both strict, because a pattern that has issued a number
 * must never be rewritten — that number may already be on paper with a
 * customer:
 *
 *   - every pattern column is still *exactly* the schema default, so a company
 *     somebody deliberately configured is left alone (including one deliberately
 *     configured to match, which is then their choice, not this code's);
 *   - the company has no row in `sequences` at all, so no number has ever been
 *     drawn from any of its series, in any fiscal year.
 *
 * Idempotent by construction: after the rewrite the patterns are no longer the
 * defaults, so a second boot skips the row. The default company is never
 * touched — its patterns are Aglo's and are meant to be.
 */
{
  const extras = db.prepare('SELECT * FROM companies WHERE is_default = 0').all() as Record<string, unknown>[];
  for (const co of extras) {
    const untouched = PATTERN_COLUMNS.every((c) => String(co[c] ?? '') === SCHEMA_DEFAULT_PATTERNS[c]);
    if (!untouched) continue;
    const issued = db.prepare('SELECT COUNT(*) AS c FROM sequences WHERE company_id = ?').get(Number(co.id)) as { c: number };
    if (issued.c > 0) continue;
    const next = defaultPatternsFor(String(co.company_name ?? ''));
    db.prepare(
      `UPDATE companies SET ${PATTERN_COLUMNS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`
    ).run(...PATTERN_COLUMNS.map((c) => next[c]), Number(co.id));
    console.warn(
      `companies: ${String(co.company_name ?? co.id)} was still numbering from the defaults and has issued nothing — ` +
      `its series now read ${next.pi_pattern} and ${next.inv_pattern}.`
    );
  }
}

/**
 * The factory side needs one location to exist before anything physical can be
 * recorded against it, and a machine or a stock figure with no plant is not
 * worth having. Rather than invent a plant name, the first one is named after
 * the default company; renaming it is a one-field edit.
 *
 * "Self" is seeded as a transporter because it is nearly half of the real
 * despatches — an own-vehicle delivery is still a delivery.
 */
const locationCount = db.prepare('SELECT COUNT(*) AS c FROM locations').get() as { c: number };
if (locationCount.c === 0) {
  const co = db.prepare('SELECT company_name, address, city FROM companies WHERE is_default = 1').get() as
    { company_name?: string; address?: string; city?: string } | undefined;
  db.prepare('INSERT INTO locations (name, address) VALUES (?, ?)').run(
    co?.company_name?.trim() || 'Main Plant',
    [co?.address, co?.city].filter(Boolean).join(', ')
  );
}
const transporterCount = db.prepare('SELECT COUNT(*) AS c FROM transporters').get() as { c: number };
if (transporterCount.c === 0) {
  db.prepare("INSERT INTO transporters (name, notes) VALUES ('Self', 'Own vehicle')").run();
}

/**
 * A document number is an identity, not a label — it goes on paperwork the
 * customer and the tax authority both keep. Enforce that in the database, so a
 * manual override cannot quietly reuse one. Quotations key on (number,
 * revision) because revisions deliberately share a number; everything else is
 * unique on the number alone.
 *
 * Done here rather than in schema.sql because that file runs first on every
 * boot: a database that already contains duplicates has to be cleaned before
 * the index can exist, or the server would refuse to start.
 */
function enforceUniqueNumbers(table: string, indexName: string, columns: string[]) {
  const cols = columns.join(', ');
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${indexName} ON ${table}(${cols})`);
    return;
  } catch {
    // Duplicates exist. Suffix the later rows so the earliest keeps the number.
    const dupes = db.prepare(
      `SELECT id FROM ${table} WHERE id NOT IN (SELECT MIN(id) FROM ${table} GROUP BY ${cols})`
    ).all() as { id: number }[];
    for (const d of dupes) {
      db.prepare(`UPDATE ${table} SET number = number || '-DUP' || id WHERE id = ?`).run(d.id);
    }
    console.warn(`${table}: renamed ${dupes.length} duplicate document number(s) so they could be made unique.`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${indexName} ON ${table}(${cols})`);
  }
}
// Uniqueness is per company now. Each entity counts its own series from 001,
// so two companies reaching the same number is legitimate — a global unique
// index would reject the second one. Within one company it is still an error.
// The old global indexes are dropped by name so the new ones can be built.
for (const old of [
  'idx_quotations_number', 'idx_orders_number', 'idx_proformas_number',
  'idx_invoices_number', 'idx_packing_lists_number',
]) {
  db.exec(`DROP INDEX IF EXISTS ${old}`);
}
enforceUniqueNumbers('quotations', 'idx_quotations_company_number', ['company_id', 'number', 'revision']);
enforceUniqueNumbers('orders', 'idx_orders_company_number', ['company_id', 'number']);
enforceUniqueNumbers('proforma_invoices', 'idx_proformas_company_number', ['company_id', 'number']);
enforceUniqueNumbers('commercial_invoices', 'idx_invoices_company_number', ['company_id', 'number']);
enforceUniqueNumbers('packing_lists', 'idx_packing_lists_company_number', ['company_id', 'number']);
enforceUniqueNumbers('work_orders', 'idx_work_orders_company_number', ['company_id', 'number']);
enforceUniqueNumbers('purchase_orders', 'idx_purchase_orders_company_number', ['company_id', 'number']);

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

/**
 * The proforma and invoice series match Aglo's own paperwork (2026-08).
 *
 * Read off the real documents rather than invented. Proformas:
 * `AGLO/EX/25-26/118A` export, `AGLO/PI/25-26/094` domestic. Invoices:
 * `AP/EX/101/25-26` export — note the sequence sits *before* the fiscal year,
 * the other way round from the proforma — and `AP/0196/26-27` domestic, which
 * runs to four digits, hence `{SEQ4}`. The domestic figures come from the
 * `Invoice No.` column of the desk's own workbook, where 35 entries divide
 * between `AP/####` shorthand and the full `AP/####/##-##`.
 *
 * Only rows still holding the *old default* are moved: a pattern anyone has
 * edited is a deliberate choice, and a migration that overwrites settings
 * someone chose is worse than one that leaves a few rows behind. Existing
 * document numbers are never touched — they are what went to the customer and
 * to the tax authority. Only the next number issued changes.
 */
for (const [column, oldDefault, aglo] of [
  ['pi_pattern', 'PI/{FY}/{SEQ}', 'AGLO/PI/{FY}/{SEQ}'],
  ['pi_export_pattern', 'EX-PI/{FY}/{SEQ}', 'AGLO/EX/{FY}/{SEQ}'],
  ['inv_pattern', 'INV/{FY}/{SEQ}', 'AP/{SEQ4}/{FY}'],
  ['inv_export_pattern', 'EX/{FY}/{SEQ}', 'AP/EX/{SEQ}/{FY}'],
] as const) {
  const moved = db.prepare(`UPDATE companies SET ${column} = ? WHERE ${column} = ?`).run(aglo, oldDefault);
  if (Number(moved.changes) > 0) {
    console.warn(`companies: ${column} moved to the Aglo series on ${moved.changes} row(s); documents already numbered keep their numbers.`);
  }
}

/**
 * Proformas booked before booking set `in_production` (2026-09).
 *
 * `syncProformaOrdered` used to set `order_confirmed`, which said the wrong
 * thing — Order Confirmed is the buyer telling us to go ahead, and it comes
 * *before* the advance. So a proforma with an order against it reads the same
 * as one with nothing booked at all, which is exactly the row whose status
 * picker is now frozen: the lock had no visible cause, because the status that
 * would have explained it was never set.
 *
 * The guard is `syncProformaOrdered`'s own, copied rather than imported —
 * `documentChain.ts` imports `db` from this file. Keep the two in step. It is
 * forward-only and never touches `cancelled`, and it fills
 * `status_before_ordered` as the live path does, so deleting the order still
 * puts the proforma back where booking found it. Idempotent: `in_production`
 * is not in the guard, so a second boot moves nothing.
 */
const booked = db.prepare(
  `UPDATE proforma_invoices
      SET status_before_ordered = status, status = 'in_production'
    WHERE order_id IS NOT NULL
      AND status IN ('draft', 'sent', 'order_confirmed', 'advance_received')`
).run();
if (Number(booked.changes) > 0) {
  console.warn(`proforma_invoices: ${booked.changes} row(s) with an order booked moved to Sales Order Generated.`);
}

// Starter note presets so the feature is useful immediately.
const presetRow = db.prepare('SELECT id, note_presets FROM companies WHERE is_default = 1 ORDER BY id LIMIT 1').get() as
  { id: number; note_presets: string } | undefined;
if (presetRow && (!presetRow.note_presets || presetRow.note_presets === '[]')) {
  db.prepare('UPDATE companies SET note_presets = ? WHERE id = ?').run(JSON.stringify([
    { label: 'Freight & insurance clause', body: 'Price is subject to change in freight & insurance billed at actual at the time of booking and dispatch.' },
    { label: 'Quantity tolerance', body: 'Quantity Tolerance: (±) 10% in value and quantity. Packing details are subject to change.' },
    { label: 'Production plan', body: 'Production and transit plan to be finalized at the time of order placement.' },
    { label: 'Force majeure', body: "Quotation is subject to force majeure clause and subject to changes in case of any unforeseen situation which is beyond supplier's control." },
    { label: 'Jurisdiction', body: 'All disputes subject to Kolkata jurisdiction.' },
    { label: 'Billing basis', body: 'Product will be billed in tonnage as per standard weight of each product; tolerance weight is acceptable to buyer as mentioned in each product description.' },
  ]), presetRow.id);
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

/**
 * True when an error is the unique-number index rejecting a manual override.
 * Routes turn this into a 409 the user can act on, rather than a 500.
 */
export function isDuplicateNumberError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(message) && /\.number\b/i.test(message);
}
