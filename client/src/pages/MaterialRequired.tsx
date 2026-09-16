import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Location, MaterialSchedule } from '../types';
import { PageHeader, Card, Select, EmptyState, TH_CLASS } from '../components/ui';
import { fmtQty } from '../lib/format';
import { useUrlFilter } from '../lib/useUrlFilter';

/**
 * Raw material required, by start date — the client's own sheet (2026-09-14):
 * one row per material, a Total column, then a column per day carrying what
 * the jobs starting that day will consume. The server derives the lot
 * (`services/materialSchedule.ts`); this draws it in that shape.
 *
 * Two columns the sheet does not have, and why. **Not scheduled** holds the
 * need of jobs with no start date — a figure with no day is still resin to
 * buy, and folding it into today would put it on a day nobody chose. And a
 * **not costed** line names the jobs whose product has no recipe, because
 * their need is unknown rather than nothing, the rule every reader of
 * `hasRecipe: false` follows.
 *
 * A material row opens on click (2026-09-16, the client: *"by clicking the raw
 * material line we get the product which requires that material and
 * customer"*) and lists the jobs its figure is made of — job, product,
 * customer, sales order, start date, the pieces still to make and this
 * material's share of them. The server hands the list over with the row, so
 * the total above and the lines under it are one computation.
 */

/** `2026-09-15` → `15-Sep`, the sheet's own heading. */
function dayLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return m >= 1 && m <= 12 ? `${d}-${months[m - 1]}` : iso;
}

export default function MaterialRequiredPage() {
  const [location, setLocation] = useUrlFilter('location_id');
  const { data, isPending } = useQuery({
    queryKey: ['material-schedule', location],
    queryFn: () => api.get<MaterialSchedule>(`/api/stock/schedule${location ? `?location_id=${location}` : ''}`),
  });
  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });

  const rows = data?.rows ?? [];
  const dates = data?.dates ?? [];
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const toggle = (id: number) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const showUnscheduled = !!data?.has_unscheduled;
  // The material column, Total, one per date, and Not scheduled where drawn.
  const colCount = 2 + dates.length + (showUnscheduled ? 1 : 0);
  // The years, so a heading can be read across a year end without ambiguity.
  const years = [...new Set(dates.map((d) => d.slice(0, 4)))];

  return (
    <div>
      <PageHeader
        title="Raw Material Required"
        subtitle="What the open jobs will consume, by the day they start"
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select className="w-44" value={location} onChange={(e) => setLocation(e.target.value)}>
          <option value="">All plants</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
        {years.length > 1 && (
          <span className="text-sm text-slate-500">Dates run {years[0]} to {years[years.length - 1]}.</span>
        )}
      </div>

      <Card className="overflow-x-auto">
        {isPending ? (
          <div className="py-8 text-center text-sm text-slate-400">Loading…</div>
        ) : rows.length === 0 ? (
          <EmptyState message={data?.uncosted.length
            ? 'Nothing costed yet — the open jobs are for products with no recipe.'
            : 'No open jobs, so nothing is required.'} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className={TH_CLASS}>
                <th className="pb-2 pr-3">Raw material</th>
                <th className="pb-2 pr-3 text-right">Total</th>
                {dates.map((d) => (
                  <th key={d} className="whitespace-nowrap pb-2 pr-3 text-right" title={d}>{dayLabel(d)}</th>
                ))}
                {showUnscheduled && <th className="whitespace-nowrap pb-2 text-right">Not scheduled</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = open.has(r.material_id);
                return (
                <Fragment key={r.material_id}>
                <tr
                  className={`cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50 ${isOpen ? 'bg-slate-50' : ''}`}
                  onClick={() => toggle(r.material_id)}
                  title={isOpen ? 'Hide the jobs behind this figure' : 'Show the jobs behind this figure'}
                >
                  <td className="whitespace-nowrap py-2 pr-3 font-medium">
                    <span className={`mr-1.5 inline-block w-3 text-xs text-slate-400 transition-transform ${isOpen ? 'rotate-90' : ''}`}>▸</span>
                    {r.material_name}
                    <span className="ml-1 text-xs text-slate-400">{r.unit}</span>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-right font-semibold tabular-nums">{fmtQty(r.total)}</td>
                  {dates.map((d) => (
                    <td key={d} className="whitespace-nowrap py-2 pr-3 text-right tabular-nums">
                      {r.by_date[d] ? fmtQty(r.by_date[d]) : <span className="text-slate-300">·</span>}
                    </td>
                  ))}
                  {showUnscheduled && (
                    <td className="whitespace-nowrap py-2 text-right tabular-nums text-amber-700">
                      {r.unscheduled ? fmtQty(r.unscheduled) : <span className="text-slate-300">·</span>}
                    </td>
                  )}
                </tr>
                {isOpen && (
                  <tr className="border-b border-slate-100 last:border-0">
                    <td colSpan={colCount} className="bg-slate-50/70 px-3 pb-3 pt-1">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className={TH_CLASS}>
                            <th className="pb-1 pr-3">Job</th>
                            <th className="pb-1 pr-3">Product</th>
                            <th className="pb-1 pr-3">Customer</th>
                            <th className="pb-1 pr-3">Sales order</th>
                            <th className="pb-1 pr-3">Starts</th>
                            <th className="pb-1 pr-3 text-right">Pieces to make</th>
                            <th className="pb-1 text-right">{r.material_name} ({r.unit})</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.jobs.map((j) => (
                            <tr key={j.work_order_id} className="border-t border-slate-100">
                              <td className="whitespace-nowrap py-1 pr-3">
                                <Link to={`/work-orders/${j.work_order_id}`} className="text-brand-700 hover:underline" onClick={(e) => e.stopPropagation()}>{j.number}</Link>
                              </td>
                              <td className="py-1 pr-3">{j.product_name ?? <span className="text-slate-400">—</span>}</td>
                              <td className="py-1 pr-3">{j.customer_name}</td>
                              <td className="whitespace-nowrap py-1 pr-3">
                                <Link to={`/orders/${j.order_id}`} className="text-brand-700 hover:underline" onClick={(e) => e.stopPropagation()}>{j.order_number}</Link>
                              </td>
                              <td className="whitespace-nowrap py-1 pr-3">
                                {j.day ? <span title={j.day}>{dayLabel(j.day)}</span> : <span className="text-amber-700">Not scheduled</span>}
                              </td>
                              <td className="whitespace-nowrap py-1 pr-3 text-right tabular-nums">{fmtQty(j.pieces)}</td>
                              <td className="whitespace-nowrap py-1 text-right font-medium tabular-nums">{fmtQty(j.qty)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        {!!data?.uncosted.length && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
            <strong>Not costed:</strong>{' '}
            {data.uncosted.map((j, i) => (
              <span key={j.id}>
                {i > 0 && ', '}
                <Link to={`/work-orders/${j.id}`} className="underline">{j.number}</Link>
              </span>
            ))}
            {' '}— the product has no recipe, so nothing above accounts for them. Add one under Products → Recipe.
          </p>
        )}
        {rows.length > 0 && (
          <p className="mt-2 text-xs text-slate-400">
            Click a material to see the jobs, products and customers behind its figure.
            Each column is a job start date and holds what the jobs starting that day will consume, for the pieces still to make.
            {showUnscheduled && ' Not scheduled is the need of jobs with no start date yet.'}
          </p>
        )}
      </Card>
    </div>
  );
}
