import { db } from '../db/connection.js';
import { round2 } from './totals.js';
import { STATUS_SQL } from './proformaStatus.js';
import { trackerRows, type InvoiceHead, type TrackerRow } from './invoiceTracker.js';

/**
 * The Reports page: four of the desk's own pivot sheets, derived on read
 * (2026-09-15, from screenshots of the Excel — *Proforma invoice – Planned for
 * production*, *Proforma Invoice yet to be scheduled*, *Proforma invoice –
 * Dispatch by month*, and a customer-wise due list with a colour per row).
 *
 * Nothing here is stored and nothing here is a second opinion: the proforma
 * figures are the documents' own `grand_total`, the invoice balances are
 * `invoiceReceivable`'s through `trackerRows`, and a proforma's status is
 * read through `STATUS_SQL`, so *Expired* means what the list means by it.
 *
 * **Every figure is per currency.** A row is a customer × SPOC × currency,
 * and the grand-total line is one entry per currency — the rule
 * `receivables.ts` states, that money only adds up within one currency. The
 * client draws one currency at a time, the way the dashboard does.
 *
 * The functions take a `ReportFilter` rather than a request so the tests can
 * call them the way `materialSchedule()` is called; the route builds it from
 * `scopeClause` and `?company=`.
 */

export interface ReportFilter {
  /** From `scopeClause(req, '<alias>.customer_id')`; `sql` blank means unrestricted. */
  scope: { sql: string; params: unknown[] };
  /** 0 means every selling entity. */
  companyId: number;
}

export interface PivotRow {
  customer_id: number;
  customer_name: string;
  /** The document's Prepared By — the sheet's SPOC column. Blank stays blank. */
  spoc: string;
  currency: string;
  /** Column key → sum of the documents' grand totals. */
  cells: Record<string, number>;
  /** Column key → how many documents that sum is over. */
  counts: Record<string, number>;
  total: number;
  count: number;
}

export interface PivotTotals { currency: string; cells: Record<string, number>; total: number; count: number }

export interface Pivot {
  /** Column keys, ascending. */
  columns: string[];
  rows: PivotRow[];
  /** One entry per currency present — never one figure across them. */
  totals: PivotTotals[];
}

interface Cell {
  customer_id: number; customer_name: string; spoc: string | null; currency: string;
  col: string; total: number; count: number;
}

/** Fold the grouped SQL rows into the sheet's shape. */
function buildPivot(cells: Cell[], fixedColumns?: string[]): Pivot {
  const rows = new Map<string, PivotRow>();
  const totals = new Map<string, PivotTotals>();
  const columns = new Set<string>(fixedColumns ?? []);
  for (const c of cells) {
    const spoc = String(c.spoc ?? '').trim();
    const key = `${c.customer_id}|${spoc}|${c.currency}`;
    let row = rows.get(key);
    if (!row) {
      row = { customer_id: c.customer_id, customer_name: c.customer_name, spoc, currency: c.currency, cells: {}, counts: {}, total: 0, count: 0 };
      rows.set(key, row);
    }
    row.cells[c.col] = round2((row.cells[c.col] ?? 0) + c.total);
    row.counts[c.col] = (row.counts[c.col] ?? 0) + c.count;
    row.total = round2(row.total + c.total);
    row.count += c.count;
    let t = totals.get(c.currency);
    if (!t) { t = { currency: c.currency, cells: {}, total: 0, count: 0 }; totals.set(c.currency, t); }
    t.cells[c.col] = round2((t.cells[c.col] ?? 0) + c.total);
    t.total = round2(t.total + c.total);
    t.count += c.count;
    columns.add(c.col);
  }
  const list = [...rows.values()].sort((a, b) =>
    a.customer_name.localeCompare(b.customer_name) || a.spoc.localeCompare(b.spoc) || a.currency.localeCompare(b.currency));
  return {
    columns: fixedColumns ?? [...columns].sort(),
    rows: list,
    totals: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}

function scoped(f: ReportFilter, alias: string, extra: string[], params: unknown[]): { where: string; params: unknown[] } {
  const where = [...extra];
  const all = [...params];
  if (f.scope.sql) { where.push(f.scope.sql); all.push(...f.scope.params); }
  if (f.companyId > 0) { where.push(`${alias}.company_id = ?`); all.push(f.companyId); }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params: all };
}

/**
 * The date a sales order is planned for: the **revised** production date,
 * falling back to the originally scheduled one, then the promised one — the
 * sheet's own *Revised* column, which is why the order form got the field
 * back the day this landed. Blank in all three is blank, never today.
 */
const PROD_DATE_SQL = `COALESCE(NULLIF(o.revised_date, ''), NULLIF(o.scheduled_date, ''), NULLIF(o.promised_date, ''), '')`;
const OPEN_ORDER_SQL = `o.status NOT IN ('completed', 'cancelled')`;

const PIVOT_SELECT = `p.customer_id, c.name AS customer_name, p.prepared_by AS spoc, p.currency`;

/**
 * *Planned for production*: every proforma whose booked order is open and has
 * a production date, under that date. `p.status <> 'cancelled'` is the only
 * status guard — a booked proforma reads *Sales Order Generated*, and one
 * whose status was set by hand still has an open order with a date, which is
 * the fact the sheet reports.
 */
export function plannedReport(f: ReportFilter): Pivot {
  const q = scoped(f, 'p', [`p.status <> 'cancelled'`, OPEN_ORDER_SQL, `${PROD_DATE_SQL} <> ''`], []);
  const cells = db.prepare(
    `SELECT ${PIVOT_SELECT}, ${PROD_DATE_SQL} AS col, SUM(p.grand_total) AS total, COUNT(*) AS count
       FROM proforma_invoices p
       JOIN customers c ON c.id = p.customer_id
       JOIN orders o ON o.id = p.order_id
       ${q.where}
      GROUP BY p.customer_id, p.prepared_by, p.currency, col`
  ).all(...(q.params as never[])) as unknown as Cell[];
  return buildPivot(cells);
}

export const UNSCHEDULED_COLUMNS = ['pending', 'confirmed'] as const;

/**
 * *Yet to be scheduled*: **Pending** is a proforma with the buyer (`sent`);
 * **Confirmed – not scheduled** is one the buyer has confirmed or paid an
 * advance on, or one booked whose order has no production date yet — so
 * nothing falls through the gap between this and *Planned for production*:
 * over the booked proformas the two WHEREs are exact complements, and there
 * is a test asserting it. A lapsed offer reads `expired` through
 * `STATUS_SQL` and is nobody's pending work; drafts and cancellations are not
 * offers at all; a booked proforma whose order is finished is finished.
 */
export function unscheduledReport(f: ReportFilter): Pivot {
  const q = scoped(f, 'p', [
    `(${STATUS_SQL} IN ('sent', 'order_confirmed', 'advance_received')
      OR (p.status = 'in_production' AND (o.id IS NULL OR (${OPEN_ORDER_SQL} AND ${PROD_DATE_SQL} = ''))))`,
  ], []);
  const cells = db.prepare(
    `SELECT ${PIVOT_SELECT},
            CASE WHEN ${STATUS_SQL} = 'sent' THEN 'pending' ELSE 'confirmed' END AS col,
            SUM(p.grand_total) AS total, COUNT(*) AS count
       FROM proforma_invoices p
       JOIN customers c ON c.id = p.customer_id
       LEFT JOIN orders o ON o.id = p.order_id
       ${q.where}
      GROUP BY p.customer_id, p.prepared_by, p.currency, col`
  ).all(...(q.params as never[])) as unknown as Cell[];
  return buildPivot(cells, [...UNSCHEDULED_COLUMNS]);
}

/** Every `YYYY-MM` from `from` to `to`, inclusive, so an empty month still has a column. */
export function monthsBetween(from: string, to: string): string[] {
  const a = /^(\d{4})-(\d{2})/.exec(from);
  const b = /^(\d{4})-(\d{2})/.exec(to);
  if (!a || !b) return [];
  const out: string[] = [];
  let y = Number(a[1]); let m = Number(a[2]);
  const endY = Number(b[1]); const endM = Number(b[2]);
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    if (out.length > 600) break;
  }
  return out;
}

/**
 * *Dispatch by month*: commercial invoices under the month of their date —
 * the same bucketing as the dashboard's invoiced-by-month series, so the two
 * agree. Amounts billed, by the client's choice, rather than the value of
 * goods on each lorry.
 */
export function dispatchReport(f: ReportFilter, from: string, to: string): Pivot {
  const q = scoped(f, 'i', ['i.date >= ?', 'i.date <= ?'], [from, to]);
  const cells = db.prepare(
    `SELECT i.customer_id, c.name AS customer_name, i.prepared_by AS spoc, i.currency,
            substr(i.date, 1, 7) AS col, SUM(i.grand_total) AS total, COUNT(*) AS count
       FROM commercial_invoices i
       JOIN customers c ON c.id = i.customer_id
       ${q.where}
      GROUP BY i.customer_id, i.prepared_by, i.currency, col`
  ).all(...(q.params as never[])) as unknown as Cell[];
  return buildPivot(cells, monthsBetween(from, to));
}

/* ------------------------------------------------------------------ due */

export type DueColour = 'red' | 'yellow' | 'green';

export interface DueInvoice {
  id: number; number: string; date: string; grand_total: number; balance_due: number;
  due_date: string; due_on_arrival: boolean;
  /** Negative when overdue; null when there is no due date to count to. */
  days_to_due: number | null;
  colour: DueColour | null;
}

export interface DueGroup {
  customer_id: number; customer_name: string; currency: string;
  /** Over the dated invoices in the window only. */
  invoiced: number; due: number;
  invoices: DueInvoice[];
  /** Owing money, with neither a typed due date nor a shipment ETA — listed, never dropped. */
  undated: { count: number; due: number; invoices: DueInvoice[] };
}

export interface DueReport {
  today: string; window_days: number; until: string;
  groups: DueGroup[];
  undated_count: number;
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`, in UTC so no timezone touches it. */
export function daysBetween(from: string, to: string): number | null {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from);
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(to);
  if (!a || !b) return null;
  const ms = Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3]);
  return Math.round(ms / 86_400_000);
}

export function addDaysIso(date: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return '';
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + days)).toISOString().slice(0, 10);
}

/**
 * The client's own colours: red once the date has passed, yellow for the
 * week in front of it (today counts), green for the week after that.
 */
export function dueColour(days: number): DueColour | null {
  if (days < 0) return 'red';
  if (days <= 7) return 'yellow';
  if (days <= 14) return 'green';
  return null;
}

/**
 * Customer-wise, every invoice still owing money whose due date is within
 * the window or already past. The balance and the due date are
 * `trackerRows`' — typed `due_date`, else the shipment's ETA — so this and
 * the Receivables tracker cannot disagree about a row.
 */
export function dueReport(f: ReportFilter, today: string, windowDays = 14): DueReport {
  const q = scoped(f, 'i', [], []);
  const heads = db.prepare(
    `SELECT i.id, i.number, i.date, i.customer_id, COALESCE(c.name, '') AS customer_name,
            i.currency, i.is_export, i.grand_total, i.due_date
       FROM commercial_invoices i LEFT JOIN customers c ON c.id = i.customer_id
       ${q.where}
      ORDER BY i.date, i.id`
  ).all(...(q.params as never[])) as unknown as InvoiceHead[];
  const until = addDaysIso(today, windowDays);
  const groups = new Map<string, DueGroup>();
  const groupFor = (r: TrackerRow) => {
    const key = `${r.customer_id}|${r.currency}`;
    let g = groups.get(key);
    if (!g) {
      g = { customer_id: r.customer_id, customer_name: r.customer_name, currency: r.currency, invoiced: 0, due: 0, invoices: [], undated: { count: 0, due: 0, invoices: [] } };
      groups.set(key, g);
    }
    return g;
  };
  for (const r of trackerRows(heads, false)) {
    if (r.balance_due <= 0) continue;
    const base = { id: r.id, number: r.number, date: r.date, grand_total: r.grand_total, balance_due: r.balance_due, due_date: r.due_date, due_on_arrival: r.due_on_arrival };
    if (!r.due_date) {
      const g = groupFor(r);
      g.undated.count += 1;
      g.undated.due = round2(g.undated.due + r.balance_due);
      g.undated.invoices.push({ ...base, days_to_due: null, colour: null });
      continue;
    }
    if (r.due_date > until) continue;
    const days = daysBetween(today, r.due_date);
    const g = groupFor(r);
    g.invoiced = round2(g.invoiced + r.grand_total);
    g.due = round2(g.due + r.balance_due);
    g.invoices.push({ ...base, days_to_due: days, colour: days == null ? null : dueColour(days) });
  }
  const list = [...groups.values()]
    .filter((g) => g.invoices.length > 0 || g.undated.count > 0)
    .sort((a, b) => a.customer_name.localeCompare(b.customer_name) || a.currency.localeCompare(b.currency));
  for (const g of list) g.invoices.sort((a, b) => a.due_date.localeCompare(b.due_date) || a.number.localeCompare(b.number));
  return { today, window_days: windowDays, until, groups: list, undated_count: list.reduce((n, g) => n + g.undated.count, 0) };
}
