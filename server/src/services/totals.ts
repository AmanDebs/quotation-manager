export interface LineItemInput {
  product_id?: number | null;
  description: string;
  hsn_code?: string;
  qty?: number | null;
  unit?: string;
  unit_price: number;
  tax_pct?: number;
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
 */
export function computeTotals(
  items: LineItemInput[],
  taxType: 'none' | 'cgst_sgst' | 'igst',
  freight = 0,
  insurance = 0
): Totals {
  const computed: ComputedItem[] = items.map((it) => ({
    ...it,
    qty: it.qty ?? null,
    tax_pct: it.tax_pct ?? 0,
    amount: it.qty != null ? round2(it.qty * it.unit_price) : 0,
  }));

  const subtotal = round2(computed.reduce((s, it) => s + it.amount, 0));
  const taxable = round2(subtotal + (freight || 0) + (insurance || 0));

  let tax_total = 0;
  if (taxType !== 'none') {
    tax_total = round2(
      computed.reduce((s, it) => s + it.amount * ((it.tax_pct ?? 0) / 100), 0) +
        0 // freight/insurance assumed tax-included per business practice; adjust in settings later
    );
  }

  const grand_total = round2(taxable + tax_total);
  return { items: computed, subtotal, tax_total, grand_total };
}
