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
  const computed: ComputedItem[] = items.map((it) => ({
    ...it,
    qty: it.qty ?? null,
    tax_pct: it.tax_pct ?? 0,
    color: it.color ?? '',
    packs: it.packs ?? null,
    pcs_per_pack: it.pcs_per_pack ?? null,
    total_pcs: it.total_pcs ?? null,
    amount: it.qty != null ? round2(it.qty * it.unit_price) : 0,
  }));

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
