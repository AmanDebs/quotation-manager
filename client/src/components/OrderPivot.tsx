import { Link } from 'react-router-dom';
import type { OrderPivot as Pivot, OrderPivotRow, PivotDimension } from '../types';
import { Card, EmptyState, TH_CLASS, CAPTION_CLASS } from './ui';
import { fmtMoneyRound, fmtQty, monthLabel, monthEnd } from '../lib/format';

/**
 * The order book folded whichever way was asked for.
 *
 * Deliberately **not** `PivotTable`, which the three Reports sheets use: that
 * one hard-codes *Customer* and *SPOC* as its first two headings, takes a row
 * type that names a customer by id, and links its cells into proformas and
 * receivables. They are two different tables — three fixed sheets against one
 * configurable grid — and what they share is already shared (`Card`,
 * `EmptyState`, `TH_CLASS`, the money formatter). The three sheets are
 * untouched by this.
 *
 * Two rules it keeps from them. **Every figure is a link** into the order
 * book narrowed to that cell, so a total is never a dead end — and where a
 * dimension is not one of the book's own filters the cell is plain text
 * rather than a link that goes somewhere wrong. And **money is drawn once per
 * currency**, as a grid each, because money only adds up within one: a
 * selector would hide the rest behind a control, where stacked sheets put the
 * rule on the page.
 */

/**
 * The tail of a capped column axis — `PIVOT_OTHER` on the server. A value
 * read off a row cannot contain NUL, so the two cannot collide. Known here
 * for the same reason the client knows a tick list is newline-separated: it
 * is the shape of the wire, not a second copy of a rule.
 */
const OTHER = '\u0000';

export function OrderPivot({ pivot, params, label }: {
  pivot: Pivot;
  /** The book's current filters, so drilling through keeps them. */
  params: URLSearchParams;
  /** How a raw value reads — the page owns the vocabulary for its own pills. */
  label: (dim: string, value: string) => string;
}) {
  const dim = (key: string) => pivot.dimensions.find((d) => d.key === key);
  const rowDims = pivot.rows.map(dim).filter((d): d is PivotDimension => !!d);
  const colDim = dim(pivot.column);
  const measure = pivot.measures.find((m) => m.key === pivot.measure);
  const num = 'whitespace-nowrap py-1.5 pr-3 text-right tabular-nums';
  const dot = <span className="text-slate-300">·</span>;

  /** The heading over a column, which the server sends as a raw value. */
  const colLabel = (key: string) => {
    if (key === OTHER) return `Other (${pivot.folded})`;
    if (!colDim) return '';
    return colDim.kind === 'month' && key ? monthLabel(key) : label(colDim.key, key);
  };

  /**
   * Where a cell drills to: the lines view, narrowed by this row's own
   * dimensions and by the column. One `null` anywhere and the figure is drawn
   * as text — a link that quietly dropped half the narrowing would be worse
   * than no link, since the list behind it would not add up to the cell.
   */
  const href = (row: OrderPivotRow, colKey?: string): string | null => {
    const q = new URLSearchParams(params);
    q.set('view', 'lines');
    q.delete('page');
    const apply = (d: PivotDimension, value: string): boolean => {
      if (!d.param) return false;
      if (d.kind === 'month') {
        // "No date" is not something the book can be filtered to.
        if (!value) return false;
        q.set(`${d.param}_from`, `${value}-01`);
        q.set(`${d.param}_to`, monthEnd(value));
        return true;
      }
      // A tick list takes a blank as a real value — the rows with nothing
      // recorded — where a plain parameter cannot say that.
      if (d.kind === 'plain' && !value) return false;
      q.set(d.param, value);
      return true;
    };
    for (const [i, d] of rowDims.entries()) if (!apply(d, row.keys[i] ?? '')) return null;
    if (colKey != null) {
      if (colKey === OTHER || !colDim) return null;
      if (!apply(colDim, colKey)) return null;
    }
    return `/orders?${q}`;
  };

  const show = (v: number | undefined, currency: string) => {
    if (!v) return dot;
    return measure?.money ? fmtMoneyRound(v, currency) : fmtQty(v);
  };

  /** A figure, as a link where the cell can be reached and text where it cannot. */
  const figure = (
    v: number | undefined, currency: string, to: string | null, title: string, bold = false,
  ) => {
    const body = show(v, currency);
    if (!v || !to) return <span className={bold ? 'font-semibold' : undefined}>{body}</span>;
    return (
      <Link
        to={to}
        title={title}
        className={`rounded px-1 hover:bg-brand-50 hover:text-brand-700${bold ? ' font-semibold' : ''}`}
      >
        {body}
      </Link>
    );
  };

  const lines = (n: number) => `${fmtQty(n)} line${n === 1 ? '' : 's'} — open them`;

  if (!pivot.grids.length) {
    return (
      <Card>
        <EmptyState message="Nothing to fold. Clear a filter, or widen the search." />
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {pivot.grids.map((g) => (
        <Card key={g.currency || 'all'} className="overflow-x-auto">
          {/* Only where it means something: a sheet of pieces is drawn once. */}
          {pivot.money && (
            <p className={`${CAPTION_CLASS} mb-2`}>{g.currency || '—'}</p>
          )}
          <table className="w-full text-xs">
            <thead>
              <tr className={TH_CLASS}>
                {rowDims.map((d) => <th key={d.key} className="pb-2 pr-3">{d.label}</th>)}
                {pivot.columns.map((c) => (
                  <th key={c} className="whitespace-nowrap pb-2 pr-3 text-right" title={c || 'Nothing recorded'}>
                    {colLabel(c)}
                  </th>
                ))}
                <th className="whitespace-nowrap pb-2 pr-3 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r, i) => (
                <tr key={r.keys.join('\u0001')} className="border-b border-slate-100 hover:bg-slate-50">
                  {rowDims.map((d, j) => {
                    // A repeated first level recedes rather than repeating at
                    // full strength — the order book's own rule about its
                    // order number down a group.
                    const same = i > 0 && g.rows[i - 1].keys[j] === r.keys[j]
                      && rowDims.slice(0, j).every((_, k) => g.rows[i - 1].keys[k] === r.keys[k]);
                    const text = r.keys[j]
                      ? (d.kind === 'month' ? monthLabel(r.keys[j]) : label(d.key, r.keys[j]))
                      : (d.kind === 'month' ? 'Not dated' : '(blank)');
                    return (
                      <td
                        key={d.key}
                        className={`max-w-[16rem] truncate py-1.5 pr-3 ${same ? 'text-slate-300' : 'font-medium'}`}
                        title={text}
                      >
                        {text}
                      </td>
                    );
                  })}
                  {pivot.columns.map((c) => (
                    <td key={c} className={num}>
                      {figure(r.cells[c], g.currency, href(r, c), lines(r.counts[c] ?? 0))}
                    </td>
                  ))}
                  <td className={num}>{figure(r.total, g.currency, href(r), lines(r.count), true)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-semibold">
                <td className="py-2 pr-3" colSpan={rowDims.length}>Grand Total</td>
                {pivot.columns.map((c) => (
                  <td key={c} className={num}>{show(g.cells[c], g.currency)}</td>
                ))}
                <td className={num}>{show(g.total, g.currency)}</td>
              </tr>
            </tfoot>
          </table>
        </Card>
      ))}
      <p className="text-xs text-slate-400">
        {measure?.label} over {fmtQty(pivot.lines)} order line{pivot.lines === 1 ? '' : 's'}
        {pivot.money && pivot.grids.length > 1
          ? ' — one sheet per currency, because money only adds up within one.'
          : '.'}
        {pivot.folded > 0 && (
          <> {' '}The {pivot.folded} smallest column{pivot.folded === 1 ? '' : 's'} are gathered
            into <em>Other</em>, which is counted but not broken down.
          </>
        )}
        {pivot.measure === 'orders' && (
          <> {' '}A sales order is counted once in each cell however many of its lines fall there,
            so the figures do not add across cells.
          </>
        )}
      </p>
    </div>
  );
}
