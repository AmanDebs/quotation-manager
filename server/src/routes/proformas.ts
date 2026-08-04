import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { nextNumber } from '../services/numbering.js';
import { computeTotals, round2, type LineItemInput } from '../services/totals.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { scopeClause, canAccessCustomer } from '../middleware/scope.js';
import { submit, decide, resetApprovalOnEdit, blockUnapprovedTransition } from '../services/approval.js';

export const proformasRouter = Router();

const listSql = `
  SELECT p.*, c.name AS customer_name, c.country AS customer_country, q.number AS quotation_number,
         o.number AS order_number, u.name AS created_by_name, a.name AS approved_by_name
  FROM proforma_invoices p
  JOIN customers c ON c.id = p.customer_id
  LEFT JOIN quotations q ON q.id = p.quotation_id
  LEFT JOIN orders o ON o.id = p.order_id
  LEFT JOIN users u ON u.id = p.created_by
  LEFT JOIN users a ON a.id = p.approved_by`;

function getFull(id: number) {
  const pi = db.prepare(`${listSql} WHERE p.id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!pi) return undefined;
  pi.items = db.prepare('SELECT * FROM pi_items WHERE pi_id = ? ORDER BY sort_order, id').all(id);
  pi.column_config = JSON.parse(String(pi.column_config || '{}'));
  const payments = db.prepare('SELECT * FROM payments WHERE pi_id = ? ORDER BY date, id').all(id) as { amount: number }[];
  pi.payments = payments;
  pi.amount_received = round2(payments.reduce((s, p) => s + p.amount, 0));
  return pi;
}

function saveItems(piId: number, items: LineItemInput[], taxType: 'none' | 'cgst_sgst' | 'igst', freight: number, insurance: number, currency: string) {
  const totals = computeTotals(items, taxType, freight, insurance, currency);
  db.prepare('DELETE FROM pi_items WHERE pi_id = ?').run(piId);
  const ins = db.prepare(
    `INSERT INTO pi_items (pi_id, product_id, description, hsn_code, qty, unit, unit_price, tax_pct, amount, color, packs, pcs_per_pack, total_pcs, custom1, custom2, custom3, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  totals.items.forEach((it, i) =>
    ins.run(piId, it.product_id ?? null, it.description, it.hsn_code ?? '', it.qty ?? null, it.unit ?? 'unit', it.unit_price, it.tax_pct ?? 0, it.amount,
      it.color ?? '', it.packs ?? null, it.pcs_per_pack ?? null, it.total_pcs ?? null,
      it.custom1 ?? '', it.custom2 ?? '', it.custom3 ?? '', i)
  );
  db.prepare('UPDATE proforma_invoices SET subtotal = ?, tax_total = ?, grand_total = ? WHERE id = ?').run(
    totals.subtotal, totals.tax_total, totals.grand_total, piId
  );
}

const headerFields = [
  'date', 'customer_id', 'quotation_id', 'order_id', 'consignee', 'notify_party', 'currency', 'freight', 'insurance',
  'lead_time', 'bank_account', 'inco_terms', 'payment_terms', 'delivery_terms', 'validity_date',
  'is_export', 'country_of_origin', 'port_of_loading', 'port_of_discharge', 'final_destination',
  'container_count', 'partial_shipment', 'po_number', 'po_date',
  'notify_party_2', 'method_of_despatch', 'quantity_tolerance', 'hs_code', 'prepared_by',
  'remarks', 'tax_type',
] as const;

function headerValues(body: Record<string, unknown>, existing?: Record<string, unknown>) {
  const v = (f: string, def: unknown = '') => body[f] ?? existing?.[f] ?? def;
  return {
    date: String(v('date', new Date().toISOString().slice(0, 10))),
    customer_id: Number(v('customer_id', 0)),
    quotation_id: v('quotation_id', null) ? Number(v('quotation_id')) : null,
    order_id: v('order_id', null) ? Number(v('order_id')) : null,
    consignee: String(v('consignee')),
    notify_party: String(v('notify_party')),
    currency: String(v('currency', 'INR')),
    freight: Number(v('freight', 0)),
    insurance: Number(v('insurance', 0)),
    lead_time: String(v('lead_time')),
    bank_account: String(v('bank_account')),
    inco_terms: String(v('inco_terms')),
    payment_terms: String(v('payment_terms')),
    delivery_terms: String(v('delivery_terms')),
    validity_date: String(v('validity_date')),
    is_export: Number(v('is_export', 0)) ? 1 : 0,
    country_of_origin: String(v('country_of_origin')),
    port_of_loading: String(v('port_of_loading')),
    port_of_discharge: String(v('port_of_discharge')),
    final_destination: String(v('final_destination')),
    container_count: String(v('container_count')),
    partial_shipment: String(v('partial_shipment', 'Not Allowed')),
    po_number: String(v('po_number')),
    po_date: String(v('po_date')),
    notify_party_2: String(v('notify_party_2')),
    method_of_despatch: String(v('method_of_despatch')),
    quantity_tolerance: String(v('quantity_tolerance')),
    hs_code: String(v('hs_code')),
    prepared_by: String(v('prepared_by')),
    remarks: String(v('remarks')),
    tax_type: String(v('tax_type', 'none')) as 'none' | 'cgst_sgst' | 'igst',
  };
}

proformasRouter.get('/', (req: AuthedRequest, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  const scope = scopeClause(req, 'p.customer_id');
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  if (req.query.status) { where.push('p.status = ?'); params.push(String(req.query.status)); }
  if (req.query.export === '1' || req.query.export === '0') { where.push('p.is_export = ?'); params.push(Number(req.query.export)); }
  if (req.query.approval) { where.push('p.approval_status = ?'); params.push(String(req.query.approval)); }
  const sql = `${listSql}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY p.date DESC, p.id DESC`;
  res.json(db.prepare(sql).all(...(params as never[])));
});

proformasRouter.get('/:id', (req: AuthedRequest, res) => {
  const pi = getFull(Number(req.params.id));
  if (!pi || !canAccessCustomer(req, Number(pi.customer_id))) return res.status(404).json({ error: 'Proforma invoice not found' });
  res.json(pi);
});

// Prefill payload for creating a PI from an accepted quotation.
proformasRouter.get('/prefill/from-quotation/:quotationId', (req: AuthedRequest, res) => {
  const qid = Number(req.params.quotationId);
  const q = db.prepare('SELECT * FROM quotations WHERE id = ?').get(qid) as Record<string, unknown> | undefined;
  if (!q || !canAccessCustomer(req, Number(q.customer_id))) return res.status(404).json({ error: 'Quotation not found' });
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(q.customer_id)) as Record<string, unknown>;
  const items = db.prepare('SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY sort_order, id').all(qid);
  const isExport = String(customer.country ?? 'India').trim().toLowerCase() !== 'india';
  res.json({
    quotation_id: qid,
    customer_id: q.customer_id,
    currency: q.currency,
    payment_terms: q.payment_terms,
    delivery_terms: q.delivery_terms,
    tax_type: isExport ? 'none' : q.tax_type,
    is_export: isExport ? 1 : 0,
    consignee: customer.consignee || '',
    notify_party: customer.notify_party || '',
    notify_party_2: customer.notify_party_2 || '',
    country_of_origin: isExport ? 'India' : '',
    quantity_tolerance: isExport ? '(±) 10% in value and quantity' : '',
    inco_terms: q.inco_terms ?? '',
    container_count: q.container_count ?? '',
    freight: q.freight ?? 0,
    insurance: q.insurance ?? 0,
    column_config: JSON.parse(String(q.column_config || '{}')),
    items,
  });
});

// Prefill payload for raising a proforma against a booked order.
proformasRouter.get('/prefill/from-order/:orderId', (req: AuthedRequest, res) => {
  const oid = Number(req.params.orderId);
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(oid) as Record<string, unknown> | undefined;
  if (!o || !canAccessCustomer(req, Number(o.customer_id))) return res.status(404).json({ error: 'Order not found' });
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(o.customer_id)) as Record<string, unknown>;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY sort_order, id').all(oid);
  const isExport = Number(o.is_export) === 1;
  res.json({
    order_id: oid,
    quotation_id: o.quotation_id,
    customer_id: o.customer_id,
    currency: o.currency,
    tax_type: o.tax_type,
    is_export: isExport ? 1 : 0,
    payment_terms: o.payment_terms,
    inco_terms: o.inco_terms,
    container_count: o.container_count,
    freight: o.freight,
    insurance: o.insurance,
    po_number: o.po_number,
    po_date: o.po_date,
    port_of_discharge: o.destination,
    final_destination: o.destination,
    method_of_despatch: o.transport,
    prepared_by: o.spoc,
    consignee: customer.consignee || '',
    notify_party: customer.notify_party || '',
    notify_party_2: customer.notify_party_2 || '',
    country_of_origin: isExport ? 'India' : '',
    quantity_tolerance: isExport ? '(±) 10% in value and quantity' : '',
    column_config: JSON.parse(String(o.column_config || '{}')),
    items,
  });
});

proformasRouter.post('/', (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  if (!body.customer_id) return res.status(400).json({ error: 'Customer is required' });
  if (!canAccessCustomer(req, Number(body.customer_id))) return res.status(403).json({ error: 'That customer is not assigned to you' });
  const h = headerValues(body);
  const id = transaction(() => {
    const number = nextNumber('proforma', { isExport: h.is_export === 1 });
    const info = db.prepare(
      `INSERT INTO proforma_invoices (number, ${headerFields.join(', ')}, created_by, column_config, status)
       VALUES (?, ${headerFields.map(() => '?').join(', ')}, ?, ?, 'draft')`
    ).run(
      number,
      ...(headerFields.map((f) => (h as Record<string, unknown>)[f]) as never[]),
      req.user!.id,
      JSON.stringify(body.column_config ?? {})
    );
    const id = Number(info.lastInsertRowid);
    saveItems(id, (body.items ?? []) as LineItemInput[], h.tax_type, h.freight, h.insurance, h.currency);
    return id;
  });
  res.status(201).json(getFull(id));
});

proformasRouter.put('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  const existing = db.prepare('SELECT * FROM proforma_invoices WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing || !canAccessCustomer(req, Number(existing.customer_id))) return res.status(404).json({ error: 'Proforma invoice not found' });
  const h = headerValues(body, existing);
  transaction(() => {
    db.prepare(
      `UPDATE proforma_invoices SET number = ?, column_config = ?, ${headerFields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`
    ).run(
      String(body.number ?? existing.number),
      JSON.stringify(body.column_config ?? JSON.parse(String(existing.column_config || '{}'))),
      ...(headerFields.map((f) => (h as Record<string, unknown>)[f]) as never[]),
      id
    );
    if (Array.isArray(body.items)) saveItems(id, body.items as LineItemInput[], h.tax_type, h.freight, h.insurance, h.currency);
    resetApprovalOnEdit('proforma_invoices', id);
  });
  res.json(getFull(id));
});

proformasRouter.post('/:id/submit', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT customer_id FROM proforma_invoices WHERE id = ?').get(id) as { customer_id: number } | undefined;
  if (!existing || !canAccessCustomer(req, existing.customer_id)) return res.status(404).json({ error: 'Proforma invoice not found' });
  submit('proforma_invoices', id, req.user!);
  res.json(getFull(id));
});

proformasRouter.post('/:id/approve', (req: AuthedRequest, res) => {
  if (req.user!.role !== 'manager') return res.status(403).json({ error: 'Only a manager can approve documents' });
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM proforma_invoices WHERE id = ?').get(id)) return res.status(404).json({ error: 'Proforma invoice not found' });
  decide('proforma_invoices', id, req.user!, req.body?.approve !== false, String(req.body?.note ?? ''));
  res.json(getFull(id));
});

proformasRouter.post('/:id/status', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const { status } = req.body ?? {};
  const allowed = ['draft', 'sent', 'order_confirmed', 'advance_received', 'in_production', 'cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const existing = db.prepare('SELECT customer_id FROM proforma_invoices WHERE id = ?').get(id) as { customer_id: number } | undefined;
  if (!existing || !canAccessCustomer(req, existing.customer_id)) return res.status(404).json({ error: 'Proforma invoice not found' });
  const blocked = blockUnapprovedTransition('proforma_invoices', id, String(status), req);
  if (blocked) return res.status(409).json({ error: blocked });
  db.prepare('UPDATE proforma_invoices SET status = ? WHERE id = ?').run(String(status), id);
  res.json(getFull(id));
});

proformasRouter.delete('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT customer_id FROM proforma_invoices WHERE id = ?').get(id) as { customer_id: number } | undefined;
  if (!existing || !canAccessCustomer(req, existing.customer_id)) return res.status(404).json({ error: 'Proforma invoice not found' });
  const used = db.prepare('SELECT COUNT(*) AS c FROM commercial_invoices WHERE pi_id = ?').get(id) as { c: number };
  if (used.c > 0) return res.status(409).json({ error: 'Proforma has a commercial invoice and cannot be deleted' });
  const paid = db.prepare('SELECT COUNT(*) AS c FROM payments WHERE pi_id = ?').get(id) as { c: number };
  if (paid.c > 0) return res.status(409).json({ error: 'Proforma has recorded payments and cannot be deleted' });
  transaction(() => {
    db.prepare('DELETE FROM pi_items WHERE pi_id = ?').run(id);
    db.prepare('DELETE FROM proforma_invoices WHERE id = ?').run(id);
  });
  res.json({ ok: true });
});
