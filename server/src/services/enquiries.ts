import { db } from '../db/connection.js';
import { canAccessCustomer } from '../middleware/scope.js';
import type { AuthedRequest } from '../middleware/auth.js';

/**
 * The front of the funnel: somebody asked before there was anything to quote.
 *
 * Two rules live here, both borrowed from parts of the app that learned them
 * the hard way.
 */

/**
 * Resolve `body.enquiry_id` into something safe to store on a quotation.
 *
 * Returns the id, `null` when there is none, or `undefined` when the caller
 * should be answered 404. The enquiry must be **in scope and belong to the
 * same customer** — the rule `linkError()` enforces for every other document
 * link. Pointing a quotation at another owner's enquiry would surface that
 * enquiry through this quotation's own responses, and the carry-forward chain
 * runs through one customer anyway.
 */
export function enquiryLinkId(
  req: AuthedRequest, raw: unknown, customerId: number
): number | null | undefined {
  if (raw === undefined || raw === null || raw === '') return null;
  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) return null;
  const row = db.prepare('SELECT customer_id FROM enquiries WHERE id = ?').get(id) as
    { customer_id: number } | undefined;
  if (!row || !canAccessCustomer(req, row.customer_id)) return undefined;
  // Answering 404 rather than 403 for a mismatch too, so an id cannot be
  // probed for by watching which error comes back.
  if (row.customer_id !== customerId) return undefined;
  return id;
}

/**
 * Move an enquiry to `quoted` once a quotation answers it.
 *
 * **Forward only, and `lost` is never touched** — the same two rules
 * `orderStatus.ts` follows. An enquiry the customer walked away from is a
 * decision somebody made, and raising a quotation against it later does not
 * un-lose it; `open` is the only status this promotes out of. Nothing moves
 * back either: deleting the quotation leaves the enquiry quoted, because it
 * genuinely was.
 */
export function syncEnquiryStatus(enquiryId: number | null | undefined): void {
  if (!enquiryId) return;
  db.prepare("UPDATE enquiries SET status = 'quoted' WHERE id = ? AND status = 'open'").run(enquiryId);
}
