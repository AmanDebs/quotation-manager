import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { WorkOrder, WorkOrderStatus, Location, Machine } from '../types';
import { PageHeader, Card, Select, Button, EmptyState, Pagination, TH_CLASS } from '../components/ui';
import PlanJobsModal from '../components/PlanJobsModal';
import { useCan } from '../App';
import { fmtQty, fmtDate } from '../lib/format';
import { useUrlFilter } from '../lib/useUrlFilter';
import { usePagedList, PAGE_SIZE } from '../lib/usePagedList';

/**
 * Every job across every order — the shop floor's own view.
 *
 * Ordered by planned start, undated jobs last: the question this page answers
 * is "what is running and what is late", and something with no date is neither.
 */

/**
 * The job's vocabulary: **Not planned → Scheduled → Running → Completed**, with
 * Cancelled off to the side (Aglo, 2026-09-11). A display layer over the
 * stored values, which do not change — `work_orders.status` carries a CHECK
 * listing all six, SQLite cannot ALTER one, and the strings are load-bearing in
 * `orderStatus.ts`, `orderJobs.ts` and every roll-up. So `planned` reads
 * *Not planned*, which is exactly what an order-raised job is until somebody
 * gives it a machine and a date; `released` reads *Scheduled*, the word the
 * order's own ladder already uses for a released job; `done` reads *Completed*.
 *
 * `paused` is **retired, not removed**, the quotation's call about `sent`: not
 * in the client's list, so no longer offered — but still labelled, tinted and
 * filterable, because a job on file may hold it and a status you cannot
 * filter for is a row you cannot find. A picker on such a job keeps it as an
 * option so the control can show what is there.
 */
export const WORK_ORDER_STATUSES: WorkOrderStatus[] = ['planned', 'released', 'running', 'paused', 'done', 'cancelled'];

const WORK_ORDER_STATUS_LABELS: Record<WorkOrderStatus, string> = {
  planned: 'Not planned',
  released: 'Scheduled',
  running: 'Running',
  paused: 'Paused',
  done: 'Completed',
  cancelled: 'Cancelled',
};

export const workOrderStatusLabel = (s: string): string =>
  WORK_ORDER_STATUS_LABELS[s as WorkOrderStatus] ?? s;

/** What a picker offers: the four steps and Cancelled, plus a retired value the job already holds. */
export const offeredWorkOrderStatuses = (current?: string): WorkOrderStatus[] =>
  WORK_ORDER_STATUSES.filter((s) => s !== 'paused' || s === current);

export const workOrderStatusStyle: Record<WorkOrderStatus, string> = {
  planned: 'bg-slate-100 text-slate-600',
  released: 'bg-blue-100 text-blue-700',
  running: 'bg-purple-100 text-purple-700',
  paused: 'bg-amber-100 text-amber-700',
  done: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
};

const todayIso = new Date().toISOString().slice(0, 10);

export default function WorkOrdersPage() {
  // Status in the URL so the dashboard's factory card can link to one stage.
  const [status, setStatus] = useUrlFilter('status');
  const [machine, setMachine] = useState('');
  const [location, setLocation] = useState('');
  const [openOnly, setOpenOnly] = useState(true);
  const can = useCan();
  /*
   * The planning step: tick jobs, press Plan. Selection is by id and lives
   * only on this page — it is not in the URL, since a half-ticked set is not
   * a view anybody bookmarks. Closed jobs cannot be ticked; the server refuses
   * them by name anyway, and a box that cannot be ticked says so sooner.
   */
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [planning, setPlanning] = useState(false);
  const mayPlan = can('work_order', 'full');
  const plannable = (w: WorkOrder) => !['done', 'cancelled'].includes(w.status);
  const toggle = (id: number, on: boolean) => setTicked((t) => {
    const next = new Set(t);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const query = new URLSearchParams();
  if (status) query.set('status', status);
  if (machine) query.set('machine_id', machine);
  if (location) query.set('location_id', location);
  if (openOnly && !status) query.set('open', '1');

  const list = usePagedList<WorkOrder, { jobs: number; planned: number; made: number }>(['work-orders', 'all', query.toString()], `/api/work-orders?${query.toString()}`);
  const jobs = list.rows;
  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });
  const { data: machines = [] } = useQuery({ queryKey: ['master', 'machines', false], queryFn: () => api.get<Machine[]>('/api/machines') });

  // Over every matching job, not the page on screen — see `summary` in
  // routes/workOrders.ts. Adding up the rows to hand would answer a different
  // question in exactly the same words.
  const summary = list.summary ?? { jobs: jobs.length, planned: 0, made: 0 };

  return (
    <div>
      <PageHeader
        title="Work Orders"
        subtitle="What the floor is making, across every order"
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select className="w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {WORK_ORDER_STATUSES.map((s) => <option key={s} value={s}>{workOrderStatusLabel(s)}</option>)}
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
          {summary.jobs} job{summary.jobs === 1 ? '' : 's'} · {fmtQty(summary.made)} of {fmtQty(summary.planned)} pcs made
        </span>
        {mayPlan && (
          <Button
            disabled={ticked.size === 0}
            onClick={() => setPlanning(true)}
            title={ticked.size ? undefined : 'Tick the jobs to plan first'}
          >
            Plan {ticked.size || ''} job{ticked.size === 1 ? '' : 's'}…
          </Button>
        )}
      </div>
      {planning && (
        <PlanJobsModal
          jobs={jobs.filter((w) => ticked.has(w.id))}
          onClose={() => setPlanning(false)}
          onPlanned={() => { setPlanning(false); setTicked(new Set()); }}
        />
      )}

      <Card className="overflow-x-auto">
        {jobs.length === 0 ? (
          <EmptyState message="No work orders match. A sales order raises its jobs when it is booked." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className={TH_CLASS}>
                {mayPlan && (
                  <th className="pb-2 pr-2">
                    <input
                      type="checkbox"
                      title="Tick every job on this page that can be planned"
                      checked={jobs.some(plannable) && jobs.filter(plannable).every((w) => ticked.has(w.id))}
                      onChange={(e) => setTicked((t) => {
                        const next = new Set(t);
                        for (const w of jobs.filter(plannable)) { if (e.target.checked) next.add(w.id); else next.delete(w.id); }
                        return next;
                      })}
                    />
                  </th>
                )}
                <th className="pb-2 pr-3">Job</th>
                <th className="pb-2 pr-3">Sales Order</th>
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
                  <tr key={w.id} className={`border-b border-slate-100 last:border-0 hover:bg-slate-50 ${ticked.has(w.id) ? 'bg-brand-50' : ''}`}>
                    {mayPlan && (
                      <td className="py-2 pr-2">
                        <input
                          type="checkbox"
                          checked={ticked.has(w.id)}
                          disabled={!plannable(w)}
                          onChange={(e) => toggle(w.id, e.target.checked)}
                        />
                      </td>
                    )}
                    <td className="py-2 pr-3 font-medium">
                      <Link to={`/work-orders/${w.id}`} className="text-brand-600 hover:underline">{w.number}</Link>
                    </td>
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
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${workOrderStatusStyle[w.status]}`}>
                        {workOrderStatusLabel(w.status)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <Pagination
          page={list.page} pages={list.pages} total={list.total} limit={PAGE_SIZE}
          onPage={list.setPage} noun="jobs"
        />
      </Card>
    </div>
  );
}
