import { db } from '../db/connection.js';
import { round2, piecesOrdered, isPieceBasis } from './totals.js';
import { advanceDue } from './receivables.js';

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
 * and a guessed ceiling would refuse a real lorry. The count is
 * `piecesOrdered`'s — the packing figure, else the billed quantity converted
 * by its basis — so a line entered as `137.5 per 1000` with no boxes typed is
 * bounded at 137,500 like any other (until 2026-09-15 it read `total_pcs`
 * alone and such a line had no ceiling at all, the defect the auto-raised
 * jobs had).
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
    'SELECT description, qty, unit, total_pcs, is_charge FROM order_items WHERE order_id = ? ORDER BY sort_order, id'
  ).all(orderId) as { description: string; qty: number | null; unit: string; total_pcs: number | null; is_charge: number }[];
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
    if (!item || item.is_charge) continue;
    const ordered = item.total_pcs != null || isPieceBasis(item.unit) ? piecesOrdered(item) : 0;
    if (!ordered) continue;

    const already = sent.get(i) ?? 0;
    const left = Math.max(0, round2(ordered - already));
    const ceiling = round2(left * (1 + OVER_TOLERANCE));
    if (qty > ceiling) {
      const name = item.description || `Line ${i + 1}`;
      return `${name}: ${fmt(qty)} pieces is more than this line has left to ship. `
        + `It was ordered at ${fmt(ordered)}${already ? `, with ${fmt(already)} already sent` : ''}, `
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

/**
 * When a trip may say it left (2026-09-17, the client with the form in front
 * of them: *"You can make it back date or even put future dispatch date -
 * pls check"*). The register is the physical record, so a date the lorry
 * could not have left on is refused rather than recorded.
 *
 * Three refusals, most specific first. **Not before the sales order** — a
 * consignment cannot leave against an order that did not yet exist. **Not
 * after today** — a lorry that has not left is a plan, not a record; the
 * ETD/ETA fields beside it are where a future date belongs. And the sea leg
 * in order: a vessel cannot sail before the goods left the plant, nor arrive
 * before it sailed, so ETD is on or after the trip and ETA on or after ETD,
 * each only where stated.
 *
 * "Today" is the date on this desk (`Asia/Kolkata`), not the server's UTC
 * day: a lorry recorded at 2 a.m. on the 18th is on the 18th, and refusing
 * it because Greenwich is still on the 17th would refuse a real trip. Every
 * other date rule here reads UTC and calls the lag "the safe direction" —
 * a lapse arriving late — but here the lag would be the unsafe one.
 *
 * Back-dating *within* the order's life is deliberately allowed: the lorry
 * left yesterday and is being recorded this morning, which is how the desk
 * sheet is actually kept. Answered 400, like the ceiling: the figure is wrong.
 */
export function todayInKolkata(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function despatchDateError(
  orderId: number,
  date: string,
  seaLeg: { etd?: string | null; eta?: string | null } = {},
  today = todayInKolkata(),
): string | null {
  const d = String(date ?? '').trim();
  if (!ISO_DATE.test(d)) return 'Dispatch date must be a date (YYYY-MM-DD).';
  const order = db.prepare('SELECT number, date FROM orders WHERE id = ?').get(orderId) as { number: string; date: string } | undefined;
  if (order && order.date && d < order.date) {
    return `Dispatch date ${d} is before the sales order ${order.number} was booked on ${order.date}. Goods cannot leave against an order that did not yet exist.`;
  }
  if (d > today) {
    return `Dispatch date ${d} is in the future. Record a trip on the day it leaves; a planned sailing goes in ETD.`;
  }
  const etd = String(seaLeg.etd ?? '').trim();
  const eta = String(seaLeg.eta ?? '').trim();
  if (etd && etd < d) return `ETD ${etd} is before the dispatch date ${d}: the vessel cannot sail before the goods left the plant.`;
  if (eta && etd && eta < etd) return `ETA ${eta} is before ETD ${etd}: a vessel cannot arrive before it sails.`;
  if (eta && !etd && eta < d) return `ETA ${eta} is before the dispatch date ${d}.`;
  return null;
}

/**
 * Nothing leaves until the advance the order asks for has arrived (2026-09-23,
 * the client: *"dispatch should be recorded only when advance decided is
 * received"*).
 *
 * The fourth guard of this shape on the despatch — after the QC gate, the
 * quantity ceiling and the date — and the first about money. It exists because
 * the terms on almost every order here say *30% Advance and Balance before
 * Dispatch*, and until now nothing in the app read that sentence: a lorry could
 * leave against an order nobody had banked a rupee on, and the only record that
 * anything was owed was the wording on the document itself.
 *
 * **The commitment is the order's own terms, never a guess.** `advanceDue`
 * reads the percentage out of the sentence the client writes, or the stored
 * `advance_due` where an older order carries one. Terms that name no
 * percentage — a credit term, `100% CAD`, the export book's bare `30-70` —
 * ask for **nothing up front**, and this refuses nothing, which is the whole
 * of what keeps it from stopping shipments it was never meant to stop. A
 * blocking rule that fires wrongly stops a lorry, so everything ambiguous
 * falls to "no advance decided".
 *
 * **Received is what the record says, not what the money did.** An order whose
 * advance really was paid but never entered is refused, and correctly: the
 * escape is to record it, which is one dialog on the order page and the reason
 * that card was built. This is a real consequence for the imported backlog,
 * where hundreds of orders carry advance terms and no payment rows, and it is
 * the intended behaviour rather than an oversight — the alternative is a gate
 * that passes whenever the record is silent, which is no gate at all.
 *
 * **POST only**, unlike `qcBlockError` beside it, and the difference is worth
 * keeping: that one guards the PUT because a trip created with one innocuous
 * line and then edited would walk a POST-only gate, whereas nothing about
 * editing a trip changes whether the advance arrived, and `order_id` is not
 * editable so a saved trip cannot be moved onto another order. Guarding the
 * PUT would instead make every trip already on file uneditable until somebody
 * back-filled a payment for it, which is the trap this codebase has built once
 * already.
 *
 * 409, like the QC gate: the record does not support the claim, where
 * `despatchLimitError` answers 400 for a figure that is simply wrong.
 */
export function advanceBlockError(orderId: number): string | null {
  const a = advanceDue(orderId);
  // Nothing was decided, so there is nothing to wait for.
  if (a.due <= 0) return null;
  // A paise of rounding is not an unpaid advance.
  if (a.outstanding <= 0.005) return null;

  const money = (n: number) => `${a.currency} ${fmt(n)}`;
  return `The advance on this sales order has not been received. `
    + `Its payment terms (${a.terms}) ask for ${money(a.due)} up front`
    + (a.received > 0 ? ` and ${money(a.received)} has been recorded, so ${money(a.outstanding)} is still outstanding` : ', and nothing has been recorded against it')
    + `. Record the advance on the sales order, or correct its payment terms, before the goods leave.`;
}
