import { db } from '../db/connection.js';
import { fmtDate } from './format.js';
import { canAccessCustomer } from '../middleware/scope.js';
import type { AuthedRequest } from '../middleware/auth.js';

export type DocType =
  | 'quotation' | 'order' | 'proforma' | 'invoice' | 'packing_list'
  | 'work_order' | 'purchase_order' | 'challan' | 'batch' | 'coa' | 'credit_note';

/** Indian fiscal year (April–March) as "25-26". */
export function fiscalYear(date = new Date()): string {
  const y = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return `${String(y).slice(2)}-${String(y + 1).slice(2)}`;
}

function fiscalYearStart(date = new Date()): number {
  return date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
}

/**
 * The fiscal year a **document** belongs to, from its own date.
 *
 * A number is a claim about when the document was issued, and an invoice dated
 * 30 March belongs to the year ending that day whoever happens to be raising it
 * in April. Taking the year from `new Date()` put a 26-27 number on it and drew
 * from the 26-27 counter — a gap in one series and a stray in the other, on the
 * consecutive-per-GSTIN numbering a GST return is checked against.
 *
 * The date arrives as a 'YYYY-MM-DD' string and is parsed as digits rather than
 * handed to `new Date()`: that constructor reads a bare date as UTC midnight
 * and then answers `getMonth()` in local time, so a document dated the 1st of
 * April would fall into the previous year on any server running behind UTC.
 * Production runs in UTC today, which is exactly the kind of thing that stays
 * true until it doesn't.
 *
 * Anything unparseable falls back to today — a document with no usable date
 * still has to be numbered.
 */
export function fiscalYearOf(date?: string | null): { start: number; label: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? '').trim());
  if (!m) return { start: fiscalYearStart(), label: fiscalYear() };
  const year = Number(m[1]);
  const month = Number(m[2]); // 1–12
  if (month < 1 || month > 12) return { start: fiscalYearStart(), label: fiscalYear() };
  const start = month >= 4 ? year : year - 1;
  return { start, label: `${String(start).slice(2)}-${String(start + 1).slice(2)}` };
}

/** The first and last day of the fiscal year a date falls in — Apr–Mar, like every counter here. */
export function fiscalYearRange(date?: string | null): { from: string; to: string } {
  const { start } = fiscalYearOf(date);
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

/**
 * Which pattern each document type numbers from, and — where it has a second
 * series — the column that says so and the word for it.
 *
 * The second series is *export* on the three selling documents and **import**
 * on the purchase order, because on a purchase the foreign party is the seller.
 * The flag and the wording are carried here rather than assumed, or a purchase
 * order would be refused with a sentence about the export series it has never
 * had, and `exportChangeError` would read an `is_export` column that does not
 * exist on that table.
 */
const patternColumn: Record<DocType, { std: string; export?: string; flag?: string; altWord?: string }> = {
  quotation: { std: 'quote_pattern' },
  order: { std: 'order_pattern', export: 'order_export_pattern', flag: 'is_export', altWord: 'export' },
  proforma: { std: 'pi_pattern', export: 'pi_export_pattern', flag: 'is_export', altWord: 'export' },
  invoice: { std: 'inv_pattern', export: 'inv_export_pattern', flag: 'is_export', altWord: 'export' },
  packing_list: { std: 'pl_pattern' },
  // Internal, so no export/domestic split — the floor does not care who the
  // buyer is, and a second series would only make the numbers harder to trace.
  work_order: { std: 'wo_pattern' },
  purchase_order: { std: 'po_pattern', export: 'po_import_pattern', flag: 'is_import', altWord: 'import' },
  // The delivery challan travelling with a lorry. One series whatever the
  // destination: a challan is issued for a *movement*, and an export
  // consignment leaving the plant for the port is the same kind of movement
  // as one leaving for Hazipur.
  challan: { std: 'challan_pattern' },
  // The lot itself and the certificate that clears it. Two series rather
  // than one because two different people quote them to two different
  // audiences: a batch id goes on the box and into the shift log, a COA
  // number goes to the buyer. Neither splits export from domestic — a lot
  // is made before anybody knows which container it leaves in.
  batch: { std: 'batch_pattern' },
  coa: { std: 'coa_pattern' },
  // The credit note takes the invoice's export/domestic split, because it is
  // a tax document that credits one: a credit against `AP/EX/101/25-26` drawn
  // from the domestic series would put a gap in one book and a stray in the
  // other, on numbering a GST return is checked against.
  credit_note: { std: 'cn_pattern', export: 'cn_export_pattern', flag: 'is_export', altWord: 'export' },
};

/**
 * Next document number from the issuing company's pattern, e.g.
 * AGLO/EX/{FY}/{SEQ} → AGLO/EX/25-26/119.
 *
 * Sequences advance per company, per doc type (export series separate), per
 * fiscal year. Per company because a GST-registered entity keeps one
 * consecutive series per GSTIN — sharing a series across the group would leave
 * gaps in each company's books.
 *
 * Tokens:
 *   {FY}    fiscal year, "25-26"
 *   {SEQ}   sequence padded to 3 digits — AGLO/EX/25-26/118
 *   {SEQ4}  the same number padded to 4 — AP/0196/26-27
 *
 * Two widths because Aglo's own books use both: the export invoice runs
 * `AP/EX/101/25-26` while the domestic one runs `AP/0196/26-27`. Padding is
 * a minimum, not a limit — a series that passes 999 simply prints in full.
 */
export function nextNumber(
  docType: DocType,
  opts: { isExport?: boolean; companyId: number; date?: string | null }
): string {
  const cols = patternColumn[docType];
  const useExport = !!opts.isExport && !!cols.export;
  const seqKey = useExport ? `${docType}_export` : docType;
  // Both the printed year and the counter come from the document's own date:
  // a back-dated invoice takes the next number in *that* year's series, not a
  // number borrowed from this one.
  const fy = fiscalYearOf(opts.date);

  // Claim the next number in a single statement. Read-then-update would hand
  // the same number to two people creating documents at the same moment; that
  // was only ever safe because SQLite serialises writes on one connection.
  const row = db.prepare(
    `INSERT INTO sequences (company_id, doc_type, year, next_num) VALUES (?, ?, ?, 1)
     ON CONFLICT(company_id, doc_type, year) DO UPDATE SET next_num = next_num + 1
     RETURNING next_num`
  ).get(opts.companyId, seqKey, fy.start) as { next_num: number };

  return applyPattern(patternFor(docType, opts.companyId, useExport), row.next_num, fy.label);
}

/** The stored pattern for one series, or a last-resort generic one. */
function patternFor(docType: DocType, companyId: number, useExport: boolean): string {
  const cols = patternColumn[docType];
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId) as Record<string, string> | undefined;
  return company?.[useExport ? cols.export! : cols.std] || `${docType.toUpperCase()}/{FY}/{SEQ}`;
}

/** Fill the tokens for a given sequence value, in a given fiscal year. */
function applyPattern(pattern: string, seq: number, fyLabel = fiscalYear()): string {
  return pattern
    .replaceAll('{FY}', fyLabel)
    // {SEQ4} first: replacing {SEQ} first would leave a stray "4" behind.
    .replaceAll('{SEQ4}', String(seq).padStart(4, '0'))
    .replaceAll('{SEQ}', String(seq).padStart(3, '0'));
}

/**
 * The series a document type counts on. Export documents count separately,
 * because a separate pattern with a shared counter would leave gaps in both.
 */
/**
 * Refuse a change to `is_export` on a document that already carries a number.
 *
 * The number is drawn at creation from the export or the domestic series and
 * is never reissued — that is deliberate, since a number may already be on
 * paper with a customer. So flipping the flag afterwards cannot move the
 * number with it, and the document ends up a domestic proforma numbered
 * `AGLO/EX/26-27/001`, charging GST, holding a number no export document will
 * ever use. The form used to allow exactly that, silently.
 *
 * Only the doc types with a **separate export series** are guarded. A
 * quotation has one series whatever it is, so its type stays editable — a
 * guard there would take away something safe.
 *
 * Same shape as `customerChangeError` in middleware/scope.ts, and there for
 * the same reason: the PUT routes wrote whatever the body carried.
 */
export function exportChangeError(
  docType: DocType,
  existing: Record<string, unknown>,
  bodyFlag: unknown
): string | null {
  if (bodyFlag === undefined || bodyFlag === null) return null;
  const cols = patternColumn[docType];
  if (!cols.export || !cols.flag) return null;
  const before = Number(existing[cols.flag]) ? 1 : 0;
  const after = Number(bodyFlag) ? 1 : 0;
  if (before === after) return null;
  const alt = cols.altWord ?? 'export';
  const was = before ? alt : 'domestic';
  return `This document was numbered ${String(existing.number ?? '')} from the ${was} series, so it cannot be switched to ${before ? 'domestic' : alt}. Raise a new document of the right type, or change the Number by hand if the series itself is wrong.`;
}

/**
 * The quotation's type is settled at creation too — for a different reason.
 *
 * `exportChangeError` above skips quotations because they draw one number
 * series whatever their type, so a flip could never leave the number
 * disagreeing; the picker was left on a saved quotation because taking away
 * something safe looked like a loss (2026-09-05). Two things changed since.
 * `NewDocumentDialog` asks the type first and then offers only that kind of
 * customer, so a flip leaves a Mauritius buyer on a domestic quotation
 * charging IGST — the one thing that dialog exists to prevent. And since
 * 2026-09-10 the proforma raised from a quotation takes its type from the
 * quotation, so a flipped one produces a proforma numbered from the wrong
 * series, which `exportChangeError` then rightly refuses to undo. The user
 * asked why the flip was allowed (2026-09-12); it no longer is.
 *
 * A quote of the other kind is a **Duplicate**, which raises a fresh number
 * and whose customer is editable — the shape a second offer already had.
 */
export function quotationTypeChangeError(existing: Record<string, unknown>, bodyFlag: unknown): string | null {
  if (bodyFlag === undefined || bodyFlag === null) return null;
  const before = Number(existing.is_export) ? 1 : 0;
  const after = Number(bodyFlag) ? 1 : 0;
  if (before === after) return null;
  return `${String(existing.number ?? 'This quotation')} was raised as ${before ? 'an export' : 'a domestic'} quotation for `
    + `${before ? 'an overseas' : 'an Indian'} buyer, so it cannot be switched to ${before ? 'domestic' : 'export'}. `
    + 'Use Duplicate to quote the other way, and pick the customer to match.';
}

export const seriesKey = (docType: DocType, isExport: boolean): string =>
  isExport && patternColumn[docType].export ? `${docType}_export` : docType;

export interface SeriesState {
  doc_type: DocType;
  is_export: boolean;
  /** The row key in `sequences`. */
  key: string;
  /** Fiscal year label the counter belongs to, e.g. "26-27". */
  fy: string;
  pattern: string;
  /** The number the *next* document will be given. */
  next_number: number;
  /** What that document's number will look like. */
  preview: string;
}

/** Every series a company counts on, and where each has got to. */
export function listSeries(companyId: number): SeriesState[] {
  const fyStart = fiscalYearStart();
  const out: SeriesState[] = [];
  for (const docType of Object.keys(patternColumn) as DocType[]) {
    for (const isExport of patternColumn[docType].export ? [false, true] : [false]) {
      const key = seriesKey(docType, isExport);
      const row = db.prepare(
        'SELECT next_num FROM sequences WHERE company_id = ? AND doc_type = ? AND year = ?'
      ).get(companyId, key, fyStart) as { next_num: number } | undefined;
      // `next_num` holds the number last *issued*; a missing row means none yet.
      const next = (row?.next_num ?? 0) + 1;
      const pattern = patternFor(docType, companyId, isExport);
      out.push({
        doc_type: docType, is_export: isExport, key, fy: fiscalYear(),
        pattern, next_number: next, preview: applyPattern(pattern, next),
      });
    }
  }
  return out;
}

/**
 * Set the number the next document in a series will get.
 *
 * The counter stores the number last issued, so "next is N" is stored as N-1.
 *
 * Moving a series **forward** is safe and is the normal reason to be here: the
 * app is taking over a book that already runs to AP/0262, and its counter has
 * to start above that rather than re-issuing numbers the customer already has.
 * Moving one **backward** is refused unless `force` is set, because the next
 * document would then take a number the unique index has already seen — the
 * failure would surface at save time, to whoever happened to be raising a
 * document, rather than here to the person who caused it.
 */
export function setNextNumber(
  companyId: number,
  key: string,
  next: number,
  opts: { force?: boolean } = {}
): { previous: number; next_number: number; preview: string } {
  if (!Number.isInteger(next) || next < 1) {
    throw Object.assign(new Error('The next number must be a whole number of 1 or more'), { status: 400 });
  }
  const fyStart = fiscalYearStart();
  const row = db.prepare(
    'SELECT next_num FROM sequences WHERE company_id = ? AND doc_type = ? AND year = ?'
  ).get(companyId, key, fyStart) as { next_num: number } | undefined;
  const previous = (row?.next_num ?? 0) + 1;

  if (next < previous && !opts.force) {
    throw Object.assign(
      new Error(`This series is already at ${previous}. Going back to ${next} would re-issue numbers that have been used.`),
      { status: 409 }
    );
  }

  db.prepare(
    `INSERT INTO sequences (company_id, doc_type, year, next_num) VALUES (?, ?, ?, ?)
     ON CONFLICT(company_id, doc_type, year) DO UPDATE SET next_num = excluded.next_num`
  ).run(companyId, key, fyStart, next - 1);

  // The pattern is looked up from the key's own doc type so the preview is the
  // real thing rather than a guess.
  const docType = (key.endsWith('_export') ? key.slice(0, -'_export'.length) : key) as DocType;
  const pattern = patternFor(docType, companyId, key.endsWith('_export'));
  return { previous, next_number: next, preview: applyPattern(pattern, next) };
}

/* ------------------------------------------------------------------ */
/* A number already on another document                                */
/* ------------------------------------------------------------------ */

/**
 * The documents whose number somebody can type, and the word each is called
 * by on screen. Quotations are deliberately absent: their index keys on
 * `(company_id, number, revision)` because revisions share a number on
 * purpose, and nothing offers a box for it.
 */
const NUMBERED: Record<string, string> = {
  proforma_invoices: 'proforma invoice',
  commercial_invoices: 'commercial invoice',
  packing_lists: 'packing list',
};

export type NumberedTable = keyof typeof NUMBERED;

/**
 * Which document already holds this number, said so it can be found
 * (2026-11-10, the client with a proforma they could not save: *"I am
 * receiving this error in proforma invoice"*).
 *
 * The per-company unique index has refused a repeated number since it was
 * built, and the central handler turned that into *"That document number is
 * already in use. Choose a different one."* — which is true and **unusable**:
 * on a book of several hundred proformas it names nothing to look for, and
 * the list is scoped, so the document holding the number may not even be on
 * the reader's own screen. A refusal that cannot be acted on is the defect
 * this codebase records about a prompt naming the wrong thing, one step on.
 *
 * So this is the guard of the shape the rest of them take — `lockError`,
 * `renameError`, `foreignBankError` — a function returning the sentence to
 * refuse with, which is what lets the route answer *before* writing and lets
 * the sentence name the number, the document and the date.
 *
 * **The customer is named only where the caller may read it.** The clash is
 * decided per company and the lists are scoped per owner, so the document in
 * the way is quite often somebody else's — telling a Sales login merely that
 * "another proforma has it" would leave them hunting a row they cannot see,
 * and printing the customer would hand them a name their own book does not
 * carry. It says which of the two it is instead.
 */
export function numberInUseError(
  req: AuthedRequest,
  table: NumberedTable,
  companyId: number,
  number: string,
  exceptId?: number,
): string | null {
  const wanted = String(number ?? '').trim();
  if (!wanted) return null;
  const noun = NUMBERED[table];
  if (!noun) return null;
  const row = db.prepare(
    `SELECT id, date, customer_id FROM ${table}
      WHERE company_id = ? AND number = ? AND id <> ? LIMIT 1`
  ).get(companyId, wanted, exceptId ?? 0) as
    { id: number; date: string; customer_id: number } | undefined;
  if (!row) return null;
  const dated = row.date ? ` dated ${fmtDate(String(row.date))}` : '';
  if (!canAccessCustomer(req, Number(row.customer_id))) {
    return `${wanted} is already on another ${noun}${dated}, which is not in your book. Give this one a different number.`;
  }
  const customer = db.prepare('SELECT name FROM customers WHERE id = ?').get(Number(row.customer_id)) as
    { name?: string } | undefined;
  const whose = customer?.name ? ` for ${customer.name}` : '';
  return `${wanted} is already on another ${noun}${dated}${whose}. Give this one a different number.`;
}

/**
 * The same refusal for the paths no guard can reach first.
 *
 * `numberInUseError` above answers *before* a write, which needs the number
 * and the company in hand — true of every box somebody types into, and not
 * of a **create**, where the number is drawn from the series inside the
 * transaction that writes it. That path can still collide: the counter knows
 * nothing about a number typed onto a document by hand, so a series catching
 * up with one is a real and baffling refusal.
 *
 * So the index stays the backstop and this is what it says. It reads the
 * table out of SQLite's own message rather than being told, which is what
 * lets it cover every numbered document including the ones with no box; and
 * it drops *"choose a different one"*, which on a create is advice about a
 * control that is not on the page.
 */
export function duplicateNumberMessage(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  if (!/UNIQUE constraint failed/i.test(message) || !/\.number\b/i.test(message)) return null;
  const table = /([a-z_]+)\.number\b/i.exec(message)?.[1] ?? '';
  const noun = NUMBERED[table] ?? DOCUMENT_NOUNS[table] ?? 'document';
  return `That number is already on another ${noun} of this company. Give this one a different number, or correct the one that holds it.`;
}

/** The numbered documents with no editable box, for the sentence above. */
const DOCUMENT_NOUNS: Record<string, string> = {
  quotations: 'quotation',
  orders: 'sales order',
  work_orders: 'work order',
  purchase_orders: 'purchase order',
};
