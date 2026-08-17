import { db } from '../db/connection.js';
import { invoiceReceivable } from './receivables.js';

/**
 * An invoice's status follows what has actually been received.
 *
 * `paid` used to be set by hand, independently of the payment record, so an
 * invoice could read Paid with money still outstanding, or sit at Dispatched
 * long after it had been settled. The receivables figures were right the whole
 * time; only the pill lied — and a pill is what people read at a glance.
 *
 * This is `services/orderStatus.ts` applied to money, and it borrows that
 * file's shape: run after anything that changes the facts, so the status the
 * list shows is the status stored, rather than something recomputed on read.
 *
 * It differs from order status in one important way, and the difference is the
 * whole design. Order status is **forward-only**, because the floor's facts
 * only ever accumulate: nothing can un-despatch a lorry. Payments are not like
 * that — a mis-keyed one gets deleted, an invoice's total gets corrected
 * upward — so this has to be able to move **back out** of `paid` as well. An
 * invoice still marked Paid after its payment was deleted is exactly the lie
 * this exists to remove, and it would be a worse one for looking automatic.
 *
 * Moving back needs to know where to go, which is why the row remembers
 * `status_before_paid`. Guessing was tried on paper and rejected: reverting
 * everything to `dispatched` would claim a shipment for an invoice settled by
 * advance before anything left the plant, and reverting everything to `final`
 * would quietly discard a despatch someone had recorded.
 *
 * Two invariants:
 *
 * - **The approval gate is never bypassed.** `paid` is an outgoing status, and
 *   `services/approval.ts` owns the rule that only an approved document may
 *   reach one. So this only ever promotes an invoice that is already approved
 *   *and* already outgoing; a draft that happens to be covered by an advance
 *   stays a draft, and no automatic path exists from unapproved to sent.
 * - **Only currency-matched money counts**, because `invoiceReceivable` is the
 *   single source of truth for credit and already excludes payments in another
 *   currency. Asking a second question here would let this disagree with both
 *   the invoice page and the dashboard.
 */

/** Statuses an invoice may be promoted *from* — it has already gone out. */
const OUTGOING = ['final', 'dispatched'];

/**
 * Bring one invoice's status into line with its payments.
 * Returns the status now on the row, or null when the invoice is gone.
 */
export function syncInvoiceStatus(invoiceId: number): string | null {
  const inv = db.prepare(
    'SELECT id, status, status_before_paid, approval_status, grand_total FROM commercial_invoices WHERE id = ?'
  ).get(invoiceId) as
    | { id: number; status: string; status_before_paid: string; approval_status: string; grand_total: number }
    | undefined;
  if (!inv) return null;

  // A nil invoice is not "paid"; it is unfinished. Reading zero as settled
  // would mark every empty draft as complete the moment it was approved.
  const settled = inv.grand_total > 0 && invoiceReceivable(invoiceId).balance_due <= 0;

  if (settled && inv.status !== 'paid') {
    // Not approved, or not yet sent: leave it alone. Promoting here would put
    // a document at an outgoing status that approval.ts would have refused.
    if (inv.approval_status !== 'approved' || !OUTGOING.includes(inv.status)) return inv.status;
    db.prepare("UPDATE commercial_invoices SET status = 'paid', status_before_paid = ? WHERE id = ?")
      .run(inv.status, invoiceId);
    return 'paid';
  }

  if (!settled && inv.status === 'paid') {
    // Back to whatever it was. An invoice marked paid by hand before this
    // existed has nothing remembered, and `final` is then the most that can be
    // said truthfully — it went out, but no despatch was ever recorded here.
    const back = OUTGOING.includes(inv.status_before_paid) ? inv.status_before_paid : 'final';
    db.prepare("UPDATE commercial_invoices SET status = ?, status_before_paid = '' WHERE id = ?")
      .run(back, invoiceId);
    return back;
  }

  return inv.status;
}

/**
 * Every invoice a payment could have moved, given what it was recorded against.
 *
 * A payment on an invoice touches that invoice. A payment on a **proforma** is
 * an advance, and `receivables.ts` spreads it across every invoice raised from
 * that proforma — so adding or deleting one can change the balance of several
 * at once, including ones the payment never named.
 */
export function syncInvoicesForPayment(payment: { invoice_id?: number | null; pi_id?: number | null }): void {
  if (payment.invoice_id) {
    syncInvoiceStatus(Number(payment.invoice_id));
    return;
  }
  if (!payment.pi_id) return;
  syncInvoicesForProforma(Number(payment.pi_id));
}

/** Every invoice raised from one proforma — they share its advance pool. */
export function syncInvoicesForProforma(piId: number): void {
  const rows = db.prepare('SELECT id FROM commercial_invoices WHERE pi_id = ?').all(piId) as { id: number }[];
  for (const r of rows) syncInvoiceStatus(r.id);
}
