import type { TaxType } from '../types';

/**
 * What a new line is taxed at, and what a deemed export is taxed at instead.
 *
 * **A new line starts at 18%** (asked for 2026-09-06). Every line used to be
 * created at 0 and typed over, on a catalogue where 18% is the answer for
 * essentially everything — so the field existed to be corrected rather than to
 * be filled in, and a line left at zero silently under-charges the tax on a
 * domestic document. It is a **default, not a rule**: the field is in the row
 * and editable, and nothing already saved changes.
 *
 * Safe to apply whatever the document is: `computeTotals` reads `tax_pct` only
 * when `taxType !== 'none'`, so an export document ignores it and hides the
 * column anyway.
 */
export const DEFAULT_TAX_PCT = 18;

/**
 * The concessional rate a **deemed export** carries — a supply to a merchant
 * exporter, which is domestic and taxed at 0.1% rather than 18%.
 *
 * Built for the purchase order first (2026-09-20, the client: *"In tax add
 * Deemed Export (0.1%)"*) and asked of the selling side on 2026-09-24
 * (*"Add this deemed export also in quotation and proforma"*).
 *
 * **It is not a fourth stored tax type.** Every one of these tables carries a
 * CHECK naming three, and SQLite cannot ALTER one — so it is a *preset* in the
 * Tax picker: IGST, with every line at 0.1%. Which means it is also **derived
 * on the way back** rather than stored: the picker reads *Deemed Export*
 * whenever the type is IGST and every line is at that rate, so there is no
 * flag that can come to disagree with the lines under it, and the PDF names
 * the concession by reading the same thing. The rule lives here, in one place,
 * because it is now asked by four forms and by every builder in `pdf.ts`; a
 * copy per document is how two of them would come to answer differently about
 * the same figures.
 */
export const DEEMED_EXPORT_PCT = 0.1;

/** What the Tax picker offers, which is the three stored types plus the preset. */
export type TaxChoice = TaxType | 'deemed_export';

export const DEEMED_EXPORT_LABEL = 'Deemed Export (IGST 0.1%)';

/**
 * Which of the four the picker should be showing.
 *
 * A document with **no lines yet** is never the preset: the rule is about what
 * the lines carry, and `every` over an empty list is vacuously true, which
 * would open a new blank document reading *Deemed Export* before anybody had
 * said anything about tax.
 */
export function taxChoiceOf(taxType: TaxType | undefined, items: { tax_pct?: number | null }[]): TaxChoice {
  const deemed = taxType === 'igst'
    && items.length > 0
    && items.every((it) => Number(it.tax_pct) === DEEMED_EXPORT_PCT);
  return deemed ? 'deemed_export' : (taxType ?? 'igst');
}

/**
 * What picking one does to the document.
 *
 * Choosing the preset writes the rate onto every line; leaving it puts those
 * lines back on the ordinary rate. **Leaving only rewrites lines the preset
 * itself set** — the `wasDeemed` test — so a rate somebody typed by hand on an
 * ordinary document is never quietly restated by touching the Tax picker.
 *
 * The rate stays editable afterwards: this writes the figure once and does not
 * police it. Typing one line back to 18% is therefore how the concession stops
 * being claimed, and the label goes with it, which is the honest behaviour —
 * the picker reports what the lines say rather than overriding them.
 */
export function taxPatchFor<T extends { tax_pct?: number | null }>(
  choice: string,
  current: TaxType | undefined,
  items: T[],
): { tax_type: TaxType; items: T[] } {
  const wasDeemed = taxChoiceOf(current, items) === 'deemed_export';
  if (choice === 'deemed_export') {
    return { tax_type: 'igst', items: items.map((it) => ({ ...it, tax_pct: DEEMED_EXPORT_PCT })) };
  }
  return {
    tax_type: choice as TaxType,
    items: wasDeemed ? items.map((it) => ({ ...it, tax_pct: DEFAULT_TAX_PCT })) : items,
  };
}

/** What a line added now should be taxed at, so the preset survives an extra line. */
export const newLineTaxPct = (choice: TaxChoice): number =>
  (choice === 'deemed_export' ? DEEMED_EXPORT_PCT : DEFAULT_TAX_PCT);
