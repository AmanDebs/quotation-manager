import { db } from '../db/connection.js';

type DocType = 'quotation' | 'order' | 'proforma' | 'invoice' | 'packing_list';

/** Indian fiscal year (April–March) as "25-26". */
export function fiscalYear(date = new Date()): string {
  const y = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return `${String(y).slice(2)}-${String(y + 1).slice(2)}`;
}

function fiscalYearStart(date = new Date()): number {
  return date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
}

const patternColumn: Record<DocType, { std: string; export?: string }> = {
  quotation: { std: 'quote_pattern' },
  order: { std: 'order_pattern', export: 'order_export_pattern' },
  proforma: { std: 'pi_pattern', export: 'pi_export_pattern' },
  invoice: { std: 'inv_pattern', export: 'inv_export_pattern' },
  packing_list: { std: 'pl_pattern' },
};

/**
 * Next document number from the configurable pattern, e.g. AGLO/EX/{FY}/{SEQ}
 * → AGLO/EX/25-26/119. Sequences advance per doc type (export series separate),
 * per fiscal year. Tokens: {FY} fiscal year "25-26", {SEQ} 3-digit sequence.
 */
export function nextNumber(docType: DocType, opts: { isExport?: boolean } = {}): string {
  const cols = patternColumn[docType];
  const useExport = !!opts.isExport && !!cols.export;
  const seqKey = useExport ? `${docType}_export` : docType;
  const fyStart = fiscalYearStart();

  // Claim the next number in a single statement. Read-then-update would hand
  // the same number to two people creating documents at the same moment; that
  // was only ever safe because SQLite serialises writes on one connection.
  const row = db.prepare(
    `INSERT INTO sequences (doc_type, year, next_num) VALUES (?, ?, 1)
     ON CONFLICT(doc_type, year) DO UPDATE SET next_num = next_num + 1
     RETURNING next_num`
  ).get(seqKey, fyStart) as { next_num: number };

  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as Record<string, string>;
  const pattern = settings[useExport ? cols.export! : cols.std] || `${docType.toUpperCase()}/{FY}/{SEQ}`;
  return pattern
    .replaceAll('{FY}', fiscalYear())
    .replaceAll('{SEQ}', String(row.next_num).padStart(3, '0'));
}
