import { useSearchParams } from 'react-router-dom';
import { isFiltered, type ColumnFilterValue, type FilterKind } from '../components/ColumnFilter';

/**
 * The header filters of a list, held in the URL.
 *
 * Written for the order book (2026-09-24, the client: *"Is it possible to add
 * filter in header of each column like in excel"*) and moved here when the Work
 * Orders list was asked for the same thing (2026-10-13). Both pages keep their
 * filters in the URL, so a filtered list is a link somebody can bookmark or
 * send — which is also what makes the spreadsheet download match the screen,
 * since the same keys reach the server for the rows, the counts and the file.
 *
 * A tick list is **newline** separated rather than comma separated: these
 * values are customer names and item descriptions off the client's own book,
 * and *Bisleri International Pvt. Ltd., Kolkata* is one value containing a
 * comma.
 */

export interface ColumnFilterSpec {
  /** The column's name, which is also the server's. */
  key: string;
  /** The heading's own words, for the panel's title and the strip. */
  label: string;
  kind: FilterKind;
  /**
   * The URL key this column uses, where it is not `f.<key>`. It exists for a
   * column whose filter the list already had under another spelling that links
   * from elsewhere in the app carry — reading that spelling as this column's
   * own is what keeps the dropdown able to clear it.
   */
  param?: string;
  /** What each stored value is called on screen, where the two differ. */
  labels?: Record<string, string>;
}

export interface ColumnFilters {
  /** What one column holds, or `undefined` when it holds nothing. */
  get: (key: string) => ColumnFilterValue | undefined;
  set: (key: string, v: ColumnFilterValue) => void;
  /** The columns with something set, for the strip above the table. */
  filtered: ColumnFilterSpec[];
  clearAll: () => void;
  /** Every filter as query parameters, for the list, its count and the download. */
  params: URLSearchParams;
}

export function useColumnFilters(specs: readonly ColumnFilterSpec[]): ColumnFilters {
  const [search, setSearch] = useSearchParams();
  const byKey = new Map(specs.map((c) => [c.key, c]));
  const base = (key: string) => byKey.get(key)?.param ?? `f.${key}`;

  /** The URL keys one column owns, so clearing it clears all of them. */
  const keysOf = (key: string): string[] => {
    const kind = byKey.get(key)?.kind;
    const b = base(key);
    return kind === 'values' ? [b]
      : kind === 'dates' ? [`${b}_from`, `${b}_to`]
        : [`${b}_min`, `${b}_max`];
  };

  /*
   * A tick list is **present-and-empty when the blank value alone is ticked**
   * — `f.color=` means *the rows with no colour*, and no key at all means no
   * filter. `URLSearchParams.get` tells the two apart (`''` against `null`),
   * which is why `useUrlFilter` cannot be reused to write them: it drops an
   * empty value, and that would silently throw the blank tick away on the round
   * trip somebody makes by copying the link.
   */
  const get = (key: string): ColumnFilterValue | undefined => {
    if (byKey.get(key)?.kind === 'values') {
      const raw = search.get(base(key));
      return raw === null ? undefined : { values: raw.split('\n') };
    }
    const [lo, hi] = keysOf(key);
    const from = search.get(lo) ?? '';
    const to = search.get(hi) ?? '';
    return from || to ? { from, to } : undefined;
  };

  /** Write one column's filter into `params`, in the shape the server reads. */
  const write = (params: URLSearchParams, key: string, v: ColumnFilterValue) => {
    if (byKey.get(key)?.kind === 'values') {
      if (v.values?.length) params.set(base(key), v.values.join('\n'));
    } else {
      const [lo, hi] = keysOf(key);
      if (v.from) params.set(lo, v.from);
      if (v.to) params.set(hi, v.to);
    }
  };

  const set = (key: string, v: ColumnFilterValue) => {
    const next = new URLSearchParams(search);
    for (const k of keysOf(key)) next.delete(k);
    write(next, key, v);
    // Narrowing a list while sitting on page seven would otherwise show an
    // empty table, which reads as a fault rather than as a filter.
    next.delete('page');
    setSearch(next, { replace: true });
  };

  const clearAll = () => {
    const next = new URLSearchParams(search);
    for (const c of specs) for (const k of keysOf(c.key)) next.delete(k);
    next.delete('page');
    setSearch(next, { replace: true });
  };

  const params = new URLSearchParams();
  for (const c of specs) {
    const v = get(c.key);
    if (v) write(params, c.key, v);
  }

  return { get, set, filtered: specs.filter((c) => isFiltered(get(c.key))), clearAll, params };
}

