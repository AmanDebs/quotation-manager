import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { round2 } from '../services/totals.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { scopeClause, canAccessCustomer } from '../middleware/scope.js';
import { qcBlockError } from '../services/qc.js';
import { syncOrderStatus } from '../services/orderStatus.js';
import { listBody } from '../services/pagination.js';

export const despatchesRouter = Router();

/**
 * What actually left the gate.
 *
 * The order desk's Despatch sheet: plant, date, boxes, destination,
 * transporter, CN number. Deliberately **not** derived from invoices — a lorry
 * can leave before the paperwork, which the real sheet shows happening
 * regularly, and a record that cannot describe that is not a record of
 * despatch.
 *
 * It also does not *replace* the invoice walk. `dispatchProgress()` remains the
 * money truth; these rows are the physical one, and the Dispatch tab shows both
 * side by side so a gap between them is visible rather than silently
 * reconciled to whichever number was written last.
 *
 * No document number: the real sheet identifies a despatch by its consignment
 * note or the invoice raised for it, and inventing a third series would give
 * the floor one more number to quote wrongly.
 */

const listSql = `
  SELECT d.*, o.number AS order_number, o.customer_id,
         c.name AS customer_name,
         l.name AS location_name, t.name AS transporter_name,
         i.number AS invoice_number, u.name AS created_by_name
  FROM despatches d
  JOIN orders o ON o.id = d.order_id
  JOIN customers c ON c.id = o.customer_id
  LEFT JOIN locations l ON l.id = d.location_id
  LEFT JOIN transporters t ON t.id = d.transporter_id
  LEFT JOIN commercial_invoices i ON i.id = d.invoice_id
  LEFT JOIN users u ON u.id = d.created_by`;

const numOrNull = (v: unknown) =>
  v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);

function accessible(req: AuthedRequest, id: number) {
  const row = db.prepare(`${listSql} WHERE d.id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row || !canAccessCustomer(req, Number(row.customer_id))) return undefined;
  return row;
}

function withItems(row: Record<string, unknown>) {
  row.items = db.prepare('SELECT * FROM despatch_items WHERE despatch_id = ? ORDER BY sort_order, id')
    .all(Number(row.id));
  return row;
}

interface ItemInput {
  order_line?: number;
  description?: string;
  qty?: number | null;
  packs?: number | null;
  notes?: string;
}

function saveItems(despatchId: number, items: ItemInput[]) {
  db.prepare('DELETE FROM despatch_items WHERE despatch_id = ?').run(despatchId);
  const ins = db.prepare(
    `INSERT INTO despatch_items (despatch_id, order_line, description, qty, packs, notes, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  // A line with neither pieces nor boxes did not go on the lorry.
  items
    .filter((it) => numOrNull(it.qty) !== null || numOrNull(it.packs) !== null)
    .forEach((it, i) =>
      ins.run(despatchId, Number(it.order_line) || 0, String(it.description ?? ''),
        numOrNull(it.qty), numOrNull(it.packs), String(it.notes ?? ''), i));
}

/** Pieces physically sent per order line — the counterpart to the invoice walk. */
export function despatchedByOrder(orderId: number): Map<number, { qty: number; packs: number; trips: number }> {
  const rows = db.prepare(
    `SELECT di.order_line,
            COALESCE(SUM(di.qty), 0) AS qty,
            COALESCE(SUM(di.packs), 0) AS packs,
            COUNT(DISTINCT d.id) AS trips
     FROM despatch_items di
     JOIN despatches d ON d.id = di.despatch_id
     WHERE d.order_id = ?
     GROUP BY di.order_line`
  ).all(orderId) as { order_line: number; qty: number; packs: number; trips: number }[];
  return new Map(rows.map((r) => [r.order_line, {
    qty: round2(r.qty), packs: round2(r.packs), trips: r.trips,
  }]));
}

/**
 * Pieces, boxes and unbilled trips over every despatch matching the filters —
 * not just the page on screen. Built from the list's own query so the two can
 * never disagree about which despatches they are describing.
 */
function despatchSummary(sql: string, params: unknown[]) {
  return db.prepare(
    `WITH f AS (${sql})
     SELECT (SELECT COUNT(*) FROM f) AS trips,
            (SELECT COUNT(*) FROM f WHERE invoice_id IS NULL) AS unbilled,
            COALESCE((SELECT SUM(di.qty) FROM despatch_items di
                       WHERE di.despatch_id IN (SELECT id FROM f)), 0) AS pieces,
            COALESCE((SELECT SUM(di.packs) FROM despatch_items di
                       WHERE di.despatch_id IN (SELECT id FROM f)), 0) AS boxes`
  ).get(...(params as never[])) as { trips: number; unbilled: number; pieces: number; boxes: number };
}

despatchesRouter.get('/', (req: AuthedRequest, res) => {
  const scope = scopeClause(req, 'o.customer_id');
  const where: string[] = [];
  const params: unknown[] = [];
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  if (req.query.order_id) { where.push('d.order_id = ?'); params.push(Number(req.query.order_id)); }
  if (req.query.location_id) { where.push('d.location_id = ?'); params.push(Number(req.query.location_id)); }
  if (req.query.from) { where.push('d.date >= ?'); params.push(String(req.query.from)); }
  if (req.query.to) { where.push('d.date <= ?'); params.push(String(req.query.to)); }
  // Gone but not billed — the reason these rows exist at all.
  if (req.query.uninvoiced === '1') where.push('d.invoice_id IS NULL');

  // This list has always been capped — at 300 rows, silently, with no way to
  // reach the 301st. Paging replaces the cap outright: `?limit=` now means a
  // page size rather than a ceiling, and the rows beyond it are reachable.
  const sql = `${listSql} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const body = listBody<Record<string, unknown>>(req.query, {
    sql, order: 'ORDER BY d.date DESC, d.id DESC', params,
  }, (rows) => rows.map(withItems));
  // The strip above the table adds up pieces, boxes and what is still
  // unbilled. Adding up one page of rows would answer a different question in
  // the same words, so the figures come from the whole filtered set.
  res.json(Array.isArray(body) ? body : { ...body, summary: despatchSummary(sql, params) });
});

despatchesRouter.get('/:id', (req: AuthedRequest, res) => {
  const row = accessible(req, Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Despatch not found' });
  res.json(withItems(row));
});

despatchesRouter.post('/', (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  const order = db.prepare('SELECT id, customer_id FROM orders WHERE id = ?')
    .get(Number(body.order_id)) as { id: number; customer_id: number } | undefined;
  if (!order || !canAccessCustomer(req, order.customer_id)) {
    return res.status(404).json({ error: 'Order not found' });
  }
  if (!String(body.date ?? '').trim()) return res.status(400).json({ error: 'Date is required' });
  const items = Array.isArray(body.items) ? (body.items as ItemInput[]) : [];
  if (!items.some((it) => numOrNull(it.qty) !== null || numOrNull(it.packs) !== null)) {
    return res.status(400).json({ error: 'Record what went — pieces or boxes on at least one line' });
  }
  // Nothing ships until it has passed QC. See qcBlockError for what "passed"
  // means and for the two things it deliberately does not block.
  const blocked = qcBlockError(order.id, items);
  if (blocked) return res.status(409).json({ error: blocked });
  // An invoice can be named, but only one belonging to the same customer.
  const invoiceId = numOrNull(body.invoice_id);
  if (invoiceId !== null) {
    const inv = db.prepare('SELECT customer_id FROM commercial_invoices WHERE id = ?')
      .get(invoiceId) as { customer_id: number } | undefined;
    if (!inv || inv.customer_id !== order.customer_id) {
      return res.status(400).json({ error: 'That invoice belongs to another customer' });
    }
  }

  const id = transaction(() => {
    const info = db.prepare(
      `INSERT INTO despatches (order_id, location_id, date, destination, transporter_id, cn_no, vehicle_no,
         tentative_delivery, freight_terms, invoice_id, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      order.id, numOrNull(body.location_id), String(body.date), String(body.destination ?? ''),
      numOrNull(body.transporter_id), String(body.cn_no ?? ''), String(body.vehicle_no ?? ''),
      String(body.tentative_delivery ?? ''), String(body.freight_terms ?? ''),
      invoiceId, String(body.notes ?? ''), req.user!.id
    );
    const despatchId = Number(info.lastInsertRowid);
    saveItems(despatchId, items);
    return despatchId;
  });

  // Goods leaving is the clearest fact there is about an order's progress.
  syncOrderStatus(order.id);
  res.status(201).json(withItems(accessible(req, id)!));
});

despatchesRouter.put('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = accessible(req, id);
  if (!existing) return res.status(404).json({ error: 'Despatch not found' });
  const body = req.body ?? {};
  const v = (f: string, def: unknown = '') => body[f] ?? existing[f] ?? def;
  const invoiceId = numOrNull(v('invoice_id', null));
  if (invoiceId !== null) {
    const inv = db.prepare('SELECT customer_id FROM commercial_invoices WHERE id = ?')
      .get(invoiceId) as { customer_id: number } | undefined;
    if (!inv || inv.customer_id !== Number(existing.customer_id)) {
      return res.status(400).json({ error: 'That invoice belongs to another customer' });
    }
  }
  if (Array.isArray(body.items)) {
    const stopped = qcBlockError(Number(existing.order_id), body.items as ItemInput[]);
    if (stopped) return res.status(409).json({ error: stopped });
  }
  transaction(() => {
    // order_id is not editable: moving a despatch would move goods onto
    // another customer's order.
    db.prepare(
      `UPDATE despatches SET location_id = ?, date = ?, destination = ?, transporter_id = ?, cn_no = ?,
         vehicle_no = ?, tentative_delivery = ?, freight_terms = ?, invoice_id = ?, notes = ? WHERE id = ?`
    ).run(
      numOrNull(v('location_id', null)), String(v('date')), String(v('destination')),
      numOrNull(v('transporter_id', null)), String(v('cn_no')), String(v('vehicle_no')),
      String(v('tentative_delivery')), String(v('freight_terms')), invoiceId, String(v('notes')), id
    );
    if (Array.isArray(body.items)) saveItems(id, body.items);
  });
  res.json(withItems(accessible(req, id)!));
});

despatchesRouter.delete('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!accessible(req, id)) return res.status(404).json({ error: 'Despatch not found' });
  transaction(() => {
    db.prepare('DELETE FROM despatch_items WHERE despatch_id = ?').run(id);
    db.prepare('DELETE FROM despatches WHERE id = ?').run(id);
  });
  res.json({ ok: true });
});
