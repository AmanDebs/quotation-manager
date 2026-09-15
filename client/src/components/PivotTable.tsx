import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ReportPivotRow, ReportPivotTotals } from '../types';
import { Card, EmptyState, TH_CLASS } from './ui';
import { fmtMoneyRound } from '../lib/format';

/**
 * A pivot in the shape of the desk's own sheets: customer and SPOC down the
 * side, one column per key, a Total column, and a grand-total row. Every
 * figure is a link into the list it was summed from — the *linked version*
 * the client asked for — so a cell is never a dead end.
 *
 * Rows arrive already narrowed to one currency (the page chooses which, as
 * the dashboard does); `totals` is that currency's entry. Money prints to the
 * whole unit here and only here — a sheet of forty cells is read for its
 * shape, and the paise are on the document a cell links to.
 */
export function PivotTable({ columns, rows, totals, currency, rowHref, cellHref, totalHref, emptyMessage, footnote, subtotalBySpoc }: {
  columns: { key: string; label: string; title?: string }[];
  rows: ReportPivotRow[];
  totals?: ReportPivotTotals;
  currency: string;
  /** The customer label's target. */
  rowHref: (r: ReportPivotRow) => string;
  /** A cell's target — the list narrowed to that customer and that column. */
  cellHref: (r: ReportPivotRow, col: string) => string;
  /** The row's Total target; the customer's whole list. */
  totalHref?: (r: ReportPivotRow) => string;
  emptyMessage: string;
  footnote?: ReactNode;
  /**
   * Group the rows by SPOC with a *Meisha Total* line closing each group —
   * the collapsed reading of the desk's own pivot, which is per person.
   */
  subtotalBySpoc?: boolean;
}) {
  if (rows.length === 0) return <Card><EmptyState message={emptyMessage} /></Card>;
  const num = 'whitespace-nowrap py-1.5 pr-3 text-right tabular-nums';
  const dot = <span className="text-slate-300">·</span>;
  const ordered = subtotalBySpoc
    ? [...rows].sort((a, b) => a.spoc.localeCompare(b.spoc) || a.customer_name.localeCompare(b.customer_name))
    : rows;
  /** A subtotal line over one SPOC's rows, in the shape of the grand total. */
  const subtotal = (spoc: string, group: ReportPivotRow[]) => (
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
        <tbody>
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
              ? subtotal(r.spoc, ordered.filter((x) => x.spoc === r.spoc))
              : null,
          ])}
        </tbody>
        {totals && (
          <tfoot>
            <tr className="border-t-2 border-slate-300 font-semibold">
              <td className="py-2 pr-3" colSpan={2}>Grand Total</td>
              {columns.map((c) => (
                <td key={c.key} className={num}>{totals.cells[c.key] ? fmtMoneyRound(totals.cells[c.key], currency) : dot}</td>
              ))}
              <td className={num}>{fmtMoneyRound(totals.total, currency)}</td>
            </tr>
          </tfoot>
        )}
      </table>
      {footnote && <p className="mt-2 text-xs text-slate-400">{footnote}</p>}
    </Card>
  );
}
