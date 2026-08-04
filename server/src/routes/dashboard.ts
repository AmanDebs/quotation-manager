import { Router } from 'express';
import { db } from '../db/connection.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { scopeClause } from '../middleware/scope.js';
import { receivedByInvoice } from '../services/receivables.js';

export const dashboardRouter = Router();

/**
 * All stats accept ?from=YYYY-MM-DD&to=YYYY-MM-DD and are limited to the
 * caller's customers (managers see everything).
 * Money aggregates are grouped by currency — mixing USD and INR would be meaningless.
 */
dashboardRouter.get('/', (req: AuthedRequest, res) => {
  const from = String(req.query.from ?? '0000-01-01');
  const to = String(req.query.to ?? '9999-12-31');
  const today = new Date().toISOString().slice(0, 10);

  const scope = scopeClause(req, 'customer_id');
  const and = scope.sql ? ` AND ${scope.sql}` : '';
  const p = scope.params;
  // Helper: date-range params followed by the scope params.
  const q = <T>(sql: string, ...extra: unknown[]) => db.prepare(sql).all(...(extra as never[])) as T[];
  const one = (sql: string, ...extra: unknown[]) => (db.prepare(sql).get(...(extra as never[])) as { c: number }).c;

  const counts = {
    quotations: one(`SELECT COUNT(*) AS c FROM quotations WHERE superseded_by IS NULL AND date BETWEEN ? AND ?${and}`, from, to, ...p),
    orders: one(`SELECT COUNT(*) AS c FROM orders WHERE status NOT IN ('cancelled') AND date BETWEEN ? AND ?${and}`, from, to, ...p),
    invoices: one(`SELECT COUNT(*) AS c FROM commercial_invoices WHERE date BETWEEN ? AND ?${and}`, from, to, ...p),
    pendingApprovals: one(
      `SELECT (SELECT COUNT(*) FROM quotations WHERE approval_status = 'pending'${and})
            + (SELECT COUNT(*) FROM proforma_invoices WHERE approval_status = 'pending'${and})
            + (SELECT COUNT(*) FROM commercial_invoices WHERE approval_status = 'pending'${and}) AS c`,
      ...p, ...p, ...p
    ),
  };

  const quotationsByStatus = q(
    `SELECT status, COUNT(*) AS count FROM quotations WHERE superseded_by IS NULL AND date BETWEEN ? AND ?${and} GROUP BY status`,
    from, to, ...p
  );

  const quotedByMonth = q(
    `SELECT substr(date, 1, 7) AS month, currency, SUM(grand_total) AS total
     FROM quotations WHERE superseded_by IS NULL AND date BETWEEN ? AND ?${and} GROUP BY month, currency ORDER BY month`,
    from, to, ...p
  );

  const invoicedByMonth = q(
    `SELECT substr(date, 1, 7) AS month, currency, SUM(grand_total) AS total
     FROM commercial_invoices WHERE date BETWEEN ? AND ?${and} GROUP BY month, currency ORDER BY month`,
    from, to, ...p
  );

  const topCustomers = q(
    `SELECT c.name, q.currency, SUM(q.grand_total) AS total, COUNT(*) AS quotes
     FROM quotations q JOIN customers c ON c.id = q.customer_id
     WHERE q.superseded_by IS NULL AND q.date BETWEEN ? AND ?${scope.sql ? ` AND q.${scope.sql}` : ''}
     GROUP BY c.id, q.currency ORDER BY total DESC LIMIT 8`,
    from, to, ...p
  );

  const topProducts = q(
    `SELECT COALESCE(p.name, qi.description) AS name, COUNT(*) AS times_quoted
     FROM quotation_items qi
     JOIN quotations q ON q.id = qi.quotation_id
     LEFT JOIN products p ON p.id = qi.product_id
     WHERE q.superseded_by IS NULL AND q.date BETWEEN ? AND ?${scope.sql ? ` AND q.${scope.sql}` : ''}
     GROUP BY COALESCE(p.name, qi.description) ORDER BY times_quoted DESC LIMIT 8`,
    from, to, ...p
  );

  const currencyTotals = q(
    `SELECT currency,
       SUM(CASE WHEN status = 'accepted' THEN grand_total ELSE 0 END) AS accepted_value,
       SUM(grand_total) AS quoted_value
     FROM quotations WHERE superseded_by IS NULL AND date BETWEEN ? AND ?${and} GROUP BY currency`,
    from, to, ...p
  );

  const fu = (cond: string, ...extra: unknown[]) => q(
    `SELECT f.*, c.name AS customer_name FROM followups f LEFT JOIN customers c ON c.id = f.customer_id
     WHERE f.done = 0 AND ${cond}${scope.sql ? ` AND f.${scope.sql}` : ''} ORDER BY f.due_date LIMIT 20`,
    ...extra, ...p
  );
  const followups = {
    overdue: fu('f.due_date < ?', today),
    today: fu('f.due_date = ?', today),
    upcoming: fu('f.due_date > ?', today),
  };

  // Receivables: per currency, invoiced value minus payments received. A PI
  // advance is shared across the invoices raised from that PI, so the split
  // comes from services/receivables.ts rather than being recomputed here.
  const invoicesAll = q<{ id: number; pi_id: number | null; currency: string; grand_total: number }>(
    `SELECT id, pi_id, currency, grand_total FROM commercial_invoices${scope.sql ? ` WHERE ${scope.sql}` : ''}`,
    ...p
  );
  const receivedPerInvoice = receivedByInvoice();
  const receivablesMap = new Map<string, { currency: string; invoiced: number; received: number; outstanding: number }>();
  for (const inv of invoicesAll) {
    const received = receivedPerInvoice.get(inv.id) ?? 0;
    const row = receivablesMap.get(inv.currency) ?? { currency: inv.currency, invoiced: 0, received: 0, outstanding: 0 };
    row.invoiced += inv.grand_total;
    row.received += Math.min(received, inv.grand_total);
    row.outstanding += Math.max(0, inv.grand_total - received);
    receivablesMap.set(inv.currency, row);
  }
  const receivables = [...receivablesMap.values()].map((r) => ({
    ...r,
    invoiced: Math.round(r.invoiced * 100) / 100,
    received: Math.round(r.received * 100) / 100,
    outstanding: Math.round(r.outstanding * 100) / 100,
  }));

  // Order book: value still to ship, per currency, plus anything past its
  // promised date. Pending value is order value minus what's been invoiced.
  const openOrders = q<{ id: number; currency: string; grand_total: number; promised_date: string; status: string }>(
    `SELECT id, currency, grand_total, promised_date, status FROM orders
     WHERE status NOT IN ('completed','cancelled')${and}`,
    ...p
  );
  const orderBookMap = new Map<string, { currency: string; open_value: number; pending_value: number; count: number }>();
  let overdueOrders = 0;
  for (const o of openOrders) {
    const invoiced = (db.prepare(
      `SELECT COALESCE(SUM(grand_total), 0) AS v FROM commercial_invoices
       WHERE order_id = ? OR pi_id IN (SELECT id FROM proforma_invoices WHERE order_id = ?)`
    ).get(o.id, o.id) as { v: number }).v;
    const row = orderBookMap.get(o.currency) ?? { currency: o.currency, open_value: 0, pending_value: 0, count: 0 };
    row.open_value += o.grand_total;
    row.pending_value += Math.max(0, o.grand_total - invoiced);
    row.count += 1;
    orderBookMap.set(o.currency, row);
    if (o.promised_date && o.promised_date < today) overdueOrders += 1;
  }
  const orderBook = [...orderBookMap.values()].map((r) => ({
    ...r,
    open_value: Math.round(r.open_value * 100) / 100,
    pending_value: Math.round(r.pending_value * 100) / 100,
  }));

  const funnel = {
    quoted: counts.quotations,
    accepted: one(`SELECT COUNT(*) AS c FROM quotations WHERE superseded_by IS NULL AND status = 'accepted' AND date BETWEEN ? AND ?${and}`, from, to, ...p),
    orders: counts.orders,
    invoiced: counts.invoices,
  };

  res.json({ counts, quotationsByStatus, quotedByMonth, invoicedByMonth, topCustomers, topProducts, currencyTotals, followups, funnel, receivables, orderBook, overdueOrders });
});
