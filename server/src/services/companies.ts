import { db } from '../db/connection.js';

/**
 * The group's selling entities.
 *
 * One rule lives here and nowhere else: **which company issues a document**.
 * It is asked at creation and then frozen on the row, because the document
 * number is drawn from that company's series and the PDF is rendered from its
 * letterhead — reprinting a 2026 invoice in 2028 has to show the entity and
 * GSTIN it actually went out under, not whichever company is selected then.
 */

export type Company = Record<string, any>;

/** JSON columns are stored as text; parse them at this boundary, once. */
function hydrate(row: Company | undefined): Company | undefined {
  if (!row) return undefined;
  return {
    ...row,
    bank_accounts: JSON.parse(String(row.bank_accounts || '[]')),
    note_presets: JSON.parse(String(row.note_presets || '[]')),
  };
}

export function listCompanies(includeInactive = false): Company[] {
  const rows = db.prepare(
    `SELECT * FROM companies ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY is_default DESC, company_name, id`
  ).all() as Company[];
  return rows.map((r) => hydrate(r)!);
}

export function getCompany(id: number): Company {
  const row = hydrate(db.prepare('SELECT * FROM companies WHERE id = ?').get(id) as Company | undefined);
  // A document pointing at a deleted company must still render rather than
  // 500, so fall back to the default instead of throwing.
  return row ?? defaultCompany();
}

export function defaultCompany(): Company {
  const row = db.prepare('SELECT * FROM companies WHERE is_default = 1 ORDER BY id LIMIT 1').get() as Company | undefined;
  return hydrate(row ?? (db.prepare('SELECT * FROM companies ORDER BY id LIMIT 1').get() as Company))!;
}

export function defaultCompanyId(): number {
  return Number(defaultCompany().id);
}

/**
 * Which company a new document belongs to: what was asked for, else the
 * customer's usual entity, else the group default. Never null — a document
 * without a company could not be numbered or printed.
 */
export function resolveCompanyId(requested: unknown, customerId?: number | null): number {
  const asked = Number(requested);
  if (Number.isInteger(asked) && asked > 0) {
    const exists = db.prepare('SELECT id FROM companies WHERE id = ?').get(asked);
    if (exists) return asked;
  }
  if (customerId) {
    const c = db.prepare('SELECT company_id FROM customers WHERE id = ?').get(Number(customerId)) as
      | { company_id: number | null }
      | undefined;
    if (c?.company_id) {
      const exists = db.prepare('SELECT id FROM companies WHERE id = ?').get(c.company_id);
      if (exists) return Number(c.company_id);
    }
  }
  return defaultCompanyId();
}

/** Tables that pin a company, for the delete guard. */
const REFERENCING = ['quotations', 'orders', 'proforma_invoices', 'commercial_invoices', 'packing_lists'] as const;

/**
 * What still points at this company. A company with documents must not vanish:
 * the paperwork would lose the entity that issued it.
 */
export function companyUsage(id: number): { table: string; count: number }[] {
  const used: { table: string; count: number }[] = [];
  for (const table of REFERENCING) {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE company_id = ?`).get(id) as { c: number };
    if (row.c > 0) used.push({ table, count: row.c });
  }
  const customers = db.prepare('SELECT COUNT(*) AS c FROM customers WHERE company_id = ?').get(id) as { c: number };
  if (customers.c > 0) used.push({ table: 'customers', count: customers.c });
  return used;
}
