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

  // `completed` is left to a human. "Fully dispatched" by the invoice walk is a
  // billing statement, and closing an order is a commercial decision that often
  // waits on payment or a short-shipment being accepted.
  return rank(implied) > rank(order.status) ? { implied, reason } : { implied: null, reason: '' };
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
  const { implied } = impliedStatus(orderId);
  if (!implied) {
    const row = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId) as { status: string } | undefined;
    return row?.status ?? null;
  }
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(implied, orderId);
  return implied;
}
