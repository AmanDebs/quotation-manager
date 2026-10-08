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

/*
 * The four date cells share one set of metrics (2026-09-29, the client:
 * *"Make it cleaner and beautify it"*).
 *
 * Three different things were being drawn under four headings — a bordered
 * box, a line of bare text and an em-dash — each with its own padding, so the
 * dates in a column did not line up with each other and a row's height
 * depended on which of its columns happened to be editable. A settled date is
 * drawn in the **same box the input occupies**, without the border or the
 * background: the column reads as one run of dates, and the only thing the
 * border says is *this one you can change*.
 */
const DATE_BOX = 'inline-flex h-[30px] w-[7.5rem] items-center px-2.5 tabular-nums';
/** The native picker glyph at full strength is the loudest thing in the row. */
const DATE_INPUT = 'w-[7.5rem] tabular-nums [&::-webkit-calendar-picker-indicator]:opacity-40 [&::-webkit-calendar-picker-indicator]:hover:opacity-70';
/** A group of two date columns opens on a rule; the pair inside shares it. */
const GROUP_EDGE = 'border-l border-slate-200';

/**
 * A date that is quiet until somebody means to type (2026-09-29, the client:
 * *"Is there a better way to fill in dates in this, it is not looking
 * beautiful"*).
 *
 * With 78 jobs unplanned the page drew **156 empty date boxes**, every one of
 * them a grey `dd-mm-yyyy` placeholder shouting for attention it did not need.
 * At rest a cell is now the date, or a faint dash where there is none, and the
 * box appears on the click that means to change it — which is the shape the
 * sales order book's own date cell took at the client's word, for exactly this
 * reason. A filled date reads as a date rather than as a control.
 *
 * It closes again on blur **only when nothing was typed into it**: a pending
 * edit stays open so the figure that is about to be saved is visible, and
 * Escape puts an untouched cell back. Everything returns to text when the page
 * is saved and the pending edits are cleared.
 */
function DateCell({ value, editable, pending, open, onOpen, onClose, onChange, title }: {
  value: string;
  editable: boolean;
  pending: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChange: (v: string) => void;
  title?: string;
}) {
  if (editable && open) {
    return (
      <Input
        type="date"
        autoFocus
        className={`${DATE_INPUT} ${pending ? 'border-brand-400 bg-brand-50/60' : ''}`}
        value={value}
        title={title}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => { if (!pending) onClose(); }}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      />
    );
  }
  if (!editable) {
    return value
      ? <span className={DATE_BOX} title={title}>{fmtDate(value)}</span>
      : <span className={`${DATE_BOX} text-slate-300`} title={title}>—</span>;
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      title={title}
      className={`${DATE_BOX} rounded text-left transition-colors hover:bg-brand-50 hover:text-brand-700 focus:bg-brand-50 focus:outline-none ${pending ? 'font-medium text-brand-700' : ''}`}
    >
      {value ? fmtDate(value) : <span className="text-slate-300">—</span>}
    </button>
  );
}

export default function WorkOrdersPage() {
  // Status in the URL so the dashboard's factory card can link to one stage.
  const [status, setStatus] = useUrlFilter('status');
  // The floor's own queue, in the URL like every other filter so it can be
  // kept open on a second screen.
  const [awaiting, setAwaiting] = useUrlFilter('awaiting');
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
  /** The one cell showing a box, as `jobId:column`. */
  const [editing, setEditing] = useState<string | null>(null);
  /*
   * The orders whose own date pair is open, and what was typed into it. Jobs on
   * one sales order run in one window far more often than not — same customer,
   * same shipment — so setting the order once and correcting the odd job is
   * the way this book is actually planned, where typing a pair per job is the
   * same two dates over and over.
   */
  const [groupOpen, setGroupOpen] = useState<Set<number>>(new Set());
  const [groupDates, setGroupDates] = useState<Record<number, { start?: string; end?: string }>>({});
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
  if (awaiting) query.set('awaiting', awaiting);
  if (openOnly && !status) query.set('open', '1');

  const list = usePagedList<WorkOrder, { jobs: number; unplanned?: number; awaiting?: number; planned: number; made: number }>(['work-orders', 'all', query.toString()], `/api/work-orders?${query.toString()}`);
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
      setEditing(null);
      setGroupDates({});
      setGroupOpen(new Set());
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

  /*
   * One date for a whole sales order. It stages the same edit on every
   * plannable job of that order through `setDate`, so each job still lands in
   * the column its own state allows — a job with a plan on file takes it as a
   * revision and one without takes it as its first plan. Nothing special is
   * saved: these are the same pending edits as any typed by hand, and any one
   * of them can be corrected on its own row before Save.
   */
  const setGroupDate = (orderId: number, group: WorkOrder[], end: boolean, value: string) => {
    setGroupDates((g) => ({ ...g, [orderId]: { ...g[orderId], [end ? 'end' : 'start']: value } }));
    for (const j of group) setDate(j, jobDateColumn(jobDateIsRevision(j, end), end), value);
  };

  // Over every matching job, not the page on screen — see `summary` in
  // routes/workOrders.ts. Adding up the rows to hand would answer a different
  // question in exactly the same words.
  const summary = list.summary ?? { jobs: jobs.length, planned: 0, made: 0 };
  // Over the whole filtered set, not the page: a queue counted over the page in
  // hand would shrink as you paged through it. Optional for a server not yet
  // redeployed, which simply shows no chip.
  const unplanned = summary.unplanned ?? 0;
  // Optional, for a server not yet redeployed: no key, no chip.
  const toConfirm = summary.awaiting ?? 0;

  /*
   * "It started." The other answer is a revised start date, which is the cell
   * beside it — so *No* opens that box rather than recording anything of its
   * own. Saying so before the shift is closed is a person's assertion, which is
   * why it goes through the status route: that clears `status_before_auto`, so
   * the job is *Running* on their word and `syncJobStatus` will not lower it
   * when the shift book is still empty.
   */
  const confirmStarted = useMutation({
    mutationFn: (jobId: number) => api.post(`/api/work-orders/${jobId}/status`, { status: 'running' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['work-orders'] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

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
        {/*
          Due to start and unanswered. Red rather than the amber beside it: a
          job nobody has confirmed is a machine that may be standing idle,
          where a job nobody has planned is only a job nobody has planned.
        */}
        {toConfirm > 0 && (
          <button
            className={`rounded-md px-2 py-1 text-xs ring-1 ${awaiting
              ? 'bg-red-100 text-red-800 ring-red-300'
              : 'bg-red-50 text-red-700 ring-red-200 hover:bg-red-100'}`}
            onClick={() => setAwaiting(awaiting ? '' : '1')}
            title={awaiting
              ? 'Show every job again'
              : 'Jobs whose start date has come with nobody saying whether they started — confirm, or revise the date'}
          >
            {toConfirm} to confirm
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
                {/* Who it is for. The group header above each run names the
                    order and the customer, and this repeats it per row at the
                    client's word (2026-10-08) — which is what makes the table
                    readable as a flat list once a filter has cut it down to a
                    handful of jobs across several orders. */}
                <th className="pb-2 pr-3" rowSpan={2}>Customer</th>
                <th className="pb-2 pr-3" rowSpan={2}>Item</th>
                <th className="pb-2 pr-3" rowSpan={2}>Colour</th>
                {/*
                  Both pairs are drawn (2026-09-29, the client with one pair and
                  a `rev.` marker in front of them: *"This page should show both
                  planned and revised dates"*). One pair showing whichever date
                  stands answers *when does this run* and hides the other half of
                  the question the two columns exist to answer — what was
                  promised, and by how much it has moved. The original was on
                  hover, which is not somewhere a column can be read from.
                */}
                <th className={`${GROUP_EDGE} pb-1 pl-3 pr-3`} colSpan={2}>Planned</th>
                <th className={`${GROUP_EDGE} pb-1 pl-3 pr-3`} colSpan={2}>Revised</th>
                <th className={`${GROUP_EDGE} pb-2 pl-3 pr-3 text-right`} rowSpan={2}>Pcs</th>
                <th className="pb-2 pr-3 text-right" rowSpan={2}>Made</th>
                <th className="pb-2 pr-3" rowSpan={2}>Status</th>
              </tr>
              {/*
                The sub-row carries the rule and the banner above it carries
                none, or the heading reads as two stacked tables. Both are
                left-aligned over cells whose dates are left-aligned — a banner
                centred over its pair floats away from the column it names.
              */}
              <tr className={`${CAPTION_CLASS} border-b border-slate-200 text-left font-normal text-slate-400`}>
                <th className={`${GROUP_EDGE} pb-2 pl-5 pr-3`}>Start</th>
                <th className="pb-2 pl-2.5 pr-3">Finish</th>
                <th className={`${GROUP_EDGE} pb-2 pl-5 pr-3`}>Start</th>
                <th className="pb-2 pl-2.5 pr-3">Finish</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((w, i) => {
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
                      <td className="whitespace-nowrap py-1.5 pr-3 font-semibold" colSpan={4}>
                        <Link to={`/orders/${w.order_id}`} className="text-brand-700 hover:underline">{w.order_number}</Link>
                        <span className="ml-2 font-normal text-slate-600">{w.customer_name}</span>
                      </td>
                      {/*
                        The order's own pair: two dates that fill every job under
                        it. Quiet until asked for, like the cells below — an
                        order already fully dated does not need a control over
                        it, and one that does needs it only once.
                      */}
                      <td className={`${GROUP_EDGE} py-1.5 pl-5 pr-3 text-xs text-slate-500`} colSpan={4}>
                        <span className="mr-3">{group.length} job{group.length === 1 ? '' : 's'}</span>
                        {mayPlan && groupPlannable.length > 0 && (
                          groupOpen.has(w.order_id) ? (
                            <span className="inline-flex items-center gap-1 align-middle">
                              <Input
                                type="date"
                                autoFocus
                                className={DATE_INPUT}
                                value={groupDates[w.order_id]?.start ?? ''}
                                title={`Start for all ${groupPlannable.length} jobs on ${w.order_number}`}
                                onChange={(e) => setGroupDate(w.order_id, groupPlannable, false, e.target.value)}
                              />
                              <span className="text-slate-300">→</span>
                              <Input
                                type="date"
                                className={DATE_INPUT}
                                value={groupDates[w.order_id]?.end ?? ''}
                                title={`Finish for all ${groupPlannable.length} jobs on ${w.order_number}`}
                                onChange={(e) => setGroupDate(w.order_id, groupPlannable, true, e.target.value)}
                              />
                              <button
                                type="button"
                                className="rounded px-1 text-slate-400 hover:text-slate-600"
                                title="Close — what was filled in stays until you discard it"
                                onClick={() => setGroupOpen((g) => { const n = new Set(g); n.delete(w.order_id); return n; })}
                              >✕</button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="rounded px-1.5 py-0.5 text-brand-600 transition-colors hover:bg-brand-50 hover:text-brand-700"
                              title={`Set one start and finish for all ${groupPlannable.length} jobs on this order — each lands in its own column, and any one of them can be corrected on its row afterwards`}
                              onClick={() => setGroupOpen((g) => new Set(g).add(w.order_id))}
                            >
                              Set dates for all {groupPlannable.length}
                            </button>
                          )
                        )}
                      </td>
                      <td className={`${GROUP_EDGE} py-1.5 pl-3 pr-3 text-right text-xs tabular-nums text-slate-500`}>{fmtQty(groupPlanned)}</td>
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
                    {/* One line, with the whole name on hover — the rule the
                        order book's own lines view follows about its customer
                        column, and for the same reason: a name that wraps makes
                        every row in the table two lines tall to serve one. */}
                    <td className="py-1.5 pr-3 text-slate-600">
                      <div className="max-w-[9rem] truncate" title={w.customer_name || undefined}>
                        {w.customer_name || '—'}
                      </div>
                    </td>
                    {/*
                      **The catalogue product, not the line's wording** (the
                      client, 2026-10-08: *"it should show actual product name
                      instead of description"*) — the call the order book's
                      lines view already made about the same two fields on
                      2026-09-16. The floor is making a catalogue item, and the
                      line's description is one desk's sentence about it, which
                      on this book runs to *"29/21 Press on / CTC Two Piece -
                      Dual…"* where the product is one name.
                      A **custom line names no product**, so it falls back to
                      its own wording rather than printing a dash — that line
                      has nothing else to say what it is. The description rides
                      the hover wherever it differs, so nothing is lost.
                    */}
                    <td className="py-1.5 pr-3">
                      <div
                        className="max-w-[12rem] truncate"
                        title={(w.product_name && w.description && w.description !== w.product_name
                          ? w.description
                          : w.product_name || w.description) || undefined}
                      >
                        {w.product_name || w.description || '—'}
                      </div>
                    </td>
                    {/* One word on this book, so it does not wrap; a blank
                        recedes rather than reading as a fault. */}
                    <td className="whitespace-nowrap py-1.5 pr-3 text-xs text-slate-600">
                      {w.color?.trim() || <span className="text-slate-300">—</span>}
                    </td>
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
                    {/*
                      One renderer for all four, which is what makes the columns
                      line up: the box, the settled date and the em-dash occupy
                      the same shape, so a row is one height whichever of its
                      four cells happen to be editable.
                    */}
                    {([[false, false], [false, true], [true, false], [true, true]] as const).map(([revised, isEnd]) => {
                      const field = jobDateColumn(revised, isEnd);
                      const editable = mayPlan && plannable(w) && jobDateIsRevision(w, isEnd) === revised;
                      const own = jobDateOf(w, field);
                      const word = isEnd ? 'finish' : 'start';
                      /*
                       * Late is judged on the finish that stands and drawn on the
                       * cell holding it, so a plan that was moved is not flagged
                       * on a date nobody is working to.
                       */
                      const flag = late && isEnd && (revised ? !!w.revised_end : !w.revised_end);
                      return (
                        <td
                          key={field}
                          className={`whitespace-nowrap py-1.5 pr-3 text-xs ${
                            flag ? 'font-medium text-red-600'
                            // The date that **stands** is the one being asked about, which is
                            // not the same cell as the one that takes the answer: a job with no
                            // revision is due on its plan, and answering *No* opens the revised
                            // box beside it.
                            : (!isEnd && !!w.due_to_start && revised === !!w.revised_start) ? 'font-medium text-red-700'
                            : 'text-slate-600'
                          } ${isEnd ? '' : `${GROUP_EDGE} pl-2`}`}
                        >
                          <DateCell
                            value={dateValue(w, field)}
                            editable={editable}
                            pending={!!dates[w.id]?.[field]}
                            open={editing === `${w.id}:${field}`}
                            onOpen={() => setEditing(`${w.id}:${field}`)}
                            onClose={() => setEditing(null)}
                            onChange={(v) => setDate(w, field, v)}
                            title={editable
                              ? revised
                                ? `${w.number} — the revised ${word}; the original stays as it was recorded`
                                : `${w.number} — the original planned ${word}, recorded once`
                              : revised
                                ? own ? undefined : (isEnd ? w.planned_end : w.planned_start) ? 'Not revised' : 'Nothing planned yet to revise'
                                : own ? 'Recorded once, and what the revision beside it is measured against' : undefined}
                          />
                          {flag && <span className="ml-1">overdue</span>}
                        </td>
                      );
                    })}
                    <td className={`${GROUP_EDGE} py-1.5 pl-3 pr-3 text-right tabular-nums`}>{fmtQty(w.qty_planned)}</td>
                    {/* The percentage sits beside the figure rather than under
                        it: stacked, it made every one of eighty rows two lines
                        tall to say something one word wide. */}
                    <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums">
                      {fmtQty(w.progress?.produced ?? 0)}
                      {w.qty_planned > 0 && (() => {
                        const pct = Math.round(((w.progress?.produced ?? 0) / w.qty_planned) * 100);
                        // Past the plan is a fact worth a colour: the figure is
                        // right, and it is the plan that is now wrong.
                        return (
                          <span className={`ml-1.5 text-xs ${pct > 100 ? 'font-medium text-amber-700' : 'text-slate-400'}`} title={pct > 100 ? 'More made than planned — the plan is behind the floor' : undefined}>
                            {pct}%{pct > 100 ? ' over' : ''}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="py-1.5 pr-3">
                      <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${workOrderStatusStyle[w.status]}`}>
                        {workOrderStatusLabel(w.status)}
                      </span>
                      {/*
                        The confirmation, asked where the answer changes
                        something. Two answers and no third: *Yes* runs the job,
                        *No* opens the revised start box beside it — which is
                        the answer, not a note about it. Drawn only on a job
                        that is actually due, so it is a queue that empties
                        rather than a control on every row.
                      */}
                      {!!w.due_to_start && mayPlan && (
                        <div className="mt-0.5 whitespace-nowrap text-xs text-red-700">
                          Started?{' '}
                          <button
                            className="rounded px-1 font-medium underline decoration-red-300 underline-offset-2 hover:bg-red-50"
                            disabled={confirmStarted.isPending}
                            onClick={() => confirmStarted.mutate(w.id)}
                            title={`Mark ${w.number} as running — it started on time`}
                          >
                            Yes
                          </button>
                          <span className="text-red-300"> · </span>
                          <button
                            className="rounded px-1 font-medium underline decoration-red-300 underline-offset-2 hover:bg-red-50"
                            onClick={() => setEditing(`${w.id}:${jobDateColumn(true, false)}`)}
                            title={`Not started — give ${w.number} a revised start date`}
                          >
                            No
                          </button>
                        </div>
                      )}
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
            {/* Everything the pending edits put on screen goes with them — an
                open cell left behind after a discard is a box holding nothing,
                which the blur that would have closed it can no longer reach. */}
            <Button
              variant="secondary"
              onClick={() => { setDates({}); setEditing(null); setGroupDates({}); setGroupOpen(new Set()); }}
              disabled={saveDates.isPending}
            >
              Discard
            </Button>
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
