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
  const showUnscheduled = !!data?.has_unscheduled;
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
              {rows.map((r) => (
                <tr key={r.material_id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="whitespace-nowrap py-2 pr-3 font-medium">
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
              ))}
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
            Each column is a job start date and holds what the jobs starting that day will consume, for the pieces still to make.
            {showUnscheduled && ' Not scheduled is the need of jobs with no start date yet.'}
          </p>
        )}
      </Card>
    </div>
  );
}
