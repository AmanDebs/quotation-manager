import { db } from '../db/connection.js';

/**
 * Pagination for the list endpoints.
 *
 * **Opt-in.** A caller that asks for neither `page` nor `limit` gets the whole
 * list as a bare array, exactly as before. That is not a transitional
 * courtesy — it is the contract. Half the lists here are also pickers: the
 * customer select on a new enquiry, the product select in the line editor, the
 * supplier list on a purchase order. An endpoint that always paged would hand
 * a select box the first fifty customers with nothing to say it had done so,
 * which is the silent-wrong-answer failure this codebase spends most of its
 * effort avoiding. A page is a thing the caller asks for.
 *
 * The response shape when they do ask:
 *
 * ```json
 * { "rows": [...], "total": 412, "page": 3, "pages": 9, "limit": 50 }
 * ```
 *
 * `page` is **the page actually served**, not the one requested — see
 * `listBody`.
 */

export interface PageRequest {
  page: number;
  limit: number;
}

export interface Paged<T> {
  rows: T[];
  total: number;
  /** The page served. May be lower than the one asked for; see `listBody`. */
  page: number;
  pages: number;
  limit: number;
}

/** Beyond this a "page" is not one, and the point of the exercise is lost. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Read `?page=` / `?limit=`, or `null` when the caller asked for neither.
 *
 * Either one alone is enough: `?limit=10` means the first ten, and `?page=2`
 * means the second fifty. Nonsense (`?page=abc`, `?page=-3`) is read as the
 * first page rather than refused — a bad page number is not worth a 400 when
 * there is an obvious right answer.
 */
export function pageRequest(query: Record<string, unknown>): PageRequest | null {
  const hasPage = query.page !== undefined && query.page !== '';
  const hasLimit = query.limit !== undefined && query.limit !== '';
  if (!hasPage && !hasLimit) return null;
  const page = Math.max(1, Math.floor(Number(query.page)) || 1);
  const asked = Math.floor(Number(query.limit)) || DEFAULT_LIMIT;
  return { page, limit: Math.min(Math.max(1, asked), MAX_LIMIT) };
}

/**
 * How many rows the query would return, without running it for its rows.
 *
 * Counts by **wrapping the query whole** rather than by swapping its SELECT
 * list for `COUNT(*)`. Rewriting SQL by hand is how a count comes to disagree
 * with the list it is counting — and the bodies here are not uniform enough to
 * rewrite safely anyway: `approvals` is a UNION ALL of three tables and
 * `orderLines` opens with a window-function CTE. Wrapping handles both, and
 * cannot drift from the query it wraps because it *is* that query.
 *
 * Pass the SQL **without** its ORDER BY: ordering rows nobody will read is
 * work for nothing.
 */
export function countOf(sql: string, params: unknown[] = []): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(...(params as never[])) as { n: number };
  return Number(row.n) || 0;
}

/**
 * Run a list query, paged or whole, and return what the route should send.
 *
 * `decorate` is for the lists that add a per-row figure the SQL does not carry
 * — an order's dispatch progress, a job's output. It runs on **the page's rows
 * only**, so the N+1 those lists always had is now bounded by the page size
 * instead of by how long the business has been trading.
 *
 * A page past the end is **clamped to the last one** rather than served empty.
 * Deleting the only invoice on page 9 should not leave someone staring at a
 * blank table wondering what they broke, and the response says which page it
 * actually gave them.
 *
 * **`order` must be a total ordering** — end it in something unique, normally
 * the id. Where the sort key has ties, which row lands on which page is not
 * defined: two LIMIT/OFFSET queries need not break the ties the same way, and
 * one row can then appear on two pages while another appears on none. Four
 * lists here sorted on a name, a due date or a document date alone. The
 * catalogue is the sharpest case, since a product is identified by name *and*
 * colour *and* pcs/box and repeated names are its normal state.
 *
 * SQLite as it stands does not in fact shuffle them — walking the pages of
 * fourteen identically-named products came back in one order, and forcing two
 * different query plans over the same page gave the same rows. So this is a
 * guarantee being made explicit rather than a bug being fixed: the behaviour
 * was correct by luck of the query planner, and adding an index would be
 * enough to change the plan and the luck with it.
 */
export function listBody<T>(
  query: Record<string, unknown>,
  q: { sql: string; order: string; params?: unknown[] },
  decorate: (rows: T[]) => unknown[] = (rows) => rows as unknown[],
): unknown[] | Paged<unknown> {
  const params = q.params ?? [];
  const p = pageRequest(query);
  if (!p) {
    return decorate(db.prepare(`${q.sql} ${q.order}`).all(...(params as never[])) as unknown as T[]);
  }
  const total = countOf(q.sql, params);
  const pages = Math.max(1, Math.ceil(total / p.limit));
  const page = Math.min(p.page, pages);
  const rows = db
    .prepare(`${q.sql} ${q.order} LIMIT ? OFFSET ?`)
    .all(...(params as never[]), p.limit, (page - 1) * p.limit) as unknown as T[];
  return { rows: decorate(rows), total, page, pages, limit: p.limit };
}
