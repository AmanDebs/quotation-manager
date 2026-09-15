/**
 * A proforma's status as the app reads it — the stored value, except that a
 * `draft` or `sent` one past its validity date reads `expired`.
 *
 * Expired is derived and never stored (the table's CHECK does not list it,
 * and SQLite cannot ALTER one), so this expression is the one definition of
 * it. It was `routes/proformas.ts`'s alone until the Reports page needed the
 * same reading (2026-09-15) — a service importing from a route is backwards,
 * so it lives here and the route imports it. Written against the alias `p`.
 *
 * `date('now')` is UTC, so east of Greenwich a proforma lapses up to 5½
 * hours late, which is the safe direction.
 */
export const STATUS_SQL = `CASE
    WHEN p.status IN ('draft', 'sent') AND p.validity_date <> '' AND p.validity_date < date('now')
    THEN 'expired' ELSE p.status END`;
