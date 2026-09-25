import { db } from '../db/connection.js';
import { fgOnHandByProduct } from './finishedGoods.js';
import { PIECES_ORDERED_SQL } from './totals.js';
import { searchClause } from './search.js';
import { countOf } from './pagination.js';
import { round2 } from './totals.js';
import { LIVE_OK, JOB_START } from './production.js';

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

export type LineState = 'not_scheduled' | 'scheduled' | 'partially_dispatched' | 'fully_dispatched';

export interface OrderLine {
  order_id: number;
  order_number: string;
  date: string;
  /** The order's original production date, and the revised one where set. */
  promised_date: string;
  revised_date: string;
  customer_id: number;
  customer_name: string;
  company_name: string | null;
  /** Who booked the order. Null on one raised before the column existed. */
  created_by_name: string | null;
  /**
   * Who is handling the order — `orders.spoc`, the *Handled by (SPOC)*
   * field. What the book's own column shows since 2026-09-24, in place of
   * who booked it: the desk reads this column to find whose order it is,
   * and the person who typed it in is rarely that person.
   */
  spoc: string;
  is_export: number;
  order_status: string;
  /**
   * Where the goods are discharged, from the order. Blank on a domestic one.
   * Read off the order rather than the line: in the desk's own export tracker
   * it never differs between lines of one document — it is repeated there only
   * because a flat sheet has no other way to say it.
   */
  port_of_discharge: string;
  /** Position of this line within its order — the index the whole chain uses. */
  order_line: number;
  product_id: number | null;
  description: string;
  /** The catalogue product's own name; null on a custom line naming none. */
  product_name: string | null;
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
  /**
   * Finished goods on the shelf for this line's product, across every plant —
   * the same figure on every line of that product, since nothing reserves
   * stock to a line. `null` on a custom line naming no product: the ledger has
   * no row to read, which is not the same as none. Filled in by the route only
   * for a caller holding `fg`; absent, not zero, otherwise.
   */
  in_stock?: number | null;
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
  /** Per-column filters, as the header dropdowns set them. */
  columns?: ColumnFilters;
}

/**
 * A filter on one column of the *Sales order lines* view — the spreadsheet
 * habit, asked for 2026-09-24 (*"Is it possible to add filter in header of
 * each column like in excel"*).
 *
 * A tick list per column, and a from/to for the dates and the three
 * quantities. It is **kept as a description rather than as SQL** for the
 * reason `scopeClause` and `searchClause` are: the same object has to reach
 * the paged list, its count, the per-product fold and the spreadsheet export,
 * and a second hand-built WHERE in any one of them is how the download comes
 * to hold rows the screen did not.
 */
export interface ColumnFilters {
  /** Tick lists, keyed by the column's own name in `FILTERABLE`. */
  values?: Partial<Record<FilterColumn, string[]>>;
  /** `YYYY-MM-DD` bounds, keyed by column. Either end may stand alone. */
  from?: Partial<Record<FilterColumn, string>>;
  to?: Partial<Record<FilterColumn, string>>;
  /** Numeric bounds, keyed by column. */
  min?: Partial<Record<FilterColumn, number>>;
  max?: Partial<Record<FilterColumn, number>>;
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
    o.id AS order_id, o.number AS order_number, o.date, o.promised_date, o.revised_date,
    o.customer_id, c.name AS customer_name, co.company_name,
    u.name AS created_by_name, o.spoc,
    o.is_export, o.status AS order_status, o.currency, o.port_of_discharge,
    l.pos AS order_line, l.product_id, l.description, p.name AS product_name, l.code, l.color, l.unit,
    -- What the Item column actually prints: the catalogue name where the line
    -- names a product, else the line's own wording (2026-09-15). Selected as
    -- its own column so the header filter and its tick list read the one
    -- expression rather than each rebuilding it — two copies of "what does
    -- this cell say" is how a dropdown comes to offer a value that matches no
    -- row.
    COALESCE(NULLIF(p.name, ''), l.description) AS item_label,
    ${PIECES_ORDERED_SQL('l')} AS ordered,
    l.qty AS billing_qty,
    l.amount,
    COALESCE((
      SELECT SUM(${LIVE_OK('e')}) FROM production_entries e
      JOIN work_orders w ON w.id = e.work_order_id
      WHERE w.order_id = o.id AND w.order_line = l.pos AND w.status <> 'cancelled'
    ), 0) AS made,
    COALESCE((
      SELECT SUM(di.qty) FROM despatch_items di
      JOIN despatches d ON d.id = di.despatch_id
      WHERE d.order_id = o.id AND di.order_line = l.pos
    ), 0) AS sent,
    -- A job on this line committed to a slot: released, or given a start
    -- date — the order ladder's own rule for its Scheduled rung, restated
    -- per line (a job merely raised is neither).
    (
      SELECT COUNT(*) FROM work_orders w
      WHERE w.order_id = o.id AND w.order_line = l.pos AND w.status <> 'cancelled'
        AND (w.status <> 'planned' OR ${JOB_START('w')} <> '')
    ) AS scheduled_jobs,
    -- In pieces, like ordered and sent beside it: an invoice line is billed
    -- in its own basis (3,245 per 1000), and summing that against a piece
    -- count read a fully billed line as 0.1% shipped (2026-09-16).
    COALESCE((
      SELECT SUM(${PIECES_ORDERED_SQL('ii')}) FROM invoice_items ii
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
  -- LEFT: a custom line names no product and must still list.
  LEFT JOIN products p ON p.id = l.product_id
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

/**
 * Four states, in the client's own words (2026-09-20: *"change the state to
 * Not Scheduled >> Scheduled >> Partially dispatched >> Fully Dispatched"*),
 * replacing the five of *not started → in production → made → part shipped
 * → shipped*. The two production rungs folded into one: this view is read
 * for what is sold and what has gone, and how far the floor is with it is
 * the Work Orders page's figure.
 *
 * **Scheduled** is the order ladder's own rule read per line: a live job on
 * the line released or given a start date. Output booked counts too — a
 * job that has run was scheduled, whatever its status field says — so a
 * line never reads *Not scheduled* over pieces already made.
 *
 * Dispatched means the dispatch record says so, and nothing else (2026-09-16,
 * the client having raised an invoice and watched an unsent line read
 * *Shipped*). Until the dispatch register existed the invoice walk was the
 * only record of goods leaving, so a billed line counted as sent; on this
 * desk the invoice regularly goes out before the lorry, so that reading
 * called the paperwork a shipment. `billed` still rides the row — the order
 * book's Billed column and the ladder's *Completed* read it — but it no
 * longer stands in for the lorry.
 */
export function stateOf(ordered: number, made: number, sent: number, scheduledJobs: number): LineState {
  const out = sent;
  if (ordered > 0 && out >= ordered) return 'fully_dispatched';
  if (out > 0) return 'partially_dispatched';
  if (scheduledJobs > 0 || made > 0) return 'scheduled';
  return 'not_scheduled';
}

/**
 * The same four states in SQL, for the State column's own filter.
 *
 * A second copy of a rule, which this codebase pays for only where paging
 * forces it — and it does here exactly as it does for `RESULT_FAILED_SQL`: the
 * lines are paged, so a state computed after the fetch could only filter and
 * count the page in hand. What makes it cheaper than that precedent is that it
 * reads the **same four figures** `stateOf` reads, by their aliases, rather
 * than restating the arithmetic behind them; `orderLineFilters.test.ts` runs
 * both over every combination that matters and asserts they never differ.
 */
export const LINE_STATE_SQL = `
  CASE
    WHEN ordered > 0 AND sent >= ordered THEN 'fully_dispatched'
    WHEN sent > 0 THEN 'partially_dispatched'
    WHEN scheduled_jobs > 0 OR made > 0 THEN 'scheduled'
    ELSE 'not_scheduled'
  END`;

/**
 * The filters as SQL, kept apart from the query so the paged list and its
 * count are built from one description of "which lines".
 */
/**
 * The status clause every reader of the book shares (2026-09-20, the
 * client with the picker open on Not scheduled, Scheduled and Partially
 * dispatched: *"These 3 checkboxes should be clicked by default"*).
 *
 * A named status shows exactly what was named, as a comma list; `all`
 * shows everything; and **blank shows the open book** — every order not
 * completed or cancelled, which is what `?open=1` has always meant and is
 * now what the page opens on. Written as what is *hidden* rather than the
 * three the picker ticks, so an order still holding a retired status
 * (`confirmed`, `in_production`, `ready` — offered no box, being words the
 * client's list does not have) stays on the working list rather than
 * vanishing from it.
 */
export function statusClause(status: string | undefined, col = 'o.status'): { sql: string; params: unknown[] } {
  const s = String(status ?? '').trim();
  if (s === 'all') return { sql: '', params: [] };
  if (!s) return { sql: `${col} NOT IN ('completed', 'cancelled')`, params: [] };
  const list = s.split(',').map((v) => v.trim()).filter(Boolean);
  if (!list.length) return { sql: '', params: [] };
  return { sql: `${col} IN (${list.map(() => '?').join(', ')})`, params: list };
}

/**
 * Which columns carry a header filter, and what each one filters on.
 *
 * Every entry is an **alias of the outer query** rather than a table column,
 * which is what makes one mechanism cover all thirteen: `customer_name` is a
 * join, `item_label` a COALESCE, `ordered` a conversion, `sent` a correlated
 * subquery, `balance` arithmetic over two of those and `state` a CASE over
 * four. Filtering after the row is built costs a wrapper and buys a filter on
 * *what the column says*, which is the only thing somebody reading the screen
 * can mean.
 *
 * `kind` is what the dropdown offers: a tick list of the values in the book, a
 * pair of dates, or a pair of numbers. `Balance` is the one that has to be
 * restated rather than named — it is `Math.max(0, ordered - sent)` on the
 * client, and a filter that read anything else would disagree with the figure
 * printed beside it.
 */
export const FILTERABLE = {
  order_number: { sql: 'order_number', kind: 'values' },
  date: { sql: 'date', kind: 'dates' },
  customer: { sql: 'customer_name', kind: 'values' },
  port: { sql: 'port_of_discharge', kind: 'values' },
  item: { sql: 'item_label', kind: 'values' },
  color: { sql: 'color', kind: 'values' },
  qty: { sql: 'ordered', kind: 'numbers' },
  sent: { sql: 'sent', kind: 'numbers' },
  balance: { sql: 'CASE WHEN ordered > 0 THEN MAX(ordered - sent, 0) END', kind: 'numbers' },
  promised: { sql: 'promised_date', kind: 'dates' },
  revised: { sql: 'revised_date', kind: 'dates' },
  spoc: { sql: 'spoc', kind: 'values' },
  state: { sql: LINE_STATE_SQL, kind: 'values' },
} as const;

export type FilterColumn = keyof typeof FILTERABLE;

export const FILTER_COLUMNS = Object.keys(FILTERABLE) as FilterColumn[];

export function isFilterColumn(v: unknown): v is FilterColumn {
  return typeof v === 'string' && v in FILTERABLE;
}

/**
 * The column filters as SQL.
 *
 * `except` leaves one column's own filter out, which is what a tick list has
 * to be built against: Excel's dropdown offers the values still reachable
 * given every *other* filter, so that unticking something can put it back.
 * Counting a column against itself would leave each list showing only what
 * was already chosen.
 */
function columnWhere(c: ColumnFilters | undefined, except?: FilterColumn): { sql: string[]; params: unknown[] } {
  const sql: string[] = [];
  const params: unknown[] = [];
  if (!c) return { sql, params };

  for (const col of FILTER_COLUMNS) {
    if (col === except) continue;
    const { sql: expr, kind } = FILTERABLE[col];

    if (kind === 'values') {
      const picked = c.values?.[col];
      if (picked?.length) {
        // A blank cell is a real answer — *no colour*, *nobody recorded* — and
        // is offered in the list as such, so it has to be tickable. `IN` never
        // matches NULL, hence the explicit arm.
        const blanks = picked.some((v) => v === '');
        const named = picked.filter((v) => v !== '');
        const arms: string[] = [];
        if (named.length) { arms.push(`(${expr}) IN (${named.map(() => '?').join(', ')})`); params.push(...named); }
        if (blanks) arms.push(`COALESCE(${expr}, '') = ''`);
        sql.push(`(${arms.join(' OR ')})`);
      }
      continue;
    }

    const from = kind === 'dates' ? c.from?.[col] : c.min?.[col];
    const to = kind === 'dates' ? c.to?.[col] : c.max?.[col];
    const bounded = (from !== undefined && from !== '') || (to !== undefined && to !== '');

    /*
     * A blank date falls in no range at all, and it has to be said rather than
     * assumed: a date is stored as text, so SQLite compares `''` as a string
     * and `'' <= '2026-09-25'` is **true** — an upper bound alone would have
     * returned every order with no revised date at all, which on the live book
     * is most of them. Found by the test that was written to assert the
     * opposite. A blank number is already excluded without help, NULL failing
     * every comparison, so the guard is the dates' own.
     */
    if (bounded && kind === 'dates') sql.push(`COALESCE(${expr}, '') <> ''`);
    if (from !== undefined && from !== '') { sql.push(`(${expr}) >= ?`); params.push(from); }
    if (to !== undefined && to !== '') { sql.push(`(${expr}) <= ?`); params.push(to); }
  }
  return { sql, params };
}

/**
 * The lines matching everything asked of them.
 *
 * Two layers, and the split is not cosmetic. The **inner** WHERE narrows rows
 * before the per-line subqueries run — scope, status, the search box — while
 * the **outer** one filters on what those subqueries produced, which is the
 * only place a filter on Sent, Balance or State can live. The query is wrapped
 * whether or not a column filter is set, so there is one shape to reason about
 * and `LINE_ORDER` names one set of columns.
 */
function lineWhere(f: Filters, except?: FilterColumn): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.scopeSql) { where.push(`o.${f.scopeSql}`); params.push(...(f.scopeParams ?? [])); }
  const status = statusClause(f.status);
  if (status.sql) { where.push(status.sql); params.push(...status.params); }
  if (f.isExport === 0 || f.isExport === 1) { where.push('o.is_export = ?'); params.push(f.isExport); }
  if (f.companyId) { where.push('o.company_id = ?'); params.push(f.companyId); }
  // `?open=1` — the dashboard's links — is the blank default said out loud.
  if (f.openOnly && f.status) where.push("o.status NOT IN ('completed','cancelled')");
  const search = orderSearchClause(f.q, 'l');
  if (search.sql) { where.push(search.sql); params.push(...search.params); }
  // The base query already carries a WHERE (charge lines are excluded there).
  const inner = `${SQL}${where.length ? ` AND ${where.join(' AND ')}` : ''}`;

  const cols = columnWhere(f.columns, except);
  params.push(...cols.params);
  return {
    sql: `SELECT * FROM (${inner}) t${cols.sql.length ? ` WHERE ${cols.sql.join(' AND ')}` : ''}`,
    params,
  };
}

// Over the wrapper's own aliases: `o` and `l` are out of scope outside it.
const LINE_ORDER = 'ORDER BY date DESC, order_id DESC, order_line';

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
  ).all(...(args as never[])) as unknown as (OrderLine & { billing_qty: number | null; scheduled_jobs: number })[];

  return rows.map(({ scheduled_jobs, ...r }) => ({
    ...r,
    ordered: round2(r.ordered),
    made: round2(r.made),
    sent: round2(r.sent),
    billed: round2(r.billed),
    state: stateOf(r.ordered, r.made, Number(r.sent), Number(scheduled_jobs)),
  }));
}

/**
 * Put the shelf beside the demand. The order book is `order: view`; the
 * figure is `fg`, and under the current matrix every role that reads the book
 * also holds `fg` — so this binds on nobody today, and is kept for the reason
 * `exportOnlyInvoice` is kept: the rule lives where the answer is decided, so
 * narrowing a cell later narrows this with it.
 */
export function withStock<T extends { product_id: number | null }>(rows: T[]): (T & { in_stock: number | null })[] {
  const shelf = fgOnHandByProduct();
  return rows.map((r) => ({ ...r, in_stock: r.product_id == null ? null : (shelf.get(r.product_id) ?? 0) }));
}

/** How many lines match, for the pager. Counts the same query it pages. */
export function countOrderLines(f: Filters = {}): number {
  const { sql, params } = lineWhere(f);
  return countOf(sql, params);
}

export interface FacetValue {
  value: string;
  /** How many lines carry it, under every filter but this column's own. */
  count: number;
}

export interface Facet {
  values: FacetValue[];
  /** Distinct values there were before the cap; the panel says so when more. */
  total: number;
}

/**
 * What one column's tick list should offer.
 *
 * **Measured over the whole filtered book, never the page on screen**, which
 * is the entire reason this is a server endpoint rather than a walk over the
 * rows the client already holds: these lines are paged, so a list built from
 * them would offer the fifty customers on page one and silently hide the other
 * seven hundred and seventy.
 *
 * Every other filter applies but this column's own — Excel's rule, and the one
 * that lets a choice be undone: a list narrowed by itself would show only what
 * was already ticked.
 *
 * `search` narrows on the server too, for the same reason. The live book names
 * 820 customers; a cap with a client-side search box would be a list that
 * stops finding things at an arbitrary depth, and this desk would meet that on
 * the first column they opened.
 */
export function lineFacet(
  f: Filters,
  column: FilterColumn,
  opts: { search?: string; limit?: number } = {},
): Facet {
  const { sql, params } = lineWhere(f, column);
  const expr = FILTERABLE[column].sql;
  const args = [...params];

  let having = '';
  const search = String(opts.search ?? '').trim();
  if (search) {
    // `%` and `_` are LIKE's own wildcards — escaped for the reason
    // `searchClause` records, so typing one finds the character.
    having = ' WHERE value LIKE ? ESCAPE \'\\\'';
    args.push(`%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  }

  const base = `SELECT COALESCE(${expr}, '') AS value, COUNT(*) AS n FROM (${sql}) v GROUP BY value`;
  const counted = `SELECT value, n FROM (${base})${having}`;

  const total = countOf(counted, args);
  const limit = opts.limit ?? 300;
  const rows = db.prepare(
    // Commonest first, so a capped list is the useful end of it; then by name,
    // which is a total ordering and so a stable one.
    `${counted} ORDER BY n DESC, value LIMIT ?`
  ).all(...([...args, limit] as never[])) as { value: string; n: number }[];

  return { values: rows.map((r) => ({ value: String(r.value), count: Number(r.n) })), total };
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
  /** On the shelf for this product, as on the lines. `null` for a custom line. */
  in_stock?: number | null;
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

    // The dispatch record, as `stateOf` reads it — not the invoice.
    const out = line.sent;
    g.ordered = round2(g.ordered + line.ordered);
    g.made = round2(g.made + line.made);
    g.shipped = round2(g.shipped + out);
    g.to_ship = round2(g.to_ship + Math.max(0, line.ordered - out));
    g.orderIds.add(line.order_id);

    // Only unshipped lines can still be due; an empty date never wins.
    if (line.state !== 'fully_dispatched' && line.promised_date) {
      if (!g.next_due || line.promised_date < g.next_due) g.next_due = line.promised_date;
    }
  }

  return [...groups.values()]
    .map(({ orderIds, ...g }) => ({ ...g, orders: orderIds.size }))
    // Most still to ship first: the page exists to say what to run next.
    .sort((a, b) => b.to_ship - a.to_ship || a.description.localeCompare(b.description));
}
