import { db } from '../db/connection.js';
import { round2 } from './totals.js';
import type { AuthedRequest } from '../middleware/auth.js';

/**
 * The sales desk releasing finished goods to Logistics.
 *
 * Asked for 2026-10-08, the hour after the Ready to dispatch queue shipped:
 * *"When a product is ready, it should be first be approved by the SPOC of
 * that order, if he approves then it should go to ready to dispatch tab so
 * that logistic person can record dispatch."*
 *
 * **This is the one stored fact in that queue, and it is stored because it is
 * an act.** Everything else `dispatchReady.ts` reports is derived from the
 * production, dispatch and QC records, so it corrects itself when one of them
 * is corrected; somebody signing goods off is not an observation, and it sits
 * on the line `batches.coa_no`, the scrap decision and `fg_adjustments` share.
 *
 * **A quantity, not a flag.** A flag would release everything made afterwards
 * too, which is exactly what the client's *"when a product is made … first be
 * approved"* rules out — so `approved_qty` is cumulative pieces cleared, and
 * making more leaves the excess awaiting the desk again while what was already
 * released stays released.
 */

/** What the desk has cleared on one line, and who cleared it. */
export interface LineApproval {
  qty: number;
  by: number | null;
  by_name: string;
  at: string;
  note: string;
}

const key = (orderId: number, line: number) => `${orderId}:${line}`;

/**
 * Every approval on these orders, keyed `order:line`.
 *
 * Asked once for the whole queue rather than once per line — the N+1 this
 * codebase keeps bounding.
 */
export function approvalsForOrders(orderIds: number[]): Map<string, LineApproval> {
  const out = new Map<string, LineApproval>();
  if (!orderIds.length) return out;
  const rows = db.prepare(
    `SELECT a.order_id, a.order_line, a.approved_qty, a.approved_by, a.approved_at, a.note,
            u.name AS approved_by_name
     FROM dispatch_approvals a
     LEFT JOIN users u ON u.id = a.approved_by
     WHERE a.order_id IN (${orderIds.map(() => '?').join(',')})`
  ).all(...orderIds) as {
    order_id: number; order_line: number; approved_qty: number;
    approved_by: number | null; approved_at: string; note: string;
    approved_by_name: string | null;
  }[];
  for (const r of rows) {
    out.set(key(r.order_id, r.order_line), {
      qty: round2(Number(r.approved_qty) || 0),
      by: r.approved_by,
      // Stored beside the id for the reason `audit_log.user_name` is: an
      // account can be deleted, and *"somebody who no longer works here
      // released this"* is a sentence the record should still be able to say.
      by_name: r.approved_by_name ?? '',
      at: r.approved_at,
      note: r.note,
    });
  }
  return out;
}

/**
 * Whether this caller may release *this* order, by its SPOC.
 *
 * The client asked for the **SPOC of that order**, and nothing in the app
 * linked the two: `orders.spoc` is one of six free-text desk names picked from
 * `DESK_NAMES`, while a login is an account with a full name — and this file
 * already records that the SPOC column replaced *Added By* precisely because
 * *"whoever typed it in is rarely that person."* So `users.desk_name` is the
 * link, and the rule over it has three readings, in this order:
 *
 * - **A super admin always may.** The rail this codebase doubles everywhere:
 *   the account that may do everything is what guarantees a stuck approval can
 *   always be cleared.
 * - **An account with a desk name may release its own orders only** — which is
 *   the client's sentence, enforced.
 * - **An account with no desk name may release any order it can see.** Blank
 *   is every row on file the day this ships, so nobody is blocked and the
 *   desk's existing work does not stop; filling the field in on the Team page
 *   is what makes the rule strict, one person at a time.
 *
 * An order naming **no** SPOC is nobody's in particular and is left to the
 * function gate — refusing it would strand every order imported from the
 * backlog, 615 of whose 616 rows carry no payment terms and many no SPOC
 * either. The field is mandatory on an order raised in the app since
 * 2026-10-07, so this covers history rather than new work.
 */
export function deskApprovalError(req: AuthedRequest, spoc: string): string | null {
  const user = req.user;
  if (!user) return 'Not signed in.';
  if (user.team_role === 'super_admin') return null;
  const mine = String(user.desk_name ?? '').trim();
  if (!mine) return null;
  const theirs = String(spoc ?? '').trim();
  if (!theirs) return null;
  if (theirs.toLowerCase() === mine.toLowerCase()) return null;
  return `This sales order is handled by ${theirs}, so ${theirs} releases it for dispatch.`;
}

/**
 * Record a release, or withdraw one.
 *
 * `qty` is the cumulative pieces cleared on that line, so this replaces rather
 * than adds — the caller has just read what is made and is saying how much of
 * it may go. **Zero deletes the row**, which is what makes a mistaken approval
 * withdrawable: an approval has no artefact out in the world, unlike an issued
 * COA, and one that could not be taken back would be the trap-with-no-way-out
 * this codebase has built exactly once.
 *
 * Goods already dispatched need no special case. The queue's arithmetic floors
 * at what was sent, so withdrawing cannot un-ship anything — it only stops
 * more going.
 */
export function setApproval(
  orderId: number,
  line: number,
  qty: number,
  userId: number | null,
  note = '',
): void {
  const q = round2(Math.max(0, Number(qty) || 0));
  if (q <= 0) {
    db.prepare('DELETE FROM dispatch_approvals WHERE order_id = ? AND order_line = ?')
      .run(orderId, line);
    return;
  }
  db.prepare(
    `INSERT INTO dispatch_approvals (order_id, order_line, approved_qty, approved_by, approved_at, note)
     VALUES (?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT (order_id, order_line) DO UPDATE SET
       approved_qty = excluded.approved_qty,
       approved_by = excluded.approved_by,
       approved_at = excluded.approved_at,
       note = excluded.note`
  ).run(orderId, line, q, userId, note);
}
