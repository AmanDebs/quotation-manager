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

/** The document tables one document may point at as its source. */
type LinkTable = 'quotations' | 'orders' | 'proforma_invoices' | 'commercial_invoices';

/**
 * Guard for a source-document id arriving in a request body — `pi_id`,
 * `order_id`, `quotation_id`.
 *
 * `customer_id` was always checked; these were not, and an unchecked link is
 * not a lesser hole. Pointing an invoice at someone else's proforma pulled that
 * proforma's payment records back through the invoice's own response — for a
 * document the same caller gets a flat 404 on when they ask for it directly —
 * and re-allocated its advances, taking credit off the invoice that had earned
 * it.
 *
 * Two conditions, because scope alone is not enough: the linked document must
 * be one the caller may see, *and* it must belong to the same customer. A
 * proforma raised for one buyer has no business on another buyer's invoice even
 * when one person happens to own both — the carry-forward chain is a chain
 * through a single customer, and anything else corrupts the figures derived
 * along it.
 *
 * Returns an error message, or null when the link is allowed. Absent ids pass:
 * a document with no source is normal.
 */
export function linkError(
  req: AuthedRequest,
  table: LinkTable,
  id: number | null | undefined,
  customerId: number | null | undefined,
  label: string
): string | null {
  if (id == null) return null;
  const row = db.prepare(`SELECT customer_id FROM ${table} WHERE id = ?`).get(Number(id)) as
    | { customer_id: number } | undefined;
  // Not "belongs to someone else": a document the caller cannot see must read
  // as one that does not exist, the rule every route here follows.
  if (!row || !canAccessCustomer(req, row.customer_id)) return `${label} not found`;
  if (Number(row.customer_id) !== Number(customerId)) {
    return `That ${label.toLowerCase()} belongs to a different customer`;
  }
  return null;
}

/**
 * Guard for a change of customer on an existing document.
 *
 * Every PUT checked the row it was editing and then wrote whatever
 * `customer_id` the body carried, so a document could be pushed onto a customer
 * the caller does not own — where it lands on that customer's ledger and in the
 * manager's lists, and where the caller can no longer see it to undo. A one-way
 * door out of your own scope.
 *
 * Returns an error message, or null when the write is allowed.
 */
export function customerChangeError(
  req: AuthedRequest,
  existingCustomerId: number | null | undefined,
  incomingCustomerId: number | null | undefined
): string | null {
  if (Number(existingCustomerId) === Number(incomingCustomerId)) return null;
  if (!canAccessCustomer(req, incomingCustomerId)) return 'That customer is not assigned to you';
  return null;
}
