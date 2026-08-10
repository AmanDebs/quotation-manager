export interface LineItemInput {
  product_id?: number | null;
  description: string;
  hsn_code?: string;
  qty?: number | null;
  unit?: string;
  unit_price: number;
  tax_pct?: number;
  color?: string;
  packs?: number | null;
  pcs_per_pack?: number | null;
  total_pcs?: number | null;
  /** Boxes that fill a container of each size; printed on export quotations. */
  qty_20ft?: number | null;
  qty_40ft?: number | null;
  custom1?: string;
  custom2?: string;
  custom3?: string;
  /** Optional per-line photo as a base64 data URL; printed on quotations. */
  image?: string;
}

export interface ComputedItem extends LineItemInput {
  amount: number;
}

export interface Totals {
  items: ComputedItem[];
  subtotal: number;
  tax_total: number;
  grand_total: number;
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Pieces in one billing unit, for the rate bases that are priced off a piece
 * count. Only these can have their quantity derived from the packing figures.
 */
const PIECES_PER_BILLING_UNIT: Record<string, number> = { 'per 1000': 1000, unit: 1 };

/**
 * Pieces in one billing unit, or null when the rate is not quoted against a
 * piece count at all. Null means Total Qty is read in that other basis
 * instead (kilos, tonnes), and a "per 1000 pcs" figure derived from it would
 * be meaningless — money divided by kilos is not a rate per 1000 pieces.
 */
export const piecesPerBillingUnit = (unit: string | undefined | null): number | null =>
  PIECES_PER_BILLING_UNIT[unit ?? ''] ?? null;

/** True when the rate is quoted against a piece count, so Total Qty is pieces. */
export const isPieceBasis = (unit: string | undefined | null): boolean =>
  piecesPerBillingUnit(unit) != null;

/**
 * The quantity a line is actually billed on.
 *
 * When the rate is per piece or per 1000 *and* the packing figures say how
 * many pieces there are, the piece count decides: boxes × pcs/box is the
 * quantity, and a separately typed qty could only ever contradict it. That
 * contradiction was reachable — the two fields were independent, so a line
 * could print 60,000 pieces against a total priced on some other number.
 *
 * For any other basis (kg, tonne, metre, litre, set, box) the piece count says
 * nothing about the billed quantity, so the typed qty stands.
 *
 * Failing both, Total Qty is taken at face value in whatever the rate basis is.
 * Quotations and proformas no longer offer a Qty field at all, so on those a
 * kg-priced line has nowhere else to state its quantity. This branch only ever
 * fires where the answer used to be null — a line that already had an amount
 * keeps exactly the amount it had.
 */
export function billedQty(it: Pick<LineItemInput, 'qty' | 'unit' | 'total_pcs'>): number | null {
  const per = PIECES_PER_BILLING_UNIT[it.unit ?? ''];
  if (per && it.total_pcs != null) return it.total_pcs / per;
  if (it.qty != null) return it.qty;
  return it.total_pcs ?? null;
}

/**
 * Single source of truth for all document math.
 * qty may be null (customer did not share quantity) — then line amount is 0
 * and the document acts as a price list.
 * tax_type 'none' (exports) zeroes all tax regardless of item tax_pct.
 * INR grand totals are rounded to the whole rupee (Indian "round off" practice);
 * PDFs derive the round-off line from the difference vs the components.
 */
export function computeTotals(
  items: LineItemInput[],
  taxType: 'none' | 'cgst_sgst' | 'igst',
  freight = 0,
  insurance = 0,
  currency = ''
): Totals {
  const computed: ComputedItem[] = items.map((it) => {
    // Derived, then stamped back onto the row, so what is stored can never
    // disagree with the packing figures printed beside it.
    const qty = billedQty(it);
    return {
      ...it,
      qty,
      tax_pct: it.tax_pct ?? 0,
      color: it.color ?? '',
      packs: it.packs ?? null,
      pcs_per_pack: it.pcs_per_pack ?? null,
      total_pcs: it.total_pcs ?? null,
      qty_20ft: it.qty_20ft ?? null,
      qty_40ft: it.qty_40ft ?? null,
      custom1: it.custom1 ?? '',
      custom2: it.custom2 ?? '',
      custom3: it.custom3 ?? '',
      image: it.image ?? '',
      amount: qty != null ? round2(qty * it.unit_price) : 0,
    };
  });

  const subtotal = round2(computed.reduce((s, it) => s + it.amount, 0));
  const taxable = round2(subtotal + (freight || 0) + (insurance || 0));

  let tax_total = 0;
  if (taxType !== 'none') {
    tax_total = round2(
      computed.reduce((s, it) => s + it.amount * ((it.tax_pct ?? 0) / 100), 0)
    );
  }

  let grand_total = round2(taxable + tax_total);
  if (currency === 'INR') grand_total = Math.round(grand_total);
  return { items: computed, subtotal, tax_total, grand_total };
}
