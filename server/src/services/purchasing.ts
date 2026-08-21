import { db } from '../db/connection.js';
import { shortfall } from './stock.js';
import { round2 } from './totals.js';

/**
 * What to buy, and from whom — the draft behind "raise a PO from the shortfall".
 *
 * `services/stock.ts` owns the shortfall itself and is asked for it rather than
 * re-derived here, the same way `receivables.ts` owns credit. What this adds is
 * the two things a buyer needs before the figure becomes an order: **who we
 * last bought each material from, and at what rate**.
 *
 * Neither is stored. `materials` has no supplier column, deliberately — a
 * material is not the property of one supplier, and writing one on would make
 * the second quote for the same resin look like a different material. The
 * answer is derived from the purchase history instead, which also makes it
 * self-correcting: buy from someone else once and the suggestion follows.
 */

export interface LastPurchase {
  material_id: number;
  supplier_id: number;
  supplier_name: string;
  rate: number;
  tax_pct: number;
  unit: string;
  currency: string;
  date: string;
  number: string;
}

/**
 * The most recent purchase of each material.
 *
 * Cancelled orders are excluded: a rate nobody went on to buy at is not what we
 * last paid. Drafts are kept — a rate typed but not yet sent is still the most
 * recent thing anyone decided about this material, and the date comes back with
 * it so a stale suggestion is visible rather than silently trusted.
 *
 * `ROW_NUMBER` rather than a correlated subquery so this stays one statement
 * however many materials there are.
 */
export function lastPurchaseByMaterial(): Map<number, LastPurchase> {
  const rows = db.prepare(
    `SELECT material_id, supplier_id, supplier_name, rate, tax_pct, unit, currency, date, number FROM (
       SELECT i.material_id, p.supplier_id, s.name AS supplier_name, i.rate, i.tax_pct, i.unit,
              p.currency, p.date, p.number,
              ROW_NUMBER() OVER (PARTITION BY i.material_id ORDER BY p.date DESC, p.id DESC) AS rn
       FROM po_items i
       JOIN purchase_orders p ON p.id = i.po_id
       JOIN suppliers s ON s.id = p.supplier_id
       WHERE i.material_id IS NOT NULL AND p.status <> 'cancelled'
     ) WHERE rn = 1`
  ).all() as unknown as LastPurchase[];
  return new Map(rows.map((r) => [r.material_id, r]));
}

export interface ShortfallDraftLine {
  material_id: number;
  description: string;
  unit: string;
  /** How much to buy: the shortfall, which is already net of what is on order. */
  qty: number;
  /** Only filled in when the last purchase was in this draft's currency. */
  rate: number;
  tax_pct: number;
  /** Working detail for the screen — not part of the document. */
  shortfall: { required: number; on_hand: number; on_order: number; short: number };
  last_supplier_id: number | null;
  last_supplier_name: string;
  last_rate: number | null;
  last_rate_currency: string;
  last_purchase_date: string;
  last_purchase_number: string;
}

export interface ShortfallDraft {
  supplier_id: number | null;
  location_id: number | null;
  date: string;
  currency: string;
  tax_type: 'none' | 'cgst_sgst' | 'igst';
  items: ShortfallDraftLine[];
  /**
   * Jobs whose product has no recipe. They contribute **nothing** to the
   * requirement — not zero, unknown — so a purchase order raised from this may
   * still be short. Passed up rather than dropped, because a shortfall report
   * that quietly ignores half the floor is worse than no report.
   */
  uncosted: { id: number; number: string; description: string }[];
  /** True when a supplier filter left some short material out of the draft. */
  filtered: boolean;
}

/**
 * Build the draft. Never writes — the carry-forward rule every other conversion
 * in this app follows.
 *
 * `supplierId` narrows to the materials we last bought from that supplier,
 * because one purchase order goes to one supplier; without it every short
 * material comes back and the buyer picks. A material never bought before has
 * no suggestion to match on and is only ever in the unfiltered list.
 */
export function shortfallDraft(
  { locationId = null, supplierId = null, date }:
  { locationId?: number | null; supplierId?: number | null; date: string }
): ShortfallDraft {
  const { rows, uncosted } = shortfall(locationId);
  const short = rows.filter((r) => r.short > 0);
  const last = lastPurchaseByMaterial();

  // The draft's currency follows the supplier we are buying from, so a rate
  // suggested from history is in the same money as the document it lands on.
  // Without a supplier there is nothing to follow, and INR is the column
  // default.
  const supplierCurrency = supplierId
    ? (db.prepare(
        `SELECT currency FROM purchase_orders WHERE supplier_id = ? AND status <> 'cancelled'
         ORDER BY date DESC, id DESC LIMIT 1`
      ).get(supplierId) as { currency: string } | undefined)?.currency
    : undefined;
  const currency = supplierCurrency || 'INR';

  const chosen = supplierId
    ? short.filter((r) => last.get(r.material_id)?.supplier_id === supplierId)
    : short;

  const items: ShortfallDraftLine[] = chosen.map((r) => {
    const prev = last.get(r.material_id);
    // A rate is only carried across when the two currencies agree. There is no
    // exchange rate stored anywhere in this app, and inventing one to price a
    // purchase order would put a fiction on a commitment — the same rule
    // `receivables.ts` applies to a payment against an invoice.
    const rateUsable = prev && prev.currency === currency;
    return {
      material_id: r.material_id,
      description: r.material_name,
      unit: prev?.unit || r.unit || 'kg',
      qty: round2(r.short),
      rate: rateUsable ? prev!.rate : 0,
      tax_pct: rateUsable ? prev!.tax_pct : 0,
      shortfall: {
        required: round2(r.required), on_hand: round2(r.on_hand),
        on_order: round2(r.on_order), short: round2(r.short),
      },
      last_supplier_id: prev?.supplier_id ?? null,
      last_supplier_name: prev?.supplier_name ?? '',
      last_rate: prev?.rate ?? null,
      last_rate_currency: prev?.currency ?? '',
      last_purchase_date: prev?.date ?? '',
      last_purchase_number: prev?.number ?? '',
    };
  });

  return {
    supplier_id: supplierId,
    location_id: locationId,
    date,
    currency,
    // Buying resin domestically is the ordinary case; the form can change it.
    tax_type: 'igst',
    items,
    uncosted,
    filtered: !!supplierId && items.length < short.length,
  };
}
