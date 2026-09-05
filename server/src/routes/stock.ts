import { Router } from 'express';
import { db } from '../db/connection.js';
import { onHandAll, onOrder, shortfall } from '../services/stock.js';
import { valuation } from '../services/costing.js';
import { round2 } from '../services/totals.js';
import { requirePermission, type AuthedRequest } from '../middleware/auth.js';
import { canAccessCustomer } from '../middleware/scope.js';

export const stockRouter = Router();

/**
 * The material ledger, read and written.
 *
 * Reading is open: an employee planning a job needs to know whether there is
 * resin for it. Writing splits by what the movement *is* — issuing material to
 * a job is a daily floor action, checked through the job's own scope, while
 * receipts, opening balances and adjustments change the company's stock
 * position and stay manager-only, like purchasing.
 */

const numOrNull = (v: unknown) =>
  v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);

/** On hand per material and location, plus what is still on order. */
stockRouter.get('/', (req, res) => {
  const locationId = numOrNull(req.query.location_id);
  const rows = onHandAll(locationId);
  const pending = onOrder();
  const levels = db.prepare('SELECT id, reorder_level FROM materials').all() as
    { id: number; reorder_level: number }[];
  const byId = new Map(levels.map((l) => [l.id, l.reorder_level]));
  // One average per material, applied to whatever each plant holds. Valuation
  // is group-wide by design — a kilo is worth the same at either plant, and a
  // per-location average would make a transfer change the company's stock
  // value. See services/costing.ts.
  const value = valuation();
  res.json(rows.map((r) => {
    const cost = value.get(r.material_id);
    return {
      ...r,
      on_order: pending.get(r.material_id) ?? 0,
      reorder_level: byId.get(r.material_id) ?? 0,
      // Flagged only when a level has actually been set — 0 means "no level",
      // not "reorder at nothing".
      below_reorder: (byId.get(r.material_id) ?? 0) > 0 && r.qty < (byId.get(r.material_id) ?? 0),
      avg_rate: cost?.avg_rate ?? 0,
      value: round2(r.qty * (cost?.avg_rate ?? 0)),
      // How much of this material never had a purchase rate recorded, so the
      // value above is extrapolated onto it from what the rest cost. Group-wide
      // like the average itself. The screen says so rather than letting the
      // figure read as fully costed.
      unpriced_qty: cost?.unpriced_qty ?? 0,
      unpriced_receipts: cost?.unpriced_receipts ?? 0,
    };
  }));
});

/** Every movement, newest first — the audit trail behind a balance. */
stockRouter.get('/moves', (req, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (req.query.material_id) { where.push('mm.material_id = ?'); params.push(Number(req.query.material_id)); }
  if (req.query.location_id) { where.push('mm.location_id = ?'); params.push(Number(req.query.location_id)); }
  if (req.query.work_order_id) { where.push('mm.work_order_id = ?'); params.push(Number(req.query.work_order_id)); }
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  res.json(db.prepare(
    `SELECT mm.*, m.name AS material_name, m.unit, l.name AS location_name,
            p.number AS po_number, w.number AS work_order_number, u.name AS created_by_name
     FROM material_moves mm
     JOIN materials m ON m.id = mm.material_id
     JOIN locations l ON l.id = mm.location_id
     LEFT JOIN purchase_orders p ON p.id = mm.po_id
     LEFT JOIN work_orders w ON w.id = mm.work_order_id
     LEFT JOIN users u ON u.id = mm.created_by
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY mm.date DESC, mm.id DESC LIMIT ?`
  ).all(...(params as never[]), limit));
});

/** What the open jobs need against what we have. */
stockRouter.get('/shortfall', (req, res) => {
  res.json(shortfall(numOrNull(req.query.location_id)));
});

/**
 * Issue material to a job — the floor's own action, so it is scoped through
 * the work order's customer rather than reserved to a manager. Stored as a
 * negative move: out is out.
 */
stockRouter.post('/issue', (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  const wo = db.prepare(
    `SELECT w.id, w.location_id, o.customer_id FROM work_orders w
     JOIN orders o ON o.id = w.order_id WHERE w.id = ?`
  ).get(Number(body.work_order_id)) as { id: number; location_id: number | null; customer_id: number } | undefined;
  if (!wo || !canAccessCustomer(req, wo.customer_id)) {
    return res.status(404).json({ error: 'Work order not found' });
  }
  const materialId = Number(body.material_id);
  if (!db.prepare('SELECT id FROM materials WHERE id = ?').get(materialId)) {
    return res.status(400).json({ error: 'That material no longer exists' });
  }
  const qty = Number(body.qty) || 0;
  if (qty <= 0) return res.status(400).json({ error: 'Issue a quantity greater than zero' });
  const locationId = numOrNull(body.location_id) ?? wo.location_id;
  if (!locationId) return res.status(400).json({ error: 'Say which plant it came out of' });
  // Checked like POST /moves does. Without it a bad id reached the foreign key
  // and came back as "still referenced by another document", which is not what
  // went wrong and points at the wrong record.
  if (!db.prepare('SELECT id FROM locations WHERE id = ?').get(locationId)) {
    return res.status(400).json({ error: 'That location no longer exists' });
  }
  const date = String(body.date ?? '').trim();
  if (!date) return res.status(400).json({ error: 'Date is required' });

  // Issuing more than is on hand is allowed and left visible as a negative
  // balance: the material physically moved, and hiding that would make the
  // ledger agree with the paperwork instead of with the floor.
  db.prepare(
    `INSERT INTO material_moves (material_id, location_id, date, qty, source, work_order_id, note, created_by)
     VALUES (?, ?, ?, ?, 'issue', ?, ?, ?)`
  ).run(materialId, locationId, date, -Math.abs(qty), wo.id, String(body.note ?? ''), req.user!.id);
  res.status(201).json({ ok: true });
});

/**
 * Opening balances, adjustments, returns and transfers. Manager-only: these
 * change the company's stock position with nothing on the floor to point at.
 */
stockRouter.post('/moves', requirePermission('material', 'full'), (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  const source = String(body.source ?? 'adjustment');
  if (!['opening', 'adjustment', 'return', 'transfer'].includes(source)) {
    return res.status(400).json({ error: 'Receipts are booked against a purchase order, and issues against a job' });
  }
  const materialId = Number(body.material_id);
  if (!db.prepare('SELECT id FROM materials WHERE id = ?').get(materialId)) {
    return res.status(400).json({ error: 'That material no longer exists' });
  }
  const locationId = Number(body.location_id);
  if (!db.prepare('SELECT id FROM locations WHERE id = ?').get(locationId)) {
    return res.status(400).json({ error: 'That location no longer exists' });
  }
  const qty = Number(body.qty);
  if (!qty) return res.status(400).json({ error: 'A movement of zero is not a movement' });
  const date = String(body.date ?? '').trim();
  if (!date) return res.status(400).json({ error: 'Date is required' });

  // A rate only means something on the way in — what this material cost to
  // acquire. On the way out the value is the running average, which costing.ts
  // derives, so anything sent here would be ignored at best and a lie at worst.
  // Omitted is NULL: unknown, which leaves the average undisturbed rather than
  // valuing the movement at nothing.
  const rate = qty > 0 && body.rate !== '' && body.rate !== null && body.rate !== undefined
    && !Number.isNaN(Number(body.rate))
    ? Number(body.rate)
    : null;

  db.prepare(
    `INSERT INTO material_moves (material_id, location_id, date, qty, rate, source, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(materialId, locationId, date, qty, rate, source, String(body.note ?? ''), req.user!.id);
  res.status(201).json({ ok: true });
});

/**
 * Correcting a mis-keyed movement. Manager-only whatever it was: an issue can
 * be deleted by the person who made it only in the sense that the manager can,
 * because a balance that anyone can quietly rewrite is not a ledger.
 */
stockRouter.delete('/moves/:id', requirePermission('material', 'full'), (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM material_moves WHERE id = ?').get(id)) {
    return res.status(404).json({ error: 'Movement not found' });
  }
  db.prepare('DELETE FROM material_moves WHERE id = ?').run(id);
  res.json({ ok: true });
});
