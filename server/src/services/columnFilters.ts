import { db } from '../db/connection.js';
import { countOf } from './pagination.js';

/**
 * A filter in a column heading, the way a spreadsheet does it — the mechanism,
 * kept apart from any one table's list of columns.
 *
 * It was written for the *Sales order lines* view (2026-09-24, the client:
 * *"Is it possible to add filter in header of each column like in excel"*) and
 * moved here when the Work Orders list was asked for the same thing
 * (2026-10-13: *"add filter to all columns in work order similar to sales
 * order"*). What is shared is every part that is **subtle rather than
 * particular**: that a blank cell is a tickable value and `IN` never matches
 * NULL, that a blank date falls in no range and SQLite will tell you otherwise,
 * that a tick list is measured over the whole filtered set with this column's
 * own filter left out, and that `%` and `_` in the search box are LIKE's own
 * wildcards. A second copy of any of those is how the two lists would come to
 * disagree about what a filter means.
 *
 * What is **not** shared is which columns a list offers and what each one
 * filters on: that stays beside the query whose aliases it names, or the two
 * drift the first time a column is renamed.
 */

export type FilterKind = 'values' | 'dates' | 'numbers';

export interface ColumnSpec {
  /**
   * The expression to filter on, written over the **outer** query's aliases
   * rather than over a table column — which is what lets one mechanism cover a
   * join, a COALESCE, a unit conversion and a correlated subquery alike.
   */
  sql: string;
  /** What the dropdown offers: a tick list, a pair of dates, or a pair of numbers. */
  kind: FilterKind;
  /**
   * The query-string key this column arrives under, where it is not the usual
   * `f.<column>`. It exists for the one case that matters: a column whose
   * filter the list *already had* under another spelling, which links from
   * elsewhere in the app carry. Reading that spelling into this column's own
   * tick list rather than applying it beside one is what keeps the dropdown
   * able to undo it — a second clause under a second key would be a filter the
   * control could not see or clear.
   */
  param?: string;
}

export type ColumnSpecs<K extends string = string> = Readonly<Record<K, ColumnSpec>>;

/**
 * The filters themselves, kept as a **description rather than as SQL** for the
 * reason `scopeClause` and `searchClause` are: the same object has to reach the
 * paged list, its count, any fold over it and the spreadsheet export, and a
 * second hand-built WHERE in any one of them is how the download comes to hold
 * rows the screen did not.
 */
export interface ColumnFilterSet<K extends string = string> {
  /** Tick lists, keyed by column. `''` is a real value and means *nothing recorded*. */
  values?: Partial<Record<K, string[]>>;
  /** `YYYY-MM-DD` bounds, keyed by column. Either end may stand alone. */
  from?: Partial<Record<K, string>>;
  to?: Partial<Record<K, string>>;
  /** Numeric bounds, keyed by column. */
  min?: Partial<Record<K, number>>;
  max?: Partial<Record<K, number>>;
}

export interface FacetValue {
  value: string;
  /** How many rows carry it, under every filter but this column's own. */
  count: number;
}

export interface Facet {
  values: FacetValue[];
  /** Distinct values there were before the cap; the panel says so when more. */
  total: number;
}

/** Is this a column the build knows? A link naming one it does not is ignored. */
export function isColumnOf<K extends string>(specs: ColumnSpecs<K>, v: unknown): v is K {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(specs, v);
}

/**
 * The column filters as SQL.
 *
 * `except` leaves one column's own filter out, which is what a tick list has to
 * be built against: Excel's dropdown offers the values still reachable given
 * every *other* filter, so that unticking something can put it back. Counting a
 * column against itself would leave each list showing only what was chosen.
 */
export function columnWhere<K extends string>(
  specs: ColumnSpecs<K>,
  c: ColumnFilterSet<K> | undefined,
  except?: K,
): { sql: string[]; params: unknown[] } {
  const sql: string[] = [];
  const params: unknown[] = [];
  if (!c) return { sql, params };

  for (const col of Object.keys(specs) as K[]) {
    if (col === except) continue;
    const { sql: expr, kind } = specs[col];

    if (kind === 'values') {
      const picked = c.values?.[col];
      if (picked?.length) {
        // A blank cell is a real answer — *no colour*, *nobody recorded* — and
        // is offered in the list as such, so it has to be tickable. `IN` never
        // matches NULL, hence the explicit arm.
        const blanks = picked.some((v) => v === '');
        const named = picked.filter((v) => v !== '');
        const arms: string[] = [];
        if (named.length) { arms.push(`(${expr}) IN (${named.map(() => '?').join(', ')})`); params.push(...named); }
        if (blanks) arms.push(`COALESCE(${expr}, '') = ''`);
        sql.push(`(${arms.join(' OR ')})`);
      }
      continue;
    }

    const from = kind === 'dates' ? c.from?.[col] : c.min?.[col];
    const to = kind === 'dates' ? c.to?.[col] : c.max?.[col];
    const bounded = (from !== undefined && from !== '') || (to !== undefined && to !== '');

    /*
     * A blank date falls in no range at all, and it has to be said rather than
     * assumed: a date is stored as text, so SQLite compares `''` as a string
     * and `'' <= '2026-09-25'` is **true** — an upper bound alone would have
     * returned every row with no date in that column at all, which on the live
     * book is most of them. Found by the test written to assert the opposite.
     * A blank number is already excluded without help, NULL failing every
     * comparison, so the guard is the dates' own.
     */
    if (bounded && kind === 'dates') sql.push(`COALESCE(${expr}, '') <> ''`);
    if (from !== undefined && from !== '') { sql.push(`(${expr}) >= ?`); params.push(from); }
    if (to !== undefined && to !== '') { sql.push(`(${expr}) <= ?`); params.push(to); }
  }
  return { sql, params };
}

/**
 * The header filters, read off the query string.
 *
 * One key per column and per end — `f.customer`, `f.date_from`, `f.qty_max` —
 * so a filtered list is a URL somebody can bookmark or send, which is what the
 * rest of these pages' filters already are. A tick list arrives as a
 * **newline-separated** list rather than a comma-separated one: these values
 * are customer names and item descriptions off the client's own book, and
 * *Bisleri International Pvt. Ltd., Kolkata* is one value containing a comma.
 *
 * A column this build does not know is ignored rather than refused: the
 * vocabulary is the code's, and a link from an older client must not 400.
 */
export function readColumnFilters<K extends string>(
  query: Record<string, unknown>,
  specs: ColumnSpecs<K>,
): ColumnFilterSet<K> {
  const values: ColumnFilterSet<K>['values'] = {};
  const from: ColumnFilterSet<K>['from'] = {};
  const to: ColumnFilterSet<K>['to'] = {};
  const min: ColumnFilterSet<K>['min'] = {};
  const max: ColumnFilterSet<K>['max'] = {};

  const read = (key: string) => {
    const raw = query[key];
    return typeof raw === 'string' ? raw : undefined;
  };

  for (const col of Object.keys(specs) as K[]) {
    const { kind, param } = specs[col];
    const base = param ?? `f.${col}`;
    if (kind === 'values') {
      const raw = read(base);
      /*
       * **Present and empty is not the same as absent.** A blank cell is a
       * tickable value — *no colour*, *no port*, *nobody recorded* — and on
       * these books a common one, so `f.color=` means *the blank one* and no
       * key at all means no filter. Reading an empty string as "no filter" is
       * what would silently drop that tick on the round trip through the URL,
       * which is where it would have been noticed last.
       */
      if (raw !== undefined) values[col] = raw.split('\n').filter((v, i, a) => a.indexOf(v) === i);
      continue;
    }
    const lo = read(`${base}_from`) ?? read(`${base}_min`);
    const hi = read(`${base}_to`) ?? read(`${base}_max`);
    if (kind === 'dates') {
      if (lo) from[col] = lo;
      if (hi) to[col] = hi;
    } else {
      if (lo !== undefined && lo !== '' && Number.isFinite(Number(lo))) min[col] = Number(lo);
      if (hi !== undefined && hi !== '' && Number.isFinite(Number(hi))) max[col] = Number(hi);
    }
  }
  return { values, from, to, min, max };
}

/**
 * What one column's tick list should offer, over a statement already narrowed
 * by every *other* filter.
 *
 * **Measured over the whole filtered set, never the page on screen**, which is
 * the entire reason this is a server endpoint rather than a walk over the rows
 * the client already holds: these lists are paged, so a list built from them
 * would offer the fifty customers on page one and silently hide the rest.
 *
 * `search` narrows on the server too, for the same reason. The live book names
 * 820 customers; a cap with a client-side search box would be a list that stops
 * finding things at an arbitrary depth, and this desk would meet that on the
 * first column they opened.
 */
export function facetOver(
  sql: string,
  params: unknown[],
  expr: string,
  opts: { search?: string; limit?: number } = {},
): Facet {
  const args = [...params];

  let having = '';
  const search = String(opts.search ?? '').trim();
  if (search) {
    // `%` and `_` are LIKE's own wildcards — escaped for the reason
    // `searchClause` records, so typing one finds the character.
    having = " WHERE value LIKE ? ESCAPE '\\'";
    args.push(`%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  }

  const base = `SELECT COALESCE(${expr}, '') AS value, COUNT(*) AS n FROM (${sql}) v GROUP BY value`;
  const counted = `SELECT value, n FROM (${base})${having}`;

  const total = countOf(counted, args);
  const limit = opts.limit ?? 300;
  const rows = db.prepare(
    // Commonest first, so a capped list is the useful end of it; then by name,
    // which is a total ordering and so a stable one.
    `${counted} ORDER BY n DESC, value LIMIT ?`
  ).all(...([...args, limit] as never[])) as { value: string; n: number }[];

  return { values: rows.map((r) => ({ value: String(r.value), count: Number(r.n) })), total };
}
