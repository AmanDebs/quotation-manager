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

/**
 * Output whose lot was condemned after inspection.
 *
 * A scrapped batch is goods that were made and then destroyed, so every
 * roll-up of what a job or an order **has** must stop counting it — otherwise
 * the floor reads as further ahead than it is, the material shortfall thinks
 * the resin for those pieces is spoken for, and the buyer is short by exactly
 * the quantity nobody re-made.
 *
 * **Condemned output becomes rejected output rather than vanishing.** Dropping
 * it from both columns was the first cut and it is perverse: `reject_pct`
 * improves when a whole lot is condemned, which is the worst quality outcome
 * there is. Nothing was un-moulded, so `qty_ok + qty_reject` is unchanged and
 * only which side of it the pieces sit on moves.
 *
 * Written as a fragment shared by all five roll-ups rather than restated in
 * each — the reason `despatch.ts` owns `SEA_LEG` and `receivables.ts` owns
 * credit. The **sixth** reader, `batchesFor`, deliberately does *not* use it:
 * the lot itself goes on reporting what it made, because "what did we scrap"
 * has to stay answerable. The job stops counting it; the lot remembers it.
 *
 * **A lot that went out is condemned only in what came back** (2026-09-12,
 * found by walking the app: a lot of 4,50,000 shipped 3,00,000, took 20,000
 * back and was then scrapped — and the roll-ups dropped all 4,50,000, so the
 * order read as if nothing had been made for goods the buyer physically
 * holds, the very defect `dispositionError` was written to prevent). Scrap
 * on a lot never dispatched means the lot no longer exists, and this fragment
 * says so. Scrap on a lot named on a trip means the *returned* goods are
 * condemned: the output stands, the shipment stands, and the finished-goods
 * ledger takes the returned pieces back off the shelf (`finishedGoods.ts`).
 * The lot itself still reads *scrapped*, which is what happened to it.
 *
 * `sb` and `sdb` are aliases nothing else here uses, so the fragment can be
 * pasted into a query that already has its own.
 */
const CONDEMNED = (e: string) =>
  `EXISTS (SELECT 1 FROM batches sb WHERE sb.id = ${e}.batch_id AND sb.disposition = 'scrapped'`
  + ` AND NOT EXISTS (SELECT 1 FROM despatch_batches sdb WHERE sdb.batch_id = sb.id))`;

/** Good output that still exists. */
export const LIVE_OK = (e: string) => `CASE WHEN ${CONDEMNED(e)} THEN 0 ELSE ${e}.qty_ok END`;

/** Rejected at the machine, plus everything a later decision condemned. */
export const LIVE_REJECT = (e: string) =>
  `(${e}.qty_reject + CASE WHEN ${CONDEMNED(e)} THEN ${e}.qty_ok ELSE 0 END)`;

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
    `SELECT COALESCE(SUM(${LIVE_OK('e')}), 0) AS ok, COALESCE(SUM(${LIVE_REJECT('e')}), 0) AS rej,
            COUNT(*) AS n
     FROM production_entries e WHERE e.work_order_id = ?`
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
    `SELECT e.work_order_id, COALESCE(SUM(${LIVE_OK('e')}), 0) AS ok,
            COALESCE(SUM(${LIVE_REJECT('e')}), 0) AS rej, COUNT(*) AS n
     FROM production_entries e WHERE e.work_order_id IN (${ids.map(() => '?').join(',')})
     GROUP BY e.work_order_id`
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
            COALESCE((SELECT SUM(${LIVE_OK('e')}) FROM production_entries e
                      JOIN work_orders w2 ON w2.id = e.work_order_id
                      WHERE w2.order_id = w.order_id AND w2.order_line = w.order_line
                        AND w2.status <> 'cancelled'), 0) AS ok,
            COALESCE((SELECT SUM(${LIVE_REJECT('e')}) FROM production_entries e
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
