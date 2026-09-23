/**
 * The two things every spreadsheet import here has to do before it can do
 * anything useful: work out which column is which, and decide whether a name
 * in a cell is a record we already hold.
 *
 * Extracted from `orderImport.ts` when the customer import became the second
 * caller. It is deliberately **not** used by `productImport.ts`: that one
 * matches on any substring rather than on whole words, and its field order was
 * verified heading by heading against a real price list, so moving it onto
 * this would change what an import of the catalogue does for no reason anybody
 * asked for.
 */

export const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * A company name with the parts that are not the name taken out, so that
 * *Northern Traders Pvt. Ltd.* and *Northern Traders Pvt Ltd* reduce to one
 * key. Loose enough to survive punctuation and the suffix, and no looser — it
 * is only ever used where an ambiguous hit is refused rather than guessed.
 */
const NOISE = /\b(pvt|private|ltd|limited|llp|inc|co|company|corporation|and)\b/g;
export const loose = (s: string) => norm(s).replace(NOISE, ' ').replace(/[^a-z0-9]/g, '');

export interface SynonymField<K extends string> {
  key: K;
  /** Lower-cased headings, best first — an exact heading beats a partial one. */
  synonyms: string[];
}

/**
 * Best-guess column for each field.
 *
 * Fields are matched **in the order they are declared** and a claimed column
 * joins a `taken` set, so whoever is declared earlier wins an ambiguous
 * heading — which is why every caller's list is ordered deliberately and says
 * so. A partial match is on **whole words**: measured against the live order
 * book, a bare `po` matched *Transport* — "trans·po·rt" — and read the
 * customer's PO number out of a column holding freight notes.
 */
export function autoMapFields<K extends string>(
  headers: string[], fields: SynonymField<K>[]
): Partial<Record<K, number>> {
  const normalised = headers.map(norm);
  const taken = new Set<number>();
  const mapping: Partial<Record<K, number>> = {};

  for (const field of fields) {
    let bestIdx = -1;
    let bestScore = 0;
    normalised.forEach((h, i) => {
      if (!h || taken.has(i)) return;
      for (const syn of field.synonyms) {
        const score = h === syn ? 100 - field.synonyms.indexOf(syn)
          : ` ${h} `.includes(` ${syn} `) ? 50 - field.synonyms.indexOf(syn)
          : 0;
        if (score > bestScore) { bestScore = score; bestIdx = i; }
      }
    });
    if (bestIdx >= 0) { mapping[field.key] = bestIdx; taken.add(bestIdx); }
  }
  return mapping;
}

/**
 * Match a name against a book of them: the exact spelling first, then a loose
 * one — and a loose match that hits **more than one** record is refused rather
 * than guessed, because attaching an order to the wrong buyer, or merging two
 * customers into one, is not a thing anybody would notice afterwards.
 */
export function matchByName<T extends { id: number; name: string }>(
  text: string, rows: T[]
): { hit?: T; ambiguous?: boolean; exact?: boolean; near?: T[] } {
  const want = norm(text);
  if (!want) return {};
  const exact = rows.filter((r) => norm(r.name) === want);
  // The same spelling twice is a book that already holds a duplicate; either
  // row answers the question being asked here.
  if (exact.length) return { hit: exact[0], exact: true };
  const key = loose(text);
  if (!key) return {};
  const near = rows.filter((r) => loose(r.name) === key);
  if (near.length === 1) return { hit: near[0], near };
  if (near.length > 1) return { ambiguous: true, near };
  return {};
}
