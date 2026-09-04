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
  /**
   * This line is a charge, not goods — freight, insurance, tooling, a testing
   * fee. It bills at its own price (quantity 1) and carries no quantity into
   * any total.
   */
  is_charge?: number | boolean;
}

export interface ComputedItem extends LineItemInput {
  amount: number;
}

export interface Totals {
  items: ComputedItem[];
  subtotal: number;
  tax_total: number;
  /**
   * Tax collected at source. 0 on every document that does not ask for it,
   * which today is everything except a purchase order — see `tcsPct` below.
   */
  tcs_amount: number;
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
 * For any other basis (kg, tonne, box) the piece count says
 * nothing about the billed quantity, so the typed qty stands.
 *
 * Failing both, Total Qty is taken at face value in whatever the rate basis is.
 * Quotations and proformas no longer offer a Qty field at all, so on those a
 * kg-priced line has nowhere else to state its quantity. This branch only ever
 * fires where the answer used to be null — a line that already had an amount
 * keeps exactly the amount it had.
 *
 * A charge line short-circuits all of that at quantity 1, so its price *is* its
 * amount. There is nothing to count: one freight bill is not one of anything
 * the goods columns are adding up.
 */
export function billedQty(it: Pick<LineItemInput, 'qty' | 'unit' | 'total_pcs' | 'is_charge'>): number | null {
  if (it.is_charge) return 1;
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
/**
 * `tcsPct` is tax collected at source, and it is the one figure here charged on
 * the whole document rather than on a line — a percentage of the taxable value
 * plus the tax on it, which is how it is stated on Aglo's own purchase orders.
 * It therefore has no home on `tax_pct`, which is per line and per rate.
 *
 * It defaults to 0, and at 0 every figure this function returns is what it
 * returned before TCS existed: no document already raised moves when it is next
 * saved. There is a test asserting exactly that across the combination matrix,
 * because "strictly additive" is the kind of claim that is easy to make and
 * expensive to be wrong about.
 */
export function computeTotals(
  items: LineItemInput[],
  taxType: 'none' | 'cgst_sgst' | 'igst',
  freight = 0,
  insurance = 0,
  currency = '',
  tcsPct = 0
): Totals {
  const computed: ComputedItem[] = items.map((it) => {
    // Derived, then stamped back onto the row, so what is stored can never
    // disagree with the packing figures printed beside it.
    const qty = billedQty(it);
    // A charge has no packing at all, so any figures left over from before the
    // line was marked as one are cleared rather than stored and hidden.
    const charge = !!it.is_charge;
    return {
      ...it,
      qty,
      tax_pct: it.tax_pct ?? 0,
      color: charge ? '' : (it.color ?? ''),
      packs: charge ? null : (it.packs ?? null),
      pcs_per_pack: charge ? null : (it.pcs_per_pack ?? null),
      total_pcs: charge ? null : (it.total_pcs ?? null),
      qty_20ft: charge ? null : (it.qty_20ft ?? null),
      qty_40ft: charge ? null : (it.qty_40ft ?? null),
      custom1: it.custom1 ?? '',
      custom2: it.custom2 ?? '',
      custom3: it.custom3 ?? '',
      image: it.image ?? '',
      amount: qty != null ? round2(qty * it.unit_price) : 0,
    };
  });

  const subtotal = round2(computed.reduce((s, it) => s + it.amount, 0));
  const charges = (freight || 0) + (insurance || 0);
  const taxable = round2(subtotal + charges);

  let tax_total = 0;
  if (taxType !== 'none') {
    const onItems = computed.reduce((s, it) => s + it.amount * ((it.tax_pct ?? 0) / 100), 0);
    /**
     * Header freight and insurance are taxed too. They used to be added into
     * `taxable` and then left out of `tax_total`, which under-charged GST by
     * the tax on them on every domestic invoice that used the header fields.
     * Freight entered as a **charge line** was always taxed correctly, because
     * a line carries its own `tax_pct`; only the two header fields missed.
     *
     * They have no rate of their own, and there is nowhere to put one. Under
     * GST a delivery charge is part of the same composite supply and follows
     * the goods, so the charge is apportioned across the lines in proportion
     * to their amounts and each share taxed at that line's own rate. Where
     * every line shares one rate — the ordinary case here — that is exactly
     * `charges × rate`, and where they differ it is the invoice's own
     * weighted rate rather than a rate picked from one arbitrary line.
     *
     * A price-only document (no quantities, so `subtotal` is 0) has no rate
     * to follow and no value to tax, so the charges attract nothing.
     */
    const onCharges = charges > 0 && subtotal > 0
      ? computed.reduce(
          (s, it) => s + charges * (it.amount / subtotal) * ((it.tax_pct ?? 0) / 100),
          0
        )
      : 0;
    tax_total = round2(onItems + onCharges);
  }

  // Charged on the taxable value *and* the tax on it, which is what the
  // reference document adds up to. Rounded on its own before it is added, so
  // the figure printed on the TCS line is the figure in the total.
  const tcs_amount = tcsPct > 0 ? round2((taxable + tax_total) * (tcsPct / 100)) : 0;

  let grand_total = round2(taxable + tax_total + tcs_amount);
  if (currency === 'INR') grand_total = Math.round(grand_total);
  return { items: computed, subtotal, tax_total, tcs_amount, grand_total };
}
