import { db } from '../db/connection.js';
import { round2, piecesPerBillingUnit } from './totals.js';
import { LIVE_OK } from './production.js';

/**
 * Finished goods on hand — the ledger this app said it did not have.
 *
 * Three earlier entries stopped at its edge: the RBAC matrix's *View FG
 * Inventory* cell had nothing to grant, the batch could be a production run
 * but never a lot picked from stock, and the dispatch → batch link carried no
 * quantity because *how much of this lot is left* was "a finished-goods
 * question". This answers the first two. It deliberately still does not
 * answer the third — see the end.
 *
 * **Derived, not kept.** The tempting build was a second `material_moves`, a
 * signed ledger written on every shift, lorry and return. It would be a copy:
 * every one of those is already a record, each can be corrected by editing or
 * deleting it (`production.ts` says so of its own figures), and a mirror of
 * them would either drift or need a sync — the two-books failure this codebase
 * refuses everywhere. So on hand is
 *
 *     made − dispatched + returned + adjusted
 *
 * over the records that exist: `production_entries` (live output only —
 * `LIVE_OK`, so a scrapped lot is not stock), `despatch_items` (through the
 * order line's position to its product, the chain's index rule),
 * `credit_note_items` on an **approved return** (the goods came back), and
 * the one table this file adds. Three of the four are events somebody else
 * already records for their own reasons; nothing here asks the floor to type
 * a thing twice.
 *
 * **What is stored is an act, not an observation.** `fg_adjustments` holds an
 * opening balance and a stock count: somebody went to the shed and counted,
 * and the ledger disagreed. The same rule as the COA and the scrap decision —
 * derive what follows from the record, store what somebody decided. It is
 * also what makes the figure honest on day one: everything made before this
 * app was moulded outside its record, so *made − dispatched* reads negative
 * on any product shipped from old stock, and an opening adjustment is the
 * fix. A negative figure is **shown, not floored**: it is the ledger saying
 * the record is incomplete, which is the thing a stock count exists to hear.
 *
 * **Per product and per plant**, like raw material — Jungalpur and PACK SKRL
 * both despatch. Output sits at the *job's* plant, a lorry-load at the trip's,
 * a return at the plant the credit note names, a count at its own. A record
 * with no plant lands in a *plant not recorded* bucket rather than being
 * dropped or guessed: silence is not zero, and it is not Jungalpur either.
 *
 * **Not answered: how much of one lot is left.** The dispatch link is set
 * membership without a quantity, deliberately, and this file does not invent
 * one — a per-lot balance would need every trip to say how many of *which*
 * lot went, which is a per-lot picking record nobody keeps and the lorry does
 * not know. What a lot made and where it went are on the lot; what is on the
 * shelf is here, by product. The two are different questions.
 */

export interface FgRow {
  product_id: number;
  product_name: string;
  color: string;
  location_id: number | null;
  location_name: string | null;
  made: number;
  dispatched: number;
  returned: number;
  adjusted: number;
  on_hand: number;
}

export interface FgReport {
  rows: FgRow[];
  /**
   * Pieces that could not be put against a product: a custom order line with
   * none, or a return line naming none. Reported rather than dropped — a
   * figure this ledger cannot place is still a figure somebody shipped.
   */
  unplaced: { dispatched: number; returned: number };
}

/** Pieces on a credit note line: the packing count where stated, else the billed count on a piece basis. */
function piecesOf(it: { qty: number | null; unit: string; total_pcs: number | null }): number | null {
  if (it.total_pcs != null) return Number(it.total_pcs);
  const per = piecesPerBillingUnit(it.unit);
  if (per != null && it.qty != null) return Number(it.qty) * per;
  return null;
}

const key = (productId: number, locationId: number | null) => `${productId}|${locationId ?? 'x'}`;

export function finishedGoods(opts: { locationId?: number | null; productId?: number | null } = {}): FgReport {
  type Acc = { made: number; dispatched: number; returned: number; adjusted: number };
  const acc = new Map<string, Acc & { product_id: number; location_id: number | null }>();
  const at = (productId: number, locationId: number | null) => {
    const k = key(productId, locationId);
    if (!acc.has(k)) acc.set(k, { product_id: productId, location_id: locationId, made: 0, dispatched: 0, returned: 0, adjusted: 0 });
    return acc.get(k)!;
  };
  const unplaced = { dispatched: 0, returned: 0 };

  // Made: live output, at the job's plant.
  for (const r of db.prepare(
    `SELECT w.product_id, w.location_id, COALESCE(SUM(${LIVE_OK('e')}), 0) AS qty
       FROM production_entries e JOIN work_orders w ON w.id = e.work_order_id
      WHERE w.product_id IS NOT NULL
      GROUP BY w.product_id, w.location_id`
  ).all() as { product_id: number; location_id: number | null; qty: number }[]) {
    at(r.product_id, r.location_id).made += Number(r.qty);
  }

  // Dispatched: each trip line, through the order line at that position to
  // its product, at the plant the lorry left from.
  for (const r of db.prepare(
    `SELECT oi.product_id, d.location_id, COALESCE(SUM(di.qty), 0) AS qty
       FROM despatch_items di
       JOIN despatches d ON d.id = di.despatch_id
       LEFT JOIN (
         SELECT order_id, product_id, is_charge,
                ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY sort_order, id) - 1 AS pos
           FROM order_items
       ) oi ON oi.order_id = d.order_id AND oi.pos = di.order_line
      WHERE di.qty IS NOT NULL AND COALESCE(oi.is_charge, 0) = 0
      GROUP BY oi.product_id, d.location_id`
  ).all() as { product_id: number | null; location_id: number | null; qty: number }[]) {
    if (r.product_id == null) { unplaced.dispatched += Number(r.qty); continue; }
    at(r.product_id, r.location_id).dispatched += Number(r.qty);
  }

  // Returned: an approved return's lines, at the plant the note names —
  // unless the note names a scrapped lot of that product, in which case what
  // came back was condemned and is not on the shelf. Scrapping a dispatched
  // lot means exactly this (`production.ts`, CONDEMNED): the output and the
  // shipment stand, the returned goods do not.
  for (const r of db.prepare(
    `SELECT ci.product_id, ci.qty, ci.unit, ci.total_pcs, n.location_id,
            EXISTS (
              SELECT 1 FROM credit_note_batches cb
                JOIN batches b ON b.id = cb.batch_id
                JOIN work_orders w ON w.id = b.work_order_id
               WHERE cb.credit_note_id = n.id AND b.disposition = 'scrapped' AND w.product_id = ci.product_id
            ) AS condemned
       FROM credit_note_items ci JOIN credit_notes n ON n.id = ci.credit_note_id
      WHERE n.kind = 'return' AND n.approval_status = 'approved' AND ci.is_charge = 0`
  ).all() as { product_id: number | null; qty: number | null; unit: string; total_pcs: number | null; location_id: number | null; condemned: number }[]) {
    const pcs = piecesOf(r);
    if (pcs == null) continue;                       // a weight-billed line with no piece count says nothing
    if (r.product_id == null) { unplaced.returned += pcs; continue; }
    if (r.condemned) continue;                       // came back, and was scrapped: not stock
    at(r.product_id, r.location_id).returned += pcs;
  }

  // Counted: the one thing stored here.
  for (const r of db.prepare(
    'SELECT product_id, location_id, COALESCE(SUM(qty), 0) AS qty FROM fg_adjustments GROUP BY product_id, location_id'
  ).all() as { product_id: number; location_id: number | null; qty: number }[]) {
    at(r.product_id, r.location_id).adjusted += Number(r.qty);
  }

  const products = new Map((db.prepare('SELECT id, name, color FROM products').all() as { id: number; name: string; color: string }[])
    .map((p) => [p.id, p]));
  const locations = new Map((db.prepare('SELECT id, name FROM locations').all() as { id: number; name: string }[])
    .map((l) => [l.id, l.name]));

  const rows: FgRow[] = [...acc.values()]
    .filter((a) => (opts.locationId == null || a.location_id === opts.locationId)
      && (opts.productId == null || a.product_id === opts.productId))
    .map((a) => ({
      product_id: a.product_id,
      product_name: products.get(a.product_id)?.name ?? `Product #${a.product_id}`,
      color: products.get(a.product_id)?.color ?? '',
      location_id: a.location_id,
      location_name: a.location_id == null ? null : (locations.get(a.location_id) ?? null),
      made: round2(a.made),
      dispatched: round2(a.dispatched),
      returned: round2(a.returned),
      adjusted: round2(a.adjusted),
      on_hand: round2(a.made - a.dispatched + a.returned + a.adjusted),
    }))
    .sort((x, y) => x.product_name.localeCompare(y.product_name)
      || (x.location_name ?? '~').localeCompare(y.location_name ?? '~'));

  return { rows, unplaced: { dispatched: round2(unplaced.dispatched), returned: round2(unplaced.returned) } };
}

/**
 * On hand per product across every plant — what the order book reads.
 *
 * Asked once for the whole book rather than once per line (the N+1 this
 * codebase keeps bounding), and **per product, not per line**: the shelf is
 * one shelf, shared by every open line of that product, so the same figure
 * prints against each of them and the screen says so. Allocating it across
 * lines would be inventing a reservation nobody made.
 */
export function fgOnHandByProduct(): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of finishedGoods().rows) out.set(r.product_id, round2((out.get(r.product_id) ?? 0) + r.on_hand));
  return out;
}
