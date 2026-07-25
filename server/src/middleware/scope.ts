import { db } from '../db/connection.js';
import type { AuthedRequest, SessionUser } from './auth.js';

/**
 * Employees only see customers they own (and every document belonging to those
 * customers). Managers see everything.
 *
 * Returns null for managers meaning "no restriction"; otherwise the list of
 * customer ids the user may touch (possibly empty).
 */
export function visibleCustomerIds(user: SessionUser | undefined): number[] | null {
  if (!user || user.role === 'manager') return null;
  const rows = db.prepare('SELECT id FROM customers WHERE owner_id = ?').all(user.id) as { id: number }[];
  return rows.map((r) => r.id);
}

/** SQL fragment + params restricting a query to the caller's customers. */
export function scopeClause(req: AuthedRequest, column = 'customer_id'): { sql: string; params: number[] } {
  const ids = visibleCustomerIds(req.user);
  if (ids === null) return { sql: '', params: [] };
  if (ids.length === 0) return { sql: `${column} IN (SELECT 0 WHERE 0)`, params: [] }; // matches nothing
  return { sql: `${column} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

/** True when the caller may act on documents for this customer. */
export function canAccessCustomer(req: AuthedRequest, customerId: number | null | undefined): boolean {
  const ids = visibleCustomerIds(req.user);
  if (ids === null) return true;
  if (customerId == null) return false;
  return ids.includes(Number(customerId));
}
