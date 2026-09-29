import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { WorkOrder, WorkOrderStatus } from '../types';
import { PageHeader, Card, Select, Button, EmptyState, ErrorText, Input, Pagination, CAPTION_CLASS, TH_CLASS } from '../components/ui';
import PlanJobsModal from '../components/PlanJobsModal';
import { useCan } from '../App';
import { fmtQty, fmtDate } from '../lib/format';
import { useUrlFilter } from '../lib/useUrlFilter';
import { usePagedList, PAGE_SIZE } from '../lib/usePagedList';
import { useUnsavedChanges } from '../lib/useUnsavedChanges';
import { jobDateOf, jobDateColumn, jobDateIsRevision, type JobDateField } from '../lib/jobDates';

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

/** Only what somebody typed: a field absent is left alone by the server. */
type DatePatch = Partial<Record<JobDateField, string>>;

export default function WorkOrdersPage() {
  // Status in the URL so the dashboard's factory card can link to one stage.
  const [status, setStatus] = useUrlFilter('status');
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
  /*
   * The planning grid (2026-09-29, the client: *"I can record all the dates in
   * a single page"*). `Plan jobs…` beside it writes **one** date across a
   * ticked set, which is right for a run of jobs that share a slot and no use
   * at all for filling in a book where every product runs on its own dates —
   * which, on the live list, is 79 jobs reading *Not planned*.
   *
   * Keyed by job id and holding only the fields somebody typed, so an edit
   * survives paging and filtering: the bar below says how many are waiting,
   * and one Save writes the lot in one request. Nothing is dropped quietly —
   * that is the whole reason the count is on screen rather than the edits
   * being cleared when the rows change.
   */
  const [dates, setDates] = useState<Record<number, DatePatch>>({});
  const [release, setRelease] = useState(true);
  const dirtyIds = Object.keys(dates).map(Number);
  const queryClient = useQueryClient();
  const mayPlan = can('work_order', 'full');
  const plannable = (w: WorkOrder) => !['done', 'cancelled'].includes(w.status);
  const toggle = (id: number, on: boolean) => setTicked((t) => {
    const next = new Set(t);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const query = new URLSearchParams();
  if (status) query.set('status', status);
  if (openOnly && !status) query.set('open', '1');

  const list = usePagedList<WorkOrder, { jobs: number; unplanned?: number; planned: number; made: number }>(['work-orders', 'all', query.toString()], `/api/work-orders?${query.toString()}`);
  const jobs = list.rows;

  /*
   * One request for the page of edits, and the same route the dialog uses —
   * the guards, the transaction and the one re-sync per order are all already
   * there, and a second endpoint would be a second thing to keep in step.
   */
  const saveDates = useMutation({
    mutationFn: () => api.post('/api/work-orders/plan', {
      jobs: dirtyIds.map((id) => ({ id, ...dates[id] })),
      release,
    }),
    onSuccess: () => {
      markSaved();
      setDates({});
      queryClient.invalidateQueries({ queryKey: ['work-orders'] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['order-lines'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  /*
   * The blocker compares pathnames, so paging and filtering — which are search
   * params — leave the typed dates alone, which is what lets somebody fill in
   * two pages and save once. Leaving the list is the case that would lose them,
   * and that is what this asks about.
   */
  const { markSaved, prompt } = useUnsavedChanges(dates, {
    run: () => saveDates.mutateAsync(),
    can: dirtyIds.length > 0,
    message: 'The dates typed on this page have not been saved.',
  });

  /** A job on screen, or one edited and since paged away, that release would move. */
  const toRelease = dirtyIds.filter((id) => (jobs.find((w) => w.id === id) ?? { status: '' }).status === 'planned').length;

  /*
   * Typing back the date the column already holds is not a change, so it is
   * dropped rather than sent — otherwise picking the same day from the
   * calendar would write a revision identical to the plan, recording a slip
   * that never happened.
   */
  const setDate = (w: WorkOrder, field: JobDateField, value: string) => setDates((d) => {
    const row = { ...d[w.id] };
    if (value === jobDateOf(w, field)) delete row[field]; else row[field] = value;
    if (Object.keys(row).length) return { ...d, [w.id]: row };
    const { [w.id]: _gone, ...rest } = d;
    return rest;
  });
  /** What a cell shows: what was typed into it, else what its own column holds. */
  const dateValue = (w: WorkOrder, field: JobDateField) => dates[w.id]?.[field] ?? jobDateOf(w, field);

  // Over every matching job, not the page on screen — see `summary` in
  // routes/workOrders.ts. Adding up the rows to hand would answer a different
  // question in exactly the same words.
  const summary = list.summary ?? { jobs: jobs.length, planned: 0, made: 0 };
  // Over the whole filtered set, not the page: a queue counted over the page in
  // hand would shrink as you paged through it. Optional for a server not yet
  // redeployed, which simply shows no chip.
  const unplanned = summary.unplanned ?? 0;

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
        {/* The queue: jobs the order raised that nobody has planned yet. A
            filter, not a count of its own — it links to exactly what it says. */}
        {!status && unplanned > 0 && (
          <button
            className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 ring-1 ring-amber-200 hover:bg-amber-100"
            onClick={() => setStatus('planned')}
            title="Show only the jobs still to plan"
          >
            {unplanned} not planned
          </button>
        )}
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
              <tr className={`${TH_CLASS} border-b-0`}>
                {mayPlan && (
                  <th className="pb-2 pr-2" rowSpan={2}>
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
                <th className="pb-2 pr-3" rowSpan={2}>Job</th>
                <th className="pb-2 pr-3" rowSpan={2}>Item</th>
                {/*
                  Both pairs are drawn (2026-09-29, the client with one pair and
                  a `rev.` marker in front of them: *"This page should show both
                  planned and revised dates"*). One pair showing whichever date
                  stands answers *when does this run* and hides the other half of
                  the question the two columns exist to answer — what was
                  promised, and by how much it has moved. The original was on
                  hover, which is not somewhere a column can be read from.
                */}
                <th className="border-l border-slate-100 pb-1 pl-3 pr-3 text-center" colSpan={2}>Planned</th>
                <th className="border-l border-slate-100 pb-1 pl-3 pr-3 text-center" colSpan={2}>Revised</th>
                <th className="border-l border-slate-100 pb-2 pl-3 pr-3 text-right" rowSpan={2}>Pcs</th>
                <th className="pb-2 pr-3 text-right" rowSpan={2}>Made</th>
                <th className="pb-2 pr-3" rowSpan={2}>Status</th>
              </tr>
              {/* The sub-row carries the rule; the banner above it carries none,
                  or the heading reads as two stacked tables. */}
              <tr className={`${CAPTION_CLASS} border-b border-slate-200 text-left font-normal text-slate-400`}>
                <th className="border-l border-slate-100 pb-2 pl-3 pr-3">Start</th>
                <th className="pb-2 pr-3">Finish</th>
                <th className="border-l border-slate-100 pb-2 pl-3 pr-3">Start</th>
                <th className="pb-2 pr-3">Finish</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((w, i) => {
                /*
                /*
                 * Late is judged against the finish that **stands** — the revised
                 * one where set, else the planned one, the rule every reader of a
                 * job's date follows — so a plan that was moved is not flagged on
                 * a date nobody is working to. Both dates are drawn in their own
                 * columns now, so there is nothing left to keep on hover.
                 */
                const standingEnd = w.revised_end || w.planned_end;
                const late = !!standingEnd && standingEnd < todayIso
                  && !['done', 'cancelled'].includes(w.status);
                /*
                 * Clubbed by sales order (2026-09-15): the server sorts the
                 * list order by order, and the first job of each opens a
                 * header row naming the order, the customer and the group's
                 * figures, with a tick that plans the whole order at once.
                 * The order and customer columns therefore live on the
                 * header rather than repeating on every job.
                 */
                const first = i === 0 || jobs[i - 1].order_id !== w.order_id;
                const group = first ? jobs.filter((x) => x.order_id === w.order_id) : [];
                const groupPlanned = group.reduce((n, x) => n + (x.qty_planned || 0), 0);
                const groupMade = group.reduce((n, x) => n + (x.progress?.produced ?? 0), 0);
                const groupPlannable = group.filter(plannable);
                return [
                  first && (
                    <tr key={`order-${w.order_id}`} className="border-t border-slate-200 bg-slate-50">
                      {mayPlan && (
                        <td className="py-1.5 pr-2">
                          {groupPlannable.length > 0 && (
                            <input
                              type="checkbox"
                              title="Tick every job on this sales order that can be planned"
                              checked={groupPlannable.every((x) => ticked.has(x.id))}
                              onChange={(e) => setTicked((t) => {
                                const next = new Set(t);
                                for (const x of groupPlannable) { if (e.target.checked) next.add(x.id); else next.delete(x.id); }
                                return next;
                              })}
                            />
                          )}
                        </td>
                      )}
                      <td className="whitespace-nowrap py-1.5 pr-3 font-semibold" colSpan={2}>
                        <Link to={`/orders/${w.order_id}`} className="text-brand-700 hover:underline">{w.order_number}</Link>
                        <span className="ml-2 font-normal text-slate-600">{w.customer_name}</span>
                      </td>
                      <td className="py-1.5 pl-3 pr-3 text-xs text-slate-500" colSpan={4}>
                        {group.length} job{group.length === 1 ? '' : 's'}
                      </td>
                      <td className="py-1.5 pl-3 pr-3 text-right text-xs tabular-nums text-slate-500">{fmtQty(groupPlanned)}</td>
                      <td className="py-1.5 pr-3 text-right text-xs tabular-nums text-slate-500">{fmtQty(groupMade)}</td>
                      <td />
                    </tr>
                  ),
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
                    {/* A document number is one word; split across two lines it reads as two. */}
                    <td className="whitespace-nowrap py-2 pl-4 pr-3 font-medium">
                      <Link to={`/work-orders/${w.id}`} className="text-brand-600 hover:underline">{w.number}</Link>
                    </td>
                    <td className="py-2 pr-3">{w.description || w.product_name || '—'}</td>
                    {/*
                      Four cells, and **exactly one box per date**: `jobDateField`
                      says which column a date may go to — planned while that
                      column is blank, revised after — so the Planned cell holds
                      the box until it has taken its date and settles to text
                      afterwards, and the Revised cell is the box from then on.
                      The rule deciding which is editable is the one the server
                      guards with, so a box can never produce a refusal.

                      A revision with no plan to revise is not offered: nothing
                      has been promised yet, so the first date typed belongs in
                      Planned. That also keeps the row two boxes wide however far
                      along the job is.

                      A closed job keeps plain text throughout — the server
                      refuses to plan a completed or cancelled one by name.
                    */}
                    {([false, true] as const).map((isEnd) => {
                      const field = jobDateColumn(false, isEnd);
                      const editable = mayPlan && plannable(w) && !jobDateIsRevision(w, isEnd);
                      const own = jobDateOf(w, field);
                      return (
                        <td key={`p${isEnd}`} className={`whitespace-nowrap py-2 pr-3 text-xs text-slate-500 ${isEnd ? '' : 'border-l border-slate-100 pl-3'}`}>
                          {editable ? (
                            <Input
                              type="date"
                              className={`w-[8rem] ${dates[w.id]?.[field] ? 'border-brand-400 bg-brand-50/60' : ''}`}
                              value={dateValue(w, field)}
                              onChange={(e) => setDate(w, field, e.target.value)}
                              title={`${w.number} — the original planned ${isEnd ? 'finish' : 'start'}, recorded once`}
                            />
                          ) : own ? (
                            <span title="Recorded once, and what the revision beside it is measured against">{fmtDate(own)}</span>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                      );
                    })}
                    {([false, true] as const).map((isEnd) => {
                      const field = jobDateColumn(true, isEnd);
                      const editable = mayPlan && plannable(w) && jobDateIsRevision(w, isEnd);
                      const own = jobDateOf(w, field);
                      /*
                       * Late is judged on the finish that stands and drawn on the
                       * cell holding it, so a plan that was moved is not flagged
                       * on a date nobody is working to.
                       */
                      const flag = late && isEnd && !!w.revised_end;
                      return (
                        <td key={`r${isEnd}`} className={`whitespace-nowrap py-2 pr-3 text-xs ${flag ? 'font-medium text-red-600' : 'text-slate-500'} ${isEnd ? '' : 'border-l border-slate-100 pl-3'}`}>
                          {editable ? (
                            <Input
                              type="date"
                              className={`w-[8rem] ${dates[w.id]?.[field] ? 'border-brand-400 bg-brand-50/60' : ''}`}
                              value={dateValue(w, field)}
                              onChange={(e) => setDate(w, field, e.target.value)}
                              title={`${w.number} — the revised ${isEnd ? 'finish' : 'start'}; the original stays as it was recorded`}
                            />
                          ) : own ? (
                            <span>{fmtDate(own)}</span>
                          ) : (
                            <span
                              className="text-slate-300"
                              title={(isEnd ? w.planned_end : w.planned_start) ? 'Not revised' : 'Nothing planned yet to revise'}
                            >—</span>
                          )}
                          {flag && <div>overdue</div>}
                        </td>
                      );
                    })}
                    <td className="border-l border-slate-100 py-2 pl-3 pr-3 text-right tabular-nums">{fmtQty(w.qty_planned)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {fmtQty(w.progress?.produced ?? 0)}
                      {w.qty_planned > 0 && (() => {
                        const pct = Math.round(((w.progress?.produced ?? 0) / w.qty_planned) * 100);
                        // Past the plan is a fact worth a colour: the figure is
                        // right, and it is the plan that is now wrong.
                        return (
                          <div className={`text-xs ${pct > 100 ? 'font-medium text-amber-700' : 'text-slate-400'}`} title={pct > 100 ? 'More made than planned — the plan is behind the floor' : undefined}>
                            {pct}%{pct > 100 ? ' over' : ''}
                          </div>
                        );
                      })()}
                    </td>
                    <td className="py-2 pr-3">
                      <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${workOrderStatusStyle[w.status]}`}>
                        {workOrderStatusLabel(w.status)}
                      </span>
                    </td>
                  </tr>,
                ];
              })}
            </tbody>
          </table>
        )}
        <Pagination
          page={list.page} pages={list.pages} total={list.total} limit={PAGE_SIZE}
          onPage={list.setPage} noun="jobs"
        />
      </Card>

      {/*
        Sticky, because the list is long and the dates are typed down it — a
        Save in the toolbar is a Save you have scrolled away from by the third
        row. It counts what is waiting rather than what is on screen, since an
        edit survives paging; that count is what makes the survival honest
        rather than hidden.
      */}
      {dirtyIds.length > 0 && (
        <div className="sticky bottom-4 z-20 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
          <span className="text-sm font-medium text-slate-700">
            {dirtyIds.length} job{dirtyIds.length === 1 ? '' : 's'} dated
          </span>
          {/* On by default: a date with no release leaves every row still
              reading *Not planned*, which reads as a save that did nothing.
              Forward only on the server, so it never demotes anything. */}
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" checked={release} onChange={(e) => setRelease(e.target.checked)} />
            Release them
            {release && toRelease > 0 && (
              <span className="text-xs text-slate-400">({toRelease} → Scheduled)</span>
            )}
          </label>
          <ErrorText error={saveDates.error} />
          <div className="ml-auto flex items-center gap-2">
            <Button variant="secondary" onClick={() => setDates({})} disabled={saveDates.isPending}>Discard</Button>
            <Button onClick={() => saveDates.mutate()} disabled={saveDates.isPending}>
              {saveDates.isPending ? 'Saving…' : 'Save dates'}
            </Button>
          </div>
        </div>
      )}

      {/* Renders nothing until leaving the list is actually blocked. */}
      {prompt}
    </div>
  );
}
