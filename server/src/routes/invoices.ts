import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { nextNumber } from '../services/numbering.js';
import { computeTotals, round2, type LineItemInput } from '../services/totals.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { scopeClause, canAccessCustomer } from '../middleware/scope.js';
import { submit, decide, resetApprovalOnEdit, blockUnapprovedTransition } from '../services/approval.js';
import { invoiceReceivable } from '../services/receivables.js';

export const invoicesRouter = Router();

const listSql = `
  SELECT i.*, c.name AS customer_name, c.country AS customer_country, p.number AS pi_number,
         u.name AS created_by_name, a.name AS approved_by_name
  FROM commercial_invoices i
  JOIN customers c ON c.id = i.customer_id
  LEFT JOIN proforma_invoices p ON p.id = i.pi_id
  LEFT JOIN users u ON u.id = i.created_by
  LEFT JOIN users a ON a.id = i.approved_by`;

function getFull(id: number) {
  const inv = db.prepare(`${listSql} WHERE i.id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!inv) return undefined;
  inv.items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id').all(id);
  inv.column_config = JSON.parse(String(inv.column_config || '{}'));
  // Qty variance vs source PI (10% clause) computed for the client to display.
  if (inv.pi_id) {
    const piItems = db.prepare('SELECT description, qty FROM pi_items WHERE pi_id = ? ORDER BY sort_order, id').all(Number(inv.pi_id)) as {
      description: string; qty: number | null;
    }[];
    const piQty = new Map(piItems.map((p) => [p.description, p.qty]));
    inv.variance = (inv.items as { description: string; qty: number | null }[])
      .filter((it) => it.qty != null && piQty.get(it.description) != null && piQty.get(it.description) !== 0)
      .map((it) => {
        const original = piQty.get(it.description)!;
        const pct = ((it.qty! - original) / original) * 100;
        return { description: it.description, pi_qty: original, invoice_qty: it.qty, variance_pct: Math.round(pct * 100) / 100 };
      })
      .filter((v) => v.variance_pct !== 0);
  }
  // Payments: recorded directly on this invoice, plus this invoice's share of any
  // advance taken on the source PI (see services/receivables.ts).
  const money = invoiceReceivable(id);
  inv.payments = money.payments;
  inv.amount_received = money.amount_received;
  inv.balance_due = money.balance_due;
  inv.advance_applied = money.advance_applied;

  // The paired packing list travels with the invoice everywhere.
  const pl = db.prepare('SELECT * FROM packing_lists WHERE invoice_id = ?').get(id) as Record<string, unknown> | undefined;
  if (pl) {
    const plItems = db.prepare('SELECT * FROM packing_list_items WHERE packing_list_id = ? ORDER BY sort_order, id').all(Number(pl.id)) as
      { gross_weight: number; net_weight: number }[];
    inv.packing = {
      ...pl,
      column_config: JSON.parse(String(pl.column_config || '{}')),
      items: plItems,
      total_gross: round2(plItems.reduce((s, it) => s + (it.gross_weight || 0), 0)),
      total_net: round2(plItems.reduce((s, it) => s + (it.net_weight || 0), 0)),
    };
  }
  return inv;
}

interface PackingInput {
  number?: string;
  date?: string;
  shipping_marks?: string;
  remarks?: string;
  column_config?: unknown;
  items?: {
    packages?: string; dimensions?: string; gross_weight?: number; net_weight?: number;
    custom1?: string; custom2?: string; custom3?: string;
  }[];
}

/**
 * A commercial invoice and its packing list are one act of work: they describe
 * the same shipment and always travel together. The invoice owns the packing
 * list — it is created on first save and its line items are always derived from
 * the invoice's items, so the two documents can never disagree about what is
 * being shipped. Only the packing-specific values (cartons, dimensions,
 * weights) come from the client.
 */
function syncPackingList(invoiceId: number, userId: number, packing: PackingInput | undefined) {
  const inv = db.prepare('SELECT * FROM commercial_invoices WHERE id = ?').get(invoiceId) as Record<string, unknown>;
  let pl = db.prepare('SELECT * FROM packing_lists WHERE invoice_id = ?').get(invoiceId) as Record<string, unknown> | undefined;

  if (!pl) {
    const number = nextNumber('packing_list');
    const info = db.prepare(
      `INSERT INTO packing_lists (number, date, invoice_id, customer_id, shipping_marks, lot_no, remarks, created_by, column_config)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      packing?.number || number,
      String(packing?.date ?? inv.date),
      invoiceId,
      Number(inv.customer_id),
      String(packing?.shipping_marks ?? ''),
      String(inv.lot_no ?? ''),
      String(packing?.remarks ?? ''),
      userId,
      JSON.stringify(packing?.column_config ?? {})
    );
    pl = { id: Number(info.lastInsertRowid) };
  } else {
    db.prepare(
      `UPDATE packing_lists SET number = ?, date = ?, customer_id = ?, shipping_marks = ?, lot_no = ?, remarks = ?, column_config = ? WHERE id = ?`
    ).run(
      String(packing?.number ?? pl.number),
      String(packing?.date ?? pl.date),
      Number(inv.customer_id),
      String(packing?.shipping_marks ?? pl.shipping_marks ?? ''),
      String(inv.lot_no ?? ''),
      String(packing?.remarks ?? pl.remarks ?? ''),
      JSON.stringify(packing?.column_config ?? JSON.parse(String(pl.column_config || '{}'))),
      Number(pl.id)
    );
  }

  const plId = Number(pl.id);
  const invItems = db.prepare(
    'SELECT description, hsn_code, qty, unit FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id'
  ).all(invoiceId) as { description: string; hsn_code: string; qty: number | null; unit: string }[];

  db.prepare('DELETE FROM packing_list_items WHERE packing_list_id = ?').run(plId);
  const ins = db.prepare(
    `INSERT INTO packing_list_items (packing_list_id, description, hsn_code, qty, unit, packages, dimensions, gross_weight, net_weight, custom1, custom2, custom3, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  invItems.forEach((it, i) => {
    const p = packing?.items?.[i] ?? {};
    ins.run(plId, it.description, it.hsn_code ?? '', it.qty ?? null, it.unit ?? 'unit',
      String(p.packages ?? ''), String(p.dimensions ?? ''), Number(p.gross_weight ?? 0), Number(p.net_weight ?? 0),
      String(p.custom1 ?? ''), String(p.custom2 ?? ''), String(p.custom3 ?? ''), i);
  });
}

function saveItems(invoiceId: number, items: LineItemInput[], taxType: 'none' | 'cgst_sgst' | 'igst', freight: number, insurance: number, currency: string) {
  const totals = computeTotals(items, taxType, freight, insurance, currency);
  db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
  const ins = db.prepare(
    `INSERT INTO invoice_items (invoice_id, product_id, description, hsn_code, qty, unit, unit_price, tax_pct, amount, color, packs, pcs_per_pack, total_pcs, qty_20ft, qty_40ft, custom1, custom2, custom3, image, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  totals.items.forEach((it, i) =>
    ins.run(invoiceId, it.product_id ?? null, it.description, it.hsn_code ?? '', it.qty ?? null, it.unit ?? 'unit', it.unit_price, it.tax_pct ?? 0, it.amount,
      it.color ?? '', it.packs ?? null, it.pcs_per_pack ?? null, it.total_pcs ?? null,
      it.qty_20ft ?? null, it.qty_40ft ?? null,
      it.custom1 ?? '', it.custom2 ?? '', it.custom3 ?? '', it.image ?? '', i)
  );
  db.prepare('UPDATE commercial_invoices SET subtotal = ?, tax_total = ?, grand_total = ? WHERE id = ?').run(
    totals.subtotal, totals.tax_total, totals.grand_total, invoiceId
  );
}

const headerFields = [
  'date', 'customer_id', 'pi_id', 'order_id', 'consignee', 'notify_party', 'currency', 'freight', 'insurance',
  'shipping_details', 'bank_account', 'inco_terms', 'payment_terms',
  'is_export', 'country_of_origin', 'port_of_loading', 'port_of_discharge', 'final_destination',
  'notify_party_2', 'method_of_despatch', 'lot_no', 'prepared_by',
  'remarks', 'tax_type',
] as const;

function headerValues(body: Record<string, unknown>, existing?: Record<string, unknown>) {
  const v = (f: string, def: unknown = '') => body[f] ?? existing?.[f] ?? def;
  return {
    date: String(v('date', new Date().toISOString().slice(0, 10))),
    customer_id: Number(v('customer_id', 0)),
    pi_id: v('pi_id', null) ? Number(v('pi_id')) : null,
    order_id: v('order_id', null) ? Number(v('order_id')) : null,
    consignee: String(v('consignee')),
    notify_party: String(v('notify_party')),
    currency: String(v('currency', 'INR')),
    freight: Number(v('freight', 0)),
    insurance: Number(v('insurance', 0)),
    shipping_details: String(v('shipping_details')),
    bank_account: String(v('bank_account')),
    inco_terms: String(v('inco_terms')),
    payment_terms: String(v('payment_terms')),
    is_export: Number(v('is_export', 0)) ? 1 : 0,
    country_of_origin: String(v('country_of_origin')),
    port_of_loading: String(v('port_of_loading')),
    port_of_discharge: String(v('port_of_discharge')),
    final_destination: String(v('final_destination')),
    notify_party_2: String(v('notify_party_2')),
    method_of_despatch: String(v('method_of_despatch')),
    lot_no: String(v('lot_no')),
    prepared_by: String(v('prepared_by')),
    remarks: String(v('remarks')),
    tax_type: String(v('tax_type', 'none')) as 'none' | 'cgst_sgst' | 'igst',
  };
}

invoicesRouter.get('/', (req: AuthedRequest, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  const scope = scopeClause(req, 'i.customer_id');
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  if (req.query.status) { where.push('i.status = ?'); params.push(String(req.query.status)); }
  if (req.query.export === '1' || req.query.export === '0') { where.push('i.is_export = ?'); params.push(Number(req.query.export)); }
  if (req.query.approval) { where.push('i.approval_status = ?'); params.push(String(req.query.approval)); }
  const sql = `${listSql}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY i.date DESC, i.id DESC`;
  res.json(db.prepare(sql).all(...(params as never[])));
});

invoicesRouter.get('/:id', (req: AuthedRequest, res) => {
  const inv = getFull(Number(req.params.id));
  if (!inv || !canAccessCustomer(req, Number(inv.customer_id))) return res.status(404).json({ error: 'Invoice not found' });
  res.json(inv);
});

// Prefill payload for creating a commercial invoice from a PI.
invoicesRouter.get('/prefill/from-proforma/:piId', (req: AuthedRequest, res) => {
  const piId = Number(req.params.piId);
  const pi = db.prepare('SELECT * FROM proforma_invoices WHERE id = ?').get(piId) as Record<string, unknown> | undefined;
  if (!pi || !canAccessCustomer(req, Number(pi.customer_id))) return res.status(404).json({ error: 'Proforma invoice not found' });
  const items = db.prepare('SELECT * FROM pi_items WHERE pi_id = ? ORDER BY sort_order, id').all(piId);
  res.json({
    pi_id: piId,
    order_id: pi.order_id,
    customer_id: pi.customer_id,
    consignee: pi.consignee,
    notify_party: pi.notify_party,
    notify_party_2: pi.notify_party_2,
    method_of_despatch: pi.method_of_despatch,
    currency: pi.currency,
    freight: pi.freight,
    insurance: pi.insurance,
    bank_account: pi.bank_account,
    inco_terms: pi.inco_terms,
    payment_terms: pi.payment_terms,
    is_export: pi.is_export,
    country_of_origin: pi.country_of_origin,
    port_of_loading: pi.port_of_loading,
    port_of_discharge: pi.port_of_discharge,
    final_destination: pi.final_destination,
    tax_type: pi.tax_type,
    column_config: JSON.parse(String(pi.column_config || '{}')),
    items,
  });
});

invoicesRouter.post('/', (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  if (!body.customer_id) return res.status(400).json({ error: 'Customer is required' });
  if (!canAccessCustomer(req, Number(body.customer_id))) return res.status(403).json({ error: 'That customer is not assigned to you' });
  const h = headerValues(body);
  const id = transaction(() => {
    const number = nextNumber('invoice', { isExport: h.is_export === 1 });
    const info = db.prepare(
      `INSERT INTO commercial_invoices (number, ${headerFields.join(', ')}, created_by, column_config, status)
       VALUES (?, ${headerFields.map(() => '?').join(', ')}, ?, ?, 'draft')`
    ).run(
      number,
      ...(headerFields.map((f) => (h as Record<string, unknown>)[f]) as never[]),
      req.user!.id,
      JSON.stringify(body.column_config ?? {})
    );
    const id = Number(info.lastInsertRowid);
    saveItems(id, (body.items ?? []) as LineItemInput[], h.tax_type, h.freight, h.insurance, h.currency);
    syncPackingList(id, req.user!.id, body.packing as PackingInput | undefined);
    return id;
  });
  res.status(201).json(getFull(id));
});

invoicesRouter.put('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  const existing = db.prepare('SELECT * FROM commercial_invoices WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing || !canAccessCustomer(req, Number(existing.customer_id))) return res.status(404).json({ error: 'Invoice not found' });
  const h = headerValues(body, existing);
  transaction(() => {
    db.prepare(
      `UPDATE commercial_invoices SET number = ?, column_config = ?, ${headerFields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`
    ).run(
      String(body.number ?? existing.number),
      JSON.stringify(body.column_config ?? JSON.parse(String(existing.column_config || '{}'))),
      ...(headerFields.map((f) => (h as Record<string, unknown>)[f]) as never[]),
      id
    );
    if (Array.isArray(body.items)) saveItems(id, body.items as LineItemInput[], h.tax_type, h.freight, h.insurance, h.currency);
    syncPackingList(id, req.user!.id, body.packing as PackingInput | undefined);
    resetApprovalOnEdit('commercial_invoices', id);
  });
  res.json(getFull(id));
});

invoicesRouter.post('/:id/submit', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT customer_id FROM commercial_invoices WHERE id = ?').get(id) as { customer_id: number } | undefined;
  if (!existing || !canAccessCustomer(req, existing.customer_id)) return res.status(404).json({ error: 'Invoice not found' });
  submit('commercial_invoices', id, req.user!);
  res.json(getFull(id));
});

invoicesRouter.post('/:id/approve', (req: AuthedRequest, res) => {
  if (req.user!.role !== 'manager') return res.status(403).json({ error: 'Only a manager can approve documents' });
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM commercial_invoices WHERE id = ?').get(id)) return res.status(404).json({ error: 'Invoice not found' });
  decide('commercial_invoices', id, req.user!, req.body?.approve !== false, String(req.body?.note ?? ''));
  res.json(getFull(id));
});

invoicesRouter.post('/:id/status', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const { status } = req.body ?? {};
  const allowed = ['draft', 'final', 'dispatched', 'paid'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const existing = db.prepare('SELECT customer_id FROM commercial_invoices WHERE id = ?').get(id) as { customer_id: number } | undefined;
  if (!existing || !canAccessCustomer(req, existing.customer_id)) return res.status(404).json({ error: 'Invoice not found' });
  const blocked = blockUnapprovedTransition('commercial_invoices', id, String(status), req);
  if (blocked) return res.status(409).json({ error: blocked });
  db.prepare('UPDATE commercial_invoices SET status = ? WHERE id = ?').run(String(status), id);
  res.json(getFull(id));
});

invoicesRouter.delete('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT customer_id FROM commercial_invoices WHERE id = ?').get(id) as { customer_id: number } | undefined;
  if (!existing || !canAccessCustomer(req, existing.customer_id)) return res.status(404).json({ error: 'Invoice not found' });
  const paid = db.prepare('SELECT COUNT(*) AS c FROM payments WHERE invoice_id = ?').get(id) as { c: number };
  if (paid.c > 0) return res.status(409).json({ error: 'Invoice has recorded payments and cannot be deleted' });
  transaction(() => {
    // The packing list belongs to the invoice, so it goes with it.
    const pls = db.prepare('SELECT id FROM packing_lists WHERE invoice_id = ?').all(id) as { id: number }[];
    for (const pl of pls) {
      db.prepare('DELETE FROM packing_list_items WHERE packing_list_id = ?').run(pl.id);
      db.prepare('DELETE FROM packing_lists WHERE id = ?').run(pl.id);
    }
    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);
    db.prepare('DELETE FROM commercial_invoices WHERE id = ?').run(id);
  });
  res.json({ ok: true });
});
