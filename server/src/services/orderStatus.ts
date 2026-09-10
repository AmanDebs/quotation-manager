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
 * **A person's status is a floor; the facts own everything above it.**
 *
 * That is one rule where there used to be two, and the second one was wrong.
 * The ladder was forward-only, on the reasoning that "a shift booked cannot be
 * un-booked, a lorry cannot un-leave" — true of the world, and false of the
 * record. A despatch, a work order and a production entry can all be deleted,
 * which is exactly how a mis-keyed one is corrected (`services/production.ts`
 * says so about its own figures: "deleting a mis-keyed shift corrects the
 * figure by construction"). Forward-only meant the status remembered a fact
 * the register no longer contained: delete the only despatch on an order and
 * it sat at *Partially dispatched* over an empty register, which is precisely
 * the status-contradicting-the-shipping-record this file exists to prevent.
 *
 * `completed` had already met this and been given `status_before_completed` —
 * a special case for one rung, when the same hole ran the length of the
 * ladder. `status_before_auto` replaces it and generalises it: it holds the
 * status that was in place **before this code first raised the order above
 * it**, and is empty whenever the current status is a person's own. So:
 *
 * - **A status a person set is never lowered**, which is the useful half of
 *   forward-only. Set `ready` early and no absence of a work order drags it
 *   back; it stays the floor even after a despatch raises the order above it
 *   and that despatch is then deleted.
 * - **A status this code set is exactly what the facts imply**, up or down,
 *   never below the floor.
 * - **`cancelled` is never touched, in or out.** It is a decision, not an
 *   observation, and nothing on the floor may un-cancel an order or cancel one.
 *
 * Two consequences worth knowing. Setting a status *below* what the facts
 * imply still gets advanced by the next entry — intended, and unchanged.
 * And an order a person closed by hand stays closed however the invoices later
 * add up, because setting the status by hand clears the memory: that is the
 * commercial decision the original design was right to protect, taken when a
 * short shipment is accepted rather than when the last piece ships.
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
 * The furthest stage the recorded facts support — **raw**, without comparing
 * it to what the order currently says.
 *
 * It used to answer null unless the facts were *ahead* of the stored status,
 * which folded the "never move back" rule into the measurement. Keeping the
 * measurement and the policy apart is what lets the status come down when a
 * record is withdrawn: `syncOrderStatus` decides how far down, against the
 * floor a person set.
 *
 * Null only for an order that does not exist or is cancelled.
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

  /*
   * A job that is actually going to run, which is what separates the two rungs
   * between Pending and In production.
   *
   * Either explicit act counts: a job **released** to the floor, or one given
   * a **start date**. Both say somebody has committed it to a slot, and which
   * of the two a desk uses varies — the dates are often left blank here, and
   * releasing three jobs at once is a normal order-level act.
   *
   * A job merely *raised* is not this. It sits at `planned` with no dates, and
   * the rung for that is `confirmed`.
   */
  const anyScheduled = (db.prepare(
    `SELECT COUNT(*) AS c FROM work_orders
      WHERE order_id = ? AND status <> 'cancelled'
        AND (status <> 'planned' OR planned_start <> '')`
  ).get(orderId) as { c: number }).c > 0;

  // Everything ordered has been made — only answerable when every goods line
  // states a quantity. A price-only line cannot be "complete".
  const allMade = goods.length > 0
    && goods.every((it) => {
      const target = it.total_pcs ?? it.qty;
      if (!target) return false;
      return (production.get(it.line)?.produced ?? 0) >= target;
    });

  /*
   * **`confirmed` is the rung a raised job reaches, and it used to be skipped.**
   *
   * The client's word (2026-09-07) is that `confirmed` reads *Work Order*
   * because what the desk means by that step is that the job has been raised —
   * not merely that the buyer said yes, which is the proforma's
   * `order_confirmed` one document upstream. The ladder disagreed with its own
   * label: raising a job jumped straight to `scheduled`, so the rung named
   * after the act was the only one of the seven nothing could ever reach, and
   * an order the floor had jobs for read *Scheduled* before anything was.
   *
   * Fixing it by moving the label instead was the other option and is the
   * worse one: it would have overruled what the client said `confirmed` means
   * to them, in order to match code that was wrong. So the ladder moved, and
   * `scheduled` gained the derivation it never had — otherwise the hole is not
   * closed, only slid one rung along.
   */
  let implied: OrderStatus = 'pending';
  let reason = '';
  if (anyJob) { implied = 'confirmed'; reason = 'a work order has been raised'; }
  if (anyScheduled) { implied = 'scheduled'; reason = 'a work order has been released or dated'; }
  if (anyProduction) { implied = 'in_production'; reason = 'production has been booked'; }
  if (allMade) { implied = 'ready'; reason = 'every line has been made in full'; }
  if (despatched.c > 0 || invoiced.c > 0) {
    implied = 'partially_dispatched';
    reason = despatched.c > 0 ? 'goods have been dispatched' : 'an invoice has been raised';
  }
  if (fullyBilled(orderId)) {
    implied = 'completed';
    reason = 'every line has been billed in full';
  }

  return { implied, reason };
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
 * Put the order where the facts and the floor say it belongs.
 *
 * Called after anything that changes the facts — a work order raised or
 * deleted, a production entry booked or removed, a despatch, an invoice —
 * rather than on read, so the status the list shows is the status stored.
 *
 * The whole rule is three lines: the floor is whatever a person last chose,
 * the facts say how far the order has actually got, and the order sits at
 * whichever is higher. `status_before_auto` is written only while the second
 * is winning, and cleared the moment the order comes back down to the floor —
 * so "is this status ours or theirs?" is answerable from the row itself,
 * without a flag that could disagree with it.
 */
export function syncOrderStatus(orderId: number): string | null {
  const row = db.prepare('SELECT status, status_before_auto FROM orders WHERE id = ?').get(orderId) as
    | { status: string; status_before_auto: string } | undefined;
  if (!row) return null;
  // A decision, not an observation. Nothing here may un-cancel an order.
  if (row.status === 'cancelled') return row.status;

  // What a person last chose. While this code is holding the order above it
  // the floor is remembered; otherwise the status on the row *is* the floor.
  const floor = row.status_before_auto || row.status;
  const { implied } = impliedStatus(orderId);
  const next: string = implied && rank(implied) > rank(floor) ? implied : floor;
  const memory = next === floor ? '' : floor;
  if (next === row.status && memory === row.status_before_auto) return row.status;

  db.prepare('UPDATE orders SET status = ?, status_before_auto = ? WHERE id = ?')
    .run(next, memory, orderId);
  return next;
}
