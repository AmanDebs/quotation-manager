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
