import { db } from '../db/connection.js';
import { searchClause } from './search.js';
import { countOf } from './pagination.js';
import { round2 } from './totals.js';

/**
 * The order book read one item at a time.
 *
 * The Orders page used to show one row per order; the real order desk works in
 * item rows — the same order number repeating down the sheet, one line per
 * product and colour, each with its own quantity and its own progress. This is
 * the one place that answers "every order line and how far along it is".
 *
 * **Position matching.** `dispatchProgress()` in `routes/orders.ts` matches
 * invoice lines to order lines by *position* — the index after
 * `ORDER BY sort_order, id`. Every `saveItems()` writes `sort_order = i`, so
 * position and `sort_order` happen to agree, but leaning on that quietly is how
 * the two would drift apart the first time someone inserts a line differently.
 * So the position is computed explicitly with `ROW_NUMBER()`, reproducing the
 * existing rule rather than assuming a shortcut — and in one statement, where
 * calling `dispatchProgress()` per order would be N+1.
 *
 * **Charge lines are excluded.** Freight is not something the floor makes or
 * ships and has no place in a product summary — the same call `goodsOnly()`
 * makes in `services/pdf.ts`.
 */

export type LineState = 'not_started' | 'in_production' | 'made' | 'part_shipped' | 'shipped';

export interface OrderLine {
  order_id: number;
  order_number: string;
  date: string;
  promised_date: string;
  customer_id: number;
  customer_name: string;
  company_name: string | null;
  /** Who booked the order. Null on one raised before the column existed. */
  created_by_name: string | null;
  is_export: number;
  order_status: string;
  /** Position of this line within its order — the index the whole chain uses. */
  order_line: number;
  product_id: number | null;
  description: string;
  code: string;
  color: string;
  unit: string;
  /** What was ordered, in pieces where the line states them. */
  ordered: number;
  amount: number;
  currency: string;
  made: number;
  sent: number;
  billed: number;
  state: LineState;
}

export interface Filters {
  /** SQL fragment and params restricting to the caller's customers. */
  scopeSql?: string;
  scopeParams?: unknown[];
  status?: string;
  isExport?: number;
  companyId?: number;
  openOnly?: boolean;
  /** Free text — see `orderSearchClause` for the six columns it covers. */
  q?: string;
}

/**
 * One statement. The three progress figures are correlated subqueries rather
 * than joins so that a line with two work orders and three despatches still
 * produces exactly one row — a join would multiply them together.
 */
const SQL = `
  WITH lines AS (
    SELECT oi.*,
           ROW_NUMBER() OVER (PARTITION BY oi.order_id ORDER BY oi.sort_order, oi.id) - 1 AS pos
    FROM order_items oi
  )
  SELECT
    o.id AS order_id, o.number AS order_number, o.date, o.promised_date,
    o.customer_id, c.name AS customer_name, co.company_name,
    u.name AS created_by_name,
    o.is_export, o.status AS order_status, o.currency,
    l.pos AS order_line, l.product_id, l.description, l.code, l.color, l.unit,
    COALESCE(l.total_pcs, l.qty, 0) AS ordered,
    l.qty AS billing_qty,
    l.amount,
    COALESCE((
      SELECT SUM(e.qty_ok) FROM production_entries e
      JOIN work_orders w ON w.id = e.work_order_id
      WHERE w.order_id = o.id AND w.order_line = l.pos AND w.status <> 'cancelled'
    ), 0) AS made,
    COALESCE((
      SELECT SUM(di.qty) FROM despatch_items di
      JOIN despatches d ON d.id = di.despatch_id
      WHERE d.order_id = o.id AND di.order_line = l.pos
    ), 0) AS sent,
    COALESCE((
      SELECT SUM(ii.qty) FROM invoice_items ii
      WHERE ii.invoice_id IN (
        SELECT id FROM commercial_invoices
        WHERE order_id = o.id
           OR pi_id IN (SELECT id FROM proforma_invoices WHERE order_id = o.id)
      )
      AND (
        SELECT COUNT(*) FROM invoice_items x
        WHERE x.invoice_id = ii.invoice_id
          AND (x.sort_order < ii.sort_order OR (x.sort_order = ii.sort_order AND x.id < ii.id))
      ) = l.pos
    ), 0) AS billed
  FROM lines l
  JOIN orders o ON o.id = l.order_id
  JOIN customers c ON c.id = o.customer_id
  LEFT JOIN companies co ON co.id = o.company_id
  -- LEFT, not JOIN: an order whose author has since been deleted must still list.
  LEFT JOIN users u ON u.id = o.created_by
  WHERE l.is_charge = 0`;

/**
 * What the order book's one search box means.
 *
 * The Orders page reads the same book three ways and offers one box over all
 * of them, so the term has to mean the same thing in each — switching tabs
 * with something typed must not quietly change what is being looked for. That
 * is what this exists to guarantee, and why it is a function rather than a
 * column list: the per-order list has no line table joined and has to reach
 * the item columns through an EXISTS, so the two call sites need different
 * SQL for one rule. Two hand-written copies is how the tabs come to disagree.
 *
 * Six columns — our own number, the customer's PO number, the customer's
 * name, and the item's description, code and colour. Those are what somebody
 * at this desk actually has in hand when trying to find an order: a number
 * off an email, the buyer's reference off their purchase order, or the item.
 *
 * `itemAlias` names the line table when one is in scope. Without it the item
 * half becomes "does any line on this order match", which is the same
 * question asked of a row that is one order rather than one line.
 */
export function orderSearchClause(q: string | undefined, itemAlias?: string): { sql: string; params: unknown[] } {
  const term = String(q ?? '').trim();
  if (!term) return { sql: '', params: [] };
  const header = ['o.number', 'o.po_number', 'c.name'];
  if (itemAlias) {
    return searchClause(
      [...header, `${itemAlias}.description`, `${itemAlias}.code`, `${itemAlias}.color`],
      term,
    );
  }
  const head = searchClause(header, term);
  const items = searchClause(['i.description', 'i.code', 'i.color'], term);
  return {
    sql: `(${head.sql} OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND ${items.sql}))`,
    params: [...head.params, ...items.params],
  };
}

function stateOf(ordered: number, made: number, sent: number, billed: number): LineState {
  const out = Math.max(sent, billed);
  if (ordered > 0 && out >= ordered) return 'shipped';
  if (out > 0) return 'part_shipped';
  if (ordered > 0 && made >= ordered) return 'made';
  if (made > 0) return 'in_production';
  return 'not_started';
}

/**
 * The filters as SQL, kept apart from the query so the paged list and its
 * count are built from one description of "which lines".
 */
function lineWhere(f: Filters): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.scopeSql) { where.push(`o.${f.scopeSql}`); params.push(...(f.scopeParams ?? [])); }
  if (f.status) { where.push('o.status = ?'); params.push(f.status); }
  if (f.isExport === 0 || f.isExport === 1) { where.push('o.is_export = ?'); params.push(f.isExport); }
  if (f.companyId) { where.push('o.company_id = ?'); params.push(f.companyId); }
  if (f.openOnly) where.push("o.status NOT IN ('completed','cancelled')");
  const search = orderSearchClause(f.q, 'l');
  if (search.sql) { where.push(search.sql); params.push(...search.params); }
  // The base query already carries a WHERE (charge lines are excluded there).
  return { sql: `${SQL}${where.length ? ` AND ${where.join(' AND ')}` : ''}`, params };
}

const LINE_ORDER = 'ORDER BY o.date DESC, o.id DESC, l.pos';

/**
 * Every order line matching the filters.
 *
 * `page` cuts it to one page and is what the HTTP list passes on; the
 * per-product view deliberately does not, because folding lines up needs all
 * of them — a page of a total is not a total.
 */
export function orderLines(f: Filters = {}, page?: { limit: number; offset: number }): OrderLine[] {
  const { sql, params } = lineWhere(f);
  const args = page ? [...params, page.limit, page.offset] : params;
  const rows = db.prepare(
    `${sql} ${LINE_ORDER}${page ? ' LIMIT ? OFFSET ?' : ''}`
  ).all(...(args as never[])) as unknown as (OrderLine & { billing_qty: number | null })[];

  return rows.map((r) => ({
    ...r,
    ordered: round2(r.ordered),
    made: round2(r.made),
    sent: round2(r.sent),
    billed: round2(r.billed),
    state: stateOf(r.ordered, r.made, Number(r.sent), Number(r.billed)),
  }));
}

/** How many lines match, for the pager. Counts the same query it pages. */
export function countOrderLines(f: Filters = {}): number {
  const { sql, params } = lineWhere(f);
  return countOf(sql, params);
}

export interface ProductDemand {
  key: string;
  product_id: number | null;
  description: string;
  code: string;
  color: string;
  unit: string;
  ordered: number;
  made: number;
  shipped: number;
  to_ship: number;
  orders: number;
  /** Earliest promised date among lines not yet shipped; '' when none remain. */
  next_due: string;
}

/**
 * The same lines folded up per product.
 *
 * Keyed on `product_id` where the line names a catalogue entry, and otherwise
 * on description + colour. A custom line is a real thing — an employee meeting
 * a new product mid-order is expected — so it groups by what it says rather
 * than being dropped or swept into one "custom" pile.
 */
export function productDemand(f: Filters = {}): ProductDemand[] {
  const groups = new Map<string, ProductDemand & { orderIds: Set<number> }>();

  for (const line of orderLines(f)) {
    const key = line.product_id
      ? `p:${line.product_id}`
      : `d:${line.description.trim().toLowerCase()}|${(line.color ?? '').trim().toLowerCase()}`;

    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        product_id: line.product_id,
        description: line.description,
        code: line.code,
        color: line.color,
        unit: line.unit,
        ordered: 0, made: 0, shipped: 0, to_ship: 0, orders: 0, next_due: '',
        orderIds: new Set<number>(),
      };
      groups.set(key, g);
    }

    const out = Math.max(line.sent, line.billed);
    g.ordered = round2(g.ordered + line.ordered);
    g.made = round2(g.made + line.made);
    g.shipped = round2(g.shipped + out);
    g.to_ship = round2(g.to_ship + Math.max(0, line.ordered - out));
    g.orderIds.add(line.order_id);

    // Only unshipped lines can still be due; an empty date never wins.
    if (line.state !== 'shipped' && line.promised_date) {
      if (!g.next_due || line.promised_date < g.next_due) g.next_due = line.promised_date;
    }
  }

  return [...groups.values()]
    .map(({ orderIds, ...g }) => ({ ...g, orders: orderIds.size }))
    // Most still to ship first: the page exists to say what to run next.
    .sort((a, b) => b.to_ship - a.to_ship || a.description.localeCompare(b.description));
}
