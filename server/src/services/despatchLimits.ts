import { db } from '../db/connection.js';
import { round2 } from './totals.js';

/**
 * What a despatch line may say went out.
 *
 * The register had no ceiling and no floor: `POST /despatches` asked for a date
 * and a figure on at least one line, and took whatever the figure was. A
 * slipped digit — 100,000,000 pieces against a line that ordered 120,000 — was
 * recorded as fact, and everything downstream believed it, because the whole
 * point of this register is that it is the physical record.
 *
 * Two rules, and they are different in kind.
 *
 * **Nothing below zero.** A lorry cannot un-take goods. This is unarguable, the
 * same shape as a work order's `qty_planned > 0` and a material issue's
 * `qty > 0`, and it is checked whatever the line was ordered at.
 *
 * **Nothing far beyond what the line has left**, which is a judgement and is
 * therefore generous. A short shipment is normal and a small over-shipment is
 * expected — Aglo's own standard clause is "(±) 10% in value and quantity" —
 * so the ceiling is what the line still has outstanding **plus that tolerance**,
 * never the outstanding figure itself. It exists to catch a typo, not to
 * enforce the contract; recording that genuinely more was sold is done by
 * raising the order's own quantity, which is the honest place for it.
 *
 * Deliberately **not** modelled on `stock.ts`, which lets an issue drive stock
 * negative because "the material physically left, and hiding it would make the
 * ledger agree with the paperwork instead of the store". The difference is that
 * a stock balance has no planned figure to be wrong against, while a despatch
 * line has an ordered quantity sitting right beside it — and 833 times that is
 * not a fact anybody would defend.
 *
 * A line the order states no piece count for is **not** bounded above: a
 * weight-billed line has no `total_pcs`, so there is nothing to compare with
 * and a guessed ceiling would refuse a real lorry.
 *
 * Shaped like `qcBlockError` and `lockError` — a function returning the
 * sentence to refuse with — so the rule is testable without an HTTP harness.
 */

/** Their own standard quantity tolerance, which this is deliberately built on. */
export const OVER_TOLERANCE = 0.1;

export interface DespatchLine {
  order_line?: number | null;
  qty?: number | null;
  packs?: number | null;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Pieces already recorded against each line of this order, optionally ignoring
 * one despatch — which is what an **edit** needs: the trip being changed is
 * already in the register, and counting it as "already sent" would make every
 * save of an unchanged despatch look like a second shipment.
 */
function sentByLine(orderId: number, exceptDespatchId?: number): Map<number, number> {
  const rows = db.prepare(
    `SELECT di.order_line, COALESCE(SUM(di.qty), 0) AS qty
       FROM despatch_items di
       JOIN despatches d ON d.id = di.despatch_id
      WHERE d.order_id = ? AND (? IS NULL OR d.id <> ?)
      GROUP BY di.order_line`
  ).all(orderId, exceptDespatchId ?? null, exceptDespatchId ?? null) as
    { order_line: number; qty: number }[];
  return new Map(rows.map((r) => [r.order_line, round2(r.qty)]));
}

export function despatchLimitError(
  orderId: number,
  lines: DespatchLine[],
  exceptDespatchId?: number,
): string | null {
  const items = db.prepare(
    'SELECT description, total_pcs, is_charge FROM order_items WHERE order_id = ? ORDER BY sort_order, id'
  ).all(orderId) as { description: string; total_pcs: number | null; is_charge: number }[];
  const sent = sentByLine(orderId, exceptDespatchId);

  for (const line of lines) {
    const i = Number(line.order_line ?? -1);
    const qty = num(line.qty);
    const packs = num(line.packs);

    // Below zero on either figure, whatever the line is.
    if ((qty !== null && qty < 0) || (packs !== null && packs < 0)) {
      return 'A dispatch cannot record a negative quantity.';
    }
    if (qty === null) continue;

    const item = items[i];
    // A line the order does not have, or a charge line, or one with no piece
    // count of its own: nothing to measure the figure against.
    if (!item || item.is_charge || !item.total_pcs) continue;

    const already = sent.get(i) ?? 0;
    const left = Math.max(0, round2(item.total_pcs - already));
    const ceiling = round2(left * (1 + OVER_TOLERANCE));
    if (qty > ceiling) {
      const name = item.description || `Line ${i + 1}`;
      return `${name}: ${fmt(qty)} pieces is more than this line has left to ship. `
        + `It was ordered at ${fmt(item.total_pcs)}${already ? `, with ${fmt(already)} already sent` : ''}, `
        + `so at most ${fmt(ceiling)} can go on this trip. `
        + 'Raise the order quantity if more really was made.';
    }
  }
  return null;
}

/** Grouped the Indian way, matching how every other figure in the app reads. */
function fmt(n: number): string {
  return new Intl.NumberFormat('en-IN').format(round2(n));
}
