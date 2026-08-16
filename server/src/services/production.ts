import { db } from '../db/connection.js';
import { round2 } from './totals.js';

/**
 * How much a job has actually made.
 *
 * Derived, never stored — the same rule `dispatchProgress()` and
 * `services/receivables.ts` follow. Output is the sum of the shift entries, so
 * deleting a mis-keyed entry corrects the figure by construction; a stored
 * `qty_produced` column would have to be remembered to correct, and one day
 * would not be.
 *
 * Everything here is in **pieces**. The floor counts pieces whatever the line
 * is billed in, which is also why a work order carries `qty_planned` rather
 * than borrowing the order line's billing quantity.
 */

export interface Progress {
  produced: number;
  rejected: number;
  /** Still to make. Never negative — over-runs are normal and are not a debt. */
  balance: number;
  /** Rejects as a share of everything moulded, or null when nothing has run. */
  reject_pct: number | null;
  entry_count: number;
}

const empty = (planned: number): Progress => ({
  produced: 0, rejected: 0, balance: round2(Math.max(0, planned)), reject_pct: null, entry_count: 0,
});

function build(planned: number, ok: number, reject: number, entries: number): Progress {
  const moulded = ok + reject;
  return {
    produced: round2(ok),
    rejected: round2(reject),
    balance: round2(Math.max(0, planned - ok)),
    reject_pct: moulded > 0 ? round2((reject / moulded) * 100) : null,
    entry_count: entries,
  };
}

/** Progress for one work order. */
export function progressFor(workOrderId: number, qtyPlanned: number): Progress {
  const row = db.prepare(
    `SELECT COALESCE(SUM(qty_ok), 0) AS ok, COALESCE(SUM(qty_reject), 0) AS rej, COUNT(*) AS n
     FROM production_entries WHERE work_order_id = ?`
  ).get(workOrderId) as { ok: number; rej: number; n: number };
  return build(qtyPlanned, row.ok, row.rej, row.n);
}

/** Progress for a list of work orders in one query, so a list page is not N+1. */
export function progressForMany(
  workOrders: { id: number; qty_planned: number }[]
): Map<number, Progress> {
  const out = new Map<number, Progress>();
  if (!workOrders.length) return out;
  const ids = workOrders.map((w) => w.id);
  const rows = db.prepare(
    `SELECT work_order_id, COALESCE(SUM(qty_ok), 0) AS ok, COALESCE(SUM(qty_reject), 0) AS rej, COUNT(*) AS n
     FROM production_entries WHERE work_order_id IN (${ids.map(() => '?').join(',')})
     GROUP BY work_order_id`
  ).all(...ids) as { work_order_id: number; ok: number; rej: number; n: number }[];
  const byId = new Map(rows.map((r) => [r.work_order_id, r]));
  for (const wo of workOrders) {
    const r = byId.get(wo.id);
    out.set(wo.id, r ? build(wo.qty_planned, r.ok, r.rej, r.n) : empty(wo.qty_planned));
  }
  return out;
}

export interface LineProduction {
  /** Pieces across every work order raised for this line. */
  planned: number;
  produced: number;
  rejected: number;
  balance: number;
  work_orders: number;
}

/**
 * Production against each line of a sales order.
 *
 * Keyed by `order_line`, the position of the line — the index-matching rule the
 * whole chain uses. A line with no work order returns zeros *and* a
 * `work_orders` count of 0, which is what lets the screen say "not started"
 * rather than "nothing made", two different things.
 */
export function productionByOrder(orderId: number): Map<number, LineProduction> {
  const rows = db.prepare(
    `SELECT w.order_line,
            COALESCE(SUM(w.qty_planned), 0) AS planned,
            COUNT(DISTINCT w.id) AS wo_count,
            COALESCE((SELECT SUM(e.qty_ok) FROM production_entries e
                      JOIN work_orders w2 ON w2.id = e.work_order_id
                      WHERE w2.order_id = w.order_id AND w2.order_line = w.order_line
                        AND w2.status <> 'cancelled'), 0) AS ok,
            COALESCE((SELECT SUM(e.qty_reject) FROM production_entries e
                      JOIN work_orders w2 ON w2.id = e.work_order_id
                      WHERE w2.order_id = w.order_id AND w2.order_line = w.order_line
                        AND w2.status <> 'cancelled'), 0) AS rej
     FROM work_orders w
     WHERE w.order_id = ? AND w.status <> 'cancelled'
     GROUP BY w.order_line`
  ).all(orderId) as { order_line: number; planned: number; wo_count: number; ok: number; rej: number }[];

  return new Map(rows.map((r) => [r.order_line, {
    planned: round2(r.planned),
    produced: round2(r.ok),
    rejected: round2(r.rej),
    balance: round2(Math.max(0, r.planned - r.ok)),
    work_orders: r.wo_count,
  }]));
}
