/**
 * What kind of thing a catalogue entry is.
 *
 * Four shapes named by the user on 2026-09-04 — caps, preforms, handles and
 * everything else — and **semi-finished** added on 2026-09-05, which is worth
 * knowing the history of. The original note said this was the shape of the
 * goods and *not* a procurement class, since the purchase-order work from the
 * same meeting wanted finished / semi-finished / raw material and overloading
 * one axis is how both end up wrong. The user then asked for exactly that
 * value here, and they are right about their own catalogue: a semi-finished
 * item on this desk is a distinct *thing* they stock and sell on, not a stage
 * a finished good passes through. Raw materials remain their own master
 * (`materials`), so the other axis is still separate where it matters.
 *
 * No `db` import, deliberately: `db/connection.ts` needs `guessProductType` for
 * a boot migration, and every service that imports `db` imports it from that
 * file. Same reasoning as `companyPatterns.ts`, and the same rule to keep.
 *
 * There is **no CHECK constraint** on the column these values go in, matching
 * `products.unit`, which has none either. SQLite cannot ALTER a CHECK, so a
 * vocabulary that grows means rebuilding the table and copying every live row —
 * the cost that made the proforma's `expired` status derived rather than
 * stored. A list whose fourth entry is *Others* is a list expecting to grow, so
 * the enum is enforced in `routes/products.ts` instead.
 */
export const PRODUCT_TYPES = ['cap', 'preform', 'handle', 'semi_finished', 'other'] as const;

export type ProductType = (typeof PRODUCT_TYPES)[number];

export const PRODUCT_TYPE_LABEL: Record<ProductType, string> = {
  cap: 'Caps',
  preform: 'Preform',
  handle: 'Handle',
  semi_finished: 'Semi-Finished',
  other: 'Others',
};

export function isProductType(v: unknown): v is ProductType {
  return typeof v === 'string' && (PRODUCT_TYPES as readonly string[]).includes(v);
}

/**
 * Word-boundary matches, so "Handle" is found in "20 Ltr Double Handle" and not
 * in a word that merely contains it. Plurals because a catalogue writes both.
 */
const NAMED: [ProductType, RegExp][] = [
  ['preform', /\bpre-?forms?\b/i],
  ['cap', /\bcaps?\b/i],
  ['handle', /\bhandles?\b/i],
  ['semi_finished', /\bsemi[- ]?finished\b/i],
];

/*
 * Adding the fifth type re-types nothing on file. The guess runs only on the
 * boot that creates the column, which has already happened everywhere — so a
 * product named "Semi Finished Preform" keeps whatever it was given, and by
 * the ambiguity rule it would have been `other` anyway, matching two words.
 */

/**
 * The type a product's own name implies, for the one-off backfill.
 *
 * **A name matching more than one word is `other`.** Choosing between "Preform
 * Cap" 's two readings would be inventing a fact, and the whole point of doing
 * this once at boot rather than continuously is that a person can correct it
 * and be believed. `db/reseed.ts` already picks its demo products this way
 * (`pick('Flip Top Cap')`, `pick('Handle')`), which is the evidence these are
 * the real categories on this desk rather than four words from a meeting.
 *
 * The weight in a name (`28mm Preform 119g`) is deliberately **not** read the
 * same way. A wrong category is visible in a list and costs one click; a wrong
 * weight is a number that flows into material planning looking authoritative.
 */
export function guessProductType(name: string): ProductType {
  const hits = NAMED.filter(([, re]) => re.test(name));
  return hits.length === 1 ? hits[0][0] : 'other';
}
