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

/**
 * Pieces in one billing unit **of this line** — `piecesPerBillingUnitOf` in
 * `server/src/services/totals.ts`, which is the authority. Every basis but one
 * is settled by the unit alone; a box holds `pcs_per_pack` pieces, stated per
 * line rather than per unit, so the table above cannot carry it.
 */
export const piecesPerBillingUnitOf = (
  it: { unit?: string | null; pcs_per_pack?: number | null }
): number | null =>
  (it.unit === 'box'
    ? (Number(it.pcs_per_pack) || null)
    : PIECES_PER_BILLING_UNIT[it.unit ?? ''] ?? null);

export function piecesOrdered(it: { qty?: number | null; unit?: string | null; total_pcs?: number | null }): number | null {
  if (it.total_pcs != null) return Number(it.total_pcs) || 0;
  const per = PIECES_PER_BILLING_UNIT[it.unit ?? ''];
  if (per == null || it.qty == null) return null;
  return Number(it.qty) * per || 0;
}

/**
 * The quantity a line is billed on — the client's copy of `billedQty` in
 * `server/src/services/totals.ts`, which is the authority. Everything drawn
 * from it on screen is a preview of what the server will compute on save, so
 * the two have to agree or the figure under the table reads differently from
 * the saved document.
 *
 * It lives here rather than inside `LineItemsEditor` because two screens now
 * ask it: that editor, for each line's own amount, and `DocumentDiscount`,
 * which needs the lines added up to say what a percentage takes off them. A
 * second copy is how the two would come to disagree about one document.
 */
export function billedQty(
  it: { qty?: number | null; unit?: string | null; total_pcs?: number | null; pcs_per_pack?: number | null; is_charge?: number | boolean }
): number | null {
  // A charge bills at quantity 1, so its price is its amount.
  if (it.is_charge) return 1;
  const per = piecesPerBillingUnitOf(it);
  if (per && it.total_pcs != null) return it.total_pcs / per;
  if (it.qty != null) return it.qty;
  return it.total_pcs ?? null;
}

/** What the lines come to before any document-level discount. */
export const linesTotal = (items: { unit_price: number; qty?: number | null; unit?: string | null; total_pcs?: number | null; pcs_per_pack?: number | null; is_charge?: number | boolean }[]): number =>
  items.reduce((s, it) => s + (billedQty(it) ?? 0) * (Number(it.unit_price) || 0), 0);
