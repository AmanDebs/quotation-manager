/**
 * How many pieces a line orders — the client's copy of `piecesOrdered` in
 * `server/src/services/totals.ts`, which is the authority.
 *
 * The packing count where it is stated; else the billed quantity converted
 * by its basis — a line entered as `137.5 per 1000` with no boxes typed is
 * 137,500 pieces, not nothing. That was the bug the auto-raised jobs had on
 * the live book (2026-09-12), and the dispatch page had it too until
 * 2026-09-15: every line of a real export order read `—` for Ordered and
 * prefilled nothing, because they had been entered as `per 1000` quantities
 * without packing figures. A weight-billed line with no piece count is
 * `null`, not 0: it has no pieces to state.
 */
export const PIECES_PER_BILLING_UNIT: Record<string, number> = { 'per 1000': 1000, unit: 1 };

export function piecesOrdered(it: { qty?: number | null; unit?: string | null; total_pcs?: number | null }): number | null {
  if (it.total_pcs != null) return Number(it.total_pcs) || 0;
  const per = PIECES_PER_BILLING_UNIT[it.unit ?? ''];
  if (per == null || it.qty == null) return null;
  return Number(it.qty) * per || 0;
}
