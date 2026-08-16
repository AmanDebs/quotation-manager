import { db } from '../db/connection.js';

type DocType = 'quotation' | 'order' | 'proforma' | 'invoice' | 'packing_list' | 'work_order';

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
  // Internal, so no export/domestic split — the floor does not care who the
  // buyer is, and a second series would only make the numbers harder to trace.
  work_order: { std: 'wo_pattern' },
};

/**
 * Next document number from the issuing company's pattern, e.g.
 * AGLO/EX/{FY}/{SEQ} → AGLO/EX/25-26/119.
 *
 * Sequences advance per company, per doc type (export series separate), per
 * fiscal year. Per company because a GST-registered entity keeps one
 * consecutive series per GSTIN — sharing a series across the group would leave
 * gaps in each company's books. Tokens: {FY} fiscal year "25-26", {SEQ}
 * 3-digit sequence.
 */
export function nextNumber(
  docType: DocType,
  opts: { isExport?: boolean; companyId: number }
): string {
  const cols = patternColumn[docType];
  const useExport = !!opts.isExport && !!cols.export;
  const seqKey = useExport ? `${docType}_export` : docType;
  const fyStart = fiscalYearStart();

  // Claim the next number in a single statement. Read-then-update would hand
  // the same number to two people creating documents at the same moment; that
  // was only ever safe because SQLite serialises writes on one connection.
  const row = db.prepare(
    `INSERT INTO sequences (company_id, doc_type, year, next_num) VALUES (?, ?, ?, 1)
     ON CONFLICT(company_id, doc_type, year) DO UPDATE SET next_num = next_num + 1
     RETURNING next_num`
  ).get(opts.companyId, seqKey, fyStart) as { next_num: number };

  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(opts.companyId) as Record<string, string> | undefined;
  const pattern = company?.[useExport ? cols.export! : cols.std] || `${docType.toUpperCase()}/{FY}/{SEQ}`;
  return pattern
    .replaceAll('{FY}', fiscalYear())
    .replaceAll('{SEQ}', String(row.next_num).padStart(3, '0'));
}
