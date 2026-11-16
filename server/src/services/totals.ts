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
  /**
   * What the document's own discount takes off the lines. 0 on every document
   * that states none, which is every one raised before the field existed —
   * see `discountPct` below.
   *
   * The lines added up **before** it is `subtotal + discount_amount`, which is
   * what the items table's own closing TOTAL row states; all three figures go
   * through `round2`, so that addition is exact rather than nearly exact.
   */
  discount_amount: number;
  /** The taxable value: the lines, less the discount. */
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
 * A document's discount percentage, held to 0–100.
 *
 * `computeTotals` clamps too, which is what guarantees no total can go
 * negative whatever is on the row — but the figure has to be clamped **where
 * it is stored** as well, or the band prints *Less Discount @ 150%* over a
 * deduction of 100%: a label claiming more than it took. One rule, one name,
 * read by every route that writes the column.
 */
export const clampDiscountPct = (v: unknown): number =>
  Math.min(100, Math.max(0, Number(v) || 0));

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

/**
 * Pieces in one billing unit **of this line**, which is the same question for
 * every basis but one: a box holds `pcs_per_pack` pieces, and that is stated
 * per line rather than per unit, so the constant table above cannot carry it.
 *
 * `box` is therefore a piece basis whose divisor lives on the row — Total Qty
 * is a piece count exactly as it is for `per 1000`, and dividing it by the
 * pack size gives the boxes the rate is charged against. Without this branch a
 * per-box line read Total Qty at face value and billed 3,57,000 boxes for a
 * line stating 85 of them (2026-11-14, the client: *"When I put unit as box it
 * is not working properly"*).
 *
 * Null for a line stating no pack size, which is the honest answer: nothing on
 * it says how many boxes there are, so the fallbacks in `billedQty` take over
 * exactly as they did before.
 */
export const piecesPerBillingUnitOf = (
  it: Pick<LineItemInput, 'unit' | 'pcs_per_pack'>
): number | null =>
  (it.unit === 'box' ? (Number(it.pcs_per_pack) || null) : piecesPerBillingUnit(it.unit));

/**
 * How many pieces a line orders — the figure a job is planned at and the order
 * book measures *made* against.
 *
 * The packing count where it is stated; else the billed quantity **converted
 * by its basis** — a line entered as `137.5 per 1000` with no boxes typed is
 * 137,500 pieces, not 137.5. Reading `total_pcs ?? qty` was the bug found on
 * the live book (2026-09-12): every per-1000 line entered without packing
 * figures got a job for a few hundred pieces, and the order's *all made* rung
 * read the same way. A line on a weight basis with no piece count falls back
 * to its billed quantity as before, which is not pieces and is not pretended
 * to be — it is what those lines have always been measured in here.
 *
 * `PIECES_ORDERED_SQL` is this restated for the order-book query, which is
 * paged and cannot derive after the fetch; `totals.test.ts` runs both over the
 * same rows and asserts they agree.
 */
export function piecesOrdered(it: Pick<LineItemInput, 'qty' | 'unit' | 'total_pcs'>): number {
  if (it.total_pcs != null) return Number(it.total_pcs) || 0;
  if (it.qty == null) return 0;
  const per = piecesPerBillingUnit(it.unit);
  return (per != null ? Number(it.qty) * per : Number(it.qty)) || 0;
}

export const PIECES_ORDERED_SQL = (l: string) =>
  `COALESCE(${l}.total_pcs, CASE ${l}.unit WHEN 'per 1000' THEN ${l}.qty * 1000 WHEN 'unit' THEN ${l}.qty ELSE ${l}.qty END, 0)`;

/**
 * True when the basis is a piece count the *unit alone* settles — `per 1000`
 * and `unit`, whose divisor is a constant. **Not `box`**, whose Total Qty is
 * pieces too but whose divisor is the line's own pack size: ask
 * `piecesPerBillingUnitOf` where the line is in hand. The callers here are the
 * ones that have only a unit string to go on.
 */
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
 * A box is a piece basis too, by `piecesPerBillingUnitOf`: the pack size is
 * on the line, so Total Qty divided by it is the box count the rate charges
 * against. For a weight basis (kg, tonne) the piece count says nothing about
 * the billed quantity, so the typed qty stands.
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
export function billedQty(
  it: Pick<LineItemInput, 'qty' | 'unit' | 'total_pcs' | 'pcs_per_pack' | 'is_charge'>
): number | null {
  if (it.is_charge) return 1;
  const per = piecesPerBillingUnitOf(it);
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
 *
 * `discountPct` is the document's own discount (2026-11-16, the client: *"Add a
 * discount option in PI and quotation"*), and it is the second figure here
 * charged on the whole document rather than on a line — deliberately, and the
 * distinction from freight is the whole of why it is not a charge line.
 *
 * Freight is a **separate supply** bundled into the sale, so it wants a rate of
 * its own and belongs on a line that carries one; that is the reasoning the
 * header Freight and Insurance boxes were removed from the forms for. A
 * discount is not a supply at all — it is a **reduction of the goods' own
 * value**, so under GST it comes off the taxable value (s.15(3)(a)) and the tax
 * on what is left follows the goods' own rates. Apportionment is therefore the
 * correct treatment here rather than a workaround for a missing rate, and a
 * flat percentage needs none: it scales every line's taxable value by the same
 * factor, so it scales the tax by the same factor. One multiplication, exact.
 *
 * **The lines keep their gross amounts.** Only the document's figures move, so
 * the proforma's derived per-1000 rate stays the list rate and reads as an
 * arithmetic chain beside the discount rather than as a second deduction from
 * a figure already net.
 *
 * Clamped to 0–100, which is a hard invariant rather than tidiness: above 100
 * the grand total goes negative, and a negative total reaches the customer as
 * an amount in words. Below 0 it would be a surcharge wearing the word
 * *discount*. Like `tcsPct` it defaults to 0, where every figure is what it
 * was before this existed.
 */
export function computeTotals(
  items: LineItemInput[],
  taxType: 'none' | 'cgst_sgst' | 'igst',
  freight = 0,
  insurance = 0,
  currency = '',
  tcsPct = 0,
  discountPct = 0
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

  /*
   * The lines added up, before the document's own discount. The items table's
   * closing TOTAL row states this figure, which is why the discount and the
   * net total are printed under it rather than over it.
   *
   * **Every line, a charge included.** A percentage off the document means a
   * percentage off what the lines come to, and that is the only reading the
   * band can show: *Gross Amount 1,10,000 / Less Discount @ 5% 5,500 / TOTAL
   * PRICE 1,04,500* reproduces, where discounting the goods alone would print
   * a figure that is not the stated percentage of the figure above it. The
   * legacy header freight and insurance are **not** discounted — they are
   * added after the subtotal, which the band shows plainly — and those boxes
   * have been off the forms since 2026-09-07, so a charge line is the one
   * route freight takes now.
   */
  const lines_total = round2(computed.reduce((s, it) => s + it.amount, 0));
  const discountPctClamped = Math.min(100, Math.max(0, Number(discountPct) || 0));
  const discount_amount = discountPctClamped > 0 ? round2(lines_total * (discountPctClamped / 100)) : 0;
  // The taxable value. Named `subtotal` because that is what it has always
  // been — the base the charges are added to and the tax is charged on — and
  // because nothing downstream reads it as the sum of the lines: every caller
  // either stamps it or prints it as TOTAL PRICE.
  const subtotal = round2(lines_total - discount_amount);
  const charges = (freight || 0) + (insurance || 0);
  const taxable = round2(subtotal + charges);

  let tax_total = 0;
  if (taxType !== 'none') {
    /*
     * A flat percentage off every line scales each line's taxable value by the
     * same factor, so it scales the tax by the same factor:
     * `Σ(aᵢ(1−d)·rᵢ) = (1−d)·Σ(aᵢrᵢ)`. No apportionment, and exact.
     */
    const onItems = computed.reduce((s, it) => s + it.amount * ((it.tax_pct ?? 0) / 100), 0)
      * (1 - discountPctClamped / 100);
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
     * A price-only document (no quantities, so the lines total 0) has no rate
     * to follow and no value to tax, so the charges attract nothing.
     *
     * The weights are over `lines_total`, not over the discounted `subtotal`:
     * they are shares of the goods and must sum to 1, and a discount changes
     * neither the proportions nor the fact that the freight itself is not
     * discounted. So freight tax is unmoved by a discount on the goods, which
     * is correct.
     */
    const onCharges = charges > 0 && lines_total > 0
      ? computed.reduce(
          (s, it) => s + charges * (it.amount / lines_total) * ((it.tax_pct ?? 0) / 100),
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
  return { items: computed, discount_amount, subtotal, tax_total, tcs_amount, grand_total };
}
