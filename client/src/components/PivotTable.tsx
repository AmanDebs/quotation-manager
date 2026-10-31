import { Link } from 'react-router-dom';
import type { ReportPivotRow, ReportPivotTotals } from '../types';
import { Card, EmptyState, TH_CLASS, BAND_CLASS } from './ui';
import { fmtMoneyRound } from '../lib/format';

/** One currency's block of the sheet: its rows, and its own grand total. */
export interface PivotSheet {
  currency: string;
  rows: ReportPivotRow[];
  totals?: ReportPivotTotals;
}

/**
 * A pivot in the shape of the desk's own sheets: customer and SPOC down the
 * side, one column per key, a Total column, and a grand-total row. Every
 * figure is a link into the list it was summed from — the *linked version*
 * the client asked for — so a cell is never a dead end.
 *
 * **One table, a block per currency**, because money only adds up within one
 * and the page draws every currency rather than putting the rest behind a
 * selector. A card each was the first shape and the render refused it: each
 * table sizes its own columns, so three sheets of the same twelve dates had
 * SPOC starting at 482, 433 and 477 — a stack you cannot read down. One
 * table is one set of column widths by construction, and each block still
 * closes on its own Grand Total, never a figure added across them.
 *
 * Money prints to the whole unit here and only here: a sheet of forty cells
 * is read for its shape, and the paise are on the document a cell links to.
 * The sentence under the sheet belongs to the page, not to this.
 */
export interface PivotTableProps {
  columns: { key: string; label: string; title?: string }[];
  /** The blocks, in the order they should be read — biggest book first. */
  sheets: PivotSheet[];
  /**
   * Name each block's currency over it. False where the book is in one
   * currency: the control row says so once, and a heading over the only
   * block there is would be saying it twice.
   */
  named: boolean;
  /** The customer label's target. */
  rowHref: (r: ReportPivotRow) => string;
  /** A cell's target — the list narrowed to that customer and that column. */
  cellHref: (r: ReportPivotRow, col: string) => string;
  /** The row's Total target; the customer's whole list. */
  totalHref?: (r: ReportPivotRow) => string;
  emptyMessage: string;
  /**
   * Group the rows by SPOC with a *Meisha Total* line closing each group —
   * the collapsed reading of the desk's own pivot, which is per person.
   */
  subtotalBySpoc?: boolean;
}

export function PivotTable({
  columns, sheets, named, rowHref, cellHref, totalHref, emptyMessage, subtotalBySpoc,
}: PivotTableProps) {
  const blocks = sheets.filter((s) => s.rows.length > 0);
  if (blocks.length === 0) return <Card><EmptyState message={emptyMessage} /></Card>;
  const num = 'whitespace-nowrap py-1.5 pr-3 text-right tabular-nums';
  const dot = <span className="text-slate-300">·</span>;
  const span = columns.length + 3;

  /** A subtotal line over one SPOC's rows, in the shape of the grand total. */
  const subtotal = (currency: string, spoc: string, group: ReportPivotRow[]) => (
    <tr key={`sub|${spoc}`} className="border-b border-slate-200 bg-slate-50 font-semibold">
      <td className="py-1.5 pr-3" colSpan={2}>{spoc || '—'} Total</td>
      {columns.map((c) => {
        const v = group.reduce((n, r) => n + (r.cells[c.key] ?? 0), 0);
        return <td key={c.key} className={num}>{v ? fmtMoneyRound(v, currency) : dot}</td>;
      })}
      <td className={num}>{fmtMoneyRound(group.reduce((n, r) => n + r.total, 0), currency)}</td>
    </tr>
  );

  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className={TH_CLASS}>
            <th className="pb-2 pr-3">Customer</th>
            <th className="pb-2 pr-3">SPOC</th>
            {columns.map((c) => (
              <th key={c.key} className="whitespace-nowrap pb-2 pr-3 text-right" title={c.title}>{c.label}</th>
            ))}
            <th className="whitespace-nowrap pb-2 pr-3 text-right">Total</th>
          </tr>
        </thead>
        {blocks.map(({ currency, rows, totals }) => {
          const ordered = subtotalBySpoc
            ? [...rows].sort((a, b) => a.spoc.localeCompare(b.spoc) || a.customer_name.localeCompare(b.customer_name))
            : rows;
          return (
            <tbody key={currency || '(none)'}>
              {named && (
                <tr>
                  <td colSpan={span} className={BAND_CLASS}>{currency || '—'}</td>
                </tr>
              )}
              {ordered.map((r, i) => [
                <tr key={`${r.customer_id}|${r.spoc}`} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="whitespace-nowrap py-1.5 pr-3 font-medium">
                    <Link to={rowHref(r)} className="text-brand-600 hover:underline">{r.customer_name}</Link>
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-slate-500">{r.spoc || '—'}</td>
                  {columns.map((c) => {
                    const v = r.cells[c.key];
                    return (
                      <td key={c.key} className={num}>
                        {v ? (
                          <Link
                            to={cellHref(r, c.key)}
                            className="rounded px-1 hover:bg-brand-50 hover:text-brand-700"
                            title={`${r.counts[c.key] ?? 0} document${(r.counts[c.key] ?? 0) === 1 ? '' : 's'} — open the list`}
                          >
                            {fmtMoneyRound(v, currency)}
                          </Link>
                        ) : dot}
                      </td>
                    );
                  })}
                  <td className={`${num} font-semibold`}>
                    {totalHref
                      ? <Link to={totalHref(r)} className="rounded px-1 hover:bg-brand-50 hover:text-brand-700">{fmtMoneyRound(r.total, currency)}</Link>
                      : fmtMoneyRound(r.total, currency)}
                  </td>
                </tr>,
                // The group's subtotal after its last row.
                subtotalBySpoc && (i === ordered.length - 1 || ordered[i + 1].spoc !== r.spoc)
                  ? subtotal(currency, r.spoc, ordered.filter((x) => x.spoc === r.spoc))
                  : null,
              ])}
              {totals && (
                <tr className="border-t-2 border-slate-300 font-semibold">
                  <td className="py-2 pr-3" colSpan={2}>Grand Total{named ? ` — ${currency || '—'}` : ''}</td>
                  {columns.map((c) => (
                    <td key={c.key} className={num}>{totals.cells[c.key] ? fmtMoneyRound(totals.cells[c.key], currency) : dot}</td>
                  ))}
                  <td className={num}>{fmtMoneyRound(totals.total, currency)}</td>
                </tr>
              )}
            </tbody>
          );
        })}
      </table>
    </Card>
  );
}
