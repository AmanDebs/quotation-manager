import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { nextNumber } from '../services/numbering.js';
import { computeTotals, round2 } from '../services/totals.js';
import { receivedByPo } from '../services/stock.js';
import { shortfallDraft } from '../services/purchasing.js';
import { resolveCompanyId } from '../services/companies.js';
import type { AuthedRequest } from '../middleware/auth.js';

export const purchaseOrdersRouter = Router();

/**
 * Buying material.
 *
 * Manager-only in full — supplier rates are not everyone's business, and
 * committing the company to a spend is not a shop-floor action. Mounted with
 * `requireManager` in index.ts rather than guarded route by route, unlike the
 * masters, because there is no read here that an employee needs.
 *
 * The same document shape as the money documents: `saveItems()`
 * deletes-and-reinserts inside a transaction and stamps server-computed
 * totals. **How much has arrived is never stored** — it is a sum over the
 * receipt rows in `material_moves`, so a part delivery needs nothing keyed
 * twice and cannot fall out of step with the ledger.
 */

const listSql = `
  SELECT p.*, s.name AS supplier_name, l.name AS location_name,
         co.company_name AS company_name, u.name AS created_by_name
  FROM purchase_orders p
  JOIN suppliers s ON s.id = p.supplier_id
  LEFT JOIN locations l ON l.id = p.location_id
  LEFT JOIN companies co ON co.id = p.company_id
  LEFT JOIN users u ON u.id = p.created_by`;

const headerFields = [
  'supplier_id', 'location_id', 'date', 'expected_date', 'currency', 'tax_type', 'payment_terms', 'notes',
] as const;

const STATUSES = ['draft', 'sent', 'part_received', 'received', 'cancelled'];

const numOrNull = (v: unknown) =>
  v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);

interface PoItemInput {
  material_id?: number | null;
  description?: string;
  qty?: number | null;
  unit?: string;
  rate?: number;
  tax_pct?: number;
}

/**
 * Item totals go through `computeTotals` like every other document, with the
 * PO's `rate` standing in for `unit_price`. Money math has exactly one home.
 */
function saveItems(poId: number, items: PoItemInput[], taxType: 'none' | 'cgst_sgst' | 'igst', currency: string) {
  const totals = computeTotals(
    items.map((it) => ({
      description: String(it.description ?? ''),
      qty: it.qty ?? null,
      unit: it.unit ?? 'kg',
      unit_price: Number(it.rate) || 0,
      tax_pct: Number(it.tax_pct) || 0,
    })),
    taxType, 0, 0, currency
  );
  db.prepare('DELETE FROM po_items WHERE po_id = ?').run(poId);
  const ins = db.prepare(
    `INSERT INTO po_items (po_id, material_id, description, qty, unit, rate, tax_pct, amount, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  totals.items.forEach((it, i) =>
    ins.run(poId, numOrNull(items[i]?.material_id), it.description, it.qty ?? null,
      it.unit ?? 'kg', Number(items[i]?.rate) || 0, it.tax_pct ?? 0, it.amount, i));
  db.prepare('UPDATE purchase_orders SET subtotal = ?, tax_total = ?, grand_total = ? WHERE id = ?')
    .run(totals.subtotal, totals.tax_total, totals.grand_total, poId);
}

function getFull(id: number) {
  const po = db.prepare(`${listSql} WHERE p.id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!po) return undefined;
  const items = db.prepare(
    `SELECT i.*, m.name AS material_name FROM po_items i
     LEFT JOIN materials m ON m.id = i.material_id
     WHERE i.po_id = ? ORDER BY i.sort_order, i.id`
  ).all(id) as Record<string, unknown>[];

  // Received is derived, per line, from the ledger.
  const received = receivedByPo(id);
  po.items = items.map((it) => {
    const got = it.material_id ? received.get(Number(it.material_id)) ?? 0 : 0;
    return { ...it, qty_received: got, qty_pending: round2(Math.max(0, (Number(it.qty) || 0) - got)) };
  });
  po.receipts = db.prepare(
    `SELECT mm.*, m.name AS material_name, l.name AS location_name, u.name AS created_by_name
     FROM material_moves mm
     JOIN materials m ON m.id = mm.material_id
     JOIN locations l ON l.id = mm.location_id
     LEFT JOIN users u ON u.id = mm.created_by
     WHERE mm.po_id = ? AND mm.source = 'po_receipt' ORDER BY mm.date, mm.id`
  ).all(id);
  return po;
}

purchaseOrdersRouter.get('/', (req, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (req.query.status) { where.push('p.status = ?'); params.push(String(req.query.status)); }
  if (req.query.supplier_id) { where.push('p.supplier_id = ?'); params.push(Number(req.query.supplier_id)); }
  if (req.query.open === '1') where.push("p.status NOT IN ('received','cancelled')");
  res.json(db.prepare(
    `${listSql} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.date DESC, p.id DESC`
  ).all(...(params as never[])));
});

/**
 * A draft purchase order for whatever the open jobs are short of.
 *
 * The carry-forward pattern, with the shortfall standing in for a source
 * document — hence no id in the path: "what are we short of" is one question
 * about the whole factory, not about one record. Never writes; the buyer
 * reviews the lines and saves normally, like every other conversion here.
 *
 * `?supplier_id=` narrows to the materials we last bought from them, since one
 * order goes to one supplier. `?location_id=` scopes the stock side to one
 * plant.
 *
 * **Declared above `/:id`**, or Express reads "prefill" as an id — the same
 * trap the document routes' own prefill endpoints sit above.
 */
purchaseOrdersRouter.get('/prefill/from-shortfall', (req, res) => {
  res.json(shortfallDraft({
    locationId: numOrNull(req.query.location_id),
    supplierId: numOrNull(req.query.supplier_id),
    date: new Date().toISOString().slice(0, 10),
  }));
});

purchaseOrdersRouter.get('/:id', (req, res) => {
  const po = getFull(Number(req.params.id));
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  res.json(po);
});

purchaseOrdersRouter.post('/', (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  if (!body.supplier_id) return res.status(400).json({ error: 'Supplier is required' });
  if (!db.prepare('SELECT id FROM suppliers WHERE id = ?').get(Number(body.supplier_id))) {
    return res.status(400).json({ error: 'That supplier no longer exists' });
  }
  const id = transaction(() => {
    const companyId = resolveCompanyId(body.company_id);
    const number = String(body.number ?? '').trim() || nextNumber('purchase_order', { companyId, date: String(body.date ?? '') });
    const info = db.prepare(
      `INSERT INTO purchase_orders (number, company_id, ${headerFields.join(', ')}, status, created_by)
       VALUES (?, ?, ${headerFields.map(() => '?').join(', ')}, ?, ?)`
    ).run(
      number, companyId,
      Number(body.supplier_id),
      numOrNull(body.location_id),
      String(body.date ?? new Date().toISOString().slice(0, 10)),
      String(body.expected_date ?? ''),
      String(body.currency ?? 'INR'),
      String(body.tax_type ?? 'igst'),
      String(body.payment_terms ?? ''),
      String(body.notes ?? ''),
      STATUSES.includes(String(body.status)) ? String(body.status) : 'draft',
      req.user!.id
    );
    const poId = Number(info.lastInsertRowid);
    saveItems(poId, Array.isArray(body.items) ? body.items : [], String(body.tax_type ?? 'igst') as never, String(body.currency ?? 'INR'));
    return poId;
  });
  res.status(201).json(getFull(id));
});

purchaseOrdersRouter.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return res.status(404).json({ error: 'Purchase order not found' });
  const body = req.body ?? {};
  const v = (f: string, def: unknown = '') => body[f] ?? existing[f] ?? def;
  transaction(() => {
    db.prepare(
      `UPDATE purchase_orders SET number = ?, supplier_id = ?, location_id = ?, date = ?, expected_date = ?,
         currency = ?, tax_type = ?, payment_terms = ?, notes = ? WHERE id = ?`
    ).run(
      String(v('number')), Number(v('supplier_id')), numOrNull(v('location_id', null)),
      String(v('date')), String(v('expected_date')), String(v('currency', 'INR')),
      String(v('tax_type', 'igst')), String(v('payment_terms')), String(v('notes')), id
    );
    if (Array.isArray(body.items)) {
      saveItems(id, body.items, String(v('tax_type', 'igst')) as never, String(v('currency', 'INR')));
    }
  });
  res.json(getFull(id));
});

purchaseOrdersRouter.post('/:id/status', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM purchase_orders WHERE id = ?').get(id)) {
    return res.status(404).json({ error: 'Purchase order not found' });
  }
  const status = String(req.body?.status ?? '');
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
  db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(status, id);
  res.json(getFull(id));
});

/**
 * Book a delivery.
 *
 * Writes straight into the ledger, which is the only record of it — and then
 * moves the order's status to `part_received` or `received` by comparing what
 * has now arrived with what was ordered. That comparison is a read of the
 * ledger, so it stays right even after a receipt is corrected.
 */
purchaseOrdersRouter.post('/:id/receipts', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });

  const rows = Array.isArray(req.body?.items) ? (req.body.items as Record<string, unknown>[]) : [];
  const locationId = numOrNull(req.body?.location_id) ?? numOrNull(po.location_id);
  if (!locationId) return res.status(400).json({ error: 'Say which plant received it' });
  if (!db.prepare('SELECT id FROM locations WHERE id = ?').get(locationId)) {
    return res.status(400).json({ error: 'That location no longer exists' });
  }
  const date = String(req.body?.date ?? '').trim();
  if (!date) return res.status(400).json({ error: 'Date is required' });

  const booked = rows
    .map((r) => ({ material_id: Number(r.material_id), qty: Number(r.qty) || 0 }))
    .filter((r) => r.material_id > 0 && r.qty !== 0);
  if (!booked.length) return res.status(400).json({ error: 'Record a quantity against at least one line' });

  transaction(() => {
    // What each line was bought at, stamped onto the movement as it is booked.
    // Read from the order now rather than through `po_id` at valuation time:
    // editing this purchase order next month must not change what the material
    // already in the shed cost. See services/costing.ts.
    const rates = new Map(
      (db.prepare('SELECT material_id, rate FROM po_items WHERE po_id = ? AND material_id IS NOT NULL')
        .all(id) as { material_id: number; rate: number }[])
        .map((r) => [r.material_id, r.rate])
    );
    const ins = db.prepare(
      `INSERT INTO material_moves (material_id, location_id, date, qty, rate, source, po_id, note, created_by)
       VALUES (?, ?, ?, ?, ?, 'po_receipt', ?, ?, ?)`
    );
    for (const r of booked) {
      // A rate of zero is a rate somebody typed; a missing line is not. NULL
      // means unknown, and costing.ts leaves the average undisturbed for it.
      const rate = rates.has(r.material_id) ? Number(rates.get(r.material_id)) : null;
      ins.run(r.material_id, locationId, date, r.qty, rate, id, String(req.body?.note ?? ''), req.user!.id);
    }
    // Fully received when nothing is outstanding on any line that names a material.
    const items = db.prepare('SELECT material_id, qty FROM po_items WHERE po_id = ? AND material_id IS NOT NULL')
      .all(id) as { material_id: number; qty: number | null }[];
    const received = receivedByPo(id);
    const outstanding = items.some((it) => (Number(it.qty) || 0) - (received.get(it.material_id) ?? 0) > 0.0001);
    if (String(po.status) !== 'cancelled') {
      db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?')
        .run(outstanding ? 'part_received' : 'received', id);
    }
  });

  res.status(201).json(getFull(id));
});

purchaseOrdersRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM purchase_orders WHERE id = ?').get(id)) {
    return res.status(404).json({ error: 'Purchase order not found' });
  }
  // Deleting would orphan the receipts that reference it, and those receipts
  // are the stock. Cancel instead.
  const moves = db.prepare('SELECT COUNT(*) AS c FROM material_moves WHERE po_id = ?').get(id) as { c: number };
  if (moves.c > 0) {
    return res.status(409).json({
      error: `Material has been received against this order (${moves.c} movement${moves.c === 1 ? '' : 's'}) — cancel it instead of deleting`,
    });
  }
  transaction(() => {
    db.prepare('DELETE FROM po_items WHERE po_id = ?').run(id);
    db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(id);
  });
  res.json({ ok: true });
});
