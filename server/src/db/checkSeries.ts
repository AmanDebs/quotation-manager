/**
 * Read-only audit: documents whose number disagrees with their export flag.
 *
 * `npm run check-series` in `server/`, where the database is.
 *
 * The number is drawn from the export or the domestic series at creation and
 * is never reissued, so the flag that chose the series must not move
 * afterwards. `exportChangeError` now refuses that, but the forms allowed it
 * silently before, and anything already saved that way is still saved that
 * way. This finds those rows.
 *
 * **It never writes.** The database is opened read-only, and there is no
 * `--fix`: the right correction depends on which of the two is right — the
 * number may already be on paper with a customer, in which case the flag is
 * what is wrong, and sometimes it is the other way round. That is a judgement,
 * not a migration.
 *
 * Only orders, proformas and invoices can be wrong, being the three doc types
 * with a separate export series. A quotation has one series either way.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const dbPath = path.join(DATA_DIR, 'app.db');

const db = new DatabaseSync(dbPath, { readOnly: true });

interface Spec {
  label: string;
  table: string;
  std: string;
  exp: string;
}

const SPECS: Spec[] = [
  { label: 'Order', table: 'orders', std: 'order_pattern', exp: 'order_export_pattern' },
  { label: 'Proforma', table: 'proforma_invoices', std: 'pi_pattern', exp: 'pi_export_pattern' },
  { label: 'Invoice', table: 'commercial_invoices', std: 'inv_pattern', exp: 'inv_export_pattern' },
];

/**
 * A numbering pattern as a regex.
 *
 * `{SEQ4}` is substituted before `{SEQ}`, exactly as `applyPattern` does, or
 * the longer token would leave a stray "4". The padding widths are minimums —
 * a series past 999 prints in full — so the digit runs are open-ended.
 */
function patternRegex(pattern: string, lenientTail: boolean): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = escaped
    .replace(/\\\{FY\\\}/g, '\\d{2}-\\d{2}')
    .replace(/\\\{SEQ4\\\}/g, '\\d{4,}')
    .replace(/\\\{SEQ\\\}/g, '\\d{3,}');
  // Real numbers carry the odd hand-added suffix — AGLO/EX/25-26/118A is a
  // real Aglo document — and the de-duplication migration appended -DUPn.
  // Those are still that series' number, so they must not read as a mismatch.
  return new RegExp(`^${body}${lenientTail ? '(?:[A-Za-z]|-DUP\\d+)?' : ''}$`);
}

const companies = new Map<number, Record<string, string>>();
function companyRow(id: number): Record<string, string> {
  let row = companies.get(id);
  if (!row) {
    row = (db.prepare('SELECT * FROM companies WHERE id = ?').get(id) as Record<string, string>) ?? {};
    companies.set(id, row);
  }
  return row;
}

const fallbackCompany = (() => {
  const row = db.prepare('SELECT id FROM companies ORDER BY id LIMIT 1').get() as { id: number } | undefined;
  return row?.id ?? 1;
})();

interface Finding {
  label: string;
  id: number;
  number: string;
  isExport: number;
  customer: string;
  date: string;
}

const mismatched: Finding[] = [];
const unrecognised: Finding[] = [];
let checked = 0;
let indistinguishable = 0;

for (const spec of SPECS) {
  const rows = db.prepare(
    `SELECT d.id, d.number, d.is_export, d.company_id, d.date, c.name AS customer
     FROM ${spec.table} d LEFT JOIN customers c ON c.id = d.customer_id
     ORDER BY d.id`
  ).all() as { id: number; number: string; is_export: number; company_id: number | null; date: string; customer: string | null }[];

  for (const row of rows) {
    checked++;
    const company = companyRow(row.company_id ?? fallbackCompany);
    const own = company[row.is_export ? spec.exp : spec.std];
    const other = company[row.is_export ? spec.std : spec.exp];
    if (!own || !other) continue;

    // Identical patterns cannot tell the two apart, and that is not a fault.
    if (own === other) { indistinguishable++; continue; }

    const number = String(row.number ?? '');
    const finding: Finding = {
      label: spec.label, id: row.id, number,
      isExport: row.is_export, customer: row.customer ?? '(none)', date: row.date,
    };

    const matchesOwn = patternRegex(own, false).test(number) || patternRegex(own, true).test(number);
    if (matchesOwn) continue;

    const matchesOther = patternRegex(other, false).test(number) || patternRegex(other, true).test(number);
    if (matchesOther) mismatched.push(finding);
    else unrecognised.push(finding);
  }
}

const kind = (isExport: number) => (isExport ? 'export' : 'domestic');

console.log(`Reading ${dbPath} (read-only)\n`);
console.log(`Checked ${checked} order, proforma and invoice numbers.\n`);

if (mismatched.length === 0) {
  console.log('No mismatches: every number matches the series its export flag says it came from.');
} else {
  console.log(`${mismatched.length} document(s) whose number came from the OTHER series:\n`);
  for (const f of mismatched) {
    console.log(`  ${f.label} #${f.id}  ${f.number}`);
    console.log(`     marked ${kind(f.isExport)}, but that number follows the ${kind(f.isExport ? 0 : 1)} pattern`);
    console.log(`     ${f.customer}, dated ${f.date}`);
  }
  console.log('\n  Either the flag is wrong or the number is. The number is the half a');
  console.log('  customer may already hold, so check the paperwork before changing');
  console.log('  anything — the Number field on the form is editable by hand.');
}

if (unrecognised.length > 0) {
  console.log(`\n${unrecognised.length} number(s) match neither pattern — set by hand, or from a pattern`);
  console.log('since changed. Not a fault, listed only so the count above is honest:');
  for (const f of unrecognised.slice(0, 20)) {
    console.log(`  ${f.label} #${f.id}  ${f.number}  (${kind(f.isExport)})`);
  }
  if (unrecognised.length > 20) console.log(`  … and ${unrecognised.length - 20} more`);
}

if (indistinguishable > 0) {
  console.log(`\n${indistinguishable} document(s) skipped: their company's export and domestic`);
  console.log('patterns are identical, so the two cannot be told apart from the number.');
}

db.close();
