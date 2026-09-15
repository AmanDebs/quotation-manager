import { Router } from 'express';
import type { AuthedRequest } from '../middleware/auth.js';
import { requirePermission } from '../middleware/auth.js';
import { scopeClause } from '../middleware/scope.js';
import { fiscalYearRange } from '../services/numbering.js';
import type { Response } from 'express';
import { buildXlsx, attachmentName, type Column } from '../services/xlsx.js';
import {
  plannedReport, unscheduledReport, dispatchReport, dueReport,
  type ReportFilter, type Pivot, type PivotRow, type DueReport,
} from '../services/reports.js';

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
