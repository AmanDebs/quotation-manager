import { Router } from 'express';
import { db } from '../db/connection.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { scopeClause } from '../middleware/scope.js';
import { receivedByInvoice } from '../services/receivables.js';
import { defaultCompanyId } from '../services/companies.js';
import { shortfall, onHandAll } from '../services/stock.js';

export const dashboardRouter = Router();

/**
 * All stats accept ?from=YYYY-MM-DD&to=YYYY-MM-DD and are limited to the
 * caller's customers (managers see everything).
 * Money aggregates are grouped by currency — mixing USD and INR would be meaningless.
 *
 * `?company=N` narrows every figure to one selling entity. Ignored when absent,
 * so the default view is still the group as a whole.
 */
dashboardRouter.get('/', (req: AuthedRequest, res) => {
  const from = String(req.query.from ?? '0000-01-01');
  const to = String(req.query.to ?? '9999-12-31');
  const today = new Date().toISOString().slice(0, 10);

  const scope = scopeClause(req, 'customer_id');
  const companyId = Number(req.query.company) > 0 ? Number(req.query.company) : 0;

  /**
   * The two row-level filters every document table shares: who may see it, and
   * which entity issued it. Both are columns on the row, so the same alias
   * serves both. SQL and params are returned together — they got out of step
   * once when they were kept apart.
   */
  const docFilter = (alias = '') => {
    const at = alias ? `${alias}.` : '';
    return {
      sql: (scope.sql ? ` AND ${at}${scope.sql}` : '') + (companyId ? ` AND ${at}company_id = ?` : ''),
      params: [...scope.params, ...(companyId ? [companyId] : [])] as unknown[],
    };
  };
  const { sql: and, params: p } = docFilter();
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

  // Where every order currently sits on the production line.
  const ordersByStatus = q(
    `SELECT status, COUNT(*) AS count, SUM(grand_total) AS total, currency
     FROM orders WHERE date BETWEEN ? AND ?${and} GROUP BY status, currency`,
    from, to, ...p
  );

  // Export vs domestic — the split the whole business is organised around.
  const businessSplit = q(
    `SELECT is_export, currency, COUNT(*) AS count, SUM(grand_total) AS total
     FROM commercial_invoices WHERE date BETWEEN ? AND ?${and} GROUP BY is_export, currency`,
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

  /**
   * Cash actually collected, per month. Invoiced value is what was asked for;
   * this is what came in, and the gap between the two lines is the collection
   * problem stated in one picture.
   *
   * A payment carries no company of its own, so it inherits one the way a
   * follow-up does: from the document it was paid against, else the customer's
   * usual entity, else the group default. Invoice first, then proforma — a row
   * can only carry one of the two, and the order just makes the intent plain.
   *
   * Not converted between currencies and never summed across them: there is no
   * rate stored anywhere, and inventing one would put a fiction on a ledger.
   */
  const payCompany = companyId
    ? {
        sql: ` AND COALESCE(
            (SELECT company_id FROM commercial_invoices WHERE id = pay.invoice_id),
            (SELECT company_id FROM proforma_invoices WHERE id = pay.pi_id),
            (SELECT company_id FROM customers WHERE id = pay.customer_id),
            ?) = ?`,
        params: [defaultCompanyId(), companyId] as unknown[],
      }
    : { sql: '', params: [] as unknown[] };

  const receivedByMonth = q(
    `SELECT substr(pay.date, 1, 7) AS month, pay.currency, SUM(pay.amount) AS total
     FROM payments pay
     WHERE pay.date BETWEEN ? AND ?${scope.sql ? ` AND pay.${scope.sql}` : ''}${payCompany.sql}
     GROUP BY month, pay.currency ORDER BY month`,
    from, to, ...scope.params, ...payCompany.params
  );

  // These join in the customer, so the filters need the document's own alias.
  const dq = docFilter('q');
  const di = docFilter('i');

  const topCustomers = q(
    `SELECT c.name, q.currency, SUM(q.grand_total) AS total, COUNT(*) AS quotes
     FROM quotations q JOIN customers c ON c.id = q.customer_id
     WHERE q.superseded_by IS NULL AND q.date BETWEEN ? AND ?${dq.sql}
     GROUP BY c.id, q.currency ORDER BY total DESC LIMIT 8`,
    from, to, ...dq.params
  );

  // Quoted value flatters whoever quotes the most; invoiced value is the real
  // business. Both are offered so the two can be compared.
  const topCustomersInvoiced = q(
    `SELECT c.name, i.currency, SUM(i.grand_total) AS total, COUNT(*) AS invoices
     FROM commercial_invoices i JOIN customers c ON c.id = i.customer_id
     WHERE i.date BETWEEN ? AND ?${di.sql}
     GROUP BY c.id, i.currency ORDER BY total DESC LIMIT 8`,
    from, to, ...di.params
  );

  const topProducts = q(
    `SELECT COALESCE(p.name, qi.description) AS name, COUNT(*) AS times_quoted
     FROM quotation_items qi
     JOIN quotations q ON q.id = qi.quotation_id
     LEFT JOIN products p ON p.id = qi.product_id
     WHERE q.superseded_by IS NULL AND q.date BETWEEN ? AND ?${dq.sql}
     GROUP BY COALESCE(p.name, qi.description) ORDER BY times_quoted DESC LIMIT 8`,
    from, to, ...dq.params
  );

  const currencyTotals = q(
    `SELECT currency,
       SUM(CASE WHEN status = 'accepted' THEN grand_total ELSE 0 END) AS accepted_value,
       SUM(grand_total) AS quoted_value
     FROM quotations WHERE superseded_by IS NULL AND date BETWEEN ? AND ?${and} GROUP BY currency`,
    from, to, ...p
  );

  /**
   * A follow-up carries no company of its own. It inherits one from the
   * document it is against, else from the customer's usual entity, else the
   * group default — the same order `resolveCompanyId` uses when stamping a new
   * document, so a reminder files under the entity that will act on it.
   *
   * `general` doubles as the order case: the schema's CHECK on `doc_type` has
   * no 'order' value, so the order form files its reminders as general with the
   * order's id (OrderForm.tsx). A genuinely general reminder carries no doc_id,
   * the subquery yields NULL, and the COALESCE falls through to the customer.
   */
  const fuCompany = companyId
    ? {
        sql: ` AND COALESCE(
            CASE f.doc_type
              WHEN 'quotation' THEN (SELECT company_id FROM quotations WHERE id = f.doc_id)
              WHEN 'general' THEN (SELECT company_id FROM orders WHERE id = f.doc_id)
              WHEN 'proforma' THEN (SELECT company_id FROM proforma_invoices WHERE id = f.doc_id)
              WHEN 'invoice' THEN (SELECT company_id FROM commercial_invoices WHERE id = f.doc_id)
            END,
            (SELECT company_id FROM customers WHERE id = f.customer_id),
            ?) = ?`,
        params: [defaultCompanyId(), companyId] as unknown[],
      }
    : { sql: '', params: [] as unknown[] };

  const fu = (cond: string, ...extra: unknown[]) => q(
    `SELECT f.*, c.name AS customer_name FROM followups f LEFT JOIN customers c ON c.id = f.customer_id
     WHERE f.done = 0 AND ${cond}${scope.sql ? ` AND f.${scope.sql}` : ''}${fuCompany.sql}
     ORDER BY f.due_date LIMIT 20`,
    ...extra, ...scope.params, ...fuCompany.params
  );
  const followups = {
    overdue: fu('f.due_date < ?', today),
    today: fu('f.due_date = ?', today),
    upcoming: fu('f.due_date > ?', today),
  };

  // Receivables: per currency, invoiced value minus payments received. A PI
  // advance is shared across the invoices raised from that PI, so the split
  // comes from services/receivables.ts rather than being recomputed here.
  const invoicesAll = q<{ id: number; pi_id: number | null; currency: string; grand_total: number; date: string }>(
    `SELECT id, pi_id, currency, grand_total, date FROM commercial_invoices WHERE 1 = 1${and}`,
    ...p
  );
  // Allocation stays group-wide on purpose: an advance is split across the
  // invoices raised from its proforma whether or not they are all on screen.
  // Filtering here would silently over-credit whichever ones remain.
  const receivedPerInvoice = receivedByInvoice();
  const receivablesMap = new Map<string, { currency: string; invoiced: number; received: number; outstanding: number }>();

  // Ageing: how long the unpaid money has been outstanding, bucketed by the
  // age of the invoice. This is what tells you which customer to chase first.
  const AGE_BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const;
  const bucketFor = (days: number) => (days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+');
  const ageingMap = new Map<string, { currency: string; bucket: string; outstanding: number; count: number }>();
  const todayMs = Date.parse(today);
  let overdueInvoices = 0;

  for (const inv of invoicesAll) {
    const received = receivedPerInvoice.get(inv.id) ?? 0;
    const row = receivablesMap.get(inv.currency) ?? { currency: inv.currency, invoiced: 0, received: 0, outstanding: 0 };
    row.invoiced += inv.grand_total;
    row.received += Math.min(received, inv.grand_total);
    const outstanding = Math.max(0, inv.grand_total - received);
    row.outstanding += outstanding;
    receivablesMap.set(inv.currency, row);

    if (outstanding > 0.005) {
      const days = Math.max(0, Math.floor((todayMs - Date.parse(inv.date)) / 86_400_000));
      const bucket = bucketFor(days);
      if (days > 60) overdueInvoices += 1;
      const key = `${inv.currency}|${bucket}`;
      const ageRow = ageingMap.get(key) ?? { currency: inv.currency, bucket, outstanding: 0, count: 0 };
      ageRow.outstanding += outstanding;
      ageRow.count += 1;
      ageingMap.set(key, ageRow);
    }
  }

  const receivables = [...receivablesMap.values()].map((r) => ({
    ...r,
    invoiced: Math.round(r.invoiced * 100) / 100,
    received: Math.round(r.received * 100) / 100,
    outstanding: Math.round(r.outstanding * 100) / 100,
  }));
  const receivablesAgeing = [...ageingMap.values()]
    .map((r) => ({ ...r, outstanding: Math.round(r.outstanding * 100) / 100 }))
    .sort((a, b) => a.currency.localeCompare(b.currency) || AGE_BUCKETS.indexOf(a.bucket as never) - AGE_BUCKETS.indexOf(b.bucket as never));

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

  // Everything that wants a human today, gathered in one place so the dashboard
  // can lead with it instead of burying it among the charts. These ignore the
  // date range on purpose — an overdue follow-up from March still needs doing.
  const reorderLevels = new Map(
    (db.prepare('SELECT id, reorder_level FROM materials').all() as { id: number; reorder_level: number }[])
      .map((m) => [m.id, m.reorder_level])
  );
  // Both of these walk the whole open job list, so they are read once here and
  // shared with the production block below rather than run twice.
  const shortRows = shortfall().rows.filter((r) => r.short > 0);
  const belowReorder = onHandAll().filter((r) => {
    const level = reorderLevels.get(r.material_id) ?? 0;
    return level > 0 && r.qty < level;
  });

  const attention = {
    overdueFollowups: followups.overdue.length,
    followupsToday: followups.today.length,
    overdueOrders,
    overdueInvoices,
    pendingApprovals: counts.pendingApprovals,
    /**
     * Quotations whose validity runs out **within the next week**, not ones
     * that already have.
     *
     * It counted the lapsed ones until `services/quotationExpiry.ts` started
     * setting the status itself — at which point a lapsed quotation is no
     * longer `sent` or `negotiating`, so this would have counted zero for ever
     * and quietly stopped being a warning. A week's notice is the actionable
     * version: it is still possible to ring the customer or extend the date.
     */
    expiringQuotations: one(
      `SELECT COUNT(*) AS c FROM quotations
       WHERE superseded_by IS NULL AND status IN ('sent','negotiating')
         AND validity_date <> '' AND validity_date >= ? AND validity_date <= date(?, '+7 days')${and}`,
      today, today, ...p
    ),
    // Jobs past their planned finish with work still to do. Scoped through the
    // order like everything else on the floor; the company filter applies via
    // the order too, since a work order has no company of its own to filter on
    // beyond the one it inherited.
    overdueWorkOrders: one(
      `SELECT COUNT(*) AS c FROM work_orders w
       JOIN orders o ON o.id = w.order_id
       WHERE w.status NOT IN ('done','cancelled')
         AND w.planned_end <> '' AND w.planned_end < ?
         ${scope.sql ? ` AND o.${scope.sql}` : ''}${companyId ? ' AND o.company_id = ?' : ''}`,
      today, ...scope.params, ...(companyId ? [companyId] : [])
    ),
    // Goods that left the plant with no invoice against them yet — the reason
    // despatch is recorded separately from billing in the first place.
    unbilledDespatches: one(
      `SELECT COUNT(*) AS c FROM despatches d
       JOIN orders o ON o.id = d.order_id
       WHERE d.invoice_id IS NULL
         ${scope.sql ? ` AND o.${scope.sql}` : ''}${companyId ? ' AND o.company_id = ?' : ''}`,
      ...scope.params, ...(companyId ? [companyId] : [])
    ),
    // Material short across the open order book. Group-wide and unscoped by
    // design: the store is not the customer's, and a buyer needs the whole
    // picture to raise one purchase order rather than several.
    materialShort: shortRows.length,
    materialBelowReorder: belowReorder.length,
  };

  /**
   * The floor, in the same shape as the sales figures above it.
   *
   * Scoped through the order like everything else on the factory side, and
   * filtered by the order's company — a work order carries a `company_id` of
   * its own, but reading the order's keeps this identical to the attention
   * strip, which is what the two are compared against.
   *
   * The job counts are **current state, not the date range**: "how many jobs
   * are open" is a question about now, the same way the order book and the
   * receivables are. Pieces made and pieces despatched *are* range-filtered —
   * those are things that happened on a date.
   */
  const floorFilter = `${scope.sql ? ` AND o.${scope.sql}` : ''}${companyId ? ' AND o.company_id = ?' : ''}`;
  const floorParams = [...scope.params, ...(companyId ? [companyId] : [])];

  const workOrdersByStatus = q(
    `SELECT w.status, COUNT(*) AS count FROM work_orders w
     JOIN orders o ON o.id = w.order_id
     WHERE 1 = 1${floorFilter} GROUP BY w.status`,
    ...floorParams
  );

  const made = db.prepare(
    `SELECT COALESCE(SUM(pe.qty_ok), 0) AS ok, COALESCE(SUM(pe.qty_reject), 0) AS reject
     FROM production_entries pe
     JOIN work_orders w ON w.id = pe.work_order_id
     JOIN orders o ON o.id = w.order_id
     WHERE pe.date BETWEEN ? AND ?${floorFilter}`
  ).get(from, to, ...(floorParams as never[])) as { ok: number; reject: number };

  const sent = db.prepare(
    `SELECT COALESCE(SUM(di.qty), 0) AS pieces, COUNT(DISTINCT d.id) AS trips
     FROM despatches d
     JOIN orders o ON o.id = d.order_id
     LEFT JOIN despatch_items di ON di.despatch_id = d.id
     WHERE d.date BETWEEN ? AND ?${floorFilter}`
  ).get(from, to, ...(floorParams as never[])) as { pieces: number; trips: number };

  const production = {
    workOrdersByStatus,
    piecesMade: Math.round(made.ok),
    piecesRejected: Math.round(made.reject),
    // Zero made is not a zero reject rate, it is no answer at all.
    rejectRate: made.ok + made.reject > 0
      ? Math.round((made.reject / (made.ok + made.reject)) * 1000) / 10
      : null,
    piecesDespatched: Math.round(sent.pieces),
    despatches: sent.trips,
    // Group-wide and unscoped, like the two material chips: the store is not
    // any one customer's, and a buyer needs the whole picture to raise one
    // purchase order rather than several. Worst shortfall first.
    shortMaterials: [...shortRows]
      .sort((a, b) => b.short - a.short)
      .slice(0, 6)
      .map((r) => ({
        material_id: r.material_id, name: r.material_name, unit: r.unit,
        required: r.required, on_hand: r.on_hand, on_order: r.on_order, short: r.short,
      })),
  };

  res.json({
    counts, quotationsByStatus, ordersByStatus, businessSplit, quotedByMonth, invoicedByMonth,
    receivedByMonth,
    topCustomers, topCustomersInvoiced, topProducts, currencyTotals, followups, funnel,
    receivables, receivablesAgeing, orderBook, overdueOrders, attention, production,
  });
});
