import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { nextNumber } from '../services/numbering.js';
import { computeTotals, type LineItemInput } from '../services/totals.js';

export const quotationsRouter = Router();

const listSql = `
  SELECT q.*, c.name AS customer_name, c.country AS customer_country
  FROM quotations q JOIN customers c ON c.id = q.customer_id`;

function getFull(id: number) {
  const quotation = db.prepare(`${listSql} WHERE q.id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!quotation) return undefined;
  quotation.items = db.prepare('SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY sort_order, id').all(id);
  return quotation;
}

function saveItems(
  quotationId: number,
  items: LineItemInput[],
  taxType: 'none' | 'cgst_sgst' | 'igst',
  freight: number,
  insurance: number,
  currency: string
) {
  const totals = computeTotals(items, taxType, freight, insurance, currency);
  db.prepare('DELETE FROM quotation_items WHERE quotation_id = ?').run(quotationId);
  const ins = db.prepare(
    `INSERT INTO quotation_items (quotation_id, product_id, description, hsn_code, qty, unit, unit_price, tax_pct, amount, color, packs, pcs_per_pack, total_pcs, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  totals.items.forEach((it, i) =>
    ins.run(quotationId, it.product_id ?? null, it.description, it.hsn_code ?? '', it.qty ?? null, it.unit ?? 'unit', it.unit_price, it.tax_pct ?? 0, it.amount,
      it.color ?? '', it.packs ?? null, it.pcs_per_pack ?? null, it.total_pcs ?? null, i)
  );
  db.prepare('UPDATE quotations SET subtotal = ?, tax_total = ?, grand_total = ? WHERE id = ?').run(
    totals.subtotal, totals.tax_total, totals.grand_total, quotationId
  );
}

quotationsRouter.get('/', (req, res) => {
  const status = String(req.query.status ?? '');
  const includeSuperseded = req.query.all === '1';
  const where: string[] = [];
  const params: unknown[] = [];
  if (!includeSuperseded) where.push('q.superseded_by IS NULL');
  if (status) { where.push('q.status = ?'); params.push(status); }
  const sql = `${listSql}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY q.date DESC, q.id DESC`;
  res.json(db.prepare(sql).all(...(params as never[])));
});

quotationsRouter.get('/:id', (req, res) => {
  const q = getFull(Number(req.params.id));
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  // Include revision history (same number, other revisions)
  q.revisions = db
    .prepare('SELECT id, revision, status, grand_total, date FROM quotations WHERE number = ? ORDER BY revision')
    .all(String(q.number));
  res.json(q);
});

const headerFields = ['date', 'customer_id', 'enquiry_id', 'currency', 'validity_date', 'payment_terms', 'delivery_terms', 'notes', 'tax_type'];

quotationsRouter.post('/', (req, res) => {
  const body = req.body ?? {};
  if (!body.customer_id) return res.status(400).json({ error: 'Customer is required' });
  const taxType = (body.tax_type ?? 'none') as 'none' | 'cgst_sgst' | 'igst';
  const result = transaction(() => {
    const number = nextNumber('quotation');
    const info = db.prepare(
      `INSERT INTO quotations (number, revision, date, customer_id, enquiry_id, currency, validity_date, payment_terms, delivery_terms, notes, freight, insurance, inco_terms, container_count, prepared_by, tax_type, status)
       VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`
    ).run(
      number,
      String(body.date ?? new Date().toISOString().slice(0, 10)),
      Number(body.customer_id),
      body.enquiry_id ? Number(body.enquiry_id) : null,
      String(body.currency ?? 'INR'),
      String(body.validity_date ?? ''),
      String(body.payment_terms ?? ''),
      String(body.delivery_terms ?? ''),
      String(body.notes ?? ''),
      Number(body.freight ?? 0),
      Number(body.insurance ?? 0),
      String(body.inco_terms ?? ''),
      String(body.container_count ?? ''),
      String(body.prepared_by ?? ''),
      taxType
    );
    const id = Number(info.lastInsertRowid);
    saveItems(id, (body.items ?? []) as LineItemInput[], taxType, Number(body.freight ?? 0), Number(body.insurance ?? 0), String(body.currency ?? 'INR'));
    if (body.enquiry_id) {
      db.prepare("UPDATE enquiries SET status = 'quoted' WHERE id = ?").run(Number(body.enquiry_id));
    }
    return id;
  });
  res.status(201).json(getFull(result));
});

quotationsRouter.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  const existing = db.prepare('SELECT * FROM quotations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return res.status(404).json({ error: 'Quotation not found' });
  const taxType = (body.tax_type ?? existing.tax_type ?? 'none') as 'none' | 'cgst_sgst' | 'igst';
  const currency = String(body.currency ?? existing.currency);
  const freight = Number(body.freight ?? existing.freight ?? 0);
  const insurance = Number(body.insurance ?? existing.insurance ?? 0);
  transaction(() => {
    db.prepare(
      `UPDATE quotations SET number = ?, date = ?, customer_id = ?, enquiry_id = ?, currency = ?, validity_date = ?, payment_terms = ?, delivery_terms = ?, notes = ?, freight = ?, insurance = ?, inco_terms = ?, container_count = ?, prepared_by = ?, tax_type = ? WHERE id = ?`
    ).run(
      String(body.number ?? existing.number),
      String(body.date ?? existing.date),
      Number(body.customer_id ?? existing.customer_id),
      body.enquiry_id ? Number(body.enquiry_id) : null,
      currency,
      String(body.validity_date ?? ''),
      String(body.payment_terms ?? ''),
      String(body.delivery_terms ?? ''),
      String(body.notes ?? ''),
      freight,
      insurance,
      String(body.inco_terms ?? ''),
      String(body.container_count ?? ''),
      String(body.prepared_by ?? ''),
      taxType,
      id
    );
    if (Array.isArray(body.items)) saveItems(id, body.items as LineItemInput[], taxType, freight, insurance, currency);
  });
  res.json(getFull(id));
});

quotationsRouter.post('/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body ?? {};
  const allowed = ['draft', 'sent', 'negotiating', 'accepted', 'rejected', 'expired'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (!db.prepare('SELECT id FROM quotations WHERE id = ?').get(id)) return res.status(404).json({ error: 'Quotation not found' });
  db.prepare('UPDATE quotations SET status = ? WHERE id = ?').run(String(status), id);
  res.json(getFull(id));
});

// Create a new revision (same number, revision+1); old one is marked superseded.
quotationsRouter.post('/:id/revise', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM quotations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return res.status(404).json({ error: 'Quotation not found' });
  if (existing.superseded_by) return res.status(409).json({ error: 'This revision was already superseded' });
  const newId = transaction(() => {
    const maxRev = db.prepare('SELECT MAX(revision) AS r FROM quotations WHERE number = ?').get(String(existing.number)) as { r: number };
    const info = db.prepare(
      `INSERT INTO quotations (number, revision, date, customer_id, enquiry_id, currency, validity_date, payment_terms, delivery_terms, notes, freight, insurance, inco_terms, container_count, prepared_by, tax_type, status, subtotal, tax_total, grand_total)
       SELECT number, ?, ?, customer_id, enquiry_id, currency, validity_date, payment_terms, delivery_terms, notes, freight, insurance, inco_terms, container_count, prepared_by, tax_type, 'negotiating', subtotal, tax_total, grand_total
       FROM quotations WHERE id = ?`
    ).run(maxRev.r + 1, new Date().toISOString().slice(0, 10), id);
    const newId = Number(info.lastInsertRowid);
    db.prepare(
      `INSERT INTO quotation_items (quotation_id, product_id, description, hsn_code, qty, unit, unit_price, tax_pct, amount, color, packs, pcs_per_pack, total_pcs, sort_order)
       SELECT ?, product_id, description, hsn_code, qty, unit, unit_price, tax_pct, amount, color, packs, pcs_per_pack, total_pcs, sort_order FROM quotation_items WHERE quotation_id = ?`
    ).run(newId, id);
    db.prepare('UPDATE quotations SET superseded_by = ?, status = ? WHERE id = ?').run(
      newId,
      existing.status === 'draft' ? 'draft' : String(existing.status),
      id
    );
    return newId;
  });
  res.status(201).json(getFull(newId));
});

quotationsRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const used = db.prepare('SELECT COUNT(*) AS c FROM proforma_invoices WHERE quotation_id = ?').get(id) as { c: number };
  if (used.c > 0) return res.status(409).json({ error: 'Quotation has a proforma invoice and cannot be deleted' });
  transaction(() => {
    db.prepare('UPDATE quotations SET superseded_by = NULL WHERE superseded_by = ?').run(id);
    db.prepare('DELETE FROM quotation_items WHERE quotation_id = ?').run(id);
    db.prepare('DELETE FROM quotations WHERE id = ?').run(id);
  });
  res.json({ ok: true });
});
