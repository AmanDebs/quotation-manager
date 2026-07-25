import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { nextNumber } from '../services/numbering.js';
import { round2 } from '../services/totals.js';

export const packingListsRouter = Router();

const listSql = `
  SELECT pl.*, c.name AS customer_name, c.country AS customer_country, i.number AS invoice_number
  FROM packing_lists pl
  JOIN customers c ON c.id = pl.customer_id
  LEFT JOIN commercial_invoices i ON i.id = pl.invoice_id`;

interface PlItemInput {
  description?: string;
  hsn_code?: string;
  qty?: number | null;
  unit?: string;
  packages?: string;
  dimensions?: string;
  gross_weight?: number;
  net_weight?: number;
}

function getFull(id: number) {
  const pl = db.prepare(`${listSql} WHERE pl.id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!pl) return undefined;
  const items = db.prepare('SELECT * FROM packing_list_items WHERE packing_list_id = ? ORDER BY sort_order, id').all(id) as {
    gross_weight: number; net_weight: number;
  }[];
  pl.items = items;
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

function saveItems(plId: number, items: PlItemInput[]) {
  db.prepare('DELETE FROM packing_list_items WHERE packing_list_id = ?').run(plId);
  const ins = db.prepare(
    `INSERT INTO packing_list_items (packing_list_id, description, hsn_code, qty, unit, packages, dimensions, gross_weight, net_weight, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  items.forEach((it, i) =>
    ins.run(plId, String(it.description ?? ''), String(it.hsn_code ?? ''), it.qty ?? null, String(it.unit ?? 'unit'), String(it.packages ?? ''),
      String(it.dimensions ?? ''), Number(it.gross_weight ?? 0), Number(it.net_weight ?? 0), i)
  );
}

packingListsRouter.get('/', (_req, res) => {
  res.json(db.prepare(`${listSql} ORDER BY pl.date DESC, pl.id DESC`).all());
});

packingListsRouter.get('/:id', (req, res) => {
  const pl = getFull(Number(req.params.id));
  if (!pl) return res.status(404).json({ error: 'Packing list not found' });
  res.json(pl);
});

// Prefill payload for creating a packing list from a commercial invoice.
packingListsRouter.get('/prefill/from-invoice/:invoiceId', (req, res) => {
  const invId = Number(req.params.invoiceId);
  const inv = db.prepare('SELECT * FROM commercial_invoices WHERE id = ?').get(invId) as Record<string, unknown> | undefined;
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  const items = db.prepare('SELECT description, hsn_code, qty, unit FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id').all(invId);
  res.json({ invoice_id: invId, customer_id: inv.customer_id, lot_no: inv.lot_no, items });
});

packingListsRouter.post('/', (req, res) => {
  const body = req.body ?? {};
  if (!body.customer_id) return res.status(400).json({ error: 'Customer is required' });
  const id = transaction(() => {
    const number = nextNumber('packing_list');
    const info = db.prepare(
      `INSERT INTO packing_lists (number, date, invoice_id, customer_id, shipping_marks, lot_no, remarks)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      number,
      String(body.date ?? new Date().toISOString().slice(0, 10)),
      body.invoice_id ? Number(body.invoice_id) : null,
      Number(body.customer_id),
      String(body.shipping_marks ?? ''),
      String(body.lot_no ?? ''),
      String(body.remarks ?? '')
    );
    const id = Number(info.lastInsertRowid);
    saveItems(id, (body.items ?? []) as PlItemInput[]);
    return id;
  });
  res.status(201).json(getFull(id));
});

packingListsRouter.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  const existing = db.prepare('SELECT * FROM packing_lists WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return res.status(404).json({ error: 'Packing list not found' });
  transaction(() => {
    db.prepare('UPDATE packing_lists SET number = ?, date = ?, invoice_id = ?, customer_id = ?, shipping_marks = ?, lot_no = ?, remarks = ? WHERE id = ?').run(
      String(body.number ?? existing.number),
      String(body.date ?? existing.date),
      body.invoice_id ? Number(body.invoice_id) : (existing.invoice_id as number | null),
      Number(body.customer_id ?? existing.customer_id),
      String(body.shipping_marks ?? existing.shipping_marks ?? ''),
      String(body.lot_no ?? existing.lot_no ?? ''),
      String(body.remarks ?? existing.remarks ?? ''),
      id
    );
    if (Array.isArray(body.items)) saveItems(id, body.items as PlItemInput[]);
  });
  res.json(getFull(id));
});

packingListsRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  transaction(() => {
    db.prepare('DELETE FROM packing_list_items WHERE packing_list_id = ?').run(id);
    db.prepare('DELETE FROM packing_lists WHERE id = ?').run(id);
  });
  res.json({ ok: true });
});
