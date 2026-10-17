import { db } from '../db/connection.js';
import { piecesPerBillingUnit } from './totals.js';
import { statusSqlFor } from './proformaStatus.js';
import type { ReportFilter, BookDoc } from './reports.js';

/**
 * What one product has been priced at, over time, and to whom
 * (2026-10-17, the user: *"show me trends of rate per unit of product x sold
 * to customer A in last 2 years along with date"*).
 *
 * The order book's Rate column answers this one row at a time and the sales
 * book answers it for what is still open; neither puts a price beside the one
 * quoted for the same thing a year earlier, which is the question.
 *
 * Three things decide the shape, and each is a departure from the sheets
 * beside it worth stating.
 *
 * **Dead documents are the point here, not noise.** `bookReport` leaves out a
 * rejected quotation because it is asking what is still live; a price history
 * that dropped them would hide exactly the rows that say *we asked this and
 * lost* — the most informative point on the chart. So every document is read,
 * live or not, each carrying its own status, and the caller narrows.
 *
 * **A rate is only comparable within one basis.** The catalogue is quoted
 * `per 1000` almost everywhere, so a line quoted per piece reads a
 * thousandfold lower against it — on a chart, a cliff that never happened.
 * Every piece-basis line is therefore normalised to **a rate per 1000
 * pieces** by `piecesPerBillingUnit`, which is `services/pdf.ts`'s own rule
 * for the proforma's rate column. A **weight-billed line is not converted** —
 * money divided by kilos is not a price per thousand pieces — and is reported
 * in its own list rather than dropped, so a product sold both ways does not
 * quietly show half its history.
 *
 * **Per currency, never across.** `receivables.ts`'s rule: one series per
 * currency, and no figure spans two.
 */

export type { BookDoc };

export interface PricePoint {
  doc: BookDoc;
  doc_id: number;
  number: string;
  date: string;
  customer_id: number;
  customer_name: string;
  /** The document's own status, as that document's list prints it. */
  status: string;
  /** Still live — not cancelled, rejected, lapsed or superseded. */
  live: boolean;
  currency: string;
  color: string;
  /** The billing quantity, in the line's own basis. */
  qty: number | null;
  /** Pieces, where the basis gives any — `piecesOrdered`'s rule. */
  pieces: number | null;
  unit: string;
  /** The rate exactly as the document holds it, in its own basis. */
  unit_price: number;
  /** That rate per 1000 pieces; null on a basis that has no piece count. */
  per1000: number | null;
  amount: number;
}

export interface PriceSeries {
  currency: string;
  /** Ascending by date, then by id — a total ordering, so *first* is a fact. */
  points: PricePoint[];
  first: number;
  last: number;
  min: number;
  max: number;
  /** First to last, as a percentage; null where the first rate is zero. */
  change_pct: number | null;
}

export interface PriceHistory {
  product_id: number;
  product_name: string;
  /** One entry per currency present. Never one figure across them. */
  series: PriceSeries[];
  /**
   * Lines whose basis has no piece count (kg, tonne). Listed rather than
   * converted, and rather than dropped.
   */
  incomparable: PricePoint[];
  /** The document kinds this caller may read — absent, not empty. */
  included: BookDoc[];
}

export interface PriceQuery {
  productId: number;
  /** 0 or absent means every customer — the spread across the book. */
  customerId?: number;
  from?: string;
  to?: string;
  docs: BookDoc[];
}

interface Row {
  doc: BookDoc; doc_id: number; number: string; date: string;
  customer_id: number; customer_name: string; status: string; live: number;
  currency: string; color: string; unit: string;
  qty: number | null; total_pcs: number | null;
  unit_price: number; amount: number;
}

/**
 * One SELECT per document kind, each joining `customers c` so that a single
 * scope clause on `c.id` covers all three — the rule `bookReport` states, and
 * what makes a part added later scoped by construction rather than by
 * remembering.
 *
 * Each carries its own `live` test, which is that document's own definition
 * and not a fourth one. Note what is deliberately **not** here: a booked
 * proforma is still a real price that was agreed, so unlike the sales book
 * this never reads `order_id`.
 */
function parts(docs: BookDoc[], productId: number, companyId: number): { sql: string[]; params: unknown[] } {
  const sql: string[] = [];
  const params: unknown[] = [];

  const head = (doc: BookDoc, alias: string, status: string, live: string) => `
    SELECT '${doc}' AS doc, ${alias}.id AS doc_id, ${alias}.number AS number, ${alias}.date AS date,
           ${alias}.customer_id AS customer_id, COALESCE(c.name, '') AS customer_name,
           ${status} AS status, ${live} AS live, ${alias}.currency AS currency,
           COALESCE(it.color, '') AS color, COALESCE(it.unit, '') AS unit,
           it.qty AS qty, it.total_pcs AS total_pcs,
           COALESCE(it.unit_price, 0) AS unit_price, COALESCE(it.amount, 0) AS amount`;

  const tail = (table: string, fk: string, parent: string, alias: string) => {
    params.push(productId);
    const company = companyId > 0 ? ` AND ${alias}.company_id = ?` : '';
    if (companyId > 0) params.push(companyId);
    return `
      FROM ${table} it
      JOIN ${parent} ${alias} ON ${alias}.id = it.${fk}
      JOIN customers c ON c.id = ${alias}.customer_id
     WHERE COALESCE(it.is_charge, 0) = 0
       AND it.product_id = ?${company}`;
  };

  if (docs.includes('order')) {
    sql.push(head('order', 'o', 'o.status', `CASE WHEN o.status <> 'cancelled' THEN 1 ELSE 0 END`)
      + tail('order_items', 'order_id', 'orders', 'o'));
  }
  if (docs.includes('proforma')) {
    // The derived status, so *expired* means here what the proforma list
    // means by it — a second reading of the same dates is how two screens
    // come to disagree about which offers lapsed.
    const st = statusSqlFor('pi');
    sql.push(head('proforma', 'pi', st, `CASE WHEN pi.status <> 'cancelled' AND ${st} <> 'expired' THEN 1 ELSE 0 END`)
      + tail('pi_items', 'pi_id', 'proforma_invoices', 'pi'));
  }
  if (docs.includes('quotation')) {
    // A superseded revision is last round's answer: a real price that really
    // was offered, so it is kept and marked rather than left out.
    sql.push(head('quotation', 'q',
      `CASE WHEN q.superseded_by IS NOT NULL THEN 'superseded' ELSE q.status END`,
      `CASE WHEN q.superseded_by IS NULL AND q.status NOT IN ('rejected', 'expired') THEN 1 ELSE 0 END`)
      + tail('quotation_items', 'quotation_id', 'quotations', 'q'));
  }
  return { sql, params };
}

/** The rate per 1000 pieces, or null on a basis with no piece count. */
export function per1000(unitPrice: number, unit: string): number | null {
  const per = piecesPerBillingUnit(unit);
  if (per == null || !(per > 0)) return null;
  // Rounded to four places to kill float noise: 3.017 / 1000 * 1000 comes
  // back as 3.0169999999999995, and a price list reads that as a defect.
  return Math.round((unitPrice / per) * 1000 * 10000) / 10000;
}

const piecesOf = (r: Row): number | null => {
  if (r.total_pcs != null) return Number(r.total_pcs) || 0;
  const per = piecesPerBillingUnit(r.unit);
  return per != null && r.qty != null ? Number(r.qty) * per : null;
};

export function priceHistory(f: ReportFilter, q: PriceQuery): PriceHistory {
  const product = db.prepare('SELECT id, name FROM products WHERE id = ?').get(q.productId) as
    { id: number; name: string } | undefined;

  const empty: PriceHistory = {
    product_id: q.productId,
    product_name: product?.name ?? '',
    series: [],
    incomparable: [],
    included: q.docs,
  };
  if (!product || !q.docs.length) return empty;

  const built = parts(q.docs, q.productId, f.companyId);
  const where: string[] = [];
  const params: unknown[] = [...built.params];

  if (f.scope.sql) {
    // Every part joins `customers c`, so the clause the route built against
    // `c.id` is read against the union's own customer column.
    where.push(f.scope.sql.replace(/\bc\.id\b/g, 'h.customer_id'));
    params.push(...f.scope.params);
  }
  if (q.customerId && q.customerId > 0) { where.push('h.customer_id = ?'); params.push(q.customerId); }
  // A blank date is stored as text and compares as a string, so `'' <= x` is
  // true — the trap `columnWhere` records finding the hard way. Both bounds
  // therefore refuse it rather than sweeping in every undated document.
  if (q.from) { where.push(`h.date <> '' AND h.date >= ?`); params.push(q.from); }
  if (q.to) { where.push(`h.date <> '' AND h.date <= ?`); params.push(q.to); }

  const sql = `SELECT * FROM (${built.sql.join(' UNION ALL ')}) h`
    + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
    + ' ORDER BY h.date, h.doc_id';

  const rows = db.prepare(sql).all(...(params as never[])) as unknown as Row[];

  const byCurrency = new Map<string, PricePoint[]>();
  const incomparable: PricePoint[] = [];

  for (const r of rows) {
    const point: PricePoint = {
      doc: r.doc,
      doc_id: Number(r.doc_id),
      number: String(r.number ?? ''),
      date: String(r.date ?? ''),
      customer_id: Number(r.customer_id),
      customer_name: String(r.customer_name ?? ''),
      status: String(r.status ?? ''),
      live: Number(r.live) === 1,
      currency: String(r.currency ?? ''),
      color: String(r.color ?? ''),
      qty: r.qty == null ? null : Number(r.qty),
      pieces: piecesOf(r),
      unit: String(r.unit ?? ''),
      unit_price: Number(r.unit_price) || 0,
      per1000: per1000(Number(r.unit_price) || 0, String(r.unit ?? '')),
      amount: Number(r.amount) || 0,
    };
    if (point.per1000 == null) { incomparable.push(point); continue; }
    const list = byCurrency.get(point.currency);
    if (list) list.push(point); else byCurrency.set(point.currency, [point]);
  }

  const series: PriceSeries[] = [...byCurrency.entries()]
    .map(([currency, points]) => {
      const rates = points.map((p) => p.per1000 as number);
      const first = rates[0];
      const last = rates[rates.length - 1];
      return {
        currency,
        points,
        first,
        last,
        min: Math.min(...rates),
        max: Math.max(...rates),
        change_pct: first > 0 ? Math.round(((last - first) / first) * 1000) / 10 : null,
      };
    })
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return { ...empty, series, incomparable };
}
