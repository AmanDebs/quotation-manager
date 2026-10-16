import { db } from '../db/connection.js';
import { LIVE_OK } from './production.js';
import { DUE_TO_START } from './jobStatus.js';
import { searchClause } from './search.js';
import {
  columnWhere, readColumnFilters, facetOver, isColumnOf,
  type ColumnFilterSet, type ColumnSpecs, type Facet,
} from './columnFilters.js';

/**
 * The Work Orders list: which jobs, in what order, and what the headings can be
 * filtered by.
 *
 * It lives here rather than in the route for the reason every other list in
 * this app does: the paged rows, the count behind the pager, the summary over
 * the whole filtered set and each heading's tick list all have to be built from
 * **one** description of *which jobs*, and a second hand-built WHERE in any one
 * of them is how a figure comes to describe a different set from the rows under
 * it.
 */

/*
 * The colour of the line a job is against (2026-09-29, the client: *"Add colour
 * column"*).
 *
 * A work order has no colour of its own and should not grow one: what is being
 * made is the order line, and its colour is the one on the quotation, the
 * proforma, the order and the invoice — mandatory on all four since
 * 2026-09-17. Reached by **position**, the chain's own index rule that
 * `work_orders.order_line` already is, and by the same `ROW_NUMBER()` walk
 * `orderLines.ts` uses rather than by reading `sort_order` directly, so
 * positions count charge lines exactly as they do everywhere else.
 *
 * It falls through to the catalogue's own colour where the line states none —
 * a product is identified by name **and** colour, so the catalogue is the
 * honest second answer; a custom line naming no product has only the line's,
 * which is why the line is asked first.
 */
const LINE_AT_POSITION = `
  LEFT JOIN (
    SELECT order_id, color,
           ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY sort_order, id) - 1 AS pos
      FROM order_items
  ) oi ON oi.order_id = w.order_id AND oi.pos = w.order_line`;

/**
 * `order_remarks` is what the desk wrote on the sales order, carried to the
 * floor (2026-09-29, the client: *"Work order does not catch packing
 * instruction / notes captured in sales order — this guide factory team on how
 * to pack, printed or non-printed box, whether box needs to be wrapped etc"*).
 *
 * **Read, never copied.** Stamping it onto the job when the job is raised
 * would be a second copy, stale the moment somebody corrects the order — and
 * `syncOrderJobs` only touches a job nothing has happened on, so the
 * correction would reach some jobs and not others, which is worse than not
 * carrying it at all. Joined here, a remark edited this morning is on the
 * floor's screen this morning, and `work_orders.notes` stays what the floor
 * writes for itself.
 */
export const listSql = `
  SELECT w.*, o.number AS order_number, o.customer_id,
         o.date AS order_date,
         o.remarks AS order_remarks,
         -- Who is handling the sales order this job is against (2026-10-15).
         -- Read off the order, like the colour and the instructions: a job has
         -- no SPOC of its own, and giving it one would be a second copy able
         -- to disagree with the document.
         o.spoc,
         -- The day the job was raised, as a date rather than the stamp.
         -- (No backticks in this comment -- the whole statement is a template
         -- literal, and one closes it.)
         --
         -- created_at is datetime('now'), which is UTC, and reading a UTC
         -- stamp as local is the 5.5-hour error this codebase records fixing
         -- once already. +330 minutes is not an approximation: India has never
         -- observed DST, so a fixed offset IS Asia/Kolkata, the timezone
         -- todayInKolkata already states this desk works in.
         --
         -- Its own alias, so the column and its heading filter read ONE
         -- expression: a range over the raw stamp would miss every job raised
         -- on its own closing day, 2026-10-16 09:00:00 sorting after
         -- 2026-10-16.
         date(w.created_at, '+330 minutes') AS created_date,
         c.name AS customer_name,
         p.name AS product_name,
         -- What the Item column actually prints: the catalogue name where the
         -- job names a product, else the line's own wording (2026-10-08). As
         -- its own alias so the heading's filter and its tick list read the one
         -- expression rather than each rebuilding it — two copies of *what does
         -- this cell say* is how a dropdown comes to offer a value matching no
         -- row.
         COALESCE(NULLIF(p.name, ''), w.description, '') AS item_label,
         COALESCE(NULLIF(oi.color, ''), p.color, '') AS color,
         -- Pieces made, for the Made column's own filter. The figure drawn on
         -- the row is still the progress block, which carries the rejects and
         -- the balance beside it; both read LIVE_OK, so a scrapped lot stops
         -- counting in one place and therefore in both.
         COALESCE((SELECT SUM(${LIVE_OK('e')}) FROM production_entries e
                    WHERE e.work_order_id = w.id), 0) AS made,
         ${DUE_TO_START('w')} AS due_to_start,
         l.name AS location_name, m.name AS machine_name, md.name AS mould_name, pr.name AS process_name,
         u.name AS created_by_name
  FROM work_orders w
  JOIN orders o ON o.id = w.order_id
  JOIN customers c ON c.id = o.customer_id
  LEFT JOIN products p ON p.id = w.product_id
  LEFT JOIN locations l ON l.id = w.location_id
  LEFT JOIN machines m ON m.id = w.machine_id
  LEFT JOIN moulds md ON md.id = w.mould_id
  LEFT JOIN processes pr ON pr.id = w.process_id
  LEFT JOIN users u ON u.id = w.created_by
  ${LINE_AT_POSITION}`;

/**
 * Which headings carry a filter, and what each one filters on (2026-10-13, the
 * client with the Work Orders list in front of them: *"add filter to all
 * columns in work order similar to sales order"*).
 *
 * One entry per column the page draws, and every one is an **alias of the
 * query above** rather than a table column — `customer_name` is a join,
 * `item_label` a COALESCE, `color` a fallback through the catalogue and `made`
 * a correlated subquery. Filtering after the row is built costs a wrapper and
 * buys a filter on *what the column says*, which is the only thing somebody
 * reading the screen can mean by it.
 *
 * The four dates are deliberately **four columns, not two**: the page draws
 * both the planned pair and the revised pair precisely so the slip between
 * them can be read, and a filter that silently asked about whichever date
 * stands would be answering a question the screen does not ask.
 *
 * `status` keeps the key it has always had rather than taking `f.status`: the
 * dashboard's factory chips link here with it, and reading it into the Status
 * column's own tick list is what lets that dropdown clear it.
 */
export const JOB_FILTERABLE = {
  job: { sql: 'number', kind: 'values' },
  created: { sql: 'created_date', kind: 'dates' },
  customer: { sql: 'customer_name', kind: 'values' },
  spoc: { sql: 'spoc', kind: 'values' },
  item: { sql: 'item_label', kind: 'values' },
  color: { sql: 'color', kind: 'values' },
  planned_start: { sql: 'planned_start', kind: 'dates' },
  planned_end: { sql: 'planned_end', kind: 'dates' },
  revised_start: { sql: 'revised_start', kind: 'dates' },
  revised_end: { sql: 'revised_end', kind: 'dates' },
  qty: { sql: 'qty_planned', kind: 'numbers' },
  made: { sql: 'made', kind: 'numbers' },
  status: { sql: 'status', kind: 'values', param: 'status' },
} as const satisfies ColumnSpecs;

export type JobFilterColumn = keyof typeof JOB_FILTERABLE;

/**
 * The search box over the floor's list (2026-10-15, the client: *"Add the
 * filter options that are available in sales order in work order too"*).
 *
 * Five columns, and they are what somebody standing in front of this list
 * actually has in hand: a **job number** off a docket, the **sales order**
 * number or the buyer's own **PO number** off a chase, the **customer**, or
 * the **product**. It mirrors `orderSearchClause` one document along —
 * deliberately the same six facts less the colour and the code, both of which
 * are already answerable from a column funnel here.
 *
 * Through `searchClause` like every other search in this app, which is what
 * escapes `%` and `_` (LIKE's own wildcards, so typing either matched every
 * row) and **brackets the clause** — this WHERE is shared with `scopeClause`,
 * and an unbracketed `OR` would be a way straight past data scoping.
 *
 * It lives in the **inner** WHERE, over real columns rather than the select's
 * aliases: `o.po_number` is reachable there and nowhere else, and the two
 * aliases it gives up (`item_label`, `color`) each have a heading filter of
 * their own.
 */
export function jobSearchClause(q: string | undefined): { sql: string; params: unknown[] } {
  return searchClause(['w.number', 'o.number', 'o.po_number', 'c.name', 'p.name'], String(q ?? '').trim());
}

/**
 * Every job matching the filters, as one statement.
 *
 * Two layers, and the split is not cosmetic: the **inner** WHERE narrows rows
 * on the tables themselves, while the **outer** one filters on what the select
 * produced, which is the only place a filter on Item, Colour or Made can live.
 * It is wrapped whether or not a column filter is set, so there is one shape to
 * reason about and `JOB_ORDER` names one set of columns.
 *
 * `except` leaves one column's own filter out, which is what a tick list has to
 * be measured against — see `columnWhere`.
 */
export type JobColumnFilters = ColumnFilterSet<JobFilterColumn>;

export interface JobFilters {
  /** SQL fragment and params restricting to the caller's customers. */
  scopeSql?: string;
  scopeParams?: unknown[];
  /** Jobs on one sales order. */
  orderId?: number;
  machineId?: number;
  locationId?: number;
  /**
   * The three the sales order book has had all along and this list had none of
   * (2026-10-15). Each is a fact about the **order** behind the job rather
   * than about the job: a work order is export or domestic, and belongs to a
   * selling entity, only because its order does — except the company, which
   * the job carries itself, being the series that numbered it.
   */
  isExport?: number;
  companyId?: number;
  /** Free text — see `jobSearchClause` for the five columns it covers. */
  q?: string;
  /** Due to start, with nobody having said whether it did. */
  awaiting?: boolean;
  /** Everything still to finish — the default view of a shop floor. */
  openOnly?: boolean;
  /** Per-column filters, as the header dropdowns set them. */
  columns?: JobColumnFilters;
}

/** What the route reads off the query string, in this list's vocabulary. */
export const readJobFilters = (query: Record<string, unknown>): JobColumnFilters =>
  readColumnFilters(query, JOB_FILTERABLE);

export function isJobFilterColumn(v: unknown): v is JobFilterColumn {
  return isColumnOf(JOB_FILTERABLE, v);
}

export function jobListWhere(f: JobFilters, except?: JobFilterColumn): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.scopeSql) { where.push(f.scopeSql); params.push(...(f.scopeParams ?? [])); }
  if (f.orderId) { where.push('w.order_id = ?'); params.push(f.orderId); }
  if (f.awaiting) where.push(DUE_TO_START('w'));
  if (f.machineId) { where.push('w.machine_id = ?'); params.push(f.machineId); }
  if (f.locationId) { where.push('w.location_id = ?'); params.push(f.locationId); }
  // Export or domestic is the **order's** flag: a job has none of its own, and
  // giving it one would be a second copy able to disagree with the document.
  if (f.isExport !== undefined) { where.push('o.is_export = ?'); params.push(f.isExport); }
  // The job's own company, not the order's — they agree by construction
  // (`insertJob` takes it from the order) and this is the one the number was
  // drawn from, which is what somebody filtering by entity is looking at.
  if (f.companyId) { where.push('w.company_id = ?'); params.push(f.companyId); }
  const search = jobSearchClause(f.q);
  if (search.sql) { where.push(search.sql); params.push(...search.params); }
  if (f.openOnly) where.push("w.status NOT IN ('done','cancelled')");
  const inner = `${listSql} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;

  const cols = columnWhere(JOB_FILTERABLE, f.columns, except);
  params.push(...cols.params);
  return {
    sql: `SELECT * FROM (${inner}) t${cols.sql.length ? ` WHERE ${cols.sql.join(' AND ')}` : ''}`,
    params,
  };
}

/**
 * What one column's tick list should offer, over the whole filtered list — see
 * `facetOver`, which owns the rule that it is measured with every filter but
 * this column's own.
 */
export function jobFacet(
  f: JobFilters,
  column: JobFilterColumn,
  opts: { search?: string; limit?: number } = {},
): Facet {
  const { sql, params } = jobListWhere(f, column);
  return facetOver(sql, params, JOB_FILTERABLE[column].sql, opts);
}

/*
 * Clubbed by sales order (2026-09-15, at the client's word): the newest order
 * first, its jobs in line order under it. A total ordering, so an order's jobs
 * never split across a page boundary by chance — only by the page being full.
 * Over the wrapper's own aliases: `o` and `w` are out of scope outside it,
 * which is why `o.date` is selected as `order_date`.
 */
export const JOB_ORDER = 'ORDER BY order_date DESC, order_id DESC, order_line, id';
/**
 * Jobs, planned pieces and pieces made across every job matching the filters.
 * Derived from `production_entries` here exactly as `progressForMany` derives
 * it per job — nothing about progress is stored, at either scale.
 */
export function jobSummary(f: JobFilters) {
  const { sql, params } = jobListWhere(f);
  return db.prepare(
    `WITH f AS (${sql})
     SELECT (SELECT COUNT(*) FROM f) AS jobs,
            -- Still to plan, over the whole filtered set: the chip that names
            -- the queue must not count the page in hand.
            (SELECT COUNT(*) FROM f WHERE status = 'planned') AS unplanned,
            -- Due to start with no answer yet. Over the whole filtered set for
            -- the reason the queue above it is: a count of the page in hand
            -- shrinks as you page through it.
            (SELECT COUNT(*) FROM f WHERE due_to_start = 1) AS awaiting,
            COALESCE((SELECT SUM(qty_planned) FROM f), 0) AS planned,
            COALESCE((SELECT SUM(${LIVE_OK('e')}) FROM production_entries e
                       WHERE e.work_order_id IN (SELECT id FROM f)), 0) AS made`
  ).get(...(params as never[])) as { jobs: number; unplanned: number; planned: number; made: number };
}