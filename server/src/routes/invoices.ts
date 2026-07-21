import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { nextNumber } from '../services/numbering.js';
import { computeTotals, round2, type LineItemInput } from '../services/totals.js';

export const invoicesRouter = Router();

const listSql = `
  SELECT i.*, c.name AS customer_name, c.country AS customer_country, p.number AS pi_number
  FROM commercial_invoices i
  JOIN customers c ON c.id = i.customer_id
  LEFT JOIN proforma_invoices p ON p.id = i.pi_id`;

function getFull(id: number) {
  const inv = db.prepare(`${listSql} WHERE i.id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!inv) return undefined;
  inv.items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id').all(id);
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
  // Payments: recorded directly on this invoice plus advances taken on the source PI.
  const payments = inv.pi_id
    ? db.prepare('SELECT * FROM payments WHERE invoice_id = ? OR pi_id = ? ORDER BY date, id').all(id, Number(inv.pi_id))
    : db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY date, id').all(id);
  inv.payments = payments;
  inv.amount_received = round2((payments as { amount: number }[]).reduce((s, p) => s + p.amount, 0));
  inv.balance_due = round2(Number(inv.grand_total) - Number(inv.amount_received));
  return inv;
}

function saveItems(invoiceId: number, items: LineItemInput[], taxType: 'none' | 'cgst_sgst' | 'igst', freight: number, insurance: number) {
  const totals = computeTotals(items, taxType, freight, insurance);
  db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
  const ins = db.prepare(
    `INSERT INTO invoice_items (invoice_id, product_id, description, hsn_code, qty, unit, unit_price, tax_pct, amount, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  totals.items.forEach((it, i) =>
    ins.run(invoiceId, it.product_id ?? null, it.description, it.hsn_code ?? '', it.qty ?? null, it.unit ?? 'unit', it.unit_price, it.tax_pct ?? 0, it.amount, i)
  );
  db.prepare('UPDATE commercial_invoices SET subtotal = ?, tax_total = ?, grand_total = ? WHERE id = ?').run(
    totals.subtotal, totals.tax_total, totals.grand_total, invoiceId
  );
}

const headerFields = [
  'date', 'customer_id', 'pi_id', 'consignee', 'notify_party', 'currency', 'freight', 'insurance',
  'shipping_details', 'bank_account', 'inco_terms', 'payment_terms',
  'is_export', 'country_of_origin', 'port_of_loading', 'port_of_discharge', 'final_destination',
  'remarks', 'tax_type',
] as const;

function headerValues(body: Record<string, unknown>, existing?: Record<string, unknown>) {
  const v = (f: string, def: unknown = '') => body[f] ?? existing?.[f] ?? def;
  return {
    date: String(v('date', new Date().toISOString().slice(0, 10))),
    customer_id: Number(v('customer_id', 0)),
    pi_id: v('pi_id', null) ? Number(v('pi_id')) : null,
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
    remarks: String(v('remarks')),
    tax_type: String(v('tax_type', 'none')) as 'none' | 'cgst_sgst' | 'igst',
  };
}

invoicesRouter.get('/', (req, res) => {
  const status = String(req.query.status ?? '');
  const rows = status
    ? db.prepare(`${listSql} WHERE i.status = ? ORDER BY i.date DESC, i.id DESC`).all(status)
    : db.prepare(`${listSql} ORDER BY i.date DESC, i.id DESC`).all();
  res.json(rows);
});

invoicesRouter.get('/:id', (req, res) => {
  const inv = getFull(Number(req.params.id));
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  res.json(inv);
});

// Prefill payload for creating a commercial invoice from a PI.
invoicesRouter.get('/prefill/from-proforma/:piId', (req, res) => {
  const piId = Number(req.params.piId);
  const pi = db.prepare('SELECT * FROM proforma_invoices WHERE id = ?').get(piId) as Record<string, unknown> | undefined;
  if (!pi) return res.status(404).json({ error: 'Proforma invoice not found' });
  const items = db.prepare('SELECT * FROM pi_items WHERE pi_id = ? ORDER BY sort_order, id').all(piId);
  res.json({
    pi_id: piId,
    customer_id: pi.customer_id,
    consignee: pi.consignee,
    notify_party: pi.notify_party,
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
    items,
  });
});

invoicesRouter.post('/', (req, res) => {
  const body = req.body ?? {};
  if (!body.customer_id) return res.status(400).json({ error: 'Customer is required' });
  const h = headerValues(body);
  const id = transaction(() => {
    const number = nextNumber('invoice');
    const info = db.prepare(
      `INSERT INTO commercial_invoices (number, ${headerFields.join(', ')}, status)
       VALUES (?, ${headerFields.map(() => '?').join(', ')}, 'draft')`
    ).run(number, ...(headerFields.map((f) => (h as Record<string, unknown>)[f]) as never[]));
    const id = Number(info.lastInsertRowid);
    saveItems(id, (body.items ?? []) as LineItemInput[], h.tax_type, h.freight, h.insurance);
    return id;
  });
  res.status(201).json(getFull(id));
});

invoicesRouter.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  const existing = db.prepare('SELECT * FROM commercial_invoices WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return res.status(404).json({ error: 'Invoice not found' });
  const h = headerValues(body, existing);
  transaction(() => {
    db.prepare(
      `UPDATE commercial_invoices SET ${headerFields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`
    ).run(...(headerFields.map((f) => (h as Record<string, unknown>)[f]) as never[]), id);
    if (Array.isArray(body.items)) saveItems(id, body.items as LineItemInput[], h.tax_type, h.freight, h.insurance);
  });
  res.json(getFull(id));
});

invoicesRouter.post('/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body ?? {};
  const allowed = ['draft', 'final', 'dispatched', 'paid'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (!db.prepare('SELECT id FROM commercial_invoices WHERE id = ?').get(id)) return res.status(404).json({ error: 'Invoice not found' });
  db.prepare('UPDATE commercial_invoices SET status = ? WHERE id = ?').run(String(status), id);
  res.json(getFull(id));
});

invoicesRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const used = db.prepare('SELECT COUNT(*) AS c FROM packing_lists WHERE invoice_id = ?').get(id) as { c: number };
  if (used.c > 0) return res.status(409).json({ error: 'Invoice has a packing list and cannot be deleted' });
  const paid = db.prepare('SELECT COUNT(*) AS c FROM payments WHERE invoice_id = ?').get(id) as { c: number };
  if (paid.c > 0) return res.status(409).json({ error: 'Invoice has recorded payments and cannot be deleted' });
  transaction(() => {
    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);
    db.prepare('DELETE FROM commercial_invoices WHERE id = ?').run(id);
  });
  res.json({ ok: true });
});
