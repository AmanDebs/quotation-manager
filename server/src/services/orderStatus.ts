import { db } from '../db/connection.js';
import { productionByOrder } from './production.js';

/**
 * What the facts say an order's status is.
 *
 * Order status has been manual since the order book was built, which meant
 * `partially_dispatched` and `completed` never set themselves however much had
 * actually shipped. Now that production, despatch and invoicing are all
 * recorded, the status can follow them.
 *
 * Two rules keep this safe:
 *
 * - **It only ever moves forward.** A manager who sets `ready` early is not
 *   dragged back to `in_production` by the absence of a work order. The facts
 *   can only ever say "at least this far".
 * - **`cancelled` is never touched, in or out.** It is a decision, not an
 *   observation, and nothing on the floor should be able to un-cancel an order
 *   or cancel one.
 *
 * The consequence worth knowing: if someone deliberately sets a status *below*
 * what the facts imply, the next production entry or despatch will advance it
 * again. That is intended — the alternative is a status that quietly contradicts
 * the shipping record.
 *
 * **`completed` is the one status that also moves back**, and it is worth being
 * clear why it is special. Everything below it is an observation that only
 * accumulates: a shift booked cannot be un-booked, a lorry cannot un-leave. But
 * an order is complete only while every line stays fully billed, and an invoice
 * can be deleted or an ordered quantity raised. Leaving a re-opened order shut
 * would hide work still to do, on the one status people use to stop looking.
 *
 * Which leaves the question the original design was right to worry about:
 * closing an order is often a commercial decision, taken when a short shipment
 * is accepted rather than when the last piece ships. That is why `orders`
 * remembers `status_before_completed`. It is filled only when *this* code
 * closes an order, so only an order closed by the shipping record is ever
 * re-opened by it. An order a human closed has nothing remembered, and stays
 * closed no matter what the invoices later say.
 */

/** Forward order of the ladder. `cancelled` is deliberately absent. */
const LADDER = [
  'pending', 'confirmed', 'scheduled', 'in_production',
  'ready', 'partially_dispatched', 'completed',
] as const;

export type OrderStatus = typeof LADDER[number] | 'cancelled';

const rank = (s: string) => {
  const i = LADDER.indexOf(s as never);
  return i === -1 ? 0 : i;
};

export interface StatusFacts {
  implied: OrderStatus | null;
  reason: string;
}

/**
 * The furthest stage the recorded facts support, or null when they support
 * nothing beyond what a human would have set anyway.
 */
export function impliedStatus(orderId: number): StatusFacts {
  const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId) as
    { status: string } | undefined;
  if (!order || order.status === 'cancelled') return { implied: null, reason: '' };

  const items = db.prepare('SELECT total_pcs, qty, is_charge FROM order_items WHERE order_id = ? ORDER BY sort_order, id')
    .all(orderId) as { total_pcs: number | null; qty: number | null; is_charge: number }[];

  // Invoiced value first: it is the strongest claim, and the existing
  // dispatchProgress walk already owns "how much has been billed".
  const invoiced = db.prepare(
    `SELECT COUNT(*) AS c FROM commercial_invoices
     WHERE order_id = ? OR pi_id IN (SELECT id FROM proforma_invoices WHERE order_id = ?)`
  ).get(orderId, orderId) as { c: number };

  const despatched = db.prepare('SELECT COUNT(*) AS c FROM despatches WHERE order_id = ?')
    .get(orderId) as { c: number };

  const production = productionByOrder(orderId);
  const goods = items.map((it, i) => ({ ...it, line: i })).filter((it) => !it.is_charge);
  const anyProduction = [...production.values()].some((p) => p.produced > 0);
  const anyJob = production.size > 0;

  // Everything ordered has been made — only answerable when every goods line
  // states a quantity. A price-only line cannot be "complete".
  const allMade = goods.length > 0
    && goods.every((it) => {
      const target = it.total_pcs ?? it.qty;
      if (!target) return false;
      return (production.get(it.line)?.produced ?? 0) >= target;
    });

  let implied: OrderStatus = 'pending';
  let reason = '';
  if (anyJob) { implied = 'scheduled'; reason = 'a work order exists'; }
  if (anyProduction) { implied = 'in_production'; reason = 'production has been booked'; }
  if (allMade) { implied = 'ready'; reason = 'every line has been made in full'; }
  if (despatched.c > 0 || invoiced.c > 0) {
    implied = 'partially_dispatched';
    reason = despatched.c > 0 ? 'goods have been despatched' : 'an invoice has been raised';
  }
  if (fullyBilled(orderId)) {
    implied = 'completed';
    reason = 'every line has been billed in full';
  }

  return rank(implied) > rank(order.status) ? { implied, reason } : { implied: null, reason: '' };
}

/**
 * Has every goods line been billed in full?
 *
 * The invoice walk, not the despatch record: `dispatchProgress()` has always
 * been the money truth for an order, and the two are shown side by side rather
 * than reconciled precisely because a lorry can leave before the paperwork.
 * Closing on the paperwork is the conservative direction — an order stays open
 * until it has actually been billed.
 *
 * Reproduces that walk here rather than importing it, because `routes/orders.ts`
 * imports this file and the cycle would be worse than eight lines of SQL. The
 * check that keeps them honest is in the test: `fully_dispatched` from
 * `GET /orders/:id` agrees with this on every order.
 *
 * **Charge lines are excluded** (`is_charge`), as everywhere else — freight is
 * not a thing that ships, and an order whose only outstanding line is a freight
 * charge is finished. A line with no quantity cannot be complete either: a
 * price-only line has no target to reach.
 */
function fullyBilled(orderId: number): boolean {
  const items = db.prepare(
    'SELECT qty, is_charge FROM order_items WHERE order_id = ? ORDER BY sort_order, id'
  ).all(orderId) as { qty: number | null; is_charge: number }[];
  const goods = items.map((it, i) => ({ ...it, line: i })).filter((it) => !it.is_charge);
  if (!goods.length || goods.some((it) => !it.qty || it.qty <= 0)) return false;

  const invoices = db.prepare(
    `SELECT id FROM commercial_invoices
     WHERE order_id = ? OR pi_id IN (SELECT id FROM proforma_invoices WHERE order_id = ?)`
  ).all(orderId, orderId) as { id: number }[];
  if (!invoices.length) return false;

  const billed = items.map(() => 0);
  for (const inv of invoices) {
    const rows = db.prepare('SELECT qty FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id')
      .all(inv.id) as { qty: number | null }[];
    // Matched by position, the same index rule syncPackingList() and
    // dispatchProgress() use.
    rows.forEach((r, i) => { if (i < billed.length && r.qty != null) billed[i] += r.qty; });
  }
  return goods.every((it) => billed[it.line] + 1e-9 >= (it.qty ?? 0));
}

/**
 * Advance the order if the facts have moved past its recorded status.
 * Returns the status now on the row.
 *
 * Called after anything that changes the facts — a production entry, a
 * despatch, an invoice — rather than on read, so the status the list shows is
 * the status stored.
 */
export function syncOrderStatus(orderId: number): string | null {
  const row = db.prepare('SELECT status, status_before_completed FROM orders WHERE id = ?').get(orderId) as
    | { status: string; status_before_completed: string } | undefined;
  if (!row) return null;
  if (row.status === 'cancelled') return row.status;

  // Re-opening: the order was closed by the shipping record, and the shipping
  // record no longer says so — an invoice was deleted, or a quantity raised.
  // Only ever undone if this code closed it; `status_before_completed` is empty
  // when a human did, and a deliberate close stays closed.
  if (row.status === 'completed' && !fullyBilled(orderId)) {
    if (!row.status_before_completed) return row.status;
    const back = row.status_before_completed;
    db.prepare("UPDATE orders SET status = ?, status_before_completed = '' WHERE id = ?").run(back, orderId);
    return back;
  }

  const { implied } = impliedStatus(orderId);
  if (!implied) return row.status;
  // Remember what to re-open to, but only when closing the order automatically.
  const before = implied === 'completed' ? row.status : row.status_before_completed;
  db.prepare('UPDATE orders SET status = ?, status_before_completed = ? WHERE id = ?')
    .run(implied, before, orderId);
  return implied;
}
