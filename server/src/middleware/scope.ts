import { db } from '../db/connection.js';
import type { AuthedRequest, SessionUser } from './auth.js';

/**
 * The document tables a person raises for a customer, and whose `created_by`
 * therefore puts that customer in their book — see `visibleCustomerIds`.
 *
 * Every one of these has both a `customer_id` and a `created_by`. `payments` is
 * deliberately absent and needs no column: a payment is always banked against a
 * proforma, an order or an invoice, so its customer is already reachable
 * through the document it settles. `despatches` and `work_orders` have no
 * `customer_id` at all — they reach a customer through the order — and are not
 * raised by Sales.
 */
const AUTHORED_TABLES = [
  'quotations',
  'proforma_invoices',
  'commercial_invoices',
  'orders',
  'packing_lists',
  'credit_notes',
  'enquiries',
  'followups',
] as const;

const VISIBLE_SQL = ['SELECT id FROM customers WHERE owner_id = ?']
  .concat(AUTHORED_TABLES.map(
    // A general follow-up carries no customer, so the NULL has to be dropped
    // rather than landing in an `IN (…)` list as a parameter that matches
    // nothing but costs a placeholder.
    (t) => `SELECT customer_id FROM ${t} WHERE created_by = ? AND customer_id IS NOT NULL`
  ))
  .join('\nUNION ');

/**
 * Which customers are in this person's book — and every document belonging to
 * them.
 *
 * **Owning customers is a Sales idea**, so it restricts Sales and nobody else.
 * A salesperson sees the customers in their book; the factory teams see every
 * order, because Production cannot make what it cannot see and Logistics cannot
 * ship it. Confirmed with the user on 2026-09-05.
 *
 * That widening is only safe because every router is **function-gated first**.
 * This one line used to be the whole of the barrier between a non-manager and
 * every quotation, proforma, payment and PDF in the database; unrestricting
 * four roles without the gates in front would have put every price the company
 * has ever quoted on the shop floor. Production being unscoped is safe exactly
 * because Production has `quotation: 'none'`.
 *
 * **A customer is in your book two ways: they are assigned to you, or you have
 * raised a document for them** (2026-10-07, the client: *"Sales user still
 * cannot raise a document for a customer they don't own, allow them"*). The
 * second half is what makes the first coherent now that anybody may raise for
 * anybody: documents are still scoped by customer, so a quotation raised for
 * somebody else's customer would otherwise have vanished from its own author's
 * list the instant it was saved — the trap-with-no-way-out this codebase has
 * built exactly once and does not intend to build again.
 *
 * It is deliberately **per customer rather than per document**, and the two
 * readings differ: having worked on a customer, you see that customer's whole
 * file, your colleague's documents on them included. That is the honest unit —
 * two people handling one buyer are both handling that buyer — and, more to the
 * point, it is a rule that **cannot be half-applied**. The per-document reading
 * would need an `OR created_by = me` on all twenty-five scoped lists and a
 * second predicate at all sixty detail reads, and one missed call site is a 404
 * on a document the person has just raised. One answer, every call site, no
 * drift. What stays private is what it was: a colleague's work on a customer
 * you have never touched.
 *
 * It is self-correcting in both directions — delete the document and the
 * customer leaves your book again — and `owner_id` is still manager-only, so
 * this is not a way to take somebody's customer.
 *
 * Returns null for "no restriction"; otherwise the list of customer ids
 * (possibly empty, which matches nothing).
 */
export function visibleCustomerIds(req: AuthedRequest): number[] | null {
  const user: SessionUser | undefined = req.user;
  // No user at all is nothing, not everything. Nothing reaches this today —
  // every consumer sits behind requireAuth — but that is the safe direction.
  if (!user) return [];
  if (user.team_role !== 'sales') return null;
  // Memoised per request: `scopeClause` is asked several times by one route
  // (the approvals queue asks six) and this is nine statements now rather than
  // one. Cached on the request so it cannot go stale between requests.
  if (req.scopedCustomerIds) return req.scopedCustomerIds;
  const params = new Array(AUTHORED_TABLES.length + 1).fill(user.id);
  const rows = db.prepare(VISIBLE_SQL).all(...params) as { id?: number; customer_id?: number }[];
  // The first branch names the column `id` and the rest `customer_id`; a UNION
  // takes its column names from the first SELECT, so every row reads as `id`.
  const ids = rows.map((r) => Number(r.id ?? r.customer_id));
  req.scopedCustomerIds = ids;
  return ids;
}

/** SQL fragment + params restricting a query to the caller's customers. */
export function scopeClause(req: AuthedRequest, column = 'customer_id'): { sql: string; params: number[] } {
  const ids = visibleCustomerIds(req);
  if (ids === null) return { sql: '', params: [] };
  if (ids.length === 0) return { sql: `${column} IN (SELECT 0 WHERE 0)`, params: [] }; // matches nothing
  return { sql: `${column} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

/** True when the caller may read and change documents for this customer. */
export function canAccessCustomer(req: AuthedRequest, customerId: number | null | undefined): boolean {
  const ids = visibleCustomerIds(req);
  if (ids === null) return true;
  if (customerId == null) return false;
  return ids.includes(Number(customerId));
}

/**
 * True when the caller may **raise** a document for this customer, which since
 * 2026-10-07 is a different question from whether its documents are theirs.
 *
 * The customer master is shared (2026-10-07), so this asks only that the
 * customer is on file — the picker on every document form offers the whole book
 * and this is what the save accepts, which is the invariant the scoped picker
 * existed to protect, now satisfied from the other side. The row is looked up
 * rather than assumed so a body naming a customer that does not exist is
 * refused by name instead of reaching SQLite as a foreign-key 500.
 *
 * It takes `req` because the rule lives where the answer is decided: narrowing
 * who may raise for whom later is a change here and nowhere else — the reason
 * `exportOnlyInvoice` is kept.
 */
export function canRaiseFor(req: AuthedRequest, customerId: number | null | undefined): boolean {
  if (!req.user) return false;
  if (customerId == null) return false;
  return !!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(Number(customerId));
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
 * Moving a document is open now, because raising one is (2026-10-07) — what is
 * still refused is a move that would put the document **out of the caller's
 * reach**, which is the whole of what this guard was ever about. A customer
 * enters your book when you have raised a document for them, so re-pointing
 * your own document carries its customer with it and is always allowed; moving
 * a document **somebody else raised** onto a customer that is not yours would
 * leave you unable to see it again, so that one is refused and says so.
 *
 * `createdBy` is the document's own author. Absent, this behaves as it always
 * did, which is the safe direction for a caller that has not been told.
 *
 * Returns an error message, or null when the write is allowed.
 */
export function customerChangeError(
  req: AuthedRequest,
  existingCustomerId: number | null | undefined,
  incomingCustomerId: number | null | undefined,
  createdBy?: number | null
): string | null {
  if (Number(existingCustomerId) === Number(incomingCustomerId)) return null;
  if (!canRaiseFor(req, incomingCustomerId)) return 'Customer not found';
  if (canAccessCustomer(req, incomingCustomerId)) return null;
  if (createdBy != null && Number(createdBy) === Number(req.user?.id)) return null;
  return 'That customer is assigned to somebody else and this document was raised by somebody else, '
    + 'so moving it there would put it out of your reach. Raise a fresh document instead.';
}
