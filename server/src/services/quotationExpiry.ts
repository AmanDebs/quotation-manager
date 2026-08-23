import { db } from '../db/connection.js';

/**
 * A quotation lapses when its validity date passes.
 *
 * `expired` was a legal status from the beginning and nothing ever set it, so
 * a price offered in April still read "Sent" in September and the list gave no
 * hint which quotes were still live. This is `services/invoiceStatus.ts`
 * applied to the calendar, and it borrows that file's shape: run after
 * anything that changes the facts, so the pill the list shows is the pill
 * stored rather than something recomputed on read.
 *
 * **Only a live offer can lapse.** `sent` and `negotiating` are the two
 * statuses that mean a price is standing in front of a customer, and they are
 * the two the dashboard has always counted for this. A `draft` was never
 * offered, so it cannot expire — marking somebody's unfinished work "expired"
 * would be wrong and would read as a fault. `accepted` and `rejected` are
 * decisions somebody made and are never touched, the rule `orderStatus.ts`
 * follows for `cancelled` and `syncEnquiryStatus` follows for `lost`.
 *
 * **It moves back, and the reason is the same as `completed` on an order.**
 * Everything below expiry is an observation that only accumulates, but the
 * validity date is editable: extending it is precisely how a business revives
 * a lapsed quote, and if the status stayed `expired` the extension would do
 * nothing visible. So the row remembers `status_before_expired`, filled
 * **only when this code expires it** — a quotation somebody marked expired by
 * hand has nothing remembered and stays expired whatever the date later says.
 *
 * Two invariants, both borrowed:
 *
 * - **The approval gate is never bypassed.** `sent` and `negotiating` are
 *   outgoing statuses under `services/approval.ts`, and editing an approved
 *   document resets its approval. So a quotation whose validity was extended
 *   *and* whose approval was reset in the same edit comes back as a `draft`,
 *   not as `sent`: without that check this would be an automatic path from
 *   unapproved to outgoing, which is the one thing the gate exists to prevent.
 * - **A superseded revision is left alone.** It is read-only and hidden from
 *   the lists; expiring it would add noise to a row nobody can act on.
 */

/** The statuses that mean a price is standing in front of a customer. */
const LIVE = ['sent', 'negotiating'];

const todayLocal = () => {
  // Local parts, not toISOString(): a date built in UTC rolls back a day
  // anywhere east of Greenwich, which would expire a quotation on the morning
  // its validity still had hours to run.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

interface Row {
  id: number;
  status: string;
  status_before_expired: string;
  approval_status: string;
  validity_date: string;
  superseded_by: number | null;
}

const load = (id: number) =>
  db.prepare(
    `SELECT id, status, status_before_expired, approval_status, validity_date, superseded_by
     FROM quotations WHERE id = ?`
  ).get(id) as Row | undefined;

/**
 * Bring one quotation's status into line with its validity date.
 * Returns the status now on the row, or null when the quotation is gone.
 */
export function syncQuotationExpiry(quotationId: number, today = todayLocal()): string | null {
  const q = load(quotationId);
  if (!q) return null;
  if (q.superseded_by !== null) return q.status;

  // No validity date means the offer does not lapse. Aglo raises plenty
  // without one, and reading "no date" as "expired" would condemn the lot.
  const lapsed = q.validity_date !== '' && q.validity_date < today;

  if (lapsed && LIVE.includes(q.status)) {
    db.prepare("UPDATE quotations SET status = 'expired', status_before_expired = ? WHERE id = ?")
      .run(q.status, quotationId);
    return 'expired';
  }

  if (!lapsed && q.status === 'expired' && LIVE.includes(q.status_before_expired)) {
    // Only an automatic expiry is automatically undone — see the note above.
    // And only back to an outgoing status if the document may still be at one.
    const back = q.approval_status === 'approved' ? q.status_before_expired : 'draft';
    db.prepare("UPDATE quotations SET status = ?, status_before_expired = '' WHERE id = ?")
      .run(back, quotationId);
    return back;
  }

  return q.status;
}

/**
 * Sweep the whole book. Two statements rather than a row-by-row loop, since
 * this runs over every quotation the business has ever raised.
 */
export function sweepQuotationExpiry(today = todayLocal()): { expired: number; revived: number } {
  const expired = db.prepare(
    `UPDATE quotations SET status = 'expired', status_before_expired = status
      WHERE superseded_by IS NULL
        AND status IN (${LIVE.map(() => '?').join(', ')})
        AND validity_date <> '' AND validity_date < ?`
  ).run(...LIVE, today);

  const revived = db.prepare(
    `UPDATE quotations
        SET status = CASE WHEN approval_status = 'approved' THEN status_before_expired ELSE 'draft' END,
            status_before_expired = ''
      WHERE superseded_by IS NULL
        AND status = 'expired'
        AND status_before_expired IN (${LIVE.map(() => '?').join(', ')})
        AND (validity_date = '' OR validity_date >= ?)`
  ).run(...LIVE, today);

  return { expired: Number(expired.changes), revived: Number(revived.changes) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sweep on boot and once a day after.
 *
 * On boot because the app may have been down over the date that mattered, and
 * daily because it may stay up for weeks. The same shape as
 * `startBackupSchedule`, including the unref: a timer must never be the reason
 * the process will not exit.
 */
export function startExpirySchedule() {
  const run = () => {
    try {
      const { expired, revived } = sweepQuotationExpiry();
      if (expired || revived) {
        console.log(`Quotation validity: ${expired} expired, ${revived} revived`);
      }
    } catch (err) {
      // A failed sweep must not take the server down with it: the figures are
      // still right, only the pill is stale.
      console.error('Quotation expiry sweep failed', err);
    }
  };
  run();
  const timer = setInterval(run, DAY_MS);
  timer.unref?.();
}
