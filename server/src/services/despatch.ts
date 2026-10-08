import { db } from '../db/connection.js';
import { round2 } from './totals.js';

/**
 * What makes a trip a *shipment* rather than a lorry.
 *
 * The documents question only arises on a sea leg: a container cannot be
 * cleared without them, while a lorry to Hazipur carries a consignment note and
 * nothing else. So "documents outstanding" has to be asked of shipments alone —
 * asked of every despatch it answers *every domestic trip ever made*, each of
 * which has a blank `docs_status` and always will. That was a real defect in
 * the register's `?docs=pending` filter as first written.
 *
 * It lives here rather than in `routes/despatches.ts` because it now has three
 * readers: that route's filter, the summary over it, and the dashboard's
 * attention strip. A route importing a rule from another route is how the two
 * come to disagree — the same reason `receivables.ts` owns "how much has this
 * been credited" and `qc.ts` owns "did this check pass".
 *
 * **Written twice**, because the two SQL contexts genuinely differ: a WHERE
 * against the joined list needs the `d.` alias, a summary over a CTE of that
 * list must not have one. A regex that rewrites SQL is a worse thing to
 * maintain than four repeated column names, and `despatchRegister.test.ts`
 * runs both over the same fixtures and asserts they pick the same rows — the
 * exception `RESULT_FAILED_SQL` established, paid for the same way.
 */

/** Unaliased: for a CTE or a query with `despatches` as its only table. */
export const SEA_LEG = "(bl_no <> '' OR container_no <> '' OR etd <> '' OR eta <> '')";

/** Aliased `d.`: for the register's joined list and the dashboard's counts. */
export const SEA_LEG_D = "(d.bl_no <> '' OR d.container_no <> '' OR d.etd <> '' OR d.eta <> '')";

/**
 * Shipments whose papers are not yet with the buyer — the chase list.
 *
 * Blank is not "no documents" but **not sent yet**, which is the state most
 * worth finding, so this is "not received" rather than "not sent". Aliased,
 * since both readers join through the order.
 */
export const DOCS_OUTSTANDING_D = `${SEA_LEG_D} AND COALESCE(d.docs_status, '') <> 'received'`;

/**
 * Pieces physically sent per order line — the counterpart to the invoice walk.
 *
 * Lives here rather than in `routes/despatches.ts`, where it was first written,
 * because it now has readers on both sides: that route, the order's own
 * `getFull`, and `dispatchReady.ts`. A **service importing from a route** is
 * backwards, and is the shape that leaves two callers reading the same fact
 * through two different doors.
 */
export function despatchedByOrder(orderId: number):
  Map<number, { qty: number; packs: number; trips: number; last_date: string }> {
  const rows = db.prepare(
    `SELECT di.order_line,
            COALESCE(SUM(di.qty), 0) AS qty,
            COALESCE(SUM(di.packs), 0) AS packs,
            COUNT(DISTINCT d.id) AS trips,
            -- When this line last moved. MAX rather than MIN: a line shipped
            -- over three trips is best described by the most recent one, which
            -- is what "has this gone yet" is actually asking.
            MAX(d.date) AS last_date
     FROM despatch_items di
     JOIN despatches d ON d.id = di.despatch_id
     WHERE d.order_id = ?
     GROUP BY di.order_line`
  ).all(orderId) as
    { order_line: number; qty: number; packs: number; trips: number; last_date: string | null }[];
  return new Map(rows.map((r) => [r.order_line, {
    qty: round2(r.qty), packs: round2(r.packs), trips: r.trips, last_date: r.last_date ?? '',
  }]));
}

/** The challan or consignment note a line last travelled under, for a job's page. */
export function lastTripForLine(orderId: number, line: number):
  { date: string; reference: string } | null {
  const row = db.prepare(
    `SELECT d.date, d.challan_no, d.cn_no
     FROM despatch_items di JOIN despatches d ON d.id = di.despatch_id
     WHERE d.order_id = ? AND di.order_line = ?
     ORDER BY d.date DESC, d.id DESC LIMIT 1`
  ).get(orderId, line) as { date: string; challan_no: string; cn_no: string } | undefined;
  if (!row) return null;
  return { date: row.date, reference: row.challan_no || row.cn_no || '' };
}
