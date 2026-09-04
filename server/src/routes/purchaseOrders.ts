import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { nextNumber, exportChangeError } from '../services/numbering.js';
import { computeTotals, round2 } from '../services/totals.js';
import { receivedByLine } from '../services/stock.js';
import { shortfallDraft } from '../services/purchasing.js';
import { resolveCompanyId } from '../services/companies.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { listBody } from '../services/pagination.js';

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
  // The header Aglo's own purchase order prints, and the import flag.
  'is_import', 'attn', 'vendor_ref', 'ship_to', 'inco_terms', 'transport', 'ship_via', 'packing', 'tcs_pct',
] as const;

const STATUSES = ['draft', 'sent', 'part_received', 'received', 'cancelled'];

const numOrNull = (v: unknown) =>
  v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);

interface PoItemInput {
  material_id?: number | null;
  product_id?: number | null;
  description?: string;
  qty?: number | null;
  unit?: string;
  packs?: number | null;
  pcs_per_pack?: number | null;
  total_pcs?: number | null;
  rate?: number;
  tax_pct?: number;
}

/**
 * A line names a material, or a product, or neither.
 *
 * Neither is a free-text line, which has always been legal here. **Both** is
 * the one thing that cannot be true: the two masters answer the same question
 * — what is being bought — and a row claiming both would make every reader of
 * it pick one arbitrarily. Checked here rather than left to a constraint,
 * because an error the user can act on must not arrive as a 500.
 */
function lineError(items: PoItemInput[]): string | null {
  for (const [i, it] of items.entries()) {
    const material = numOrNull(it.material_id);
    const product = numOrNull(it.product_id);
    if (material && product) return `Line ${i + 1} names both a material and a product — it can only be one`;
    if (material && !db.prepare('SELECT id FROM materials WHERE id = ?').get(material)) {
      return `Line ${i + 1}: that material no longer exists`;
    }
    if (product && !db.prepare('SELECT id FROM products WHERE id = ?').get(product)) {
      return `Line ${i + 1}: that product no longer exists`;
    }
  }
  return null;
}

/**
 * Item totals go through `computeTotals` like every other document, with the
 * PO's `rate` standing in for `unit_price`. Money math has exactly one home.
 */
function saveItems(
  poId: number, items: PoItemInput[],
  taxType: 'none' | 'cgst_sgst' | 'igst', currency: string, tcsPct = 0
) {
  const totals = computeTotals(
    items.map((it) => ({
      description: String(it.description ?? ''),
      qty: it.qty ?? null,
      unit: it.unit ?? 'kg',
      // Packing rides through, so a piece-priced line derives its quantity from
      // boxes x pcs/box exactly as it does on a quotation. Every line on file
      // is kg with a typed qty, which billedQty returns unchanged.
      packs: it.packs ?? null,
      pcs_per_pack: it.pcs_per_pack ?? null,
      total_pcs: it.total_pcs ?? null,
      unit_price: Number(it.rate) || 0,
      tax_pct: Number(it.tax_pct) || 0,
    })),
    taxType, 0, 0, currency, tcsPct
  );
  db.prepare('DELETE FROM po_items WHERE po_id = ?').run(poId);
  const ins = db.prepare(
    `INSERT INTO po_items (po_id, material_id, product_id, description, qty, unit,
                           packs, pcs_per_pack, total_pcs, rate, tax_pct, amount, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // What was bought is read back out of the *original* row by index:
  // computeTotals is not given it and does not reorder, so the index holds.
  totals.items.forEach((it, i) =>
    ins.run(poId, numOrNull(items[i]?.material_id), numOrNull(items[i]?.product_id),
      it.description, it.qty ?? null, it.unit ?? 'kg',
      it.packs ?? null, it.pcs_per_pack ?? null, it.total_pcs ?? null,
      Number(items[i]?.rate) || 0, it.tax_pct ?? 0, it.amount, i));
  db.prepare('UPDATE purchase_orders SET subtotal = ?, tax_total = ?, tcs_amount = ?, grand_total = ? WHERE id = ?')
    .run(totals.subtotal, totals.tax_total, totals.tcs_amount, totals.grand_total, poId);
}

function getFull(id: number) {
  const po = db.prepare(`${listSql} WHERE p.id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!po) return undefined;
  const items = db.prepare(
    `SELECT i.*, m.name AS material_name, pr.name AS product_name, pr.unit AS product_unit
     FROM po_items i
     LEFT JOIN materials m ON m.id = i.material_id
     LEFT JOIN products pr ON pr.id = i.product_id
     WHERE i.po_id = ? ORDER BY i.sort_order, i.id`
  ).all(id) as Record<string, unknown>[];

  // Received is derived per line, from the receipts — never stored, and never
  // inferred from the material, which used to credit two lines of the same
  // material with each other's deliveries.
  const received = receivedByLine(id);
  po.items = items.map((it, i) => {
    const got = received.get(i) ?? 0;
    return { ...it, qty_received: got, qty_pending: round2(Math.max(0, (Number(it.qty) || 0) - got)) };
  });
  po.receipts = db.prepare(
    `SELECT r.*, l.name AS location_name, u.name AS created_by_name
     FROM po_receipts r
     LEFT JOIN locations l ON l.id = r.location_id
     LEFT JOIN users u ON u.id = r.created_by
     WHERE r.po_id = ? ORDER BY r.date, r.id`
  ).all(id);
  return po;
}

purchaseOrdersRouter.get('/', (req, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (req.query.status) { where.push('p.status = ?'); params.push(String(req.query.status)); }
  if (req.query.supplier_id) { where.push('p.supplier_id = ?'); params.push(Number(req.query.supplier_id)); }
  if (req.query.open === '1') where.push("p.status NOT IN ('received','cancelled')");
  res.json(listBody(req.query, {
    sql: `${listSql} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    order: 'ORDER BY p.date DESC, p.id DESC',
    params,
  }));
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
    // `?basis=jobs` asks what the work orders raised so far are short of;
    // the default asks it of the order book, before the jobs exist.
    basis: req.query.basis === 'jobs' ? 'jobs' : 'orders',
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
  const badLine = lineError(Array.isArray(body.items) ? body.items : []);
  if (badLine) return res.status(400).json({ error: badLine });
  const isImport = Number(body.is_import) ? 1 : 0;
  const id = transaction(() => {
    const companyId = resolveCompanyId(body.company_id);
    // An import draws from its own series, the way an export proforma does.
    const number = String(body.number ?? '').trim()
      || nextNumber('purchase_order', { companyId, date: String(body.date ?? ''), isExport: !!isImport });
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
      isImport,
      String(body.attn ?? ''),
      String(body.vendor_ref ?? ''),
      String(body.ship_to ?? ''),
      String(body.inco_terms ?? ''),
      String(body.transport ?? ''),
      String(body.ship_via ?? ''),
      String(body.packing ?? ''),
      Number(body.tcs_pct) || 0,
      STATUSES.includes(String(body.status)) ? String(body.status) : 'draft',
      req.user!.id
    );
    const poId = Number(info.lastInsertRowid);
    saveItems(
      poId, Array.isArray(body.items) ? body.items : [],
      String(body.tax_type ?? 'igst') as never, String(body.currency ?? 'INR'), Number(body.tcs_pct) || 0
    );
    return poId;
  });
  res.status(201).json(getFull(id));
});

purchaseOrdersRouter.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return res.status(404).json({ error: 'Purchase order not found' });
  const body = req.body ?? {};
  // The number was drawn from the domestic or the import series and is never
  // reissued, so the flag cannot move afterwards — the same guard, and the same
  // reason, as on an order, a proforma and an invoice.
  const badType = exportChangeError('purchase_order', existing, body.is_import);
  if (badType) return res.status(409).json({ error: badType });
  const badLine = lineError(Array.isArray(body.items) ? body.items : []);
  if (badLine) return res.status(400).json({ error: badLine });
  const v = (f: string, def: unknown = '') => body[f] ?? existing[f] ?? def;
  const tcsPct = Number(v('tcs_pct', 0)) || 0;
  transaction(() => {
    db.prepare(
      `UPDATE purchase_orders SET number = ?, supplier_id = ?, location_id = ?, date = ?, expected_date = ?,
         currency = ?, tax_type = ?, payment_terms = ?, notes = ?,
         attn = ?, vendor_ref = ?, ship_to = ?, inco_terms = ?, transport = ?, ship_via = ?,
         packing = ?, tcs_pct = ? WHERE id = ?`
    ).run(
      String(v('number')), Number(v('supplier_id')), numOrNull(v('location_id', null)),
      String(v('date')), String(v('expected_date')), String(v('currency', 'INR')),
      String(v('tax_type', 'igst')), String(v('payment_terms')), String(v('notes')),
      String(v('attn')), String(v('vendor_ref')), String(v('ship_to')), String(v('inco_terms')),
      String(v('transport')), String(v('ship_via')), String(v('packing')), tcsPct, id
    );
    if (Array.isArray(body.items)) {
      saveItems(id, body.items, String(v('tax_type', 'igst')) as never, String(v('currency', 'INR')), tcsPct);
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
 * **Two records, one transaction, two different questions.** A `po_receipts`
 * row says what arrived against which *line* of this order, and that is the
 * only thing "received" is ever derived from. Where the line names a material,
 * a `material_moves` row says what that did to the *stock* — unchanged, same
 * source, same rate stamped from the line. Where it names a product there is
 * no second row: this app has no finished-goods ledger, and inventing a
 * quantity in the materials one would corrupt both the balance and the moving
 * average by aliasing onto whatever material shares that id.
 *
 * A delivery is booked against a **line position**, not a material. Keying it
 * on the material was wrong in both directions — two lines of the same material
 * each credited with the other's delivery, and a line naming none never
 * receivable, so an order carrying one could never close.
 *
 * The status still follows the arithmetic rather than being typed, and the
 * comparison is still a read, so correcting a receipt corrects the status.
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

  // The order's lines, by position — what a receipt is booked against.
  const lines = db.prepare(
    'SELECT material_id, qty, rate FROM po_items WHERE po_id = ? ORDER BY sort_order, id'
  ).all(id) as { material_id: number | null; qty: number | null; rate: number }[];

  const booked = rows
    .map((r) => ({ line: Number(r.line), qty: Number(r.qty) || 0 }))
    .filter((r) => Number.isInteger(r.line) && r.line >= 0 && r.line < lines.length && r.qty !== 0);
  if (!booked.length) return res.status(400).json({ error: 'Record a quantity against at least one line' });

  transaction(() => {
    const insReceipt = db.prepare(
      `INSERT INTO po_receipts (po_id, po_line, date, qty, location_id, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insMove = db.prepare(
      `INSERT INTO material_moves (material_id, location_id, date, qty, rate, source, po_id, note, created_by)
       VALUES (?, ?, ?, ?, ?, 'po_receipt', ?, ?, ?)`
    );
    const note = String(req.body?.note ?? '');
    for (const r of booked) {
      insReceipt.run(id, r.line, date, r.qty, locationId, note, req.user!.id);
      const line = lines[r.line];
      // Only a material reaches the stock ledger. The rate is the line's own,
      // stamped as the movement is booked rather than read back through
      // `po_id` later: editing this order next month must not change what the
      // material already in the shed cost. See services/costing.ts.
      if (line.material_id) {
        insMove.run(Number(line.material_id), locationId, date, r.qty, Number(line.rate), id, note, req.user!.id);
      }
    }
    // Fully received when no line is outstanding — every line now, including
    // one naming a product, which the material-keyed version could not see.
    const received = receivedByLine(id);
    const outstanding = lines.some((it, i) => (Number(it.qty) || 0) - (received.get(i) ?? 0) > 0.0001);
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
  // Counted on the receipts, not the ledger: a delivery against a product line
  // writes no movement, and deleting the order would take that record with it.
  const moves = db.prepare('SELECT COUNT(*) AS c FROM po_receipts WHERE po_id = ?').get(id) as { c: number };
  if (moves.c > 0) {
    return res.status(409).json({
      error: `Deliveries have been booked against this order (${moves.c} receipt${moves.c === 1 ? '' : 's'}) — cancel it instead of deleting`,
    });
  }
  transaction(() => {
    db.prepare('DELETE FROM po_items WHERE po_id = ?').run(id);
    db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(id);
  });
  res.json({ ok: true });
});
