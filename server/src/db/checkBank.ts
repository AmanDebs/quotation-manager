/**
 * Read-only audit: documents printing another entity's bank account.
 *
 * `npm run check-bank` in `server/`, where the database is.
 *
 * The bank picker on the proforma and invoice forms read `/api/settings`,
 * which is the view of the **default** company — so on a second entity's
 * document it offered the first entity's accounts (2026-09-25, the client:
 * *"this is picking AGLO polymers bank details in Aglo Packaging PI / CI"*).
 * The page then printed that account under `BENEFICIARY NAME: <the issuing
 * company>`, which is the one shape of wrong that looks right: nothing on it
 * contradicts itself, and the money is asked for into the wrong entity.
 *
 * The picker now offers the issuing company's own list and `foreignBankError`
 * refuses the rest, but **anything saved before that is still saved that way**,
 * and a proforma is a document a buyer has already been sent. This finds them.
 *
 * **It never writes,** the rule `checkSeries.ts` states: the database is
 * opened read-only and there is no `--fix`. Correcting one is a decision with
 * a customer on the other end — the account has to be changed *and* the
 * document re-sent, or a payment chased into the wrong account — which is not
 * something a migration should do quietly.
 *
 * It reports only what it can **positively place**: an exact match on another
 * company's account. A value matching nothing on file is left out, since the
 * details are stored on the document rather than referenced, so one edited in
 * Settings afterwards matches no company at all — including its own.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'), { readOnly: true });

interface CompanyRow { id: number; company_name: string; bank_accounts: string }
interface DocRow { id: number; number: string; date: string; company_id: number; bank_account: string }

/** Whitespace is not a different account — the details are a typed block. */
const norm = (s: string) => String(s ?? '').trim().replace(/\s+/g, ' ');

const companies = db.prepare('SELECT id, company_name, bank_accounts FROM companies').all() as unknown as CompanyRow[];

/** Every account on file, by its normalised text, to the company that holds it. */
const owner = new Map<string, CompanyRow>();
for (const c of companies) {
  for (const b of JSON.parse(String(c.bank_accounts || '[]')) as { details?: string }[]) {
    const key = norm(String(b.details ?? ''));
    if (key && !owner.has(key)) owner.set(key, c);
  }
}
const nameOf = (id: number) => companies.find((c) => Number(c.id) === Number(id))?.company_name ?? `company ${id}`;

const TABLES: { label: string; table: string }[] = [
  { label: 'Proforma', table: 'proforma_invoices' },
  { label: 'Invoice', table: 'commercial_invoices' },
];

let found = 0;
let checked = 0;

for (const { label, table } of TABLES) {
  const rows = db.prepare(
    `SELECT id, number, date, company_id, bank_account FROM ${table}
      WHERE COALESCE(bank_account, '') <> '' ORDER BY date, id`
  ).all() as unknown as DocRow[];
  checked += rows.length;

  const bad = rows.filter((r) => {
    const holder = owner.get(norm(r.bank_account));
    return !!holder && Number(holder.id) !== Number(r.company_id);
  });
  if (!bad.length) continue;

  console.log(`\n${label}s printing another entity's account — ${bad.length}:`);
  for (const r of bad) {
    const holder = owner.get(norm(r.bank_account))!;
    console.log(
      `  ${r.number}  ${r.date}  issued by ${nameOf(r.company_id)}`
      + `  →  account belongs to ${holder.company_name}`
    );
  }
  found += bad.length;
}

console.log(
  found
    ? `\n${found} document${found === 1 ? '' : 's'} to correct, of ${checked} stating an account.`
      + '\nOpen each one, pick an account on the issuing company, and re-send it if it has gone out.'
    : `\nNothing to correct: all ${checked} document${checked === 1 ? '' : 's'} stating an account`
      + ' either name their own company’s or name one no company holds.'
);

db.close();
