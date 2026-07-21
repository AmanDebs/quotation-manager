import { Router } from 'express';
import { db } from '../db/connection.js';

export const dashboardRouter = Router();

/**
 * All stats accept ?from=YYYY-MM-DD&to=YYYY-MM-DD.
 * Money aggregates are grouped by currency — mixing USD and INR totals would be meaningless.
 */
dashboardRouter.get('/', (req, res) => {
  const from = String(req.query.from ?? '0000-01-01');
  const to = String(req.query.to ?? '9999-12-31');
  const today = new Date().toISOString().slice(0, 10);

  const counts = {
    enquiries: (db.prepare('SELECT COUNT(*) AS c FROM enquiries WHERE date BETWEEN ? AND ?').get(from, to) as { c: number }).c,
    quotations: (db.prepare('SELECT COUNT(*) AS c FROM quotations WHERE superseded_by IS NULL AND date BETWEEN ? AND ?').get(from, to) as { c: number }).c,
    orders: (db.prepare("SELECT COUNT(*) AS c FROM proforma_invoices WHERE status IN ('order_confirmed','advance_received','in_production') AND date BETWEEN ? AND ?").get(from, to) as { c: number }).c,
    invoices: (db.prepare('SELECT COUNT(*) AS c FROM commercial_invoices WHERE date BETWEEN ? AND ?').get(from, to) as { c: number }).c,
  };

  const quotationsByStatus = db.prepare(
    'SELECT status, COUNT(*) AS count FROM quotations WHERE superseded_by IS NULL AND date BETWEEN ? AND ? GROUP BY status'
  ).all(from, to);

  const quotedByMonth = db.prepare(
    `SELECT substr(date, 1, 7) AS month, currency, SUM(grand_total) AS total
     FROM quotations WHERE superseded_by IS NULL AND date BETWEEN ? AND ? GROUP BY month, currency ORDER BY month`
  ).all(from, to);

  const invoicedByMonth = db.prepare(
    `SELECT substr(date, 1, 7) AS month, currency, SUM(grand_total) AS total
     FROM commercial_invoices WHERE date BETWEEN ? AND ? GROUP BY month, currency ORDER BY month`
  ).all(from, to);

  const topCustomers = db.prepare(
    `SELECT c.name, q.currency, SUM(q.grand_total) AS total, COUNT(*) AS quotes
     FROM quotations q JOIN customers c ON c.id = q.customer_id
     WHERE q.superseded_by IS NULL AND q.date BETWEEN ? AND ?
     GROUP BY c.id, q.currency ORDER BY total DESC LIMIT 8`
  ).all(from, to);

  const topProducts = db.prepare(
    `SELECT COALESCE(p.name, qi.description) AS name, COUNT(*) AS times_quoted
     FROM quotation_items qi
     JOIN quotations q ON q.id = qi.quotation_id
     LEFT JOIN products p ON p.id = qi.product_id
     WHERE q.superseded_by IS NULL AND q.date BETWEEN ? AND ?
     GROUP BY COALESCE(p.name, qi.description) ORDER BY times_quoted DESC LIMIT 8`
  ).all(from, to);

  const currencyTotals = db.prepare(
    `SELECT currency,
       SUM(CASE WHEN status = 'accepted' THEN grand_total ELSE 0 END) AS accepted_value,
       SUM(grand_total) AS quoted_value
     FROM quotations WHERE superseded_by IS NULL AND date BETWEEN ? AND ? GROUP BY currency`
  ).all(from, to);

  const followups = {
    overdue: db.prepare(
      `SELECT f.*, c.name AS customer_name FROM followups f LEFT JOIN customers c ON c.id = f.customer_id
       WHERE f.done = 0 AND f.due_date < ? ORDER BY f.due_date LIMIT 20`
    ).all(today),
    today: db.prepare(
      `SELECT f.*, c.name AS customer_name FROM followups f LEFT JOIN customers c ON c.id = f.customer_id
       WHERE f.done = 0 AND f.due_date = ? ORDER BY f.due_date LIMIT 20`
    ).all(today),
    upcoming: db.prepare(
      `SELECT f.*, c.name AS customer_name FROM followups f LEFT JOIN customers c ON c.id = f.customer_id
       WHERE f.done = 0 AND f.due_date > ? ORDER BY f.due_date LIMIT 20`
    ).all(today),
  };

  // Receivables: per currency, invoiced value minus payments received (incl. PI advances).
  const invoicesAll = db.prepare('SELECT id, pi_id, currency, grand_total FROM commercial_invoices').all() as
    { id: number; pi_id: number | null; currency: string; grand_total: number }[];
  const paymentsAll = db.prepare('SELECT pi_id, invoice_id, amount FROM payments').all() as
    { pi_id: number | null; invoice_id: number | null; amount: number }[];
  const receivablesMap = new Map<string, { currency: string; invoiced: number; received: number; outstanding: number }>();
  for (const inv of invoicesAll) {
    const received = paymentsAll
      .filter((p) => p.invoice_id === inv.id || (inv.pi_id != null && p.pi_id === inv.pi_id))
      .reduce((s, p) => s + p.amount, 0);
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

  const funnel = {
    enquiries: counts.enquiries,
    quoted: counts.quotations,
    accepted: (db.prepare("SELECT COUNT(*) AS c FROM quotations WHERE superseded_by IS NULL AND status = 'accepted' AND date BETWEEN ? AND ?").get(from, to) as { c: number }).c,
    invoiced: counts.invoices,
  };

  res.json({ counts, quotationsByStatus, quotedByMonth, invoicedByMonth, topCustomers, topProducts, currencyTotals, followups, funnel, receivables });
});
