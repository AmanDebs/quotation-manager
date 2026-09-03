import { db } from '../db/connection.js';

/**
 * The chain runs one way: quotation → proforma → order → commercial invoice.
 *
 * Two things live here, and they are two halves of one rule. Converting a
 * document **moves its status by itself**, and a document that has been
 * converted **can no longer be edited** — otherwise the figures a downstream
 * document was built from could be changed underneath it.
 *
 * **Nothing is stored.** There is no `locked` column: a quotation is locked
 * because a proforma names it, and a proforma is locked because it carries an
 * order id. Delete the downstream document and the lock lifts by itself, the
 * same way dispatch progress, balances and order status are all derived rather
 * than written down. That is also the only way to unlock — deliberately, since
 * an override would be a second route to changing a document somebody has
 * already acted on.
 */

/* ------------------------------------------------------------------ */
/* Status follows the conversion                                       */
/* ------------------------------------------------------------------ */

/**
 * A quotation answered by a proforma has been accepted.
 *
 * Forward-only and guarded by the current status, the shape `syncEnquiryStatus`
 * uses. **`rejected` is never touched**: losing a quotation is a decision
 * somebody made, the same reason `orderStatus.ts` refuses to move `cancelled`.
 * `accepted` is left alone because it is already there.
 *
 * `status_before_expired` is cleared with it. That column exists so a lapsed
 * quotation can be put back where it was; once the offer has been converted
 * there is nothing to go back to, and leaving it set would point at a status
 * this quotation can no longer reach.
 */
export function syncQuotationConverted(quotationId: number | null | undefined): void {
  if (!quotationId) return;
  db.prepare(
    `UPDATE quotations SET status = 'accepted', status_before_expired = ''
     WHERE id = ? AND status IN ('draft', 'sent', 'negotiating', 'expired')`
  ).run(quotationId);
}

/**
 * A proforma with an order booked against it is confirmed.
 *
 * Only from `draft` or `sent`. `advance_received` and `in_production` sit
 * *after* `order_confirmed` in the pipeline, so moving there would drag the
 * document backwards — the trap `orderStatus.ts` documents. `cancelled` is a
 * decision and is never touched.
 */
export function syncProformaOrdered(piId: number | null | undefined): void {
  if (!piId) return;
  db.prepare(
    `UPDATE proforma_invoices SET status = 'order_confirmed'
     WHERE id = ? AND status IN ('draft', 'sent')`
  ).run(piId);
}

/* ------------------------------------------------------------------ */
/* What a conversion locks                                             */
/* ------------------------------------------------------------------ */

export interface LockedBy {
  /** What to call the document that did the locking, e.g. "proforma invoice". */
  kind: string;
  id: number;
  number: string;
}

/** The proforma raised from this quotation, if there is one. */
export function quotationLockedBy(quotationId: number): LockedBy | null {
  const row = db
    .prepare('SELECT id, number FROM proforma_invoices WHERE quotation_id = ? ORDER BY id LIMIT 1')
    .get(quotationId) as { id: number; number: string } | undefined;
  return row ? { kind: 'proforma invoice', id: row.id, number: row.number } : null;
}

/**
 * The order booked from this proforma, if there is one.
 *
 * Read off the proforma's own `order_id` rather than by searching orders: an
 * order has no `pi_id`, so this column *is* the link — the one
 * `dispatchProgress()` walks.
 */
export function proformaLockedBy(piId: number): LockedBy | null {
  const row = db
    .prepare(
      `SELECT o.id, o.number FROM proforma_invoices p
       JOIN orders o ON o.id = p.order_id
       WHERE p.id = ?`
    )
    .get(piId) as { id: number; number: string } | undefined;
  return row ? { kind: 'order', id: row.id, number: row.number } : null;
}

/**
 * Refuse a change to a document that has already been converted.
 *
 * Returns a message naming what locked it and how to undo that, or null when
 * the change is allowed. Callers answer **409**, not 403: it is a conflict
 * with what already exists downstream, the same code `exportChangeError` uses.
 *
 * This guards the document's *content* — its header, its line items, its
 * status, a revision, an approval decision. It deliberately does **not** guard
 * the things that carry on happening after conversion: a payment is banked
 * against the proforma after the order is booked, which is the normal case and
 * the whole point of an advance; internal notes are the team's own record and
 * have their own endpoint for exactly this reason; and duplicating, following
 * up or printing change nothing.
 */
export function lockError(
  table: 'quotations' | 'proforma_invoices',
  id: number,
  action = 'edited'
): string | null {
  const by = table === 'quotations' ? quotationLockedBy(id) : proformaLockedBy(id);
  if (!by) return null;
  const self = table === 'quotations' ? 'quotation' : 'proforma';
  return `This ${self} was converted into ${by.kind} ${by.number}, so it cannot be ${action}. `
    + `Delete that ${by.kind} first if it really has to change.`;
}
