/**
 * What kind of thing a catalogue entry is.
 *
 * Four shapes, named by the user on 2026-09-04: caps, preforms, handles, and
 * everything else. It is the shape of the goods, **not** a procurement class —
 * the purchase-order work from the same meeting wants finished / semi-finished
 * / raw material, which is a different axis, and overloading this one is how
 * both end up wrong.
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
export const PRODUCT_TYPES = ['cap', 'preform', 'handle', 'other'] as const;

export type ProductType = (typeof PRODUCT_TYPES)[number];

export const PRODUCT_TYPE_LABEL: Record<ProductType, string> = {
  cap: 'Caps',
  preform: 'Preform',
  handle: 'Handle',
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
];

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
