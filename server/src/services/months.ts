/**
 * Month buckets.
 *
 * `monthsBetween` lived in `services/reports.ts` until the order-book pivot
 * wanted it too (2026-10-30). It is here rather than there so that
 * `orderLines.ts` does not have to import the reports service — which is
 * cycle-free today and would stop being the moment a report reads order
 * lines, which is exactly the direction this app keeps going. The cycle
 * `documentChain.ts` already has to work around is the precedent for moving a
 * shared fact out rather than reaching across.
 */

/**
 * Every month from one date to another, inclusive, as `YYYY-MM`.
 *
 * **A month with nothing in it is still a month**, which is the whole reason
 * this exists rather than a `DISTINCT` over the rows: a sheet of the fiscal
 * year has to read Apr…Mar with the gaps visible, or a quiet month looks like
 * a month nobody has reached yet.
 */
export function monthsBetween(from: string, to: string): string[] {
  const a = /^(\d{4})-(\d{2})/.exec(from);
  const b = /^(\d{4})-(\d{2})/.exec(to);
  if (!a || !b) return [];
  const out: string[] = [];
  let y = Number(a[1]); let m = Number(a[2]);
  const endY = Number(b[1]); const endM = Number(b[2]);
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    if (out.length > 600) break;
  }
  return out;
}
