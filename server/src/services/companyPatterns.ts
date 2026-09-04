/**
 * What a *new* company in the group numbers its documents with.
 *
 * The counters were already per company — `sequences` is keyed on
 * (company_id, doc_type, year) and every entity starts at 001, which is right:
 * a GST-registered company keeps one consecutive series per GSTIN, and sharing
 * a series across the group would leave gaps in each one's books. The half
 * that was missing is that a company created through `POST /api/companies`
 * inherited the *pattern* columns' schema defaults, which are Aglo's own
 * paperwork — `AGLO/PI/{FY}/{SEQ}`, `AP/{SEQ4}/{FY}`. So the second entity's
 * first proforma came out `AGLO/PI/26-27/001`, character for character the
 * same as the first entity's, carrying another company's name in its number.
 *
 * Nothing refused it, and nothing could: uniqueness is per company by design,
 * exactly so that two entities may both hold a 001. The restart was working
 * perfectly and was invisible, which is the worst way for it to work.
 *
 * So a new company derives its patterns from its own name. The derivation is
 * checked against the one set of real patterns we have: "Aglo Polymers Pvt
 * Ltd" gives slug AGLO and initials AP, which is precisely how Aglo's own
 * documents are numbered. That is a sanity check, not a coincidence — the
 * conventions on this desk are the first word for a long series and the
 * initials for the invoice, and following them is what makes a derived number
 * look like something a person would have chosen.
 *
 * Pure on purpose — no database import. `db/connection.ts` needs this for its
 * one-off backfill and `services/numbering.ts` imports `db` from that file, so
 * putting it there would close a circle. Same trap `documentChain.ts` already
 * has to work around.
 */

/**
 * Words that say what kind of company it is rather than which one, dropped
 * before the name is read. `co` is in the list at the cost of mangling a
 * "Co-operative", which is the cheaper mistake: leaving it in turns every
 * "… & Co" into initials ending in C.
 */
const LEGAL_FORM = new Set([
  'pvt', 'private', 'ltd', 'limited', 'llp', 'plc', 'inc', 'incorporated',
  'corp', 'corporation', 'co', 'company', 'gmbh', 'llc', 'sarl', 'bv', 'nv',
  'fze', 'fzco', 'fzc', 'dmcc', 'sa', 'ag', 'and', 'the',
]);

/** The two tokens a pattern can be built from. */
export function nameTokens(name: string): { slug: string; initials: string } {
  const words = String(name ?? '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .filter((w) => !LEGAL_FORM.has(w.toLowerCase()));

  // A company with nothing usable in its name still has to be numbered.
  if (!words.length) return { slug: 'CO', initials: 'CO' };

  const initials = words.length > 1
    ? words.map((w) => w[0]).join('').toUpperCase().slice(0, 4)
    : words[0].toUpperCase().slice(0, 2);
  // Six characters is AGLO with room; a one-letter first word ("A P Traders")
  // makes a series nobody can read, so it falls back to the initials.
  const first = words[0].toUpperCase().slice(0, 6);
  return { slug: first.length >= 2 ? first : initials, initials };
}

/** Every pattern column, in the order Settings shows them. */
export const PATTERN_COLUMNS = [
  'quote_pattern', 'pi_pattern', 'pi_export_pattern', 'inv_pattern', 'inv_export_pattern',
  'pl_pattern', 'order_pattern', 'order_export_pattern', 'wo_pattern', 'po_pattern', 'po_import_pattern',
] as const;

export type PatternColumn = (typeof PATTERN_COLUMNS)[number];

/**
 * The schema's own defaults, repeated here so the backfill can tell a company
 * that was never configured from one somebody deliberately set. Keep in step
 * with the `companies` table in `db/schema.sql`; the test asserts they match.
 */
export const SCHEMA_DEFAULT_PATTERNS: Record<PatternColumn, string> = {
  quote_pattern: 'QT/{FY}/{SEQ}',
  pi_pattern: 'AGLO/PI/{FY}/{SEQ}',
  pi_export_pattern: 'AGLO/EX/{FY}/{SEQ}',
  inv_pattern: 'AP/{SEQ4}/{FY}',
  inv_export_pattern: 'AP/EX/{SEQ}/{FY}',
  pl_pattern: 'PL/{FY}/{SEQ}',
  order_pattern: 'SO/{FY}/{SEQ}',
  order_export_pattern: 'SO-EX/{FY}/{SEQ}',
  wo_pattern: 'WO/{FY}/{SEQ}',
  po_pattern: 'PO/{FY}/{SEQ}',
  po_import_pattern: 'PO-IMP/{FY}/{SEQ}',
};

/**
 * Every series prefixed with the company's own token, so a number says which
 * entity issued it before anybody has to look it up. The invoice keeps the
 * initials-and-{SEQ4} shape Aglo's domestic book uses, and the export invoice
 * the sequence-before-the-year shape — those are how they are written here,
 * not a slip.
 */
export function defaultPatternsFor(name: string): Record<PatternColumn, string> {
  const { slug, initials } = nameTokens(name);
  return {
    quote_pattern: `${slug}/QT/{FY}/{SEQ}`,
    pi_pattern: `${slug}/PI/{FY}/{SEQ}`,
    pi_export_pattern: `${slug}/EX/{FY}/{SEQ}`,
    inv_pattern: `${initials}/{SEQ4}/{FY}`,
    inv_export_pattern: `${initials}/EX/{SEQ}/{FY}`,
    pl_pattern: `${slug}/PL/{FY}/{SEQ}`,
    order_pattern: `${slug}/SO/{FY}/{SEQ}`,
    order_export_pattern: `${slug}/SO-EX/{FY}/{SEQ}`,
    wo_pattern: `${slug}/WO/{FY}/{SEQ}`,
    po_pattern: `${slug}/PO/{FY}/{SEQ}`,
    po_import_pattern: `${slug}/PO-IMP/{FY}/{SEQ}`,
  };
}
