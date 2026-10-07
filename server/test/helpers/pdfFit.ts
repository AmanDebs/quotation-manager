/**
 * How much room a document's Description column is left — the one number that
 * decides whether an items table fits between the page margins.
 *
 * pdfmake will not break a word. A column narrower than its own longest
 * unbreakable run therefore makes the **whole table** grow past the right
 * margin rather than wrap, and the page then has an items table finishing
 * beyond the letterhead rule and the totals band. That is what the client was
 * looking at on 2026-09-29 (*"alignment is not coming properly"*): the
 * quotation's nine fixed columns left Description 34.8pt against the word
 * *preform-700gm*, measured at 55.6pt, and the table hung 20.5pt off the page.
 *
 * The guard goes on Description because it is the column that must never be
 * squeezed — every other one holds a number or a short word. Adding a column
 * to a builder, or widening one, trips the assertion with the reason on it
 * rather than shipping a table that hangs off the page.
 *
 * Lives here rather than in either test file because two builders are held to
 * it, and two copies of the arithmetic is how the two come to disagree.
 */
import assert from 'node:assert/strict';

/** A4 less `baseDoc`'s 40pt margins. */
export const CONTENT_WIDTH = 595.28 - 40 - 40;

/**
 * What one column costs besides its declared width: `gridLayout` leaves
 * pdfmake's default 4pt of padding a side, and each of the n+1 vertical rules
 * is 0.5pt. Verified against a rendered quotation, whose cells came back at
 * exactly `width + 8.5` apiece.
 */
const PADDING_PER_COLUMN = 8;
const RULE_WIDTH = 0.5;

/**
 * The longest word these catalogues actually produce in a Description —
 * *preform-700gm*, measured at 55.6pt. 60 keeps headroom without pretending to
 * a precision a test cannot measure.
 */
export const MIN_DESCRIPTION = 60;

/** The items table is the one table on the page with a header row. */
export function itemsTable(def: unknown): { widths: (number | string)[] } {
  let found: { widths: (number | string)[] } | undefined;
  const walk = (n: any): void => {
    if (!n || typeof n !== 'object' || found) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.table?.headerRows && Array.isArray(n.table.widths)) { found = n.table; return; }
    for (const k of ['stack', 'columns', 'content', 'table', 'body']) if (n[k]) walk(n[k]);
  };
  walk((def as { content?: unknown }).content);
  assert.ok(found, 'no items table in the document');
  return found;
}

/** What the `'*'` column is left with once every fixed width is paid for. */
export function descriptionShare(def: unknown): number {
  const widths = itemsTable(def).widths;
  const stars = widths.filter((w) => w === '*').length;
  assert.equal(stars, 1, 'Description is the only flexible column');
  const fixed = widths.reduce((sum: number, w) => sum + (typeof w === 'number' ? w : 0), 0);
  return CONTENT_WIDTH
    - fixed
    - widths.length * PADDING_PER_COLUMN
    - (widths.length + 1) * RULE_WIDTH;
}

/** Assert this document's table fits, naming the shortfall when it does not. */
export function assertFits(def: unknown, what: string): void {
  const share = descriptionShare(def);
  assert.ok(
    share >= MIN_DESCRIPTION,
    `${what}: Description is left ${share.toFixed(2)}pt, under the ${MIN_DESCRIPTION}pt it needs`
  );
}
