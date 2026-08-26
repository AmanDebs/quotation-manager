import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { nextNumber } from '../services/numbering.js';
import { computeTotals, round2, type LineItemInput } from '../services/totals.js';
import { productionByOrder } from '../services/production.js';
import { despatchedByOrder } from './despatches.js';
import { orderMaterialCost } from '../services/costing.js';
import { orderLines, productDemand, countOrderLines,
  type Filters, type OrderLine, type ProductDemand } from '../services/orderLines.js';
import { buildXlsx, attachmentName, type Column } from '../services/xlsx.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { scopeClause, canAccessCustomer, linkError, customerChangeError } from '../middleware/scope.js';
import { syncOrderStatus } from '../services/orderStatus.js';
import { resolveCompanyId } from '../services/companies.js';
import { listBody, pageRequest } from '../services/pagination.js';

export const ordersRouter = Router();

const listSql = `
  SELECT o.*, c.name AS customer_name, c.country AS customer_country,
         co.company_name AS company_name,
         q.number AS quotation_number, u.name AS created_by_name
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
  -- LEFT, not JOIN: a document must still list if its company row is gone.
  LEFT JOIN companies co ON co.id = o.company_id
  LEFT JOIN quotations q ON q.id = o.quotation_id
  LEFT JOIN users u ON u.id = o.created_by`;

interface OrderItemInput extends LineItemInput {
  code?: string;
  supplier?: string;
  scheduled_date?: string;
  dispatched_date?: string;
}

/**
 * How much of this order has actually shipped.
 *
 * Derived, never stored — the same rule the packing list and invoice balance
 * use. Walks every commercial invoice reachable from the order (linked
 * directly, or through a proforma raised from it) and sums invoice lines
 * against order lines **by position**, which is how the carry-forward chain
 * builds them.
 */
function dispatchProgress(orderId: number, items: { qty: number | null; unit_price: number }[]) {
  const invoices = db.prepare(
    `SELECT id FROM commercial_invoices
     WHERE order_id = ?
        OR pi_id IN (SELECT id FROM proforma_invoices WHERE order_id = ?)`
  ).all(orderId, orderId) as { id: number }[];

  const dispatched = items.map(() => 0);
  for (const inv of invoices) {
    const invItems = db.prepare(
      'SELECT qty FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id'
    ).all(inv.id) as { qty: number | null }[];
    invItems.forEach((it, i) => {
      if (i < dispatched.length && it.qty != null) dispatched[i] += it.qty;
    });
  }

  const perLine = items.map((it, i) => {
    const done = round2(dispatched[i]);
    const ordered = it.qty ?? 0;
    return {
      qty_dispatched: done,
      qty_pending: round2(Math.max(0, ordered - done)),
      dispatched_value: round2(done * it.unit_price),
    };
  });

  const orderedValue = round2(items.reduce((s, it) => s + (it.qty ?? 0) * it.unit_price, 0));
  const dispatchedValue = round2(perLine.reduce((s, l) => s + l.dispatched_value, 0));
  return {
    perLine,
    invoiceCount: invoices.length,
    dispatched_value: dispatchedValue,
    pending_value: round2(Math.max(0, orderedValue - dispatchedValue)),
    fully_dispatched: items.length > 0 && perLine.every((l, i) => (items[i].qty ?? 0) > 0 && l.qty_pending === 0),
    any_dispatched: perLine.some((l) => l.qty_dispatched > 0),
  };
}

function getFull(id: number) {
  const order = db.prepare(`${listSql} WHERE o.id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!order) return undefined;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY sort_order, id').all(id) as
    Record<string, unknown>[];
  const progress = dispatchProgress(id, items as unknown as { qty: number | null; unit_price: number }[]);
  // Production sits beside dispatch on every line, keyed by position like the
  // rest of the chain. A line with no work order reports `work_orders: 0`, so
  // the screen can say "not started" rather than "nothing made".
  const production = productionByOrder(id);
  // Physically sent, which is not the same question as invoiced — a lorry can
  // leave before the paperwork. Both are shown; neither is reconciled to the
  // other behind the user's back.
  const sent = despatchedByOrder(id);
  // Material actually issued against this order's jobs, at moving average.
  // Partial by nature — `jobs_without_issues` says how much of the order has
  // not drawn material yet, so a margin is not read off half a job.
  const cost = orderMaterialCost(id);
  order.material_cost = cost.material_cost;
  order.costing = cost;
  order.items = items.map((it, i) => ({
    ...it,
    ...progress.perLine[i],
    production: production.get(i) ?? { planned: 0, produced: 0, rejected: 0, balance: 0, work_orders: 0 },
    despatched: sent.get(i) ?? { qty: 0, packs: 0, trips: 0 },
  }));
  order.column_config = JSON.parse(String(order.column_config || '{}'));
  order.dispatched_value = progress.dispatched_value;
  order.pending_value = progress.pending_value;
  order.fully_dispatched = progress.fully_dispatched;
  order.any_dispatched = progress.any_dispatched;
  // Downstream documents raised from this order.
  order.proformas = db.prepare('SELECT id, number, date, status, grand_total FROM proforma_invoices WHERE order_id = ? ORDER BY id').all(id);
  order.invoices = db.prepare(
    `SELECT id, number, date, status, grand_total FROM commercial_invoices
     WHERE order_id = ? OR pi_id IN (SELECT id FROM proforma_invoices WHERE order_id = ?) ORDER BY id`
  ).all(id, id);
  return order;
}

const headerFields = [
  'date', 'customer_id', 'quotation_id', 'is_export', 'order_through', 'spoc', 'po_number', 'po_date',
  'currency', 'tax_type', 'payment_terms', 'freight', 'insurance', 'inco_terms', 'container_count',
  'advance_due', 'advance_amount', 'advance_received_date', 'destination', 'transport', 'freight_terms',
  'promised_date', 'scheduled_date', 'revised_date', 'actual_production_date', 'remarks', 'notes',
] as const;

function headerValues(body: Record<string, unknown>, existing?: Record<string, unknown>) {
  const v = (f: string, def: unknown = '') => body[f] ?? existing?.[f] ?? def;
  return {
    date: String(v('date', new Date().toISOString().slice(0, 10))),
    customer_id: Number(v('customer_id', 0)),
    quotation_id: v('quotation_id', null) ? Number(v('quotation_id')) : null,
    is_export: Number(v('is_export', 0)) ? 1 : 0,
    order_through: String(v('order_through')),
    spoc: String(v('spoc')),
    po_number: String(v('po_number')),
    po_date: String(v('po_date')),
    currency: String(v('currency', 'INR')),
    tax_type: String(v('tax_type', 'none')) as 'none' | 'cgst_sgst' | 'igst',
    payment_terms: String(v('payment_terms')),
    freight: Number(v('freight', 0)),
    insurance: Number(v('insurance', 0)),
    inco_terms: String(v('inco_terms')),
    container_count: String(v('container_count')),
    advance_due: Number(v('advance_due', 0)),
    advance_amount: Number(v('advance_amount', 0)),
    advance_received_date: String(v('advance_received_date')),
    destination: String(v('destination')),
    transport: String(v('transport')),
    freight_terms: String(v('freight_terms')),
    promised_date: String(v('promised_date')),
    scheduled_date: String(v('scheduled_date')),
    revised_date: String(v('revised_date')),
    actual_production_date: String(v('actual_production_date')),
    remarks: String(v('remarks')),
    notes: String(v('notes')),
  };
}

function saveItems(orderId: number, items: OrderItemInput[], taxType: 'none' | 'cgst_sgst' | 'igst', freight: number, insurance: number, currency: string) {
  const totals = computeTotals(items, taxType, freight, insurance, currency);
  db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId);
  const ins = db.prepare(
    `INSERT INTO order_items (order_id, product_id, description, hsn_code, code, qty, unit, unit_price, tax_pct, amount,
       color, packs, pcs_per_pack, total_pcs, qty_20ft, qty_40ft, is_charge, supplier, scheduled_date, dispatched_date, custom1, custom2, custom3, image, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  totals.items.forEach((it, i) => {
    const src = items[i] ?? {};
    ins.run(orderId, it.product_id ?? null, it.description, it.hsn_code ?? '', String(src.code ?? ''),
      it.qty ?? null, it.unit ?? 'unit', it.unit_price, it.tax_pct ?? 0, it.amount,
      it.color ?? '', it.packs ?? null, it.pcs_per_pack ?? null, it.total_pcs ?? null,
      it.qty_20ft ?? null, it.qty_40ft ?? null, it.is_charge ? 1 : 0,
      String(src.supplier ?? ''), String(src.scheduled_date ?? ''), String(src.dispatched_date ?? ''),
      it.custom1 ?? '', it.custom2 ?? '', it.custom3 ?? '', it.image ?? '', i);
  });
  db.prepare('UPDATE orders SET subtotal = ?, tax_total = ?, grand_total = ? WHERE id = ?').run(
    totals.subtotal, totals.tax_total, totals.grand_total, orderId
  );
}

/**
 * The per-order list's filters, built once so the list and its export cannot
 * drift apart — an export that quietly disagreed with the table it sits under
 * is worse than no export.
 */
function orderListWhere(req: AuthedRequest): { where: string[]; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const scope = scopeClause(req, 'o.customer_id');
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  if (req.query.status) { where.push('o.status = ?'); params.push(String(req.query.status)); }
  if (req.query.export === '1' || req.query.export === '0') { where.push('o.is_export = ?'); params.push(Number(req.query.export)); }
  // Narrow to one selling entity. Ignored when the group has just one.
  if (Number(req.query.company) > 0) { where.push('o.company_id = ?'); params.push(Number(req.query.company)); }
  // ?open=1 → the order book: everything not yet completed or cancelled.
  if (req.query.open === '1') where.push("o.status NOT IN ('completed','cancelled')");
  return { where, params };
}

ordersRouter.get('/', (req: AuthedRequest, res) => {
  const { where, params } = orderListWhere(req);
  res.json(listBody<Record<string, unknown>>(req.query, {
    sql: `${listSql}${where.length ? ' WHERE ' + where.join(' AND ') : ''}`,
    order: 'ORDER BY o.date DESC, o.id DESC',
    params,
  // Lists show progress too, so the order book reads at a glance. Two queries
  // per row, which is why it runs after the page has been cut and not before.
  }, (rows) => rows.map((o) => {
    const items = db.prepare('SELECT qty, unit_price FROM order_items WHERE order_id = ? ORDER BY sort_order, id')
      .all(Number(o.id)) as { qty: number | null; unit_price: number }[];
    const p = dispatchProgress(Number(o.id), items);
    return { ...o, dispatched_value: p.dispatched_value, pending_value: p.pending_value, any_dispatched: p.any_dispatched };
  })));
});

/**
 * The order book one item at a time, and the same lines folded up per product.
 *
 * Declared **above** `/:id`: both are single-segment paths, so Express would
 * otherwise read "lines" as an order id. The `/prefill/...` routes below are
 * safe where they are only because they carry more than one segment.
 */
function lineFilters(req: AuthedRequest): Filters {
  const scope = scopeClause(req, 'customer_id');
  return {
    scopeSql: scope.sql || undefined,
    scopeParams: scope.params,
    status: req.query.status ? String(req.query.status) : undefined,
    isExport: req.query.export === '1' ? 1 : req.query.export === '0' ? 0 : undefined,
    companyId: Number(req.query.company) > 0 ? Number(req.query.company) : undefined,
    openOnly: req.query.open === '1',
    q: String(req.query.q ?? '').trim() || undefined,
  };
}

ordersRouter.get('/lines', (req: AuthedRequest, res) => {
  const f = lineFilters(req);
  const p = pageRequest(req.query);
  if (!p) return res.json(orderLines(f));
  const total = countOrderLines(f);
  const pages = Math.max(1, Math.ceil(total / p.limit));
  const page = Math.min(p.page, pages);
  res.json({
    rows: orderLines(f, { limit: p.limit, offset: (page - 1) * p.limit }),
    total, page, pages, limit: p.limit,
  });
});

/**
 * Never paged, on purpose: this folds every matching line into one row per
 * product, and a total taken over one page of lines is not the total. It is
 * bounded by the catalogue rather than by trading volume, which is what makes
 * that affordable.
 */
ordersRouter.get('/by-product', (req: AuthedRequest, res) => {
  res.json(productDemand(lineFilters(req)));
});

/**
 * The order book as a spreadsheet — whichever of the three views is on screen.
 *
 * Declared above `/:id` for the same reason `/lines` is: Express would read
 * "export" as an order id.
 *
 * Three rules it follows. It exports the **whole filtered set, never a page**,
 * because a download that silently stopped at fifty rows is the kind of wrong
 * that is only discovered in a meeting. It goes through the **same filters as
 * the view it came from**, so what downloads is what was on screen. And it is
 * **scoped like every other read** — `lineFilters`/`orderListWhere` both apply
 * `scopeClause`, so an employee's export contains their customers and no more.
 */
const STATE_LABEL: Record<string, string> = {
  not_started: 'Not started', in_production: 'In production', made: 'Made',
  part_shipped: 'Part shipped', shipped: 'Shipped',
};

const lineColumns: Column<OrderLine>[] = [
  { header: 'Order', value: (r) => r.order_number },
  { header: 'Date', value: (r) => r.date, type: 'date' },
  { header: 'Customer', value: (r) => r.customer_name },
  { header: 'Issued by', value: (r) => r.company_name },
  { header: 'Item', value: (r) => r.description },
  { header: 'Code', value: (r) => r.code },
  { header: 'Colour', value: (r) => r.color },
  { header: 'Unit', value: (r) => r.unit },
  { header: 'Qty', value: (r) => r.ordered, type: 'number' },
  { header: 'Made', value: (r) => r.made, type: 'number' },
  { header: 'Sent', value: (r) => r.sent, type: 'number' },
  { header: 'Billed', value: (r) => r.billed, type: 'number' },
  { header: 'Promised', value: (r) => r.promised_date, type: 'date' },
  { header: 'State', value: (r) => STATE_LABEL[r.state] ?? r.state },
  { header: 'Amount', value: (r) => r.amount, type: 'money' },
  { header: 'Currency', value: (r) => r.currency },
  { header: 'Type', value: (r) => (r.is_export ? 'Export' : 'Domestic') },
  { header: 'Order status', value: (r) => r.order_status },
  { header: 'Added by', value: (r) => r.created_by_name },
];

const productColumns: Column<ProductDemand>[] = [
  { header: 'Product', value: (r) => r.description },
  { header: 'Code', value: (r) => r.code },
  { header: 'Colour', value: (r) => r.color },
  { header: 'Unit', value: (r) => r.unit },
  { header: 'On order', value: (r) => r.ordered, type: 'number' },
  { header: 'Made', value: (r) => r.made, type: 'number' },
  { header: 'Shipped', value: (r) => r.shipped, type: 'number' },
  { header: 'To ship', value: (r) => r.to_ship, type: 'number' },
  { header: 'Orders', value: (r) => r.orders, type: 'number' },
  { header: 'Next due', value: (r) => r.next_due, type: 'date' },
];

type OrderRow = Record<string, unknown>;
const orderColumns: Column<OrderRow>[] = [
  { header: 'Order', value: (r) => String(r.number ?? '') },
  { header: 'Date', value: (r) => String(r.date ?? ''), type: 'date' },
  { header: 'Customer', value: (r) => String(r.customer_name ?? '') },
  { header: 'Issued by', value: (r) => (r.company_name == null ? '' : String(r.company_name)) },
  { header: 'PO number', value: (r) => String(r.po_number ?? '') },
  { header: 'PO date', value: (r) => String(r.po_date ?? ''), type: 'date' },
  { header: 'Promised', value: (r) => String(r.promised_date ?? ''), type: 'date' },
  { header: 'Status', value: (r) => String(r.status ?? '') },
  { header: 'Type', value: (r) => (Number(r.is_export) ? 'Export' : 'Domestic') },
  { header: 'Currency', value: (r) => String(r.currency ?? '') },
  { header: 'Total', value: (r) => Number(r.grand_total ?? 0), type: 'money' },
  { header: 'Dispatched value', value: (r) => Number(r.dispatched_value ?? 0), type: 'money' },
  { header: 'Pending value', value: (r) => Number(r.pending_value ?? 0), type: 'money' },
];

ordersRouter.get('/export', (req: AuthedRequest, res) => {
  const view = String(req.query.view ?? 'lines');

  let sheet: string;
  let book: Buffer;
  if (view === 'by-product') {
    sheet = 'By product';
    book = buildXlsx(sheet, productColumns, productDemand(lineFilters(req)));
  } else if (view === 'orders') {
    sheet = 'Orders';
    const { where, params } = orderListWhere(req);
    const rows = db
      .prepare(`${listSql}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY o.date DESC, o.id DESC`)
      .all(...(params as never[])) as OrderRow[];
    // The same per-row decoration the list does, so the two columns that are
    // derived rather than stored are in the download as well.
    for (const o of rows) {
      const items = db.prepare('SELECT qty, unit_price FROM order_items WHERE order_id = ? ORDER BY sort_order, id')
        .all(Number(o.id)) as { qty: number | null; unit_price: number }[];
      const p = dispatchProgress(Number(o.id), items);
      o.dispatched_value = p.dispatched_value;
      o.pending_value = p.pending_value;
    }
    book = buildXlsx(sheet, orderColumns, rows);
  } else {
    sheet = 'Order lines';
    // No page argument: the whole filtered set.
    book = buildXlsx(sheet, lineColumns, orderLines(lineFilters(req)));
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${attachmentName(sheet)}"`);
  res.send(book);
});

ordersRouter.get('/:id', (req: AuthedRequest, res) => {
  const o = getFull(Number(req.params.id));
  if (!o || !canAccessCustomer(req, Number(o.customer_id))) return res.status(404).json({ error: 'Order not found' });
  res.json(o);
});

// Prefill payload for booking an order from an accepted quotation.
ordersRouter.get('/prefill/from-quotation/:quotationId', (req: AuthedRequest, res) => {
  const qid = Number(req.params.quotationId);
  const q = db.prepare('SELECT * FROM quotations WHERE id = ?').get(qid) as Record<string, unknown> | undefined;
  if (!q || !canAccessCustomer(req, Number(q.customer_id))) return res.status(404).json({ error: 'Quotation not found' });
  const items = db.prepare('SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY sort_order, id').all(qid);
  res.json({
    quotation_id: qid,
    customer_id: q.customer_id,
    company_id: q.company_id,
    currency: q.currency,
    tax_type: q.tax_type,
    is_export: q.is_export,
    payment_terms: q.payment_terms,
    inco_terms: q.inco_terms,
    container_count: q.container_count,
    freight: q.freight,
    insurance: q.insurance,
    spoc: q.prepared_by,
    column_config: JSON.parse(String(q.column_config || '{}')),
    items,
  });
});

/**
 * Prefill payload for booking an order from a proforma the buyer has confirmed.
 *
 * The advance is deliberately not carried across. A payment recorded against
 * the proforma stays there — `services/receivables.ts` allocates it to the
 * invoices raised from that proforma, and copying the figure onto the order as
 * well would show the same money twice on the dashboard.
 */
ordersRouter.get('/prefill/from-proforma/:piId', (req: AuthedRequest, res) => {
  const piId = Number(req.params.piId);
  const pi = db.prepare('SELECT * FROM proforma_invoices WHERE id = ?').get(piId) as Record<string, unknown> | undefined;
  if (!pi || !canAccessCustomer(req, Number(pi.customer_id))) return res.status(404).json({ error: 'Proforma invoice not found' });
  const items = db.prepare('SELECT * FROM pi_items WHERE pi_id = ? ORDER BY sort_order, id').all(piId);
  res.json({
    // Echoed back on save so the proforma can be pointed at the new order.
    pi_id: piId,
    quotation_id: pi.quotation_id,
    customer_id: pi.customer_id,
    company_id: pi.company_id,
    currency: pi.currency,
    tax_type: pi.tax_type,
    is_export: pi.is_export,
    payment_terms: pi.payment_terms,
    inco_terms: pi.inco_terms,
    container_count: pi.container_count,
    freight: pi.freight,
    insurance: pi.insurance,
    destination: pi.final_destination,
    po_number: pi.po_number,
    po_date: pi.po_date,
    spoc: pi.prepared_by,
    column_config: JSON.parse(String(pi.column_config || '{}')),
    items,
  });
});

ordersRouter.post('/', (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  if (!body.customer_id) return res.status(400).json({ error: 'Customer is required' });
  if (!canAccessCustomer(req, Number(body.customer_id))) return res.status(403).json({ error: 'That customer is not assigned to you' });
  const h = headerValues(body);
  const link = linkError(req, 'quotations', h.quotation_id, h.customer_id, 'Quotation');
  if (link) return res.status(404).json({ error: link });
  // Fixed at creation: the number below comes from this company's series.
  const companyId = resolveCompanyId(body.company_id, Number(body.customer_id));
  const id = transaction(() => {
    const number = nextNumber('order', { isExport: h.is_export === 1, companyId, date: h.date });
    const info = db.prepare(
      `INSERT INTO orders (number, company_id, ${headerFields.join(', ')}, created_by, column_config, status)
       VALUES (?, ?, ${headerFields.map(() => '?').join(', ')}, ?, ?, ?)`
    ).run(
      number,
      companyId,
      ...(headerFields.map((f) => (h as Record<string, unknown>)[f]) as never[]),
      req.user!.id,
      JSON.stringify(body.column_config ?? {}),
      String(body.status ?? 'pending')
    );
    const id = Number(info.lastInsertRowid);
    saveItems(id, (body.items ?? []) as OrderItemInput[], h.tax_type, h.freight, h.insurance, h.currency);

    /**
     * Booked from a proforma: point that proforma at this order.
     *
     * The link lives on `proforma_invoices.order_id`, not on the order — which
     * is what `dispatchProgress()` already walks to find invoices raised
     * through a proforma, so tracking works with no schema change.
     *
     * Only claimed when the proforma is unattached. A proforma that already
     * names an order keeps it: re-pointing it would silently orphan the first
     * order's dispatch figures.
     */
    if (body.pi_id) {
      const pi = db.prepare('SELECT customer_id, order_id FROM proforma_invoices WHERE id = ?')
        .get(Number(body.pi_id)) as { customer_id: number; order_id: number | null } | undefined;
      // Same customer as well as in scope: a proforma raised for one buyer must
      // not end up carrying another buyer's order.
      if (pi && pi.order_id == null && canAccessCustomer(req, pi.customer_id)
        && Number(pi.customer_id) === Number(h.customer_id)) {
        db.prepare('UPDATE proforma_invoices SET order_id = ? WHERE id = ?').run(id, Number(body.pi_id));
      }
    }
    return id;
  });
  res.status(201).json(getFull(id));
});

ordersRouter.put('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing || !canAccessCustomer(req, Number(existing.customer_id))) return res.status(404).json({ error: 'Order not found' });
  const h = headerValues(body, existing);
  const moved = customerChangeError(req, existing.customer_id as number, h.customer_id);
  if (moved) return res.status(403).json({ error: moved });
  const link = linkError(req, 'quotations', h.quotation_id, h.customer_id, 'Quotation');
  if (link) return res.status(404).json({ error: link });
  transaction(() => {
    db.prepare(
      `UPDATE orders SET number = ?, column_config = ?, ${headerFields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`
    ).run(
      String(body.number ?? existing.number),
      JSON.stringify(body.column_config ?? JSON.parse(String(existing.column_config || '{}'))),
      ...(headerFields.map((f) => (h as Record<string, unknown>)[f]) as never[]),
      id
    );
    if (Array.isArray(body.items)) saveItems(id, body.items as OrderItemInput[], h.tax_type, h.freight, h.insurance, h.currency);
  });
  // Changing what was ordered changes whether it has all been billed: asking
  // for more than has shipped re-opens an order the invoices had closed.
  syncOrderStatus(id);
  res.json(getFull(id));
});

ordersRouter.post('/:id/status', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const { status } = req.body ?? {};
  const allowed = ['pending', 'confirmed', 'scheduled', 'in_production', 'ready', 'partially_dispatched', 'completed', 'cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const existing = db.prepare('SELECT customer_id FROM orders WHERE id = ?').get(id) as { customer_id: number } | undefined;
  if (!existing || !canAccessCustomer(req, existing.customer_id)) return res.status(404).json({ error: 'Order not found' });
  // Clearing the memory is what makes a hand-closed order stay closed: with
  // nothing remembered, syncOrderStatus will never re-open it, which is right
  // when a short shipment has been accepted and the invoices will never add up.
  db.prepare("UPDATE orders SET status = ?, status_before_completed = '' WHERE id = ?").run(String(status), id);
  res.json(getFull(id));
});

ordersRouter.delete('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT customer_id FROM orders WHERE id = ?').get(id) as { customer_id: number } | undefined;
  if (!existing || !canAccessCustomer(req, existing.customer_id)) return res.status(404).json({ error: 'Order not found' });
  const used = db.prepare(
    `SELECT (SELECT COUNT(*) FROM proforma_invoices WHERE order_id = ?) +
            (SELECT COUNT(*) FROM commercial_invoices WHERE order_id = ?) AS c`
  ).get(id, id) as { c: number };
  if (used.c > 0) return res.status(409).json({ error: 'This order has documents raised against it and cannot be deleted' });
  // work_orders cascades on order_id, so without this the delete would take a
  // job and its shift entries with it — a day's production, gone quietly.
  const jobs = db.prepare('SELECT COUNT(*) AS c FROM work_orders WHERE order_id = ?').get(id) as { c: number };
  if (jobs.c > 0) {
    return res.status(409).json({ error: `This order has ${jobs.c} work order${jobs.c === 1 ? '' : 's'} against it and cannot be deleted` });
  }
  // Same reasoning: despatches cascade on order_id, and they are the record of
  // goods that physically left the plant.
  const trips = db.prepare('SELECT COUNT(*) AS c FROM despatches WHERE order_id = ?').get(id) as { c: number };
  if (trips.c > 0) {
    return res.status(409).json({ error: `This order has ${trips.c} despatch${trips.c === 1 ? '' : 'es'} recorded against it and cannot be deleted` });
  }
  transaction(() => {
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
    db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  });
  res.json({ ok: true });
});
