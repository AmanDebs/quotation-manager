import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { nextNumber } from '../services/numbering.js';
import { round2 } from '../services/totals.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { scopeClause, canAccessCustomer } from '../middleware/scope.js';
import { resolveCompanyId } from '../services/companies.js';
import { listBody } from '../services/pagination.js';

export const packingListsRouter = Router();

const listSql = `
  SELECT pl.*, c.name AS customer_name, c.country AS customer_country, i.number AS invoice_number,
         u.name AS created_by_name
  FROM packing_lists pl
  JOIN customers c ON c.id = pl.customer_id
  LEFT JOIN commercial_invoices i ON i.id = pl.invoice_id
  LEFT JOIN users u ON u.id = pl.created_by`;

interface PlItemInput {
  description?: string;
  hsn_code?: string;
  qty?: number | null;
  unit?: string;
  packages?: string;
  dimensions?: string;
  gross_weight?: number;
  net_weight?: number;
  custom1?: string;
  custom2?: string;
  custom3?: string;
}

function getFull(id: number) {
  const pl = db.prepare(`${listSql} WHERE pl.id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!pl) return undefined;
  const items = db.prepare('SELECT * FROM packing_list_items WHERE packing_list_id = ? ORDER BY sort_order, id').all(id) as {
    gross_weight: number; net_weight: number;
  }[];
  pl.items = items;
  pl.column_config = JSON.parse(String(pl.column_config || '{}'));
  pl.total_gross = round2(items.reduce((s, it) => s + (it.gross_weight || 0), 0));
  pl.total_net = round2(items.reduce((s, it) => s + (it.net_weight || 0), 0));
  // Parties and shipping context come from the linked invoice (for the PDF header).
  if (pl.invoice_id) {
    pl.invoice = db.prepare(
      `SELECT number, consignee, notify_party, notify_party_2, method_of_despatch, is_export,
              country_of_origin, port_of_loading, port_of_discharge, final_destination, inco_terms, currency
       FROM commercial_invoices WHERE id = ?`
    ).get(Number(pl.invoice_id));
  }
  return pl;
}

/**
 * When a packing list belongs to an invoice, what is being shipped is the
 * invoice's business — only the packing values are editable here. Standalone
 * packing lists (no invoice) remain fully editable.
 */
function saveItems(plId: number, items: PlItemInput[], invoiceId?: number | null) {
  if (invoiceId) {
    const invItems = db.prepare(
      'SELECT description, hsn_code, qty, unit, is_charge FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id'
    ).all(invoiceId) as { description: string; hsn_code: string; qty: number | null; unit: string; is_charge: number }[];
    db.prepare('DELETE FROM packing_list_items WHERE packing_list_id = ?').run(plId);
    const insLinked = db.prepare(
      `INSERT INTO packing_list_items (packing_list_id, description, hsn_code, qty, unit, packages, dimensions, gross_weight, net_weight, is_charge, custom1, custom2, custom3, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    invItems.forEach((inv, i) => {
      const p = items[i] ?? {};
      insLinked.run(plId, inv.description, inv.hsn_code ?? '', inv.qty ?? null, inv.unit ?? 'unit',
        String(p.packages ?? ''), String(p.dimensions ?? ''), Number(p.gross_weight ?? 0), Number(p.net_weight ?? 0),
        inv.is_charge ? 1 : 0,
        String(p.custom1 ?? ''), String(p.custom2 ?? ''), String(p.custom3 ?? ''), i);
    });
    return;
  }
  saveStandaloneItems(plId, items);
}

function saveStandaloneItems(plId: number, items: PlItemInput[]) {
  db.prepare('DELETE FROM packing_list_items WHERE packing_list_id = ?').run(plId);
  const ins = db.prepare(
    `INSERT INTO packing_list_items (packing_list_id, description, hsn_code, qty, unit, packages, dimensions, gross_weight, net_weight, custom1, custom2, custom3, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  items.forEach((it, i) =>
    ins.run(plId, String(it.description ?? ''), String(it.hsn_code ?? ''), it.qty ?? null, String(it.unit ?? 'unit'), String(it.packages ?? ''),
      String(it.dimensions ?? ''), Number(it.gross_weight ?? 0), Number(it.net_weight ?? 0),
      String(it.custom1 ?? ''), String(it.custom2 ?? ''), String(it.custom3 ?? ''), i)
  );
}

packingListsRouter.get('/', (req: AuthedRequest, res) => {
  const scope = scopeClause(req, 'pl.customer_id');
  res.json(listBody(req.query, {
    sql: `${listSql}${scope.sql ? ' WHERE ' + scope.sql : ''}`,
    order: 'ORDER BY pl.date DESC, pl.id DESC',
    params: scope.params,
  }));
});

packingListsRouter.get('/:id', (req: AuthedRequest, res) => {
  const pl = getFull(Number(req.params.id));
  if (!pl || !canAccessCustomer(req, Number(pl.customer_id))) return res.status(404).json({ error: 'Packing list not found' });
  res.json(pl);
});

// Prefill payload for creating a packing list from a commercial invoice.
packingListsRouter.get('/prefill/from-invoice/:invoiceId', (req: AuthedRequest, res) => {
  const invId = Number(req.params.invoiceId);
  const inv = db.prepare('SELECT * FROM commercial_invoices WHERE id = ?').get(invId) as Record<string, unknown> | undefined;
  if (!inv || !canAccessCustomer(req, Number(inv.customer_id))) return res.status(404).json({ error: 'Invoice not found' });
  const items = db.prepare('SELECT description, hsn_code, qty, unit FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id').all(invId);
  res.json({ invoice_id: invId, customer_id: inv.customer_id, company_id: inv.company_id, lot_no: inv.lot_no, items });
});

packingListsRouter.post('/', (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  if (!body.customer_id) return res.status(400).json({ error: 'Customer is required' });
  if (!canAccessCustomer(req, Number(body.customer_id))) return res.status(403).json({ error: 'That customer is not assigned to you' });
  // A standalone packing list follows its invoice's company when it has one.
  const linked = body.invoice_id
    ? (db.prepare('SELECT company_id FROM commercial_invoices WHERE id = ?').get(Number(body.invoice_id)) as { company_id: number } | undefined)
    : undefined;
  const companyId = resolveCompanyId(linked?.company_id ?? body.company_id, Number(body.customer_id));
  const id = transaction(() => {
    const number = nextNumber('packing_list', { companyId, date: String(body.date ?? '') });
    const info = db.prepare(
      `INSERT INTO packing_lists (number, date, invoice_id, customer_id, company_id, shipping_marks, lot_no, remarks, created_by, column_config)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      number,
      String(body.date ?? new Date().toISOString().slice(0, 10)),
      body.invoice_id ? Number(body.invoice_id) : null,
      Number(body.customer_id),
      companyId,
      String(body.shipping_marks ?? ''),
      String(body.lot_no ?? ''),
      String(body.remarks ?? ''),
      req.user!.id,
      JSON.stringify(body.column_config ?? {})
    );
    const id = Number(info.lastInsertRowid);
    saveItems(id, (body.items ?? []) as PlItemInput[], body.invoice_id ? Number(body.invoice_id) : null);
    return id;
  });
  res.status(201).json(getFull(id));
});

packingListsRouter.put('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  const existing = db.prepare('SELECT * FROM packing_lists WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing || !canAccessCustomer(req, Number(existing.customer_id))) return res.status(404).json({ error: 'Packing list not found' });
  transaction(() => {
    db.prepare('UPDATE packing_lists SET number = ?, date = ?, invoice_id = ?, customer_id = ?, shipping_marks = ?, lot_no = ?, remarks = ?, column_config = ? WHERE id = ?').run(
      String(body.number ?? existing.number),
      String(body.date ?? existing.date),
      body.invoice_id ? Number(body.invoice_id) : (existing.invoice_id as number | null),
      Number(body.customer_id ?? existing.customer_id),
      String(body.shipping_marks ?? existing.shipping_marks ?? ''),
      String(body.lot_no ?? existing.lot_no ?? ''),
      String(body.remarks ?? existing.remarks ?? ''),
      JSON.stringify(body.column_config ?? JSON.parse(String(existing.column_config || '{}'))),
      id
    );
    const invoiceId = body.invoice_id ? Number(body.invoice_id) : (existing.invoice_id as number | null);
    if (Array.isArray(body.items)) saveItems(id, body.items as PlItemInput[], invoiceId);
  });
  res.json(getFull(id));
});

packingListsRouter.delete('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT customer_id FROM packing_lists WHERE id = ?').get(id) as { customer_id: number } | undefined;
  if (!existing || !canAccessCustomer(req, existing.customer_id)) return res.status(404).json({ error: 'Packing list not found' });
  transaction(() => {
    db.prepare('DELETE FROM packing_list_items WHERE packing_list_id = ?').run(id);
    db.prepare('DELETE FROM packing_lists WHERE id = ?').run(id);
  });
  res.json({ ok: true });
});
