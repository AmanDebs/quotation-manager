import { useEffect, useRef } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUrlFilter } from './useUrlFilter';

/**
 * A list that arrives one page at a time.
 *
 * The server pages **only when asked** (see `services/pagination.ts`), so a
 * picker that needs every customer keeps calling the plain endpoint and keeps
 * getting an array. A screen that shows a list to a person asks, via this.
 *
 * Everything a pager gets wrong is handled here once rather than in each of
 * the dozen list pages:
 *
 * - **The page lives in the URL**, like the filters, so a link to page 3 of
 *   the invoices is a link to page 3 of the invoices.
 * - **Changing a filter returns you to page 1.** Filtering a list down to four
 *   rows while sitting on page seven shows an empty table, which reads as a
 *   fault rather than as a filter. The reset is driven off the query key
 *   changing, so it covers filters held in plain component state as well as
 *   the ones in the URL — and it takes effect in the same render, so the
 *   discarded page is never fetched.
 * - **The previous page stays on screen while the next one loads**
 *   (`keepPreviousData`), so paging does not flash an empty table between
 *   clicks.
 * - **The served page wins.** Ask for page 99 of 3 and the server sends page 3
 *   rather than nothing; the effect below puts the URL back in step, or the
 *   arrows would count from a page that does not exist.
 */

export interface Paged<T, S = never> {
  rows: T[];
  total: number;
  page: number;
  pages: number;
  limit: number;
  /**
   * Figures over the whole filtered set, for lists whose header adds their
   * rows up. A page total wearing the words of a whole-list total is worse
   * than no total, so the two endpoints with such a strip — despatches and
   * work orders — send theirs from the server.
   */
  summary?: S;
}

/** Matches the server's default. A page is a screenful and a bit. */
export const PAGE_SIZE = 50;

/** The page number, in the URL. 1-based, and 1 when absent. */
export function usePage(): [number, (n: number) => void] {
  const [raw, setRaw] = useUrlFilter('page');
  const page = Math.max(1, Math.floor(Number(raw)) || 1);
  return [page, (n: number) => setRaw(n <= 1 ? '' : String(n))];
}

export interface PagedList<T, S = never> {
  rows: T[];
  total: number;
  page: number;
  pages: number;
  setPage: (n: number) => void;
  isPending: boolean;
  isFetching: boolean;
  summary?: S;
}

/**
 * `key` is the query key without the page — the page is appended here so every
 * list keys the same way. `url` is the endpoint with its filters already on
 * it; `page` and `limit` are added. `enabled` is for a page that holds several
 * lists and shows one at a time, like the order book's three views.
 */
export function usePagedList<T, S = never>(
  key: readonly unknown[],
  url: string,
  opts: { limit?: number; enabled?: boolean } = {},
): PagedList<T, S> {
  const limit = opts.limit ?? PAGE_SIZE;
  const enabled = opts.enabled ?? true;
  const [urlPage, setPage] = usePage();

  // A different key means a different list, and page 7 of the old one means
  // nothing in the new one. Noticed during the render that first sees the new
  // key, so this render already asks for page 1; the effect below only tidies
  // the URL to match, rather than provoking a second fetch.
  const keyId = JSON.stringify(key);
  const lastKey = useRef(keyId);
  const listChanged = lastKey.current !== keyId;
  const page = listChanged ? 1 : urlPage;

  const query = useQuery({
    queryKey: [...key, page, limit],
    queryFn: () => api.get<Paged<T, S>>(`${url}${url.includes('?') ? '&' : '?'}page=${page}&limit=${limit}`),
    placeholderData: keepPreviousData,
    enabled,
  });

  useEffect(() => {
    lastKey.current = keyId;
    if (listChanged && urlPage !== 1) setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyId]);

  const served = query.data?.page;
  useEffect(() => {
    if (served !== undefined && served !== page) setPage(served);
    // Only when the server says it served a different page; setPage is stable
    // enough for this and including it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [served]);

  return {
    rows: query.data?.rows ?? [],
    total: query.data?.total ?? 0,
    pages: query.data?.pages ?? 1,
    page: served ?? page,
    setPage,
    isPending: query.isPending,
    isFetching: query.isFetching,
    summary: query.data?.summary,
  };
}
