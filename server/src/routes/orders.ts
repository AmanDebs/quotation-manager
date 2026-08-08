import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { nextNumber } from '../services/numbering.js';
import { computeTotals, round2, type LineItemInput } from '../services/totals.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { scopeClause, canAccessCustomer } from '../middleware/scope.js';
import { resolveCompanyId } from '../services/companies.js';

export const ordersRouter = Router();

const listSql = `
  SELECT o.*, c.name AS customer_name, c.country AS customer_country,
         q.number AS quotation_number, u.name AS created_by_name
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
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
  order.items = items.map((it, i) => ({ ...it, ...progress.perLine[i] }));
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
       color, packs, pcs_per_pack, total_pcs, qty_20ft, qty_40ft, supplier, scheduled_date, dispatched_date, custom1, custom2, custom3, image, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  totals.items.forEach((it, i) => {
    const src = items[i] ?? {};
    ins.run(orderId, it.product_id ?? null, it.description, it.hsn_code ?? '', String(src.code ?? ''),
      it.qty ?? null, it.unit ?? 'unit', it.unit_price, it.tax_pct ?? 0, it.amount,
      it.color ?? '', it.packs ?? null, it.pcs_per_pack ?? null, it.total_pcs ?? null,
      it.qty_20ft ?? null, it.qty_40ft ?? null,
      String(src.supplier ?? ''), String(src.scheduled_date ?? ''), String(src.dispatched_date ?? ''),
      it.custom1 ?? '', it.custom2 ?? '', it.custom3 ?? '', it.image ?? '', i);
  });
  db.prepare('UPDATE orders SET subtotal = ?, tax_total = ?, grand_total = ? WHERE id = ?').run(
    totals.subtotal, totals.tax_total, totals.grand_total, orderId
  );
}

ordersRouter.get('/', (req: AuthedRequest, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  const scope = scopeClause(req, 'o.customer_id');
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  if (req.query.status) { where.push('o.status = ?'); params.push(String(req.query.status)); }
  if (req.query.export === '1' || req.query.export === '0') { where.push('o.is_export = ?'); params.push(Number(req.query.export)); }
  // ?open=1 → the order book: everything not yet completed or cancelled.
  if (req.query.open === '1') where.push("o.status NOT IN ('completed','cancelled')");
  const sql = `${listSql}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY o.date DESC, o.id DESC`;
  const rows = db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  // Lists show progress too, so the order book reads at a glance.
  res.json(rows.map((o) => {
    const items = db.prepare('SELECT qty, unit_price FROM order_items WHERE order_id = ? ORDER BY sort_order, id')
      .all(Number(o.id)) as { qty: number | null; unit_price: number }[];
    const p = dispatchProgress(Number(o.id), items);
    return { ...o, dispatched_value: p.dispatched_value, pending_value: p.pending_value, any_dispatched: p.any_dispatched };
  }));
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

ordersRouter.post('/', (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  if (!body.customer_id) return res.status(400).json({ error: 'Customer is required' });
  if (!canAccessCustomer(req, Number(body.customer_id))) return res.status(403).json({ error: 'That customer is not assigned to you' });
  const h = headerValues(body);
  // Fixed at creation: the number below comes from this company's series.
  const companyId = resolveCompanyId(body.company_id, Number(body.customer_id));
  const id = transaction(() => {
    const number = nextNumber('order', { isExport: h.is_export === 1, companyId });
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
  res.json(getFull(id));
});

ordersRouter.post('/:id/status', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const { status } = req.body ?? {};
  const allowed = ['pending', 'confirmed', 'scheduled', 'in_production', 'ready', 'partially_dispatched', 'completed', 'cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const existing = db.prepare('SELECT customer_id FROM orders WHERE id = ?').get(id) as { customer_id: number } | undefined;
  if (!existing || !canAccessCustomer(req, existing.customer_id)) return res.status(404).json({ error: 'Order not found' });
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(String(status), id);
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
  transaction(() => {
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
    db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  });
  res.json({ ok: true });
});
