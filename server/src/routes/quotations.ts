import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { nextNumber } from '../services/numbering.js';
import { computeTotals, type LineItemInput } from '../services/totals.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { scopeClause, canAccessCustomer } from '../middleware/scope.js';
import { submit, decide, resetApprovalOnEdit, blockUnapprovedTransition } from '../services/approval.js';
import { resolveCompanyId } from '../services/companies.js';

export const quotationsRouter = Router();

const listSql = `
  SELECT q.*, c.name AS customer_name, c.country AS customer_country,
         u.name AS created_by_name, a.name AS approved_by_name
  FROM quotations q
  JOIN customers c ON c.id = q.customer_id
  LEFT JOIN users u ON u.id = q.created_by
  LEFT JOIN users a ON a.id = q.approved_by`;

function getFull(id: number) {
  const quotation = db.prepare(`${listSql} WHERE q.id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!quotation) return undefined;
  quotation.items = db.prepare('SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY sort_order, id').all(id);
  quotation.column_config = JSON.parse(String(quotation.column_config || '{}'));
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
    `INSERT INTO quotation_items (quotation_id, product_id, description, hsn_code, qty, unit, unit_price, tax_pct, amount, color, packs, pcs_per_pack, total_pcs, qty_20ft, qty_40ft, custom1, custom2, custom3, image, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  totals.items.forEach((it, i) =>
    ins.run(quotationId, it.product_id ?? null, it.description, it.hsn_code ?? '', it.qty ?? null, it.unit ?? 'unit', it.unit_price, it.tax_pct ?? 0, it.amount,
      it.color ?? '', it.packs ?? null, it.pcs_per_pack ?? null, it.total_pcs ?? null,
      it.qty_20ft ?? null, it.qty_40ft ?? null,
      it.custom1 ?? '', it.custom2 ?? '', it.custom3 ?? '', it.image ?? '', i)
  );
  db.prepare('UPDATE quotations SET subtotal = ?, tax_total = ?, grand_total = ? WHERE id = ?').run(
    totals.subtotal, totals.tax_total, totals.grand_total, quotationId
  );
}

quotationsRouter.get('/', (req: AuthedRequest, res) => {
  const status = String(req.query.status ?? '');
  const includeSuperseded = req.query.all === '1';
  const where: string[] = [];
  const params: unknown[] = [];
  const scope = scopeClause(req, 'q.customer_id');
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  if (!includeSuperseded) where.push('q.superseded_by IS NULL');
  if (status) { where.push('q.status = ?'); params.push(status); }
  if (req.query.export === '1' || req.query.export === '0') {
    where.push('q.is_export = ?');
    params.push(Number(req.query.export));
  }
  if (req.query.approval) { where.push('q.approval_status = ?'); params.push(String(req.query.approval)); }
  const sql = `${listSql}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY q.date DESC, q.id DESC`;
  res.json(db.prepare(sql).all(...(params as never[])));
});

quotationsRouter.get('/:id', (req: AuthedRequest, res) => {
  const q = getFull(Number(req.params.id));
  if (!q || !canAccessCustomer(req, Number(q.customer_id))) return res.status(404).json({ error: 'Quotation not found' });
  q.revisions = db
    .prepare('SELECT id, revision, status, grand_total, date FROM quotations WHERE number = ? ORDER BY revision')
    .all(String(q.number));
  res.json(q);
});

quotationsRouter.post('/', (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  if (!body.customer_id) return res.status(400).json({ error: 'Customer is required' });
  if (!canAccessCustomer(req, Number(body.customer_id))) return res.status(403).json({ error: 'That customer is not assigned to you' });
  const taxType = (body.tax_type ?? 'none') as 'none' | 'cgst_sgst' | 'igst';
  const isExport = body.is_export ? 1 : 0;
  // Which entity is selling. Fixed here and never changed afterwards: the
  // number below is drawn from this company's series.
  const companyId = resolveCompanyId(body.company_id, Number(body.customer_id));
  const result = transaction(() => {
    const number = nextNumber('quotation', { companyId });
    const info = db.prepare(
      `INSERT INTO quotations (number, revision, date, customer_id, currency, validity_date, payment_terms, delivery_terms, notes, freight, insurance, inco_terms, container_count, prepared_by, tax_type, is_export, created_by, column_config, company_id, status)
       VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`
    ).run(
      number,
      String(body.date ?? new Date().toISOString().slice(0, 10)),
      Number(body.customer_id),
      String(body.currency ?? 'INR'),
      String(body.validity_date ?? ''),
      String(body.payment_terms ?? ''),
      String(body.delivery_terms ?? ''),
      String(body.notes ?? ''),
      Number(body.freight ?? 0),
      Number(body.insurance ?? 0),
      String(body.inco_terms ?? ''),
      String(body.container_count ?? ''),
      String(body.prepared_by ?? req.user!.name),
      taxType,
      isExport,
      req.user!.id,
      JSON.stringify(body.column_config ?? {}),
      companyId
    );
    const id = Number(info.lastInsertRowid);
    saveItems(id, (body.items ?? []) as LineItemInput[], taxType, Number(body.freight ?? 0), Number(body.insurance ?? 0), String(body.currency ?? 'INR'));
    return id;
  });
  res.status(201).json(getFull(result));
});

quotationsRouter.put('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  const existing = db.prepare('SELECT * FROM quotations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing || !canAccessCustomer(req, Number(existing.customer_id))) return res.status(404).json({ error: 'Quotation not found' });
  const taxType = (body.tax_type ?? existing.tax_type ?? 'none') as 'none' | 'cgst_sgst' | 'igst';
  const currency = String(body.currency ?? existing.currency);
  const freight = Number(body.freight ?? existing.freight ?? 0);
  const insurance = Number(body.insurance ?? existing.insurance ?? 0);
  transaction(() => {
    db.prepare(
      `UPDATE quotations SET number = ?, date = ?, customer_id = ?, currency = ?, validity_date = ?, payment_terms = ?, delivery_terms = ?, notes = ?, freight = ?, insurance = ?, inco_terms = ?, container_count = ?, prepared_by = ?, tax_type = ?, is_export = ?, column_config = ? WHERE id = ?`
    ).run(
      String(body.number ?? existing.number),
      String(body.date ?? existing.date),
      Number(body.customer_id ?? existing.customer_id),
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
      body.is_export !== undefined ? (body.is_export ? 1 : 0) : Number(existing.is_export ?? 0),
      JSON.stringify(body.column_config ?? JSON.parse(String(existing.column_config || '{}'))),
      id
    );
    if (Array.isArray(body.items)) saveItems(id, body.items as LineItemInput[], taxType, freight, insurance, currency);
    resetApprovalOnEdit('quotations', id);
  });
  res.json(getFull(id));
});

/**
 * The team's private note on a quotation — never printed, never seen by the
 * customer.
 *
 * Deliberately not folded into PUT /:id. That handler ends with
 * resetApprovalOnEdit and rewrites every line item, neither of which should
 * happen because somebody jotted "call back Monday": an approved quotation
 * must stay approved, and the money must not be touched. It also works on a
 * superseded revision, which is read-only everywhere else — recording why a
 * revision was replaced is exactly what this is for.
 */
quotationsRouter.patch('/:id/internal-notes', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT customer_id FROM quotations WHERE id = ?').get(id) as { customer_id: number } | undefined;
  if (!existing || !canAccessCustomer(req, existing.customer_id)) return res.status(404).json({ error: 'Quotation not found' });
  db.prepare('UPDATE quotations SET internal_notes = ? WHERE id = ?').run(String(req.body?.internal_notes ?? ''), id);
  res.json(getFull(id));
});

quotationsRouter.post('/:id/submit', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT customer_id FROM quotations WHERE id = ?').get(id) as { customer_id: number } | undefined;
  if (!existing || !canAccessCustomer(req, existing.customer_id)) return res.status(404).json({ error: 'Quotation not found' });
  submit('quotations', id, req.user!);
  res.json(getFull(id));
});

quotationsRouter.post('/:id/approve', (req: AuthedRequest, res) => {
  if (req.user!.role !== 'manager') return res.status(403).json({ error: 'Only a manager can approve documents' });
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM quotations WHERE id = ?').get(id)) return res.status(404).json({ error: 'Quotation not found' });
  decide('quotations', id, req.user!, req.body?.approve !== false, String(req.body?.note ?? ''));
  res.json(getFull(id));
});

quotationsRouter.post('/:id/status', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const { status } = req.body ?? {};
  const allowed = ['draft', 'sent', 'negotiating', 'accepted', 'rejected', 'expired'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const existing = db.prepare('SELECT customer_id FROM quotations WHERE id = ?').get(id) as { customer_id: number } | undefined;
  if (!existing || !canAccessCustomer(req, existing.customer_id)) return res.status(404).json({ error: 'Quotation not found' });
  const blocked = blockUnapprovedTransition('quotations', id, String(status), req);
  if (blocked) return res.status(409).json({ error: blocked });
  db.prepare('UPDATE quotations SET status = ? WHERE id = ?').run(String(status), id);
  res.json(getFull(id));
});

// Create a new revision (same number, revision+1); old one is marked superseded.
quotationsRouter.post('/:id/revise', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM quotations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing || !canAccessCustomer(req, Number(existing.customer_id))) return res.status(404).json({ error: 'Quotation not found' });
  if (existing.superseded_by) return res.status(409).json({ error: 'This revision was already superseded' });
  const newId = transaction(() => {
    const maxRev = db.prepare('SELECT MAX(revision) AS r FROM quotations WHERE number = ?').get(String(existing.number)) as { r: number };
    const info = db.prepare(
      // internal_notes rides along: a revision is the next round of the same
      // negotiation, so the running commentary should follow it.
      `INSERT INTO quotations (number, revision, date, customer_id, company_id, currency, validity_date, payment_terms, delivery_terms, notes, internal_notes, freight, insurance, inco_terms, container_count, prepared_by, tax_type, is_export, column_config, created_by, status, subtotal, tax_total, grand_total)
       SELECT number, ?, ?, customer_id, company_id, currency, validity_date, payment_terms, delivery_terms, notes, internal_notes, freight, insurance, inco_terms, container_count, prepared_by, tax_type, is_export, column_config, ?, 'negotiating', subtotal, tax_total, grand_total
       FROM quotations WHERE id = ?`
    ).run(maxRev.r + 1, new Date().toISOString().slice(0, 10), req.user!.id, id);
    const newId = Number(info.lastInsertRowid);
    db.prepare(
      `INSERT INTO quotation_items (quotation_id, product_id, description, hsn_code, qty, unit, unit_price, tax_pct, amount, color, packs, pcs_per_pack, total_pcs, qty_20ft, qty_40ft, custom1, custom2, custom3, image, sort_order)
       SELECT ?, product_id, description, hsn_code, qty, unit, unit_price, tax_pct, amount, color, packs, pcs_per_pack, total_pcs, qty_20ft, qty_40ft, custom1, custom2, custom3, image, sort_order FROM quotation_items WHERE quotation_id = ?`
    ).run(newId, id);
    db.prepare('UPDATE quotations SET superseded_by = ? WHERE id = ?').run(newId, id);
    return newId;
  });
  res.status(201).json(getFull(newId));
});

quotationsRouter.delete('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT customer_id FROM quotations WHERE id = ?').get(id) as { customer_id: number } | undefined;
  if (!existing || !canAccessCustomer(req, existing.customer_id)) return res.status(404).json({ error: 'Quotation not found' });
  // Every table that points at this quotation has to be checked here — a
  // foreign key left dangling surfaces to the user as "Internal server error".
  const orders = db.prepare('SELECT COUNT(*) AS c FROM orders WHERE quotation_id = ?').get(id) as { c: number };
  if (orders.c > 0) return res.status(409).json({ error: 'Quotation has an order booked against it and cannot be deleted' });
  const used = db.prepare('SELECT COUNT(*) AS c FROM proforma_invoices WHERE quotation_id = ?').get(id) as { c: number };
  if (used.c > 0) return res.status(409).json({ error: 'Quotation has a proforma invoice and cannot be deleted' });
  transaction(() => {
    db.prepare('UPDATE quotations SET superseded_by = NULL WHERE superseded_by = ?').run(id);
    db.prepare('DELETE FROM quotation_items WHERE quotation_id = ?').run(id);
    db.prepare('DELETE FROM quotations WHERE id = ?').run(id);
  });
  res.json({ ok: true });
});
