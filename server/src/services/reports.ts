import { db } from '../db/connection.js';
import { ORDER_JOB_END } from './production.js';
import { round2 } from './totals.js';
import { monthsBetween } from './months.js';
import { STATUS_SQL, statusSqlFor } from './proformaStatus.js';
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
 * sheet's own *Revised* column — and since the order form stopped offering
 * any of the three (2026-09-25), finally to the latest finish across the
 * order's own live jobs. Blank in all four is blank, never today.
 *
 * The fallback is what keeps these two sheets answering at all. Both read this
 * one expression — *Planned for production* is the orders it can date and
 * *Yet to be scheduled* is the rest — so they stay **exact complements** over
 * the booked proformas however many steps it grows, which is what the
 * complement test asserts. Without it every order raised since that date fell
 * to the second sheet for ever, whatever the floor had planned.
 */
const PROD_DATE_SQL = `COALESCE(NULLIF(o.revised_date, ''), NULLIF(o.scheduled_date, ''), NULLIF(o.promised_date, ''), ${ORDER_JOB_END('o')}, '')`;
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

/**
 * Every `YYYY-MM` from `from` to `to`, inclusive, so an empty month still has
 * a column. It lives in `services/months.ts` since the order-book pivot wants
 * it too, and is re-exported here because this is where its callers look.
 */
export { monthsBetween };

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

/* ------------------------------------------------------------------ *
 * The sales book: every live line, by customer or by where it is going
 * ------------------------------------------------------------------ */

/**
 * One listing over the three selling documents that are still somebody's work
 * (2026-10-16, the client: *"Is there a report which can give me summary of
 * country wise or customer wise: All Sales order, PI (not converted to SO),
 * Quotation (not converted to PI) — capturing date, product info, qty, unit
 * price and total"*).
 *
 * It is the one question the app could not answer: the order book's *Order
 * lines* view is sales orders alone, and nothing anywhere put the offers still
 * open beside the business already won.
 *
 * **Nothing is counted twice, and the rule is each document's own.** A
 * proforma appears only while `order_id IS NULL` — the back-pointer booking
 * sets, which is what `lockError` already reads as *converted* — and a
 * quotation only while no proforma names it, which is `quotationLockedBy`'s
 * own test rather than the `accepted` status it happens to set (a quotation
 * whose proforma was deleted is open again, and says so here). So the three
 * groups partition the live book: a line is in exactly one of them.
 *
 * **Dead documents are left out** at the client's word — a cancelled order, a
 * cancelled or lapsed proforma, a rejected or lapsed quotation. Lapsed is read
 * through `statusSqlFor`, so *expired* means here what the proforma list means
 * by it rather than a second reading of the same dates.
 *
 * **Charge lines are excluded**, the rule every reader of an item table
 * follows: freight is not a product and has no quantity anybody is selling.
 */
export type BookDoc = 'order' | 'proforma' | 'quotation';
export type BookGroupBy = 'customer' | 'country';

export interface BookLine {
  doc: BookDoc;
  doc_id: number;
  number: string;
  date: string;
  customer_id: number;
  customer_name: string;
  /** The destination as the document states it, else the customer's country. */
  country: string;
  /** Which of the two the line above came from — `''` when neither states one. */
  country_from: 'destination' | 'customer' | '';
  /** The catalogue product where the line names one, else its own wording. */
  product: string;
  description: string;
  color: string;
  /** The **billing** quantity and its basis, so qty × unit price is the total. */
  qty: number | null;
  unit: string;
  unit_price: number;
  currency: string;
  amount: number;
}

export interface BookTotal { currency: string; amount: number; lines: number }

export interface BookGroup {
  key: string;
  label: string;
  /** How many documents of each kind this group's lines came from. */
  counts: Record<BookDoc, number>;
  /** Per currency, never one figure across them. */
  totals: BookTotal[];
  lines: BookLine[];
}

export interface BookReport {
  by: BookGroupBy;
  /** The document kinds the caller may read — absent, not empty, is the rule. */
  included: BookDoc[];
  groups: BookGroup[];
  totals: BookTotal[];
  /** Lines the record cannot place under any country. */
  unplaced: number;
}

/**
 * Where a line is going, in the document's own words.
 *
 * The client chose the **destination**, falling back to the customer's
 * country — and the reason is one this file's neighbours already record: Aglo
 * sells to Africa through Dubai and Mauritius intermediaries who are
 * registered in India, so the customer's country answers *who we invoice*
 * rather than *where the goods go*. It is also the practical answer, the
 * customer import having carried no country column at all, which leaves that
 * field at its `'India'` default for most of the book.
 *
 * **Stated, never parsed.** A destination of *Nacala, Mozambique* groups under
 * exactly that rather than being reduced to a country name — picking a word
 * out of a port is the guess `incoBasis` records the cost of, and the desk can
 * see and correct what it typed. A quotation carries no destination field at
 * all, so it is always placed by its customer.
 */
function placeOf(r: { destination: string; customer_country: string }): Pick<BookLine, 'country' | 'country_from'> {
  const dest = String(r.destination ?? '').trim();
  if (dest) return { country: dest, country_from: 'destination' };
  const home = String(r.customer_country ?? '').trim();
  if (home) return { country: home, country_from: 'customer' };
  return { country: '', country_from: '' };
}

interface BookRow {
  doc: BookDoc; doc_id: number; number: string; date: string;
  customer_id: number; customer_name: string; customer_country: string;
  destination: string; currency: string;
  product: string; description: string; color: string;
  qty: number | null; unit: string; unit_price: number; amount: number;
}

/**
 * The three parts of the union, each naming its own *still open* rule.
 *
 * Every part joins `customers c`, which is what lets one `scopeClause` on
 * `c.id` cover all three — a scope clause per alias would be three chances to
 * forget one.
 */
function bookParts(docs: BookDoc[], companyId: number): { sql: string[]; params: unknown[] } {
  const sql: string[] = [];
  const params: unknown[] = [];
  const company = (alias: string) => {
    if (!(companyId > 0)) return '';
    params.push(companyId);
    return ` AND ${alias}.company_id = ?`;
  };
  const head = (doc: BookDoc, alias: string, dest: string) => `
    SELECT '${doc}' AS doc, ${alias}.id AS doc_id, ${alias}.number AS number, ${alias}.date AS date,
           ${alias}.customer_id AS customer_id, COALESCE(c.name, '') AS customer_name,
           COALESCE(c.country, '') AS customer_country, ${dest} AS destination,
           ${alias}.currency AS currency,
           COALESCE(NULLIF(pr.name, ''), it.description, '') AS product,
           COALESCE(it.description, '') AS description, COALESCE(it.color, '') AS color,
           it.qty AS qty, COALESCE(it.unit, '') AS unit,
           COALESCE(it.unit_price, 0) AS unit_price, COALESCE(it.amount, 0) AS amount,
           it.sort_order AS sort_order, it.id AS line_id`;

  if (docs.includes('order')) {
    sql.push(`${head('order', 'o', "COALESCE(NULLIF(o.port_of_discharge, ''), '')")}
      FROM order_items it
      JOIN orders o ON o.id = it.order_id
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN products pr ON pr.id = it.product_id
     WHERE COALESCE(it.is_charge, 0) = 0
       AND o.status <> 'cancelled'${company('o')}`);
  }
  if (docs.includes('proforma')) {
    // Open means **not booked**: `order_id` is the back-pointer booking sets,
    // and it is what freezes the proforma everywhere else in the app.
    sql.push(`${head('proforma', 'pi', "COALESCE(NULLIF(pi.final_destination, ''), NULLIF(pi.port_of_discharge, ''), '')")}
      FROM pi_items it
      JOIN proforma_invoices pi ON pi.id = it.pi_id
      JOIN customers c ON c.id = pi.customer_id
      LEFT JOIN products pr ON pr.id = it.product_id
     WHERE COALESCE(it.is_charge, 0) = 0
       AND pi.order_id IS NULL
       AND pi.status <> 'cancelled'
       AND ${statusSqlFor('pi')} <> 'expired'${company('pi')}`);
  }
  if (docs.includes('quotation')) {
    // A quotation is converted when a proforma **names** it, which is the test
    // `quotationLockedBy` uses — not the `accepted` status that conversion
    // happens to set, since deleting that proforma opens the quotation again.
    // A superseded revision is last round's answer and is never its own line.
    sql.push(`${head('quotation', 'q', "''")}
      FROM quotation_items it
      JOIN quotations q ON q.id = it.quotation_id
      JOIN customers c ON c.id = q.customer_id
      LEFT JOIN products pr ON pr.id = it.product_id
     WHERE COALESCE(it.is_charge, 0) = 0
       AND q.superseded_by IS NULL
       AND q.status NOT IN ('rejected', 'expired')
       AND NOT EXISTS (SELECT 1 FROM proforma_invoices x WHERE x.quotation_id = q.id)${company('q')}`);
  }
  return { sql, params };
}

/** Money only adds up within one currency — `receivables.ts`'s rule. */
function addTo(totals: BookTotal[], currency: string, amount: number) {
  const cur = String(currency || '');
  const found = totals.find((t) => t.currency === cur);
  if (found) { found.amount = round2(found.amount + amount); found.lines += 1; return; }
  totals.push({ currency: cur, amount: round2(amount), lines: 1 });
}

export function bookReport(
  f: ReportFilter,
  opts: { by: BookGroupBy; docs: BookDoc[] },
): BookReport {
  const docs = opts.docs;
  const empty: BookReport = { by: opts.by, included: docs, groups: [], totals: [], unplaced: 0 };
  if (!docs.length) return empty;

  const parts = bookParts(docs, f.companyId);
  if (!parts.sql.length) return empty;

  /*
   * The scope clause goes on the **outside**, over the union's own
   * `customer_id`, so it is written once rather than per part — and a part
   * added later is scoped by construction rather than by remembering.
   */
  const union = parts.sql.join('\n    UNION ALL\n');
  const where = f.scope.sql ? ` WHERE ${f.scope.sql.replace(/\bc\.id\b/g, 'book.customer_id')}` : '';
  const rows = db.prepare(
    `SELECT * FROM (${union}) book${where}
      ORDER BY customer_name, date DESC, number, sort_order, line_id`
  ).all(...([...parts.params, ...f.scope.params] as never[])) as unknown as BookRow[];

  const groups = new Map<string, BookGroup>();
  const totals: BookTotal[] = [];
  let unplaced = 0;

  for (const r of rows) {
    const place = placeOf(r);
    if (!place.country) unplaced += 1;
    const line: BookLine = {
      doc: r.doc,
      doc_id: Number(r.doc_id),
      number: String(r.number ?? ''),
      date: String(r.date ?? ''),
      customer_id: Number(r.customer_id),
      customer_name: String(r.customer_name ?? ''),
      ...place,
      product: String(r.product ?? ''),
      description: String(r.description ?? ''),
      color: String(r.color ?? ''),
      qty: r.qty === null || r.qty === undefined ? null : Number(r.qty),
      unit: String(r.unit ?? ''),
      unit_price: Number(r.unit_price ?? 0),
      currency: String(r.currency ?? ''),
      amount: Number(r.amount ?? 0),
    };

    /*
     * A line the record cannot place is grouped as such rather than dropped —
     * the `finishedGoods` rule about what cannot be placed, and the reason the
     * page can say how many there are instead of quietly showing a shorter
     * book than exists.
     */
    const key = opts.by === 'country' ? (line.country || '') : String(line.customer_id);
    const label = opts.by === 'country'
      ? (line.country || 'Not stated')
      : (line.customer_name || `Customer ${line.customer_id}`);
    let g = groups.get(key);
    if (!g) {
      g = { key, label, counts: { order: 0, proforma: 0, quotation: 0 }, totals: [], lines: [] };
      groups.set(key, g);
    }
    g.lines.push(line);
    addTo(g.totals, line.currency, line.amount);
    addTo(totals, line.currency, line.amount);
  }

  // How many *documents* each group's lines came from, not how many lines.
  for (const g of groups.values()) {
    for (const doc of ['order', 'proforma', 'quotation'] as BookDoc[]) {
      g.counts[doc] = new Set(g.lines.filter((l) => l.doc === doc).map((l) => l.doc_id)).size;
    }
    g.totals.sort((a, b) => a.currency.localeCompare(b.currency));
  }
  totals.sort((a, b) => a.currency.localeCompare(b.currency));

  const list = [...groups.values()].sort((a, b) => {
    // *Not stated* sits last wherever it appears, being an absence rather than
    // a place or a buyer.
    if (!a.key && b.key) return 1;
    if (a.key && !b.key) return -1;
    return a.label.localeCompare(b.label);
  });

  return { by: opts.by, included: docs, groups: list, totals, unplaced };
}
