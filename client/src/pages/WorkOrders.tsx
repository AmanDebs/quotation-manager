import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { WorkOrder, WorkOrderStatus, Location, Machine } from '../types';
import { PageHeader, Card, Select, EmptyState } from '../components/ui';
import { fmtQty, fmtDate } from '../lib/format';

/**
 * Every job across every order — the shop floor's own view.
 *
 * Ordered by planned start, undated jobs last: the question this page answers
 * is "what is running and what is late", and something with no date is neither.
 */

const STATUSES: WorkOrderStatus[] = ['planned', 'released', 'running', 'paused', 'done', 'cancelled'];

const statusStyle: Record<WorkOrderStatus, string> = {
  planned: 'bg-slate-100 text-slate-600',
  released: 'bg-blue-100 text-blue-700',
  running: 'bg-purple-100 text-purple-700',
  paused: 'bg-amber-100 text-amber-700',
  done: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
};

const todayIso = new Date().toISOString().slice(0, 10);

export default function WorkOrdersPage() {
  const [status, setStatus] = useState('');
  const [machine, setMachine] = useState('');
  const [location, setLocation] = useState('');
  const [openOnly, setOpenOnly] = useState(true);

  const query = new URLSearchParams();
  if (status) query.set('status', status);
  if (machine) query.set('machine_id', machine);
  if (location) query.set('location_id', location);
  if (openOnly && !status) query.set('open', '1');

  const { data: jobs = [] } = useQuery({
    queryKey: ['work-orders', 'all', query.toString()],
    queryFn: () => api.get<WorkOrder[]>(`/api/work-orders?${query.toString()}`),
  });
  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });
  const { data: machines = [] } = useQuery({ queryKey: ['master', 'machines', false], queryFn: () => api.get<Machine[]>('/api/machines') });

  const planned = jobs.reduce((s, w) => s + (w.qty_planned || 0), 0);
  const made = jobs.reduce((s, w) => s + (w.progress?.produced ?? 0), 0);

  return (
    <div>
      <PageHeader
        title="Work Orders"
        subtitle="What the floor is making, across every order"
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select className="w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        <Select className="w-44" value={location} onChange={(e) => setLocation(e.target.value)}>
          <option value="">All plants</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
        <Select className="w-44" value={machine} onChange={(e) => setMachine(e.target.value)}>
          <option value="">All machines</option>
          {machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </Select>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={openOnly}
            disabled={!!status}
            onChange={(e) => setOpenOnly(e.target.checked)}
          />
          Open jobs only
        </label>
        <span className="ml-auto text-sm text-slate-500">
          {jobs.length} job{jobs.length === 1 ? '' : 's'} · {fmtQty(made)} of {fmtQty(planned)} pcs made
        </span>
      </div>

      <Card className="overflow-x-auto">
        {jobs.length === 0 ? (
          <EmptyState message="No work orders match. Raise one from an order's Production tab." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-2 pr-3">Job</th>
                <th className="pb-2 pr-3">Order</th>
                <th className="pb-2 pr-3">Customer</th>
                <th className="pb-2 pr-3">Item</th>
                <th className="pb-2 pr-3">Machine</th>
                <th className="pb-2 pr-3">Planned</th>
                <th className="pb-2 pr-3 text-right">Pcs</th>
                <th className="pb-2 pr-3 text-right">Made</th>
                <th className="pb-2 pr-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((w) => {
                // Late means the finish date has passed with work still to do.
                const late = !!w.planned_end && w.planned_end < todayIso
                  && !['done', 'cancelled'].includes(w.status);
                return (
                  <tr key={w.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="py-2 pr-3 font-medium">{w.number}</td>
                    <td className="py-2 pr-3">
                      <Link to={`/orders/${w.order_id}`} className="text-brand-600 hover:underline">{w.order_number}</Link>
                    </td>
                    <td className="py-2 pr-3">{w.customer_name}</td>
                    <td className="py-2 pr-3">{w.description || w.product_name || '—'}</td>
                    <td className="py-2 pr-3 text-xs text-slate-500">
                      {w.machine_name || '—'}
                      {w.location_name && <div className="text-slate-400">{w.location_name}</div>}
                    </td>
                    <td className={`py-2 pr-3 text-xs ${late ? 'font-medium text-red-600' : 'text-slate-500'}`}>
                      {w.planned_start || w.planned_end
                        ? `${w.planned_start ? fmtDate(w.planned_start) : '?'} → ${w.planned_end ? fmtDate(w.planned_end) : '?'}`
                        : '—'}
                      {late && <div>overdue</div>}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{fmtQty(w.qty_planned)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {fmtQty(w.progress?.produced ?? 0)}
                      {w.qty_planned > 0 && (
                        <div className="text-xs text-slate-400">
                          {Math.round(((w.progress?.produced ?? 0) / w.qty_planned) * 100)}%
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${statusStyle[w.status]}`}>
                        {w.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
