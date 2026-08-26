import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { nextNumber, exportChangeError } from '../services/numbering.js';
import { computeTotals, round2, type LineItemInput } from '../services/totals.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { scopeClause, canAccessCustomer, linkError, customerChangeError } from '../middleware/scope.js';
import { resolveCompanyId } from '../services/companies.js';
import { syncOrderStatus } from '../services/orderStatus.js';
import { submit, decide, resetApprovalOnEdit, blockUnapprovedTransition } from '../services/approval.js';
import { invoiceReceivable } from '../services/receivables.js';
import { syncInvoiceStatus, syncInvoicesForProforma } from '../services/invoiceStatus.js';
import { listBody } from '../services/pagination.js';
import { searchClause } from '../services/search.js';
import { buildXlsx, attachmentName, type Column } from '../services/xlsx.js';

/**
 * Bring the paid/unpaid status back into line after anything that moves money.
 *
 * The invoice itself, plus every sibling raised from the same proforma: they
 * share one advance pool, allocated earliest-invoice-first, so changing this
 * invoice's total — or adding it, or deleting it — can settle or un-settle a
 * different one that was never touched.
 */
function syncMoneyStatus(invoiceId: number | null, ...piIds: (number | null | undefined)[]) {
  if (invoiceId) syncInvoiceStatus(invoiceId);
  for (const piId of new Set(piIds.filter((p): p is number => !!p))) syncInvoicesForProforma(piId);
}

/**
 * Every order an invoice bills against — its own `order_id`, or the one its
 * proforma carries. Both the current links and any it is moving away from, so
 * that re-pointing an invoice re-opens the order it used to close.
 */
function orderIdsBehind(invoiceId: number | null, ...links: (number | null | undefined)[]): number[] {
  const ids = new Set<number>();
  if (invoiceId) {
    const row = db.prepare(
      `SELECT COALESCE(order_id, (SELECT order_id FROM proforma_invoices WHERE id = pi_id)) AS o
       FROM commercial_invoices WHERE id = ?`
    ).get(invoiceId) as { o: number | null } | undefined;
    if (row?.o) ids.add(row.o);
  }
  for (const link of links) {
    if (!link) continue;
    ids.add(link);
    const viaPi = db.prepare('SELECT order_id FROM proforma_invoices WHERE id = ?').get(link) as
      { order_id: number | null } | undefined;
    if (viaPi?.order_id) ids.add(viaPi.order_id);
  }
  // A proforma id is not an order id; keep only rows that are actually orders.
  return [...ids].filter((id) =>
    !!db.prepare('SELECT id FROM orders WHERE id = ?').get(id));
}

export const invoicesRouter = Router();

const listSql = `
  SELECT i.*, c.name AS customer_name, c.country AS customer_country, p.number AS pi_number,
         co.company_name AS company_name,
         u.name AS created_by_name, a.name AS approved_by_name
  FROM commercial_invoices i
  JOIN customers c ON c.id = i.customer_id
  -- LEFT, not JOIN: a document must still list if its company row is gone.
  LEFT JOIN companies co ON co.id = i.company_id
  LEFT JOIN proforma_invoices p ON p.id = i.pi_id
  LEFT JOIN users u ON u.id = i.created_by
  LEFT JOIN users a ON a.id = i.approved_by`;

function getFull(id: number) {
  const inv = db.prepare(`${listSql} WHERE i.id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!inv) return undefined;
  inv.items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id').all(id);
  inv.column_config = JSON.parse(String(inv.column_config || '{}'));
  /**
   * Quantity variance against the source proforma — the 10% clause — computed
   * here for the client to show.
   *
   * **Matched by position**, the index-matching rule the whole chain uses:
   * `syncPackingList()` rewrites packing rows by index, `dispatchProgress()`
   * sums invoice lines by index, and `orderLines.ts` reproduces the same rule
   * in SQL. This used to match on `description` instead, which meant editing
   * the wording on an invoice line silently emptied its variance row — the
   * report came back clean because nothing matched, which is the worst way for
   * a check to fail.
   *
   * Positions are **not** compacted before matching. A charge line keeps its
   * slot so the goods after it still line up, exactly as the packing list
   * keeps a charge row it never prints; charges are skipped when reporting
   * instead, since a percentage variance on freight means nothing.
   *
   * `pi_description` rides along so the screen can say when the two lines at
   * one position are not describing the same thing — index matching is an
   * assumption, and this is where it would show.
   */
  if (inv.pi_id) {
    const piItems = db.prepare(
      'SELECT description, qty, is_charge FROM pi_items WHERE pi_id = ? ORDER BY sort_order, id'
    ).all(Number(inv.pi_id)) as { description: string; qty: number | null; is_charge: number }[];

    inv.variance = (inv.items as { description: string; qty: number | null; is_charge: number }[])
      .map((it, i) => ({ it, pi: piItems[i] }))
      .filter(({ it, pi }) =>
        // An invoice line past the end of the proforma has nothing to compare
        // against; so does one where either side is a charge.
        !!pi && !it.is_charge && !pi.is_charge
        && it.qty != null && pi.qty != null && pi.qty !== 0)
      .map(({ it, pi }) => {
        const pct = ((it.qty! - pi.qty!) / pi.qty!) * 100;
        return {
          description: it.description,
          pi_description: pi.description,
          pi_qty: pi.qty,
          invoice_qty: it.qty,
          variance_pct: Math.round(pct * 100) / 100,
        };
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
  // Money against this invoice or its proforma in another currency, credited to
  // nothing. Carried so the page can say so rather than silently under-reporting.
  inv.currency_mismatch = money.currency_mismatch;

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
    // The packing list is the invoice's other half, so it is issued by the
    // same company and numbered from that company's series.
    const plCompanyId = Number(inv.company_id) || resolveCompanyId(null, Number(inv.customer_id));
    // Dated with the invoice it belongs to, so it is numbered in that year too.
    const number = nextNumber('packing_list', { companyId: plCompanyId, date: String(packing?.date ?? inv.date ?? '') });
    const info = db.prepare(
      `INSERT INTO packing_lists (number, date, invoice_id, customer_id, company_id, shipping_marks, lot_no, remarks, created_by, column_config)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      packing?.number || number,
      String(packing?.date ?? inv.date),
      invoiceId,
      Number(inv.customer_id),
      plCompanyId,
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
    'SELECT description, hsn_code, qty, unit, is_charge FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id'
  ).all(invoiceId) as { description: string; hsn_code: string; qty: number | null; unit: string; is_charge: number }[];

  db.prepare('DELETE FROM packing_list_items WHERE packing_list_id = ?').run(plId);
  const ins = db.prepare(
    `INSERT INTO packing_list_items (packing_list_id, description, hsn_code, qty, unit, packages, dimensions, gross_weight, net_weight, is_charge, custom1, custom2, custom3, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  invItems.forEach((it, i) => {
    const p = packing?.items?.[i] ?? {};
    ins.run(plId, it.description, it.hsn_code ?? '', it.qty ?? null, it.unit ?? 'unit',
      String(p.packages ?? ''), String(p.dimensions ?? ''), Number(p.gross_weight ?? 0), Number(p.net_weight ?? 0),
      it.is_charge ? 1 : 0,
      String(p.custom1 ?? ''), String(p.custom2 ?? ''), String(p.custom3 ?? ''), i);
  });
}

function saveItems(invoiceId: number, items: LineItemInput[], taxType: 'none' | 'cgst_sgst' | 'igst', freight: number, insurance: number, currency: string) {
  const totals = computeTotals(items, taxType, freight, insurance, currency);
  db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
  const ins = db.prepare(
    `INSERT INTO invoice_items (invoice_id, product_id, description, hsn_code, qty, unit, unit_price, tax_pct, amount, color, packs, pcs_per_pack, total_pcs, qty_20ft, qty_40ft, is_charge, custom1, custom2, custom3, image, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  totals.items.forEach((it, i) =>
    ins.run(invoiceId, it.product_id ?? null, it.description, it.hsn_code ?? '', it.qty ?? null, it.unit ?? 'unit', it.unit_price, it.tax_pct ?? 0, it.amount,
      it.color ?? '', it.packs ?? null, it.pcs_per_pack ?? null, it.total_pcs ?? null,
      it.qty_20ft ?? null, it.qty_40ft ?? null, it.is_charge ? 1 : 0,
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

/** The list's filters, built once so the list and its export cannot drift. */
function invoiceListWhere(req: AuthedRequest): { where: string[]; params: unknown[] } {
  // Not named `q`: the alias below is a table, and on invoices `i` is too.
  const search = String(req.query.q ?? '').trim();
  const where: string[] = [];
  const params: unknown[] = [];
  const scope = scopeClause(req, 'i.customer_id');
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  // Number or customer, as on the quotations list: the two things
  // somebody has in hand when they come looking for a invoice.
  const text = searchClause(['i.number', 'c.name'], search);
  if (text.sql) { where.push(text.sql); params.push(...text.params); }
  if (req.query.status) { where.push('i.status = ?'); params.push(String(req.query.status)); }
  if (req.query.export === '1' || req.query.export === '0') { where.push('i.is_export = ?'); params.push(Number(req.query.export)); }
  // Narrow to one selling entity. Ignored when the group has just one.
  if (Number(req.query.company) > 0) { where.push('i.company_id = ?'); params.push(Number(req.query.company)); }
  if (req.query.approval) { where.push('i.approval_status = ?'); params.push(String(req.query.approval)); }
  return { where, params };
}

invoicesRouter.get('/', (req: AuthedRequest, res) => {
  const { where, params } = invoiceListWhere(req);
  res.json(listBody(req.query, {
    sql: `${listSql}${where.length ? ' WHERE ' + where.join(' AND ') : ''}`,
    order: 'ORDER BY i.date DESC, i.id DESC',
    params,
  }));
});

/**
 * The list as a spreadsheet. Declared **above** `/:id`, or Express reads
 * "export" as a document id. Whole filtered set, never a page — `page`/`limit`
 * are ignored — through the same filters as the list, scoping included.
 *
 * Unlike the list, this decorates each row with what has been received.
 * "How much has this invoice been credited" is `receivables.ts`'s question and
 * it is **asked**, never recomputed here — advances on the source proforma are
 * allocated across the invoices raised from it, and money in a currency the
 * invoice does not share is credited to nothing. That last figure rides along
 * in its own column rather than being dropped, because an advance that is
 * silently uncounted is exactly what somebody would come to a spreadsheet to
 * find.
 */
type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? '' : String(v));
const num = (v: unknown) => Number(v ?? 0);

const invoiceColumns: Column<Row>[] = [
  { header: 'Number', value: (r) => str(r.number) },
  { header: 'Date', value: (r) => str(r.date), type: 'date' },
  { header: 'Customer', value: (r) => str(r.customer_name) },
  { header: 'Country', value: (r) => str(r.customer_country) },
  { header: 'Issued by', value: (r) => str(r.company_name) },
  { header: 'From proforma', value: (r) => str(r.pi_number) },
  { header: 'Type', value: (r) => (num(r.is_export) ? 'Export' : 'Domestic') },
  { header: 'INCO', value: (r) => str(r.inco_terms) },
  { header: 'Discharge port', value: (r) => str(r.port_of_discharge) },
  { header: 'Currency', value: (r) => str(r.currency) },
  { header: 'Subtotal', value: (r) => num(r.subtotal), type: 'money' },
  { header: 'Freight', value: (r) => num(r.freight), type: 'money' },
  { header: 'Insurance', value: (r) => num(r.insurance), type: 'money' },
  { header: 'Tax', value: (r) => num(r.tax_total), type: 'money' },
  { header: 'Total', value: (r) => num(r.grand_total), type: 'money' },
  { header: 'Received', value: (r) => num(r.amount_received), type: 'money' },
  { header: 'Of which advance', value: (r) => num(r.advance_applied), type: 'money' },
  { header: 'Balance due', value: (r) => num(r.balance_due), type: 'money' },
  { header: 'Unapplied (currency)', value: (r) => str(r.currency_mismatch) },
  { header: 'Status', value: (r) => str(r.status) },
  { header: 'Approval', value: (r) => str(r.approval_status) },
  { header: 'Created by', value: (r) => str(r.created_by_name) },
];

invoicesRouter.get('/export', (req: AuthedRequest, res) => {
  const { where, params } = invoiceListWhere(req);
  const rows = db
    .prepare(`${listSql}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY i.date DESC, i.id DESC`)
    .all(...(params as never[])) as Row[];
  for (const inv of rows) {
    const money = invoiceReceivable(Number(inv.id));
    inv.amount_received = money.amount_received;
    inv.advance_applied = money.advance_applied;
    inv.balance_due = money.balance_due;
    inv.currency_mismatch = money.currency_mismatch
      .map((m) => `${m.currency} ${m.amount}`)
      .join(', ');
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${attachmentName('Commercial invoices')}"`);
  res.send(buildXlsx('Commercial invoices', invoiceColumns, rows));
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
    company_id: pi.company_id,
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
  // The source documents are checked as carefully as the customer is: an
  // unchecked pi_id let another owner's advances be read and re-allocated.
  const link = linkError(req, 'proforma_invoices', h.pi_id, h.customer_id, 'Proforma invoice')
    ?? linkError(req, 'orders', h.order_id, h.customer_id, 'Order');
  if (link) return res.status(404).json({ error: link });
  // Fixed at creation: the number below comes from this company's series.
  const companyId = resolveCompanyId(body.company_id, Number(body.customer_id));
  const id = transaction(() => {
    const number = nextNumber('invoice', { isExport: h.is_export === 1, companyId, date: h.date });
    const info = db.prepare(
      `INSERT INTO commercial_invoices (number, company_id, ${headerFields.join(', ')}, created_by, column_config, status)
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
    syncPackingList(id, req.user!.id, body.packing as PackingInput | undefined);
    return id;
  });
  // Billing is a fact about the order behind it, whether the invoice was raised
  // from the order directly or through a proforma.
  const orderId = db.prepare(
    `SELECT COALESCE(order_id, (SELECT order_id FROM proforma_invoices WHERE id = pi_id)) AS o
     FROM commercial_invoices WHERE id = ?`
  ).get(id) as { o: number | null };
  if (orderId?.o) syncOrderStatus(orderId.o);
  syncMoneyStatus(id, h.pi_id);
  res.status(201).json(getFull(id));
});

invoicesRouter.put('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  const existing = db.prepare('SELECT * FROM commercial_invoices WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing || !canAccessCustomer(req, Number(existing.customer_id))) return res.status(404).json({ error: 'Invoice not found' });
  const h = headerValues(body, existing);
  const moved = customerChangeError(req, existing.customer_id as number, h.customer_id);
  if (moved) return res.status(403).json({ error: moved });
  // The number was drawn from the export or the domestic series and is never
  // reissued, so the flag cannot move after the fact without leaving the two
  // disagreeing. 409, not 403: it is a conflict with what is already on file.
  const retyped = exportChangeError('invoice', existing, (req.body ?? {}).is_export);
  if (retyped) return res.status(409).json({ error: retyped });
  const link = linkError(req, 'proforma_invoices', h.pi_id, h.customer_id, 'Proforma invoice')
    ?? linkError(req, 'orders', h.order_id, h.customer_id, 'Order');
  if (link) return res.status(404).json({ error: link });
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
  // The total may have changed, and so may the proforma it draws its advance
  // from — sync against both the old link and the new one.
  syncMoneyStatus(id, existing.pi_id as number | null, h.pi_id);
  // Changing what was billed changes whether the order behind it is finished,
  // in either direction: raising a quantity re-opens an order this closed.
  for (const o of orderIdsBehind(id, existing.order_id as number | null, existing.pi_id as number | null)) {
    syncOrderStatus(o);
  }
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
  // Approval can be the last thing standing between an already-settled invoice
  // and 'paid', since an unapproved one is deliberately never promoted.
  syncInvoiceStatus(id);
  res.json(getFull(id));
});

invoicesRouter.post('/:id/status', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const { status } = req.body ?? {};
  const allowed = ['draft', 'final', 'dispatched', 'paid'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const existing = db.prepare('SELECT customer_id, status FROM commercial_invoices WHERE id = ?').get(id) as
    { customer_id: number; status: string } | undefined;
  if (!existing || !canAccessCustomer(req, existing.customer_id)) return res.status(404).json({ error: 'Invoice not found' });
  const blocked = blockUnapprovedTransition('commercial_invoices', id, String(status), req);
  if (blocked) return res.status(409).json({ error: blocked });
  // Setting anything else by hand makes that the new baseline, so a stale
  // memory cannot later restore something the user has moved away from. Setting
  // 'paid' by hand records what it was *before*, so that if the payment record
  // disagrees and the sync below puts it back, it goes back to where it was —
  // a rejected "mark as paid" must not quietly demote a dispatched invoice.
  const before = String(status) === 'paid' ? existing.status : '';
  db.prepare('UPDATE commercial_invoices SET status = ?, status_before_paid = ? WHERE id = ?')
    .run(String(status), before, id);
  // The payment record has the last word, as it does everywhere else. Marking a
  // half-paid invoice Paid does not make it paid, and parking a settled one at
  // Dispatched is undone the same way the shop floor undoes an order's status.
  syncInvoiceStatus(id);
  res.json(getFull(id));
});

invoicesRouter.delete('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT customer_id, pi_id, order_id FROM commercial_invoices WHERE id = ?').get(id) as
    { customer_id: number; pi_id: number | null; order_id: number | null } | undefined;
  if (!existing || !canAccessCustomer(req, existing.customer_id)) return res.status(404).json({ error: 'Invoice not found' });
  const paid = db.prepare('SELECT COUNT(*) AS c FROM payments WHERE invoice_id = ?').get(id) as { c: number };
  if (paid.c > 0) return res.status(409).json({ error: 'Invoice has recorded payments and cannot be deleted' });
  // A despatch points at the invoice it was billed under. Without this the
  // foreign key still stops the delete, but the caller is told only that "this
  // record is still referenced by another document" — true, and useless.
  const trips = db.prepare(
    `SELECT COUNT(*) AS c FROM despatches WHERE invoice_id = ?`
  ).get(id) as { c: number };
  if (trips.c > 0) {
    return res.status(409).json({
      error: `This invoice is on ${trips.c} despatch record${trips.c === 1 ? '' : 's'}. Clear the invoice from ${trips.c === 1 ? 'it' : 'them'} first, or keep the invoice.`,
    });
  }
  // Read the links before the row is gone.
  const orders = orderIdsBehind(id, existing.order_id, existing.pi_id);
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
  // Removing this invoice hands its share of the proforma's advance back to the
  // others, which can settle one that was short — and un-bills the order behind
  // it, which re-opens it if this invoice was what closed it.
  syncMoneyStatus(null, existing.pi_id);
  for (const o of orders) syncOrderStatus(o);
  res.json({ ok: true });
});
