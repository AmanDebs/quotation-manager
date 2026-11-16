import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { WorkOrder, PlannedJob, PlanPreview } from '../types';
import { Button, Input, Modal, ErrorText, TH_CLASS } from './ui';
import { fmtDate, fmtQty, today } from '../lib/format';

/**
 * Plan a queue: say what runs in what order and from when, and the app works
 * out the dates (2026-11-16, the client: *"My team is finding it [hard] to
 * fill the planned dates for production in the current format, look a better
 * way to plan our production"*).
 *
 * **The reversal this exists for.** The grid asks for two dates per job,
 * which asks the planner to know how long each job takes and then do
 * eighty-four small sums — which is why 65 of 84 jobs on the live book carry
 * no dates at all. Here they give one start date and an order of work; the
 * server measures each product's rate from the shifts already booked
 * (`services/outputRate.ts`), divides what is **left to make** by it, and
 * lays the jobs end to end.
 *
 * **It stages, it does not save.** The press writes the dates into the
 * list's own pending edits through `setDate`, so every one of them is on
 * screen and correctable, the sticky bar then reads *N jobs dated*, and one
 * Save sends the single `POST /work-orders/plan` that has always written a
 * plan — with its guards, its transaction and its `plannedDateError` routing
 * untouched. Pressing again before Save simply restages.
 *
 * **It says which promises the plan breaks.** `ORDER_DUE` is already the one
 * answer to when an order is due, so a job whose computed finish falls after
 * it is marked — the question a planner actually has, and the one no screen
 * in this app could answer before.
 */

/** Why a row could not be dated, in the words the planner needs. */
const BLOCKED: Record<string, string> = {
  'no-rate': 'no output rate yet — type one on the product, or date this job by hand',
  'nothing-left': 'nothing left to make',
};

const rateLabel = (p: PlannedJob): string => (p.rate ? `${fmtQty(p.rate.pcs_per_day)}/day` : '—');

/**
 * Where the figure came from, on the hover rather than in the cell — spelled
 * out in full this column alone pushed the table four hundred pixels past the
 * dialog, and a planner table that scrolls sideways cannot be read across.
 */
const rateTitle = (p: PlannedJob): string | undefined => {
  if (!p.rate) return undefined;
  return p.rate.source === 'measured'
    ? `Measured from ${p.rate.days} day${p.rate.days === 1 ? '' : 's'} of shifts already booked, the last on ${fmtDate(p.rate.last_run)}`
    : 'Stated on the product — the floor has never booked a shift for it';
};

export default function PlanQueueModal({ jobs, onClose, onStage }: {
  jobs: WorkOrder[];
  onClose: () => void;
  /** Hands the dated rows back to the list, which stages them like any typed date. */
  onStage: (plan: PlannedJob[]) => void;
}) {
  const [start, setStart] = useState(today());
  /*
   * The order to run them in. Empty until somebody moves a row — the server
   * opens on soonest customer date first, which is where a planner starts,
   * and `keep_order` is what says "this is mine now".
   */
  const [order, setOrder] = useState<number[]>([]);
  const ids = useMemo(() => jobs.map((j) => j.id), [jobs]);
  const asked = order.length ? order : ids;

  const preview = useQuery({
    queryKey: ['plan-preview', asked.join(','), start, order.length > 0],
    queryFn: () => api.post<PlanPreview>('/api/work-orders/plan/preview', {
      ids: asked, start, keep_order: order.length > 0,
    }),
    enabled: !!start && ids.length > 0,
  });

  const rows = preview.data?.jobs ?? [];
  const datable = rows.filter((p) => !p.blocked);
  const late = datable.filter((p) => p.late).length;

  /** Move a row one place, which is what makes the order the planner's own. */
  const move = (id: number, by: -1 | 1) => {
    const list = rows.map((p) => p.id);
    const i = list.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setOrder(list);
  };

  const num = 'whitespace-nowrap py-1.5 pr-3 text-right tabular-nums';

  return (
    <Modal title={`Plan ${jobs.length} job${jobs.length === 1 ? '' : 's'}`} onClose={onClose} wide>
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Start from</span>
            <Input type="date" className="w-40" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <p className="text-xs text-slate-500">
            One queue, one job at a time, seven days a week. Each job takes
            what is left to make divided by how fast that product goes.
          </p>
        </div>

        {preview.isError && <ErrorText error={preview.error} />}
        {preview.isPending ? (
          <div className="py-6 text-center text-sm text-slate-400">Working it out…</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={TH_CLASS}>
                  <th className="pb-2 pr-3">Job</th>
                  <th className="pb-2 pr-3">Item</th>
                  <th className="pb-2 pr-3 text-right">To make</th>
                  <th className="pb-2 pr-3">Rate</th>
                  <th className="pb-2 pr-3 text-right">Days</th>
                  <th className="pb-2 pr-3">Start → Finish</th>
                  <th className="pb-2 pr-3">Needed</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((p, i) => (
                  <tr key={p.id} className={`border-t border-slate-100 ${p.blocked ? 'text-slate-400' : ''}`}>
                    {/* The customer under the job number, so neither column
                        has to be wide enough for both. */}
                    <td className="whitespace-nowrap py-1.5 pr-3">
                      <div className="font-medium">{p.number}</div>
                      <div className="max-w-[9rem] truncate text-xs text-slate-400" title={p.customer_name}>{p.customer_name}</div>
                    </td>
                    <td className="max-w-[9rem] truncate py-1.5 pr-3" title={p.item}>{p.item || '—'}</td>
                    <td className={num}>{fmtQty(p.pieces)}</td>
                    <td className={`${num} text-xs`} title={rateTitle(p)}>{rateLabel(p)}</td>
                    <td className={num}>{p.days ?? '—'}</td>
                    <td className={`py-1.5 pr-3 ${p.late ? 'font-semibold text-red-600' : ''}`}>
                      {p.blocked
                        ? <span className="text-xs">{BLOCKED[p.blocked] ?? p.blocked}</span>
                        : <span className="whitespace-nowrap">{fmtDate(p.planned_start)} → {fmtDate(p.planned_end)}</span>}
                    </td>
                    {/* The customer's own date, so a late plan says what it is late against. */}
                    <td className={`whitespace-nowrap py-1.5 pr-3 text-xs ${p.late ? 'text-red-600' : 'text-slate-400'}`}>
                      {p.due ? fmtDate(p.due) : '—'}
                    </td>
                    <td className="whitespace-nowrap py-1.5 text-right">
                      <button
                        className="px-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                        disabled={i === 0}
                        onClick={() => move(p.id, -1)}
                        title="Run this one earlier"
                      >▲</button>
                      <button
                        className="px-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                        disabled={i === rows.length - 1}
                        onClick={() => move(p.id, 1)}
                        title="Run this one later"
                      >▼</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-3">
          <div className="text-xs text-slate-500">
            {late > 0 && (
              <span className="mr-3 font-semibold text-red-600">
                {late} would finish after the customer&rsquo;s date
              </span>
            )}
            Nothing is saved yet — the dates go onto the list, where you can correct any of them before Save.
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button
              disabled={datable.length === 0}
              onClick={() => { onStage(datable); onClose(); }}
              title={datable.length ? undefined : 'None of these can be dated yet'}
            >
              Fill in {datable.length} date{datable.length === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
