import { Router } from 'express';
import type { AuthedRequest } from '../middleware/auth.js';
import { requirePermission } from '../middleware/auth.js';
import { scopeClause } from '../middleware/scope.js';
import { fiscalYearRange } from '../services/numbering.js';
import { plannedReport, unscheduledReport, dispatchReport, dueReport, type ReportFilter } from '../services/reports.js';

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

reportsRouter.get('/planned', requirePermission('proforma'), (req: AuthedRequest, res) => {
  res.json(plannedReport(filter(req, 'p.customer_id')));
});

reportsRouter.get('/unscheduled', requirePermission('proforma'), (req: AuthedRequest, res) => {
  res.json(unscheduledReport(filter(req, 'p.customer_id')));
});

reportsRouter.get('/dispatch', requirePermission('invoice'), (req: AuthedRequest, res) => {
  // The current fiscal year unless asked otherwise; the range is echoed so the
  // page can label its columns from what was actually answered.
  const fy = fiscalYearRange(todayIso());
  const iso = (v: unknown, fallback: string) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : fallback);
  const from = iso(req.query.from, fy.from);
  const to = iso(req.query.to, fy.to);
  res.json({ from, to, ...dispatchReport(filter(req, 'i.customer_id'), from, to) });
});

reportsRouter.get('/due', requirePermission('payment'), (req: AuthedRequest, res) => {
  res.json(dueReport(filter(req, 'i.customer_id'), todayIso()));
});
