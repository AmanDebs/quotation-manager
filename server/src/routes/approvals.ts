import { Router } from 'express';
import { db } from '../db/connection.js';
import { listBody } from '../services/pagination.js';
import { scopeClause } from '../middleware/scope.js';
import type { AuthedRequest } from '../middleware/auth.js';

export const approvalsRouter = Router();

/**
 * Everything waiting on somebody who may approve, newest first. `type` matches
 * the PDF/route slug so the client can link straight to the document.
 *
 * **Scoped like every other list** (2026-09-25). The comment here used to read
 * *manager-only*, and that was true when it was written: the mount was
 * `requireManager`, and a manager sees the whole book. The 2026-09-10 matrix
 * gave **Sales** `approval: full` — and Sales is the one role `visibleCustomerIds`
 * restricts — so this queue had been handing one Sales owner every other
 * owner's pending documents, with number, customer and grand total. The
 * dashboard's own `pendingApprovals` has been scoped all along, so the badge,
 * the chip and the list also disagreed about the number.
 */
approvalsRouter.get('/', (req: AuthedRequest, res) => {
  const status = String(req.query.status ?? 'pending');
  // One clause per branch of the UNION: each table names its own alias, and
  // the params have to be pushed in the order the branches are read.
  const sc = (alias: string) => {
    const c = scopeClause(req, `${alias}.customer_id`);
    return c.sql ? ` AND ${c.sql}` : '';
  };
  const scp = (alias: string) => scopeClause(req, `${alias}.customer_id`).params;
  // Pending is short by definition, but ?status=approved is the whole history
  // of everything the group has ever sent out, so this pages like the rest.
  res.json(listBody(req.query, {
    sql: `SELECT 'quotation' AS type, q.id AS id, q.number, q.date AS date, q.currency, q.grand_total, q.approval_status,
            q.is_export, c.name AS customer_name, u.name AS created_by_name
     FROM quotations q JOIN customers c ON c.id = q.customer_id LEFT JOIN users u ON u.id = q.created_by
     WHERE q.approval_status = ? AND q.superseded_by IS NULL${sc('q')}
     UNION ALL
     SELECT 'proforma', p.id, p.number, p.date, p.currency, p.grand_total, p.approval_status,
            p.is_export, c.name, u.name
     FROM proforma_invoices p JOIN customers c ON c.id = p.customer_id LEFT JOIN users u ON u.id = p.created_by
     WHERE p.approval_status = ?${sc('p')}
     UNION ALL
     SELECT 'invoice', i.id, i.number, i.date, i.currency, i.grand_total, i.approval_status,
            i.is_export, c.name, u.name
     FROM commercial_invoices i JOIN customers c ON c.id = i.customer_id LEFT JOIN users u ON u.id = i.created_by
     WHERE i.approval_status = ?${sc('i')}
     UNION ALL
     SELECT 'credit-note', n.id, n.number, n.date, n.currency, n.grand_total, n.approval_status,
            n.is_export, c.name, u.name
     FROM credit_notes n JOIN customers c ON c.id = n.customer_id LEFT JOIN users u ON u.id = n.created_by
     WHERE n.approval_status = ?${sc('n')}`,
    order: 'ORDER BY date DESC, type, id',
    params: [status, ...scp('q'), status, ...scp('p'), status, ...scp('i'), status, ...scp('n')],
  }));
});

/**
 * What the sidebar badge reads, and it must count exactly what the list shows
 * — a badge saying 3 over a queue of 1 is worse than no badge. Same scope,
 * same four tables.
 */
approvalsRouter.get('/count', (req: AuthedRequest, res) => {
  const scope = scopeClause(req, 'customer_id');
  const and = scope.sql ? ` AND ${scope.sql}` : '';
  const p = scope.params;
  const row = db.prepare(
    `SELECT (SELECT COUNT(*) FROM quotations WHERE approval_status = 'pending' AND superseded_by IS NULL${and})
          + (SELECT COUNT(*) FROM proforma_invoices WHERE approval_status = 'pending'${and})
          + (SELECT COUNT(*) FROM commercial_invoices WHERE approval_status = 'pending'${and})
          -- A credit note waits on approval like the rest, and it is the one
          -- document where waiting matters most: unapproved, it credits nothing.
          + (SELECT COUNT(*) FROM credit_notes WHERE approval_status = 'pending'${and}) AS c`
  ).get(...([...p, ...p, ...p, ...p] as never[])) as { c: number };
  res.json({ pending: row.c });
});
