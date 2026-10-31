/*
 * The two formatters a printed document and the screen that previews it have
 * to agree about.
 *
 * They lived in `pdf.ts` while that file was the only thing drawing a header.
 * `coaHeader.ts` now builds the Certificate of Analysis's header for both the
 * PDF and the page that ticks its cells on and off, and a second copy of
 * *how a date reads* is exactly how the preview comes to disagree with the
 * paper — the move `monthsBetween` made into `services/months.ts`, for the
 * same reason.
 */

/** Grouped the Indian way, which is what this desk reads. */
export function fmtNum(n: number | null | undefined, maxFrac = 3): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: maxFrac }).format(n);
}

/** `YYYY-MM-DD` as this desk writes it. Blank in, blank out. */
export function fmtDate(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}
