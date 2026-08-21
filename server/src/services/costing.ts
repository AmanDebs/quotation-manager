import { db } from '../db/connection.js';
import { round2 } from './totals.js';

/**
 * What material is worth — the only place allowed to answer it, the way
 * `stock.ts` owns how much there is and `receivables.ts` owns credit.
 *
 * **Moving average, chosen with Aglo (2026-08-21) over FIFO.** The resin is
 * bought in bulk at similar rates, so FIFO's layer-by-layer tracking buys
 * little, and a moving average is forgiving of a ledger corrected after the
 * fact — which this one is designed to be.
 *
 * **Nothing is stored.** There is no "current average" column and no stock
 * value column, for the same reason there is no stock column: a figure that is
 * written down can drift from the movements that produced it. The average is
 * derived by replaying `material_moves` in date order, so deleting a mis-keyed
 * receipt corrects the valuation by construction, exactly as it already
 * corrects the quantity.
 *
 * What *is* stored is `material_moves.rate` on the way **in** — what a unit
 * cost when it arrived. That is a fact about a delivery, not a derivation, and
 * it is stamped at receipt rather than read back through the purchase order,
 * because editing a PO months later must not rewrite what the stock cost.
 *
 * **Valuation is per material, group-wide** — not per location, which is how
 * quantity is held. A kilo of HDPE is worth the same at either plant; giving
 * each its own average would mean a transfer between them changed the value of
 * the company's stock, which is not a thing that happens when a lorry moves
 * between Jungalpur and PACK SKRL.
 */

export interface MaterialValue {
  material_id: number;
  material_name: string;
  unit: string;
  /** Everything on hand, priced or not — the same figure `stock.ts` reports. */
  qty: number;
  /** How much of it arrived with a rate, so its cost is known rather than assumed. */
  priced_qty: number;
  /** The rest. Non-zero means `avg_rate` is being extrapolated onto stock nobody costed. */
  unpriced_qty: number;
  /** Moving average cost per unit, taken from the priced stock alone. */
  avg_rate: number;
  /** qty × avg_rate — an estimate exactly to the extent `unpriced_qty` is non-zero. */
  value: number;
  /** Movements that brought material in without a rate. */
  unpriced_receipts: number;
}

interface MoveRow {
  id: number;
  material_id: number;
  qty: number;
  rate: number | null;
  work_order_id: number | null;
  date: string;
}

/** One movement with the value the replay assigned to it. Signed like `qty`. */
export interface ValuedMove extends MoveRow {
  /** The rate this movement was valued at — its own coming in, the average going out. */
  applied_rate: number;
  value: number;
}

/**
 * Replay the whole ledger once, in movement order, carrying a running quantity
 * and value per material.
 *
 * Ordered by `date` then `id`, the same tie-break the rest of the app uses, so
 * two movements booked on one day settle in the order they were entered.
 *
 * An **in** movement with no rate adds quantity but **stays out of the average
 * entirely**, rather than entering it at zero or at the running average. Both
 * of those were tried: at zero it makes unpriced stock look free and drags
 * every later average down with it — 500 kg unrated plus 500 kg at 80 came out
 * at 40, which is a claim that half the shed cost nothing. Keeping it out means
 * the average is what the priced stock actually cost, and `unpriced_qty` says
 * how much is being valued by extrapolation, the way `hasRecipe: false` reports
 * a product nobody has costed. The fix for a flagged material is to record a
 * rate on the opening balance, not to reinterpret silence as zero.
 *
 * An **out** movement takes the average and does not change it — that is what
 * makes the average "moving" rather than recalculated. It draws down the priced
 * pool first, so a job is charged what we know material costs rather than an
 * average diluted by stock of unknown value. Issuing more than is on hand
 * drives the quantity negative, because the material physically left and hiding
 * it would make the ledger agree with the paperwork instead of with the store.
 */
function replay(materialId?: number): { totals: Map<number, MaterialValue>; moves: ValuedMove[] } {
  const rows = db.prepare(
    `SELECT mm.id, mm.material_id, mm.qty, mm.rate, mm.work_order_id, mm.date
     FROM material_moves mm
     ${materialId ? 'WHERE mm.material_id = ?' : ''}
     ORDER BY mm.date, mm.id`
  ).all(...(materialId ? [materialId] : []) as never[]) as unknown as MoveRow[];

  const names = new Map(
    (db.prepare('SELECT id, name, unit FROM materials').all() as
      { id: number; name: string; unit: string }[]).map((m) => [m.id, m])
  );

  const totals = new Map<number, MaterialValue>();
  const moves: ValuedMove[] = [];

  // Running state per material. `pricedValue` and `pricedQty` are the average's
  // base; `qty` is everything, priced or not.
  const state = new Map<number, { qty: number; pricedQty: number; pricedValue: number }>();

  for (const move of rows) {
    const material = names.get(move.material_id);
    let running = totals.get(move.material_id);
    if (!running) {
      running = {
        material_id: move.material_id,
        material_name: material?.name ?? '',
        unit: material?.unit ?? '',
        qty: 0, priced_qty: 0, unpriced_qty: 0, avg_rate: 0, value: 0, unpriced_receipts: 0,
      };
      totals.set(move.material_id, running);
      state.set(move.material_id, { qty: 0, pricedQty: 0, pricedValue: 0 });
    }
    const acc = state.get(move.material_id)!;
    const average = acc.pricedQty > 0 ? acc.pricedValue / acc.pricedQty : 0;
    let applied: number;

    if (move.qty > 0) {
      if (move.rate == null) {
        // Quantity arrives, the average does not move. Valued at whatever the
        // priced stock is worth, which is the honest estimate available.
        applied = average;
        running.unpriced_receipts += 1;
      } else {
        applied = move.rate;
        acc.pricedQty += move.qty;
        acc.pricedValue += move.qty * move.rate;
      }
      acc.qty += move.qty;
    } else {
      applied = average;
      // Consume the priced pool first, never below zero: what is left over is
      // stock whose cost was never recorded, and it stays unpriced.
      const consumed = Math.min(-move.qty, acc.pricedQty);
      acc.pricedQty -= consumed;
      acc.pricedValue -= consumed * average;
      acc.qty += move.qty;
    }

    // A balance back at zero must be worth zero. Rounding across many
    // movements otherwise leaves a few paise behind that no material owns.
    if (Math.abs(acc.qty) < 0.00001) { acc.qty = 0; acc.pricedQty = 0; acc.pricedValue = 0; }

    moves.push({ ...move, applied_rate: applied, value: move.qty * applied });
  }

  for (const row of totals.values()) {
    const acc = state.get(row.material_id)!;
    const average = acc.pricedQty > 0 ? acc.pricedValue / acc.pricedQty : 0;
    row.qty = round2(acc.qty);
    row.priced_qty = round2(acc.pricedQty);
    row.unpriced_qty = round2(Math.max(0, acc.qty - acc.pricedQty));
    row.avg_rate = round2(average);
    row.value = round2(acc.qty * average);
  }
  return { totals, moves };
}

/** Value per material, group-wide. */
export function valuation(): Map<number, MaterialValue> {
  return replay().totals;
}

/**
 * What the material issued to one job cost.
 *
 * Issues are negative, so their values are too; the sign is flipped here
 * because a cost is stated as a positive number. A job that has had nothing
 * issued costs 0 — genuinely nothing has been consumed, which is not the same
 * ambiguity as a product nobody has costed.
 */
export function materialCostByWorkOrder(): Map<number, number> {
  const { moves } = replay();
  const out = new Map<number, number>();
  for (const move of moves) {
    if (!move.work_order_id || move.qty >= 0) continue;
    out.set(move.work_order_id, (out.get(move.work_order_id) ?? 0) + -move.value);
  }
  for (const [id, value] of out) out.set(id, round2(value));
  return out;
}

export interface OrderMaterialCost {
  material_cost: number;
  /** Jobs that have had material issued, so the figure can be read in context. */
  jobs_issued: number;
  /** Open jobs on this order with nothing issued yet — the cost is not final. */
  jobs_without_issues: number;
}

/**
 * Material cost of everything made against one sales order.
 *
 * **Partial by nature.** It is the cost of what has actually been issued so
 * far, not a forecast of the finished order, so `jobs_without_issues` comes
 * with it — a margin read off a half-issued order is a number about half a job.
 */
export function orderMaterialCost(orderId: number): OrderMaterialCost {
  const jobs = db.prepare('SELECT id FROM work_orders WHERE order_id = ?').all(orderId) as { id: number }[];
  if (!jobs.length) return { material_cost: 0, jobs_issued: 0, jobs_without_issues: 0 };
  const byJob = materialCostByWorkOrder();
  let cost = 0;
  let issued = 0;
  for (const job of jobs) {
    const jobCost = byJob.get(job.id);
    if (jobCost === undefined) continue;
    cost += jobCost;
    issued += 1;
  }
  return {
    material_cost: round2(cost),
    jobs_issued: issued,
    jobs_without_issues: jobs.length - issued,
  };
}
