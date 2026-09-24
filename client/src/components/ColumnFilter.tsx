import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Button } from './ui';

/**
 * A filter in a column heading, the way a spreadsheet does it (2026-09-24, the
 * client with the order book in front of them: *"Is it possible to add filter
 * in header of each column like in excel"*).
 *
 * **The list of values comes from the server, not from the rows on screen** —
 * which is the whole reason this is not fifty lines of client code. The order
 * book is paged, so a tick list built from what has been fetched would offer
 * the customers on page one and silently hide the other seven hundred, and
 * ticking one would filter a single page of a book somebody is trying to
 * search. Everything here is asked of `/orders/lines/facet` against the whole
 * filtered set, and the filters themselves ride in the URL like every other
 * filter this page has.
 *
 * **The panel is a portal on `<body>`.** The table sits in an `overflow-x-auto`
 * card and a scroll container clips on *both* axes, so a panel positioned
 * inside the heading would be cut off at the row below — the same trap
 * `SearchSelect` records, whose placement this borrows: measured in a layout
 * effect, re-placed on scroll (captured, so the table's own wrapper is heard)
 * and thrown away on close, so it can only ever draw where it was measured.
 */

export type FilterKind = 'values' | 'dates' | 'numbers';

export interface ColumnFilterValue {
  /** Ticked values. `''` is a real one and means *nothing recorded*. */
  values?: string[];
  from?: string;
  to?: string;
}

interface FacetValue { value: string; count: number }
interface Facet { values: FacetValue[]; total: number }

const BLANK_LABEL = '(blank)';

/** Is anything set on this column? Drives the tint on the heading. */
export function isFiltered(v: ColumnFilterValue | undefined): boolean {
  return !!(v && ((v.values && v.values.length) || v.from || v.to));
}

export function ColumnFilter({
  column, kind, label, value, onChange, query,
}: {
  column: string;
  kind: FilterKind;
  /** The heading's own words, for the panel's title and the button's tooltip. */
  label: string;
  value: ColumnFilterValue | undefined;
  onChange: (v: ColumnFilterValue) => void;
  /** Every other filter on the page, so the list offers reachable values only. */
  query: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<ColumnFilterValue>({});
  const [box, setBox] = useState<{ left: number; top: number; flip: boolean; max: number } | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const active = isFiltered(value);

  // Only while the panel is open, and keyed on the search term, so typing
  // narrows against the book rather than against the first 300 rows of it.
  const facetUrl = `/api/orders/lines/facet?column=${encodeURIComponent(column)}`
    + `${query ? `&${query}` : ''}${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ''}`;
  const { data: facet, isPending } = useQuery({
    queryKey: ['line-facet', column, query, search.trim()],
    queryFn: () => api.get<Facet>(facetUrl),
    enabled: open && kind === 'values',
    // The book does not change while a dropdown is open, and reopening the
    // same column twice in a row should not cost a round trip.
    staleTime: 30_000,
  });

  const place = useCallback(() => {
    const el = anchor.current;
    if (!el) return;
    const WANTED = kind === 'values' ? 340 : 190, GAP = 8, FLOOR = 150, WIDTH = 280;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - GAP;
    const above = r.top - GAP;
    const flip = below < WANTED && above > below;
    const room = flip ? above : below;
    setBox({
      left: Math.max(GAP, Math.min(r.left, window.innerWidth - WIDTH - GAP)),
      top: flip ? r.top - 2 : r.bottom + 4,
      flip,
      max: Math.max(FLOOR, Math.min(WANTED, room)),
    });
  }, [kind]);

  useLayoutEffect(() => {
    if (!open) { setBox(null); return; }
    place();
    const replace = () => place();
    window.addEventListener('scroll', replace, true);
    window.addEventListener('resize', replace);
    const outside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchor.current?.contains(t) || panel.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('scroll', replace, true);
      window.removeEventListener('resize', replace);
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', key);
    };
  }, [open, place]);

  const start = () => {
    // The panel edits a copy: a tick is not a fetch, so ten of them cost one
    // reload rather than ten, and Cancel is simply closing it.
    setDraft({ values: [...(value?.values ?? [])], from: value?.from ?? '', to: value?.to ?? '' });
    setSearch('');
    setOpen(true);
  };

  const apply = (v: ColumnFilterValue) => { onChange(v); setOpen(false); };

  const ticked = useMemo(() => new Set(draft.values ?? []), [draft.values]);
  const toggle = (v: string) => {
    const next = new Set(ticked);
    if (next.has(v)) next.delete(v); else next.add(v);
    setDraft((d) => ({ ...d, values: [...next] }));
  };

  const shown = facet?.values ?? [];
  const allShown = shown.length > 0 && shown.every((o) => ticked.has(o.value));

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => (open ? setOpen(false) : start())}
        title={active ? `${label} — filtered. Click to change.` : `Filter ${label}`}
        aria-label={`Filter ${label}`}
        className={`ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors ${
          active ? 'bg-brand-600 text-white' : 'text-slate-400 hover:bg-slate-200 hover:text-slate-600'
        }`}
      >
        {/* A funnel, drawn rather than typed — the sidebar's own rule about
            emoji: they carry their own colour and cannot tint with the state. */}
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor"
             strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 5h18l-7 8v6l-4 2v-8z" />
        </svg>
      </button>

      {open && box && createPortal(
        <div
          ref={panel}
          className="fixed z-50 w-[280px] rounded-lg border border-slate-200 bg-white p-2 shadow-xl"
          style={{
            left: box.left,
            top: box.flip ? undefined : box.top,
            bottom: box.flip ? window.innerHeight - box.top : undefined,
            maxHeight: box.max,
          }}
        >
          <div className="mb-1.5 flex items-baseline justify-between gap-2 px-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
            <button
              type="button"
              className="text-[11px] text-slate-400 hover:text-brand-600"
              onClick={() => apply({})}
            >
              Clear
            </button>
          </div>

          {kind === 'values' ? (
            <>
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search…"
                className="mb-1.5 w-full rounded-md border border-slate-200 px-2 py-1 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/25"
              />
              <div className="mb-1 flex items-center justify-between px-1 text-[11px] text-slate-400">
                <button
                  type="button"
                  className="hover:text-brand-600"
                  onClick={() =>
                    setDraft((d) => {
                      const next = new Set(d.values ?? []);
                      // Over what is *shown*, so it means what it says while a
                      // search is narrowing the list — and it adds to the ticks
                      // already made rather than replacing them.
                      if (allShown) shown.forEach((o) => next.delete(o.value));
                      else shown.forEach((o) => next.add(o.value));
                      return { ...d, values: [...next] };
                    })}
                >
                  {allShown ? 'Untick these' : 'Tick these'}
                </button>
                <span>{ticked.size > 0 ? `${ticked.size} ticked` : 'nothing ticked'}</span>
              </div>

              <div className="overflow-y-auto" style={{ maxHeight: box.max - 130 }}>
                {isPending ? (
                  <div className="px-1 py-2 text-sm text-slate-400">Reading the book…</div>
                ) : shown.length === 0 ? (
                  <div className="px-1 py-2 text-sm text-slate-400">Nothing matches that.</div>
                ) : (
                  shown.map((o) => (
                    <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-slate-50">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 shrink-0 accent-brand-600"
                        checked={ticked.has(o.value)}
                        onChange={() => toggle(o.value)}
                      />
                      <span className={`min-w-0 flex-1 truncate ${o.value === '' ? 'italic text-slate-400' : ''}`} title={o.value || BLANK_LABEL}>
                        {o.value === '' ? BLANK_LABEL : o.value}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-slate-400">{o.count}</span>
                    </label>
                  ))
                )}
              </div>

              {/* Said out loud rather than left to be discovered: the list is
                  capped, and on a book of 820 customers somebody would
                  otherwise conclude the missing ones are not there. */}
              {facet && facet.total > shown.length && (
                <div className="px-1 pt-1 text-[11px] text-slate-400">
                  {shown.length} of {facet.total} — type to find the rest
                </div>
              )}
            </>
          ) : (
            <div className="grid grid-cols-2 gap-2 px-1 pb-1">
              <label className="text-[11px] uppercase tracking-wide text-slate-500">
                From
                <input
                  autoFocus
                  type={kind === 'dates' ? 'date' : 'number'}
                  value={draft.from ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
                  className="mt-0.5 w-full rounded-md border border-slate-200 px-2 py-1 text-sm normal-case tracking-normal focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/25"
                />
              </label>
              <label className="text-[11px] uppercase tracking-wide text-slate-500">
                To
                <input
                  type={kind === 'dates' ? 'date' : 'number'}
                  value={draft.to ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
                  className="mt-0.5 w-full rounded-md border border-slate-200 px-2 py-1 text-sm normal-case tracking-normal focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/25"
                />
              </label>
              {kind === 'dates' && (
                <p className="col-span-2 text-[11px] text-slate-400">
                  Both ends count. A line with no date in this column is in no range.
                </p>
              )}
            </div>
          )}

          <div className="mt-1.5 flex justify-end gap-2 border-t border-slate-100 pt-1.5">
            <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setOpen(false)}>Cancel</Button>
            <Button className="px-2 py-1 text-xs" onClick={() => apply(draft)}>Apply</Button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
