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

/**
 * `date` plus `days`, both `YYYY-MM-DD`, in **UTC** so no timezone touches it:
 * `new Date('2026-10-02')` reads as UTC midnight and is then asked about
 * locally, which lands the answer a day out on either side of Greenwich.
 *
 * Blank where the date cannot be read, so a caller shows nothing rather than
 * a confident wrong day.
 *
 * It lived in `services/reports.ts` until the production planner wanted it
 * too (2026-11-16), and moved here for the reason `monthsBetween` did: a
 * shared fact belongs out of the file that happened to need it first.
 */
export function addDaysIso(date: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return '';
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + days)).toISOString().slice(0, 10);
}

/**
 * Whole days from one date to another, both `YYYY-MM-DD`, in **UTC** for
 * `addDaysIso`' own reason: read locally, a bare date is UTC midnight asked
 * about somewhere else and the answer lands a day out either side of
 * Greenwich. Negative where `to` is the earlier of the two; 0 where either
 * cannot be read, so a caller shows nothing rather than a confident figure.
 */
export function daysBetweenIso(from: string, to: string): number {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from);
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(to);
  if (!a || !b) return 0;
  const ms = Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3]);
  return Math.round(ms / 86_400_000);
}
