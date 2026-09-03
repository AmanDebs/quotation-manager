import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { nextNumber, exportChangeError } from '../services/numbering.js';
import { computeTotals, round2, type LineItemInput } from '../services/totals.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { scopeClause, canAccessCustomer, linkError, customerChangeError } from '../middleware/scope.js';
import { resolveCompanyId } from '../services/companies.js';
import { submit, decide, resetApprovalOnEdit, blockUnapprovedTransition, blockUnapprovedConversion } from '../services/approval.js';
import { listBody } from '../services/pagination.js';
import { searchClause } from '../services/search.js';
import { lockError, syncQuotationConverted, alreadyConvertedError } from '../services/documentChain.js';
import { buildXlsx, attachmentName, type Column } from '../services/xlsx.js';

export const proformasRouter = Router();

const listSql = `
  SELECT p.*, c.name AS customer_name, c.country AS customer_country, q.number AS quotation_number,
         co.company_name AS company_name,
         o.number AS order_number, u.name AS created_by_name, a.name AS approved_by_name,
         -- What has actually been banked against this proforma. Derived on
         -- read like every other money figure, and counted only where the
         -- payment's currency agrees with the document's — the rule
         -- services/receivables.ts applies to invoices, applied here so the
         -- list and the proforma page cannot report different advances. A
         -- blank currency counts as matching: payments inherit theirs from the
         -- document, so an empty one can only be a legacy row, and dropping it
         -- would quietly reduce a balance that has been right for months.
         --
         -- A correlated subquery rather than a per-row call: the list is
         -- paged, and asking once per row is the N+1 this codebase keeps
         -- bounding.
         (SELECT COALESCE(SUM(pm.amount), 0) FROM payments pm
           WHERE pm.pi_id = p.id
             AND (pm.currency IS NULL OR pm.currency = '' OR pm.currency = p.currency)) AS advance_received,
         -- Money the line above deliberately did not count. Surfaced rather
         -- than dropped: silently under-reporting what a customer has paid is
         -- the one outcome worse than an awkward figure on screen.
         (SELECT COUNT(*) FROM payments pm
           WHERE pm.pi_id = p.id
             AND pm.currency IS NOT NULL AND pm.currency <> '' AND pm.currency <> p.currency) AS currency_mismatch_count
  FROM proforma_invoices p
  JOIN customers c ON c.id = p.customer_id
  -- LEFT, not JOIN: a document must still list if its company row is gone.
  LEFT JOIN companies co ON co.id = p.company_id
  LEFT JOIN quotations q ON q.id = p.quotation_id
  LEFT JOIN orders o ON o.id = p.order_id
  LEFT JOIN users u ON u.id = p.created_by
  LEFT JOIN users a ON a.id = p.approved_by`;

function getFull(id: number) {
  const pi = db.prepare(`${listSql} WHERE p.id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!pi) return undefined;
  pi.items = db.prepare('SELECT * FROM pi_items WHERE pi_id = ? ORDER BY sort_order, id').all(id);
  pi.column_config = JSON.parse(String(pi.column_config || '{}'));
  const payments = db.prepare('SELECT * FROM payments WHERE pi_id = ? ORDER BY date, id').all(id) as { amount: number; currency?: string | null }[];
  pi.payments = payments;
  // Money only adds up within one currency — the same rule the list's
  // `advance_received` applies above, and the one receivables.ts has always
  // applied to invoices. This used to sum every payment whatever its currency,
  // so a €10,000 advance and ₹10,000 added to 20,000 of nothing, and the
  // figure here could disagree with the one on the list. A blank currency
  // counts as matching, for the reason given above the query.
  const docCurrency = String(pi.currency ?? '');
  const matches = (c: unknown) => !c || String(c) === docCurrency;
  pi.amount_received = round2(payments.filter((p) => matches(p.currency)).reduce((s, p) => s + p.amount, 0));
  // Not converted and not allocated — there is no rate stored anywhere and
  // inventing one would put a fiction on a ledger. Reported instead.
  pi.currency_mismatch = payments
    .filter((p) => !matches(p.currency))
    .map((p) => ({ currency: String(p.currency), amount: p.amount }));
  return pi;
}

function saveItems(piId: number, items: LineItemInput[], taxType: 'none' | 'cgst_sgst' | 'igst', freight: number, insurance: number, currency: string) {
  const totals = computeTotals(items, taxType, freight, insurance, currency);
  db.prepare('DELETE FROM pi_items WHERE pi_id = ?').run(piId);
  const ins = db.prepare(
    `INSERT INTO pi_items (pi_id, product_id, description, hsn_code, qty, unit, unit_price, tax_pct, amount, color, packs, pcs_per_pack, total_pcs, qty_20ft, qty_40ft, is_charge, custom1, custom2, custom3, image, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  totals.items.forEach((it, i) =>
    ins.run(piId, it.product_id ?? null, it.description, it.hsn_code ?? '', it.qty ?? null, it.unit ?? 'unit', it.unit_price, it.tax_pct ?? 0, it.amount,
      it.color ?? '', it.packs ?? null, it.pcs_per_pack ?? null, it.total_pcs ?? null,
      it.qty_20ft ?? null, it.qty_40ft ?? null, it.is_charge ? 1 : 0,
      it.custom1 ?? '', it.custom2 ?? '', it.custom3 ?? '', it.image ?? '', i)
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

/** The list's filters, built once so the list and its export cannot drift. */
function proformaListWhere(req: AuthedRequest): { where: string[]; params: unknown[] } {
  // Not named `q`: the alias below is a table, and on invoices `i` is too.
  const search = String(req.query.q ?? '').trim();
  const where: string[] = [];
  const params: unknown[] = [];
  const scope = scopeClause(req, 'p.customer_id');
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  // Number or customer, as on the quotations list: the two things
  // somebody has in hand when they come looking for a proforma.
  const text = searchClause(['p.number', 'c.name'], search);
  if (text.sql) { where.push(text.sql); params.push(...text.params); }
  if (req.query.status) { where.push('p.status = ?'); params.push(String(req.query.status)); }
  if (req.query.export === '1' || req.query.export === '0') { where.push('p.is_export = ?'); params.push(Number(req.query.export)); }
  // Narrow to one selling entity. Ignored when the group has just one.
  if (Number(req.query.company) > 0) { where.push('p.company_id = ?'); params.push(Number(req.query.company)); }
  if (req.query.approval) { where.push('p.approval_status = ?'); params.push(String(req.query.approval)); }
  return { where, params };
}

proformasRouter.get('/', (req: AuthedRequest, res) => {
  const { where, params } = proformaListWhere(req);
  res.json(listBody(req.query, {
    sql: `${listSql}${where.length ? ' WHERE ' + where.join(' AND ') : ''}`,
    order: 'ORDER BY p.date DESC, p.id DESC',
    params,
  }));
});

/**
 * The list as a spreadsheet. Declared **above** `/:id`, or Express reads
 * "export" as a document id. Whole filtered set, never a page — `page`/`limit`
 * are ignored — through the same filters as the list, scoping included.
 */
type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? '' : String(v));
const num = (v: unknown) => Number(v ?? 0);

const proformaColumns: Column<Row>[] = [
  { header: 'Number', value: (r) => str(r.number) },
  { header: 'Date', value: (r) => str(r.date), type: 'date' },
  { header: 'Customer', value: (r) => str(r.customer_name) },
  { header: 'Country', value: (r) => str(r.customer_country) },
  { header: 'Issued by', value: (r) => str(r.company_name) },
  { header: 'From quotation', value: (r) => str(r.quotation_number) },
  { header: 'Order', value: (r) => str(r.order_number) },
  { header: 'PO number', value: (r) => str(r.po_number) },
  { header: 'PO date', value: (r) => str(r.po_date), type: 'date' },
  { header: 'Type', value: (r) => (num(r.is_export) ? 'Export' : 'Domestic') },
  { header: 'INCO', value: (r) => str(r.inco_terms) },
  { header: 'Discharge port', value: (r) => str(r.port_of_discharge) },
  { header: 'Currency', value: (r) => str(r.currency) },
  { header: 'Subtotal', value: (r) => num(r.subtotal), type: 'money' },
  { header: 'Freight', value: (r) => num(r.freight), type: 'money' },
  { header: 'Insurance', value: (r) => num(r.insurance), type: 'money' },
  { header: 'Tax', value: (r) => num(r.tax_total), type: 'money' },
  { header: 'Total', value: (r) => num(r.grand_total), type: 'money' },
  // The advance and what is still to come. The subtraction is display
  // arithmetic over two figures the server already computed, not a second
  // opinion about either — `advance_received` remains the single source.
  { header: 'Advance received', value: (r) => num(r.advance_received), type: 'money' },
  { header: 'Balance', value: (r) => round2(num(r.grand_total) - num(r.advance_received)), type: 'money' },
  // Rides along for the same reason it does on the invoice export: an advance
  // that went uncounted is exactly what somebody opens a spreadsheet to find.
  { header: 'Uncounted payments', value: (r) => num(r.currency_mismatch_count), type: 'number' },
  { header: 'Payment terms', value: (r) => str(r.payment_terms) },
  { header: 'Status', value: (r) => str(r.status) },
  { header: 'Approval', value: (r) => str(r.approval_status) },
  { header: 'Issued by (user)', value: (r) => str(r.created_by_name) },
];

proformasRouter.get('/export', (req: AuthedRequest, res) => {
  const { where, params } = proformaListWhere(req);
  const rows = db
    .prepare(`${listSql}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY p.date DESC, p.id DESC`)
    .all(...(params as never[])) as Row[];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${attachmentName('Proforma invoices')}"`);
  res.send(buildXlsx('Proforma invoices', proformaColumns, rows));
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
  // Both said now rather than after the form is filled in. commit: false — a
  // GET must not approve anything just by being asked.
  const converted = alreadyConvertedError(qid);
  if (converted) return res.status(409).json({ error: converted });
  const unapproved = blockUnapprovedConversion('quotations', qid, req, false);
  if (unapproved) return res.status(409).json({ error: unapproved });
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(q.customer_id)) as Record<string, unknown>;
  const items = db.prepare('SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY sort_order, id').all(qid);
  const isExport = String(customer.country ?? 'India').trim().toLowerCase() !== 'india';
  res.json({
    quotation_id: qid,
    customer_id: q.customer_id,
    company_id: q.company_id,
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
  /**
   * The proforma this order was booked from, if there is one.
   *
   * Meaningless to a proforma — it has no pi_id column, so headerValues drops
   * it — but this endpoint also feeds the invoice form, and there it matters a
   * great deal. An invoice with a null pi_id is not allocated any of the
   * advance taken against that proforma (services/receivables.ts credits an
   * advance across the invoices raised from that PI) and skips the 10%
   * quantity-variance check, which is gated on the same column. With the
   * process running proforma to order to invoice, raising the invoice from the
   * order is the normal path, so the link has to survive it.
   *
   * Resolved backwards, earliest first, because the link lives on
   * proforma_invoices.order_id and two proformas can each claim one order.
   */
  const linkedPi = db
    .prepare('SELECT id FROM proforma_invoices WHERE order_id = ? ORDER BY id LIMIT 1')
    .get(oid) as { id: number } | undefined;
  res.json({
    order_id: oid,
    pi_id: linkedPi?.id ?? null,
    quotation_id: o.quotation_id,
    customer_id: o.customer_id,
    company_id: o.company_id,
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
  // An order_id pointing at another owner's order would fold this proforma's
  // invoices into that order's dispatch figures — checked, like the customer.
  const link = linkError(req, 'quotations', h.quotation_id, h.customer_id, 'Quotation')
    ?? linkError(req, 'orders', h.order_id, h.customer_id, 'Order');
  if (link) return res.status(404).json({ error: link });
  // Raising a proforma locks the quotation, so a draft would be frozen as a
  // draft. A manager converting an unapproved one approves it in the same
  // action, exactly as blockUnapprovedTransition already does for a status move.
  if (h.quotation_id) {
    // A quotation answers one negotiation once. Enforced here and not only on
    // the prefill, since the prefill is a GET the form can be got past.
    const converted = alreadyConvertedError(Number(h.quotation_id));
    if (converted) return res.status(409).json({ error: converted });
    const unapproved = blockUnapprovedConversion('quotations', Number(h.quotation_id), req);
    if (unapproved) return res.status(409).json({ error: unapproved });
  }
  // Fixed at creation: the number below comes from this company's series.
  const companyId = resolveCompanyId(body.company_id, Number(body.customer_id));
  const id = transaction(() => {
    const number = nextNumber('proforma', { isExport: h.is_export === 1, companyId, date: h.date });
    const info = db.prepare(
      `INSERT INTO proforma_invoices (number, company_id, ${headerFields.join(', ')}, created_by, column_config, status)
       VALUES (?, ?, ${headerFields.map(() => '?').join(', ')}, ?, ?, 'draft')`
    ).run(
      number,
      companyId,
      ...(headerFields.map((f) => (h as Record<string, unknown>)[f]) as never[]),
      req.user!.id,
      JSON.stringify(body.column_config ?? {})
    );
    const id = Number(info.lastInsertRowid);
    saveItems(id, (body.items ?? []) as LineItemInput[], h.tax_type, h.freight, h.insurance, h.currency);
    // Inside the transaction, like syncEnquiryStatus: a quotation reading
    // Accepted with no proforma to show for it would be exactly the drift
    // status syncing exists to prevent.
    syncQuotationConverted(h.quotation_id);
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
  const moved = customerChangeError(req, existing.customer_id as number, h.customer_id);
  if (moved) return res.status(403).json({ error: moved });
  // An order was booked from this proforma, so its figures are what that order
  // was built from. Note this guards the document's *content* only: the status
  // pipeline deliberately carries on past order_confirmed to advance_received
  // and in_production, which happen after the order exists.
  const locked = lockError('proforma_invoices', id);
  if (locked) return res.status(409).json({ error: locked });
  // The number was drawn from the export or the domestic series and is never
  // reissued, so the flag cannot move after the fact without leaving the two
  // disagreeing. 409, not 403: it is a conflict with what is already on file.
  const retyped = exportChangeError('proforma', existing, (req.body ?? {}).is_export);
  if (retyped) return res.status(409).json({ error: retyped });
  const link = linkError(req, 'quotations', h.quotation_id, h.customer_id, 'Quotation')
    ?? linkError(req, 'orders', h.order_id, h.customer_id, 'Order');
  if (link) return res.status(404).json({ error: link });
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
  const lockedSubmit = lockError('proforma_invoices', id, 'submitted for approval');
  if (lockedSubmit) return res.status(409).json({ error: lockedSubmit });
  submit('proforma_invoices', id, req.user!);
  res.json(getFull(id));
});

proformasRouter.post('/:id/approve', (req: AuthedRequest, res) => {
  if (req.user!.role !== 'manager') return res.status(403).json({ error: 'Only a manager can approve documents' });
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM proforma_invoices WHERE id = ?').get(id)) return res.status(404).json({ error: 'Proforma invoice not found' });
  // Approved by rule before the order could be booked from it.
  const lockedDecide = lockError('proforma_invoices', id, 'approved or rejected');
  if (lockedDecide) return res.status(409).json({ error: lockedDecide });
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

/**
 * The team's private note, saved on its own rather than through the form.
 *
 * Same endpoint shape as the quotation's, and for the same reason: going
 * through the document's PUT would reset an approved proforma to
 * `not_submitted` (that is what `resetApprovalOnEdit` is for) and rewrite
 * every line item, when all that changed was a sentence nobody outside the
 * office will ever read.
 */
// Deliberately absent from `headerFields` above, exactly as on a quotation:
// only this endpoint writes the column. Letting the document's PUT carry it
// would mean a form saved from a stale draft could overwrite a note somebody
// typed in the panel a moment earlier.
proformasRouter.patch('/:id/internal-notes', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT customer_id FROM proforma_invoices WHERE id = ?').get(id) as { customer_id: number } | undefined;
  if (!existing || !canAccessCustomer(req, existing.customer_id)) return res.status(404).json({ error: 'Proforma not found' });
  db.prepare('UPDATE proforma_invoices SET internal_notes = ? WHERE id = ?').run(String(req.body?.internal_notes ?? ''), id);
  res.json(getFull(id));
});

/**
 * Duplicate: the same proforma as a fresh document, under a **new** number.
 *
 * Same shape as the quotation's duplicate, and the same reasoning, with one
 * hazard of its own.
 *
 * **`order_id` must not carry across.** A proforma has no `pi_id` on the
 * order, so the link between the two lives on this column, and
 * `dispatchProgress()` walks it to decide how much of an order has been
 * billed. Copying it would point a second proforma at an order that already
 * has one — which is exactly what `POST /orders` refuses to do from the other
 * direction, because it orphans the first order's dispatch figures.
 *
 * **`quotation_id` does not either.** A duplicate is a separate offer, and two
 * proformas both claiming to be the one raised from a quotation makes "which
 * document came from this quote" unanswerable. The carry-forward endpoint
 * (`prefill/from-quotation/:id`) is how a proforma is properly attached to a
 * quotation, and it still is.
 *
 * Payments are not copied — they are money received against *that* document —
 * and, as on a quotation, the approval resets, internal notes stay behind, and
 * a validity date already past is dropped rather than carried into an offer
 * that lapses the moment it is sent.
 *
 * The number comes from the same series the source used: `is_export` is
 * copied, so an export proforma duplicates into the export series.
 */
proformasRouter.post('/:id/duplicate', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM proforma_invoices WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing || !canAccessCustomer(req, Number(existing.customer_id))) return res.status(404).json({ error: 'Proforma not found' });
  const today = new Date().toISOString().slice(0, 10);
  const validity = String(existing.validity_date ?? '');
  const newId = transaction(() => {
    const number = nextNumber('proforma', {
      isExport: Number(existing.is_export) === 1,
      companyId: Number(existing.company_id),
      date: today,
    });
    const info = db.prepare(
      `INSERT INTO proforma_invoices (number, date, customer_id, company_id, consignee, notify_party, currency, freight, insurance, lead_time, bank_account, inco_terms, payment_terms, delivery_terms, validity_date, is_export, country_of_origin, port_of_loading, port_of_discharge, final_destination, container_count, partial_shipment, po_number, po_date, notify_party_2, method_of_despatch, quantity_tolerance, hs_code, prepared_by, remarks, tax_type, column_config, created_by, status, subtotal, tax_total, grand_total)
       SELECT ?, ?, customer_id, company_id, consignee, notify_party, currency, freight, insurance, lead_time, bank_account, inco_terms, payment_terms, delivery_terms, ?, is_export, country_of_origin, port_of_loading, port_of_discharge, final_destination, container_count, partial_shipment, po_number, po_date, notify_party_2, method_of_despatch, quantity_tolerance, hs_code, prepared_by, remarks, tax_type, column_config, ?, 'draft', subtotal, tax_total, grand_total
       FROM proforma_invoices WHERE id = ?`
    ).run(number, today, validity >= today ? validity : '', req.user!.id, id);
    const newId = Number(info.lastInsertRowid);
    db.prepare(
      `INSERT INTO pi_items (pi_id, product_id, description, hsn_code, qty, unit, unit_price, tax_pct, amount, color, packs, pcs_per_pack, total_pcs, qty_20ft, qty_40ft, is_charge, custom1, custom2, custom3, image, sort_order)
       SELECT ?, product_id, description, hsn_code, qty, unit, unit_price, tax_pct, amount, color, packs, pcs_per_pack, total_pcs, qty_20ft, qty_40ft, is_charge, custom1, custom2, custom3, image, sort_order FROM pi_items WHERE pi_id = ?`
    ).run(newId, id);
    return newId;
  });
  res.status(201).json(getFull(newId));
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
