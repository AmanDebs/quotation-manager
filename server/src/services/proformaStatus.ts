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
 *
 * **It takes the alias it is written against** (2026-10-16). It was fixed to
 * `p`, which is right for every WHERE that reads the table — and wrong for the
 * one reader that had to ask the same question of a *subquery*'s own output,
 * once the list grew header funnels and had to be wrapped to filter on its
 * aliases. A second copy against the other alias is how the list and the
 * dashboard would come to disagree about which offers have lapsed, so there is
 * one rule and the caller says whose columns to read.
 */
export const statusSqlFor = (alias: string) => `CASE
    WHEN ${alias}.status IN ('draft', 'sent') AND ${alias}.validity_date <> ''
      AND ${alias}.validity_date < date('now')
    THEN 'expired' ELSE ${alias}.status END`;

/** The expression as every WHERE in the app reads it: against the table. */
export const STATUS_SQL = statusSqlFor('p');
