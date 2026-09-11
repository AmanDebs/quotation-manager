import { Router } from 'express';
import { db } from '../db/connection.js';
import { requirePermission, type AuthedRequest } from '../middleware/auth.js';
import { finishedGoods } from '../services/finishedGoods.js';
import { buildXlsx, attachmentName, type Column } from '../services/xlsx.js';

/**
 * Finished goods on hand, and the stock count that corrects it. The ledger is
 * `services/finishedGoods.ts`; this is its two doors. Mounted on `fg` — the
 * spec's *View FG Inventory* — with the count behind `full`.
 */
export const finishedGoodsRouter = Router();

const REASONS = ['opening', 'count', 'other'] as const;

finishedGoodsRouter.get('/', (req: AuthedRequest, res) => {
  const locationId = Number(req.query.location_id) > 0 ? Number(req.query.location_id) : null;
  const productId = Number(req.query.product_id) > 0 ? Number(req.query.product_id) : null;
  const report = finishedGoods({ locationId, productId });
  // Not paged: bounded by the catalogue times the plants, not by trading volume.
  res.json(report);
});

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? '' : String(v));
const num = (v: unknown) => Number(v ?? 0);
const columns: Column<Row>[] = [
  { header: 'Product', value: (r) => str(r.product_name) },
  { header: 'Colour', value: (r) => str(r.color) },
  { header: 'Plant', value: (r) => str(r.location_name ?? 'Plant not recorded') },
  { header: 'Made', value: (r) => num(r.made), type: 'number' },
  { header: 'Dispatched', value: (r) => num(r.dispatched), type: 'number' },
  { header: 'Returned', value: (r) => num(r.returned), type: 'number' },
  { header: 'Counted / opening', value: (r) => num(r.adjusted), type: 'number' },
  { header: 'On hand', value: (r) => num(r.on_hand), type: 'number' },
];

/** Declared above `/adjust/:id` by shape rather than by need — there is no `/:id` here, but the habit is the point. */
finishedGoodsRouter.get('/export', (req: AuthedRequest, res) => {
  const locationId = Number(req.query.location_id) > 0 ? Number(req.query.location_id) : null;
  const rows = finishedGoods({ locationId }).rows as unknown as Row[];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${attachmentName('Finished goods')}"`);
  res.send(buildXlsx('Finished goods', columns, rows));
});

/** Every count and opening balance, newest first — the audit behind the figure. */
finishedGoodsRouter.get('/adjustments', (req: AuthedRequest, res) => {
  const productId = Number(req.query.product_id) > 0 ? Number(req.query.product_id) : null;
  res.json(db.prepare(
    `SELECT a.*, p.name AS product_name, l.name AS location_name, u.name AS created_by_name
       FROM fg_adjustments a
       JOIN products p ON p.id = a.product_id
       LEFT JOIN locations l ON l.id = a.location_id
       LEFT JOIN users u ON u.id = a.created_by
      ${productId ? 'WHERE a.product_id = ?' : ''}
      ORDER BY a.date DESC, a.id DESC LIMIT 200`
  ).all(...(productId ? [productId] : []) as never[]));
});

/**
 * Record a count or an opening balance.
 *
 * **Signed, and the sign is the person's.** `qty` is the correction — +2,000
 * means two thousand more than the record said, −350 means fewer — not the
 * shelf figure, which would make every count a subtraction the route did
 * behind the user's back and a mis-keyed one impossible to read afterwards.
 * The form offers "set on hand to N" and does that arithmetic on screen where
 * the figure it starts from is visible.
 */
finishedGoodsRouter.post('/adjust', requirePermission('fg', 'full'), (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  const productId = Number(body.product_id);
  if (!(productId > 0) || !db.prepare('SELECT id FROM products WHERE id = ?').get(productId)) {
    return res.status(400).json({ error: 'Product is required' });
  }
  const locationId = Number(body.location_id) > 0 ? Number(body.location_id) : null;
  if (locationId && !db.prepare('SELECT id FROM locations WHERE id = ?').get(locationId)) {
    return res.status(400).json({ error: 'That plant is not on file' });
  }
  const qty = Number(body.qty);
  if (!Number.isFinite(qty) || qty === 0) return res.status(400).json({ error: 'The adjustment must be a non-zero number of pieces' });
  const reason = String(body.reason ?? 'count');
  if (!(REASONS as readonly string[]).includes(reason)) {
    return res.status(400).json({ error: `Reason must be one of ${REASONS.join(', ')}` });
  }
  const date = String(body.date ?? '').trim() || new Date().toISOString().slice(0, 10);
  const info = db.prepare(
    `INSERT INTO fg_adjustments (product_id, location_id, date, qty, reason, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(productId, locationId, date, qty, reason, String(body.notes ?? ''), req.user!.id);
  res.status(201).json({ id: Number(info.lastInsertRowid), ...finishedGoods({ productId }) });
});

finishedGoodsRouter.delete('/adjust/:id', requirePermission('fg', 'full'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT product_id FROM fg_adjustments WHERE id = ?').get(id) as { product_id: number } | undefined;
  if (!row) return res.status(404).json({ error: 'Adjustment not found' });
  db.prepare('DELETE FROM fg_adjustments WHERE id = ?').run(id);
  res.json({ ok: true, ...finishedGoods({ productId: row.product_id }) });
});
