import { db } from '../db/connection.js';

type DocType = 'quotation' | 'proforma' | 'invoice' | 'packing_list';

const prefixColumn: Record<DocType, string> = {
  quotation: 'quote_prefix',
  proforma: 'pi_prefix',
  invoice: 'inv_prefix',
  packing_list: 'pl_prefix',
};

/** Returns the next document number like QT-2026-0001 and advances the sequence. */
export function nextNumber(docType: DocType): string {
  const year = new Date().getFullYear();
  db.prepare(
    'INSERT INTO sequences (doc_type, year, next_num) VALUES (?, ?, 1) ON CONFLICT(doc_type, year) DO NOTHING'
  ).run(docType, year);
  const row = db
    .prepare('SELECT next_num FROM sequences WHERE doc_type = ? AND year = ?')
    .get(docType, year) as { next_num: number };
  db.prepare('UPDATE sequences SET next_num = next_num + 1 WHERE doc_type = ? AND year = ?').run(docType, year);
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as Record<string, string>;
  const prefix = settings[prefixColumn[docType]] || docType.toUpperCase();
  return `${prefix}-${year}-${String(row.next_num).padStart(4, '0')}`;
}
