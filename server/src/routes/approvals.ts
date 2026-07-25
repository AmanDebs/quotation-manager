import { Router } from 'express';
import { db } from '../db/connection.js';

export const approvalsRouter = Router();

/**
 * Everything waiting on a manager, newest first. Manager-only (guarded in index.ts).
 * `type` matches the PDF/route slug so the client can link straight to the document.
 */
approvalsRouter.get('/', (req, res) => {
  const status = String(req.query.status ?? 'pending');
  const rows = db.prepare(
    `SELECT 'quotation' AS type, q.id, q.number, q.date, q.currency, q.grand_total, q.approval_status,
            q.is_export, c.name AS customer_name, u.name AS created_by_name
     FROM quotations q JOIN customers c ON c.id = q.customer_id LEFT JOIN users u ON u.id = q.created_by
     WHERE q.approval_status = ? AND q.superseded_by IS NULL
     UNION ALL
     SELECT 'proforma', p.id, p.number, p.date, p.currency, p.grand_total, p.approval_status,
            p.is_export, c.name, u.name
     FROM proforma_invoices p JOIN customers c ON c.id = p.customer_id LEFT JOIN users u ON u.id = p.created_by
     WHERE p.approval_status = ?
     UNION ALL
     SELECT 'invoice', i.id, i.number, i.date, i.currency, i.grand_total, i.approval_status,
            i.is_export, c.name, u.name
     FROM commercial_invoices i JOIN customers c ON c.id = i.customer_id LEFT JOIN users u ON u.id = i.created_by
     WHERE i.approval_status = ?
     ORDER BY date DESC`
  ).all(status, status, status);
  res.json(rows);
});

approvalsRouter.get('/count', (_req, res) => {
  const row = db.prepare(
    `SELECT (SELECT COUNT(*) FROM quotations WHERE approval_status = 'pending' AND superseded_by IS NULL)
          + (SELECT COUNT(*) FROM proforma_invoices WHERE approval_status = 'pending')
          + (SELECT COUNT(*) FROM commercial_invoices WHERE approval_status = 'pending') AS c`
  ).get() as { c: number };
  res.json({ pending: row.c });
});
