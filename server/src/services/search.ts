/**
 * The text search a document list offers, in one place.
 *
 * Shaped like `scopeClause` in middleware/scope.ts — it hands back `{ sql,
 * params }` for the caller to push onto its own WHERE, rather than trying to
 * own the query. Every list builds its filters the same way, and a search that
 * assembled the whole statement would be the one filter that did not.
 *
 * **`%` and `_` are LIKE's own wildcards.** Typing either matched every row
 * instead of the character somebody typed, so the term is escaped and the
 * ESCAPE clause beside each LIKE declares the escape character. Aglo's
 * document numbers and customer names contain neither today, so this is
 * correctness ahead of need rather than a fix to anything observed — but the
 * moment search covers a description or a note it stops being hypothetical.
 * Parameters are bound either way, so injection was never the concern.
 *
 * Note the backslash needs no doubling in SQL: it is a plain character in the
 * string literal `'\'`, and only means anything because ESCAPE names it.
 */

const ESCAPE_CHAR = '\\';

/** Wrap a term for a substring LIKE, with the wildcards in it made literal. */
export function likeTerm(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (ch) => ESCAPE_CHAR + ch);
  return `%${escaped}%`;
}

/**
 * An OR of LIKE tests across `columns`, plus the params to bind to it.
 * Returns empty sql for a blank term, so a caller can push unconditionally.
 */
export function searchClause(
  columns: string[],
  term: string
): { sql: string; params: string[] } {
  const trimmed = term.trim();
  if (!trimmed || columns.length === 0) return { sql: '', params: [] };
  const tests = columns.map((col) => `${col} LIKE ? ESCAPE '${ESCAPE_CHAR}'`);
  return {
    sql: `(${tests.join(' OR ')})`,
    params: columns.map(() => likeTerm(trimmed)),
  };
}
