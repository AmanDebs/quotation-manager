import { Router } from 'express';
import type { AuthedRequest } from '../middleware/auth.js';
import { requirePermission, allows } from '../middleware/auth.js';
import { scopeClause } from '../middleware/scope.js';
import { fiscalYearRange } from '../services/numbering.js';
import type { Response } from 'express';
import { buildXlsx, attachmentName, type Column } from '../services/xlsx.js';
import {
  plannedReport, unscheduledReport, dispatchReport, dueReport, bookReport,
  type ReportFilter, type Pivot, type PivotRow, type DueReport,
  type BookDoc, type BookGroupBy, type BookReport,
} from '../services/reports.js';
import { priceHistory, type PriceHistory } from '../services/priceHistory.js';

/**
 * The Reports page's four sheets. Mounted on `requireAuth` alone and guarded
 * **per route**, because the four do not belong to one function: the proforma
 * pivots are `proforma`, the invoiced-by-month one is `invoice`, and the due
 * list is `payment` — the Receivables tracker's own cell, whose figures it
 * reads. A single mount on any one of them would either open a price to a
 * role that may not read it or refuse a role its own sheet — the trap the
 * work-orders mount recorded. Every route is a GET; nothing here writes.
 */
export const reportsRouter = Router();

const filter = (req: AuthedRequest, column: string): ReportFilter => ({
  scope: scopeClause(req, column),
  companyId: Number(req.query.company) > 0 ? Number(req.query.company) : 0,
});

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Each sheet downloads as the spreadsheet it came from. `?currency=` narrows
 * to the one the page is showing; without it every row goes, with its
 * currency in a column — never added across. Grand totals are per currency
 * and close the sheet, one line each, as the screen draws them.
 */
type Row = Record<string, unknown>;
function sendXlsx(res: Response, name: string, cols: Column<Row>[], rows: Row[]) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${attachmentName(name)}"`);
  res.send(buildXlsx(name, cols, rows));
}

function pivotXlsx(res: Response, name: string, p: Pivot, labels: (col: string) => string, currency: string) {
  const rows: Row[] = (currency ? p.rows.filter((r) => r.currency === currency) : p.rows)
    .map((r: PivotRow) => ({ customer: r.customer_name, spoc: r.spoc, currency: r.currency, ...r.cells, total: r.total }));
  for (const t of p.totals) {
    if (currency && t.currency !== currency) continue;
    rows.push({ customer: 'Grand Total', spoc: '', currency: t.currency, ...t.cells, total: t.total });
  }
  const cols: Column<Row>[] = [
    { header: 'Customer', value: (r) => String(r.customer ?? '') },
    { header: 'SPOC', value: (r) => String(r.spoc ?? '') },
    { header: 'Currency', value: (r) => String(r.currency ?? '') },
    ...p.columns.map((c): Column<Row> => ({ header: labels(c), value: (r) => (r[c] as number | undefined) ?? null, type: 'money' })),
    { header: 'Total', value: (r) => r.total as number, type: 'money' },
  ];
  sendXlsx(res, name, cols, rows);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (iso: string) => {
  const [, m, d] = iso.split('-').map(Number);
  return m >= 1 && m <= 12 ? `${d}-${MONTHS[m - 1]}` : iso;
};
const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return m >= 1 && m <= 12 ? `${MONTHS[m - 1]} ${y}` : ym;
};
const currencyOf = (req: AuthedRequest) => String(req.query.currency ?? '').trim().toUpperCase();

function dueXlsx(res: Response, d: DueReport, currency: string) {
  const rows: Row[] = [];
  const status = (c: string | null) => (c === 'red' ? 'Overdue' : c === 'yellow' ? 'Due within 7 days' : c === 'green' ? 'Due in 8-14 days' : 'No due date');
  for (const g of d.groups) {
    if (currency && g.currency !== currency) continue;
    for (const i of [...g.invoices, ...g.undated.invoices]) {
      rows.push({ customer: g.customer_name, currency: g.currency, number: i.number, date: i.date, amount: i.grand_total, due: i.balance_due, due_date: i.due_date, basis: i.due_on_arrival ? 'on arrival' : '', days: i.days_to_due, status: status(i.colour) });
    }
    rows.push({ customer: `${g.customer_name} Total`, currency: g.currency, number: '', date: '', amount: g.invoiced, due: g.due + g.undated.due, due_date: '', basis: '', days: null, status: '' });
  }
  sendXlsx(res, 'Due', [
    { header: 'Customer', value: (r) => String(r.customer) },
    { header: 'Currency', value: (r) => String(r.currency) },
    { header: 'Invoice', value: (r) => String(r.number) },
    { header: 'Invoice date', value: (r) => (r.date as string) || null, type: 'date' },
    { header: 'Invoice amount', value: (r) => r.amount as number, type: 'money' },
    { header: 'Due amount', value: (r) => r.due as number, type: 'money' },
    { header: 'Due date', value: (r) => (r.due_date as string) || null, type: 'date' },
    { header: 'Basis', value: (r) => String(r.basis) },
    { header: 'Days to due', value: (r) => (r.days as number | null), type: 'number' },
    { header: 'Status', value: (r) => String(r.status) },
  ], rows);
}

/** The current fiscal year unless asked otherwise; echoed so the page labels its columns from what was answered. */
function dispatchRange(req: AuthedRequest): { from: string; to: string } {
  const fy = fiscalYearRange(todayIso());
  const iso = (v: unknown, fallback: string) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : fallback);
  return { from: iso(req.query.from, fy.from), to: iso(req.query.to, fy.to) };
}

// The exports, declared above the JSON routes they mirror.
reportsRouter.get('/planned/export', requirePermission('proforma'), (req: AuthedRequest, res) => {
  pivotXlsx(res, 'Planned for production', plannedReport(filter(req, 'p.customer_id')), dayLabel, currencyOf(req));
});
reportsRouter.get('/unscheduled/export', requirePermission('proforma'), (req: AuthedRequest, res) => {
  const labels: Record<string, string> = { pending: 'Pending', confirmed: 'Confirmed - not scheduled' };
  pivotXlsx(res, 'Yet to be scheduled', unscheduledReport(filter(req, 'p.customer_id')), (c) => labels[c] ?? c, currencyOf(req));
});
reportsRouter.get('/dispatch/export', requirePermission('invoice'), (req: AuthedRequest, res) => {
  const { from, to } = dispatchRange(req);
  pivotXlsx(res, 'Dispatch by month', dispatchReport(filter(req, 'i.customer_id'), from, to), monthLabel, currencyOf(req));
});
reportsRouter.get('/due/export', requirePermission('payment'), (req: AuthedRequest, res) => {
  dueXlsx(res, dueReport(filter(req, 'i.customer_id'), todayIso()), currencyOf(req));
});

reportsRouter.get('/planned', requirePermission('proforma'), (req: AuthedRequest, res) => {
  res.json(plannedReport(filter(req, 'p.customer_id')));
});

reportsRouter.get('/unscheduled', requirePermission('proforma'), (req: AuthedRequest, res) => {
  res.json(unscheduledReport(filter(req, 'p.customer_id')));
});

reportsRouter.get('/dispatch', requirePermission('invoice'), (req: AuthedRequest, res) => {
  const { from, to } = dispatchRange(req);
  res.json({ from, to, ...dispatchReport(filter(req, 'i.customer_id'), from, to) });
});

reportsRouter.get('/due', requirePermission('payment'), (req: AuthedRequest, res) => {
  res.json(dueReport(filter(req, 'i.customer_id'), todayIso()));
});


/* ------------------------------------------------------------------ *
 * The sales book
 * ------------------------------------------------------------------ */

/**
 * Which of the three the caller may actually read.
 *
 * This sheet spans three functions, and the rule is `customerSummary`'s:
 * **a document kind the caller may not read is absent, not empty**, decided
 * here rather than on the client, which must never hold a second copy of the
 * access table. So a login with `order` alone gets the sales orders and is
 * told so by `included`, rather than a page that silently looks like a short
 * book.
 */
function bookDocs(req: AuthedRequest): BookDoc[] {
  const out: BookDoc[] = [];
  if (allows(req, 'order')) out.push('order');
  if (allows(req, 'proforma')) out.push('proforma');
  if (allows(req, 'quotation')) out.push('quotation');
  return out;
}

const bookGroupBy = (req: AuthedRequest): BookGroupBy =>
  (String(req.query.by ?? '') === 'country' ? 'country' : 'customer');

/**
 * Every live line of the selling book, by customer or by where it is going.
 *
 * Mounted on no one function — see `bookDocs`. A caller holding none of the
 * three is refused outright rather than handed an empty sheet, which would
 * read as *there is no business* rather than as *this is not yours*.
 */
function book(req: AuthedRequest): BookReport | null {
  const docs = bookDocs(req);
  if (!docs.length) return null;
  // Scoped on `c.id`: all three parts join `customers c`, so one clause
  // covers them and a part added later is scoped by construction.
  return bookReport(filter(req, 'c.id'), { by: bookGroupBy(req), docs });
}

reportsRouter.get('/book', (req: AuthedRequest, res) => {
  const out = book(req);
  if (!out) return res.status(403).json({ error: 'You do not have access to any of the sales documents' });
  return res.json(out);
});

const DOC_LABEL: Record<BookDoc, string> = {
  order: 'Sales Order',
  proforma: 'Proforma',
  quotation: 'Quotation',
};

/**
 * The sheet as a spreadsheet: one row per line, the group on every row so the
 * file can be pivoted in Excel the way the desk already does. The whole
 * filtered set, never a page, and `?currency=` narrows to the one on screen.
 */
reportsRouter.get('/book/export', (req: AuthedRequest, res) => {
  const out = book(req);
  if (!out) return res.status(403).json({ error: 'You do not have access to any of the sales documents' });
  const only = String(req.query.currency ?? '').trim();
  const rows: Row[] = [];
  for (const g of out.groups) {
    for (const l of g.lines) {
      if (only && l.currency !== only) continue;
      rows.push({ ...l, group: g.label });
    }
  }
  /*
   * No separate column for the grouping: every row already carries its
   * customer *and* its destination, so the file pivots on either — where a
   * group column would simply repeat one of them under a second heading.
   */
  const cols: Column<Row>[] = [
    { header: 'Document', value: (r) => DOC_LABEL[r.doc as BookDoc] ?? String(r.doc ?? '') },
    { header: 'Number', value: (r) => String(r.number ?? '') },
    { header: 'Date', value: (r) => String(r.date ?? ''), type: 'date' },
    { header: 'Customer', value: (r) => String(r.customer_name ?? '') },
    { header: 'Country / destination', value: (r) => String(r.country ?? '') },
    // Where that came from, so a row placed by the buyer's registered country
    // is not read as a shipping destination.
    { header: 'Placed by', value: (r) => String(r.country_from ?? '') },
    { header: 'Product', value: (r) => String(r.product ?? '') },
    { header: 'Line description', value: (r) => String(r.description ?? '') },
    { header: 'Colour', value: (r) => String(r.color ?? '') },
    { header: 'Qty', value: (r) => (r.qty == null ? '' : Number(r.qty)), type: 'number' },
    { header: 'Unit', value: (r) => String(r.unit ?? '') },
    { header: 'Unit price', value: (r) => Number(r.unit_price ?? 0), type: 'money' },
    { header: 'Currency', value: (r) => String(r.currency ?? '') },
    { header: 'Total', value: (r) => Number(r.amount ?? 0), type: 'money' },
  ];
  return sendXlsx(res, 'Sales book', cols, rows);
});


/* ------------------------------------------------------------------ *
 * The price history of one product
 * ------------------------------------------------------------------ */

/**
 * What one product has been priced at over time, and to whom.
 *
 * It spans the same three functions as the sales book and is gated the same
 * way, through `bookDocs` — a kind the caller may not read is absent, not
 * empty, and a caller holding none of the three is refused rather than handed
 * an empty chart, which would read as *we have never priced this*.
 *
 * **No default date range here.** The client fills the last two years in, so
 * the dates are on screen and editable before anything is asked for — the
 * `DEFAULT_VALIDITY_DAYS` rule, that a default the form shows is one somebody
 * can disagree with, where a default applied at the server would be a window
 * nobody chose and nobody can see.
 */
function history(req: AuthedRequest): PriceHistory | null {
  const docs = bookDocs(req);
  if (!docs.length) return null;
  const str = (k: string) => String(req.query[k] ?? '').trim();
  return priceHistory(filter(req, 'c.id'), {
    productId: Number(req.query.product) || 0,
    customerId: Number(req.query.customer_id) || 0,
    from: str('from'),
    to: str('to'),
    docs,
  });
}

const NO_DOCS = 'You do not have access to any of the sales documents';

reportsRouter.get('/price-history', (req: AuthedRequest, res) => {
  // Without a product there is no question to answer — this report is about
  // one catalogue row, and an unfiltered price list of the whole book would
  // be a different report wearing these words.
  if (!(Number(req.query.product) > 0)) return res.status(400).json({ error: 'Name a product to see its price history' });
  const out = history(req);
  if (!out) return res.status(403).json({ error: NO_DOCS });
  // An id that is not on file is refused rather than answered with an empty
  // chart, which would read as *we have never priced this*.
  if (!out.product_name) return res.status(404).json({ error: 'Product not found' });
  return res.json(out);
});

/**
 * The same points as a spreadsheet, one row each — including the ones with no
 * comparable rate, since the screen shows those too and the download has to
 * match it. The rate is written **twice**: as the document holds it, and
 * normalised, so the file can be charted without redoing the conversion and
 * checked without trusting it.
 */
reportsRouter.get('/price-history/export', (req: AuthedRequest, res) => {
  if (!(Number(req.query.product) > 0)) return res.status(400).json({ error: 'Name a product to see its price history' });
  const out = history(req);
  if (!out) return res.status(403).json({ error: NO_DOCS });
  if (!out.product_name) return res.status(404).json({ error: 'Product not found' });
  const only = String(req.query.currency ?? '').trim();
  const rows: Row[] = [...out.series.flatMap((s) => s.points), ...out.incomparable]
    .filter((p) => !only || p.currency === only)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || Number(a.doc_id) - Number(b.doc_id))
    .map((p) => ({ ...p, product: out.product_name }));
  const cols: Column<Row>[] = [
    { header: 'Date', value: (r) => String(r.date ?? ''), type: 'date' },
    { header: 'Document', value: (r) => DOC_LABEL[r.doc as BookDoc] ?? String(r.doc ?? '') },
    { header: 'Number', value: (r) => String(r.number ?? '') },
    { header: 'Status', value: (r) => String(r.status ?? '') },
    { header: 'Customer', value: (r) => String(r.customer_name ?? '') },
    { header: 'Product', value: (r) => String(r.product ?? '') },
    { header: 'Colour', value: (r) => String(r.color ?? '') },
    { header: 'Qty', value: (r) => (r.qty == null ? '' : Number(r.qty)), type: 'number' },
    { header: 'Unit', value: (r) => String(r.unit ?? '') },
    { header: 'Pieces', value: (r) => (r.pieces == null ? '' : Number(r.pieces)), type: 'number' },
    { header: 'Rate', value: (r) => Number(r.unit_price ?? 0), type: 'money' },
    // Blank, never zero, on a basis that states no piece count: a weight line
    // has a real price and no comparable one, and 0 would read as free.
    { header: 'Rate per 1000 pcs', value: (r) => (r.per1000 == null ? '' : Number(r.per1000)), type: 'money' },
    { header: 'Currency', value: (r) => String(r.currency ?? '') },
    { header: 'Amount', value: (r) => Number(r.amount ?? 0), type: 'money' },
  ];
  return sendXlsx(res, `Price history ${out.product_name}`.trim(), cols, rows);
});
