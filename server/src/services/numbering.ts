import { db } from '../db/connection.js';

export type DocType =
  | 'quotation' | 'order' | 'proforma' | 'invoice' | 'packing_list'
  | 'work_order' | 'purchase_order';

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
