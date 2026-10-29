import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { WorkOrder, WorkOrderStatus } from '../types';
import { PageHeader, Card, Button, EmptyState, ErrorText, ExportTabs, Input, Pagination, SegmentedTabs, Select, CAPTION_CLASS, TH_CLASS } from '../components/ui';
import { useCompanies } from '../components/CompanySelect';
import { JobDateCell } from './Orders';
import { Icon } from '../components/icons';
import { ColumnFilter, FilteredByStrip } from '../components/ColumnFilter';
import { useColumnFilters, type ColumnFilterSpec } from '../lib/useColumnFilters';
import PlanJobsModal from '../components/PlanJobsModal';
import { LogOutput } from '../components/LogOutputModal';
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

/**
 * A filter in every heading (2026-10-13, the client with the list in front of
 * them: *"add filter to all columns in work order similar to sales order"*).
 *
 * One entry per column the table draws, in the order it draws them, so the
 * strip above reads left to right like the headings do. Every list is filled
 * from the server against the whole filtered set — see `ColumnFilter`, which
 * records why that cannot be a walk over the rows in hand.
 *
 * **Status keeps the key it has always had.** The dashboard's factory chips
 * link here with `?status=`, so that is the key this column reads and writes
 * rather than `f.status`; reading it as the column's own tick list is what lets
 * the dropdown clear it, where a second key beside it would be a filter the
 * control could neither see nor undo. It is also why the standalone *All
 * statuses* select above the table is gone: two controls over one fact is how
 * the two come to disagree.
 *
 * Its values are **labelled**, which no other column needs: a job is stored
 * `planned` and drawn *Not planned*, and those are opposites read aloud.
 */
const JOB_FILTERS: ColumnFilterSpec[] = [
  { key: 'job', label: 'Job', kind: 'values' },
  { key: 'created', label: 'Date raised', kind: 'dates' },
  { key: 'customer', label: 'Customer', kind: 'values' },
  { key: 'spoc', label: 'SPOC', kind: 'values' },
  { key: 'item', label: 'Item', kind: 'values' },
  { key: 'color', label: 'Colour', kind: 'values' },
  { key: 'planned_start', label: 'Planned Start', kind: 'dates' },
  { key: 'planned_end', label: 'Planned Finish', kind: 'dates' },
  { key: 'revised_start', label: 'Revised Start', kind: 'dates' },
  { key: 'revised_end', label: 'Revised Finish', kind: 'dates' },
  { key: 'qty', label: 'Pcs', kind: 'numbers' },
  { key: 'made', label: 'Made', kind: 'numbers' },
  {
    key: 'status',
    label: 'Status',
    kind: 'values',
    param: 'status',
    labels: WORK_ORDER_STATUS_LABELS,
  },
];

const JOB_FILTER_KIND = new Map(JOB_FILTERS.map((c) => [c.key, c.kind]));

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
/*
 * 108px, and the figure is measured rather than chosen (2026-10-15, the client:
 * *"Reduce the width of these columns in work order"*). It was 120.
 *
 * **What has to fit is the date input, not the date.** The settled text
 * `13/10/2026` needs 85px, but the box is the same width as the box the input
 * occupies — which is the whole point of `DATE_BOX`, so a column does not jump
 * as a cell opens — and a native `<input type="date">` has to hold
 * `dd-mm-yyyy` *and* Chrome's own calendar glyph. Rendered at 88, 96, 104, 112
 * and 120 and looked at: **at 88 the year is cut off and at 96 its last digit
 * is**, 104 reads in full with the glyph clear of it, and 112 has slack. 108 is
 * the floor plus four pixels, which is what the focus ring and a slightly
 * different rendering want.
 *
 * Four columns at 12px each is 48 of the 556 these four were taking — a third
 * of the whole table for four dates. The table is `w-full`, so at a width
 * where it already fits the card that room goes to Item and Customer, which
 * are the columns that were being clipped; where it does not, the card scrolls
 * less.
 */
const DATE_BOX = 'inline-flex h-[28px] w-[6.5rem] items-center px-2 tabular-nums';
/*
 * The native picker glyph at full strength is the loudest thing in the row.
 *
 * `[font-size:inherit]` is not decoration: `fieldClass` hard-codes `text-sm`
 * on every `Input`, and two font-size utilities of equal specificity are
 * settled by **stylesheet order**, not by which was written last — the trap
 * `setsWidth()` exists for. An arbitrary *property* beats the scale outright,
 * so the box takes the table's own size and the column can narrow with it.
 */
const DATE_INPUT = 'w-[6.5rem] px-2 tabular-nums [font-size:inherit] [&::-webkit-calendar-picker-indicator]:opacity-40 [&::-webkit-calendar-picker-indicator]:hover:opacity-70';
/** A group of two date columns opens on a rule; the pair inside shares it. */
const GROUP_EDGE = 'border-l border-slate-200';

/*
 * A sales order with several jobs folds into one row (2026-10-29, the client:
 * *"In sale order which has multiple work orders group them together, to avoid
 * overly large pages and enhance readability"*).
 *
 * Removing the header from a group of **one** was the other half of this, a day
 * earlier. What was left is the opposite case: `SO/26-27/037` has five jobs —
 * one product, `28mm PCO 1810`, in five colours — and took six rows of a page
 * that showed eighteen.
 *
 * **Whether a multi-job order starts open is a preference about this screen**,
 * so it is remembered the way `Dashboard.tsx` remembers its Review fold and
 * `Layout.tsx` its sidebar: `qm.<area>.<thing>`, `'1'`/`'0'`, and a `try/catch`
 * on both sides, because a blocked or corrupt store must not take the page
 * down with it. Nothing is stored until somebody presses the control, so the
 * default is folded.
 */
const FOLD_KEY = 'qm.workorders.fold';
function readExpandGroups(): boolean {
  try { return localStorage.getItem(FOLD_KEY) === '0'; } catch { return false; }
}

/**
 * What a folded order is making: the products, and the colours where there is
 * one of them.
 *
 * On the client's own five-job order the **colour is the only thing telling the
 * jobs apart**, so a folded row without it would hide exactly the point. It is
 * clipped to one line with the whole list on hover, the rule the Item and
 * Customer cells beside it already follow — a summary that wrapped would undo
 * the height the fold just bought.
 */
function groupItems(group: WorkOrder[]): string {
  const products = [...new Set(group.map((w) => w.product_name || w.description || '').filter(Boolean))];
  if (!products.length) return '';
  if (products.length > 1) return products.join(', ');
  const colors = [...new Set(group.map((w) => w.color?.trim() || '').filter(Boolean))];
  return colors.length ? `${products[0]} · ${colors.join(', ')}` : products[0];
}

/** The group's statuses, commonest first — *5 Not planned*, or *3 Scheduled · 2 Running*. */
function statusMix(group: WorkOrder[]): { status: WorkOrderStatus; n: number }[] {
  const counts = new Map<WorkOrderStatus, number>();
  for (const w of group) counts.set(w.status, (counts.get(w.status) ?? 0) + 1);
  return [...counts.entries()]
    .map(([status, n]) => ({ status, n }))
    .sort((a, b) => b.n - a.n);
}

/**
 * Earliest start to latest finish across the group, by the date that **stands**
 * — the revised one where set, else the planned one, which is the rule every
 * reader of a job's date follows. ISO dates sort chronologically, so this is a
 * sort rather than a comparison written out. Blank where no job carries one:
 * silence is not a date.
 */
function dateSpan(group: WorkOrder[]): { from: string; to: string } {
  const starts = group.map((w) => w.revised_start || w.planned_start).filter(Boolean).sort();
  const ends = group.map((w) => w.revised_end || w.planned_end).filter(Boolean).sort();
  return { from: starts[0] ?? '', to: ends[ends.length - 1] ?? '' };
}

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
  // The header filters, held in the URL — the same hook the order book reads
  // its own through. Status is one of them, under the `?status=` key the
  // dashboard's factory card has always linked with.
  const columns = useColumnFilters(JOB_FILTERS);
  const statusTicked = columns.get('status')?.values ?? [];
  // The floor's own queue, in the URL like every other filter so it can be
  // kept open on a second screen.
  const [awaiting, setAwaiting] = useUrlFilter('awaiting');
  const [openOnly, setOpenOnly] = useState(true);
  /*
   * The three the sales order book has had all along and this list had none of
   * (2026-10-15, the client with both pages in front of them: *"Add the filter
   * options that are available in sales order in work order too"*).
   *
   * All three in the **URL**, which is where every other filter on this page
   * already lives — the column funnels and the *to confirm* queue — so a
   * narrowed list can be bookmarked, reloaded and left open on a screen beside
   * the machines. (The order book keeps its own two in component state; this
   * is the better half of the two shapes rather than a copy of the weaker.)
   *
   * They go to the server under the same keys that list uses, so a habit
   * learned on one works on the other — and **server-side**, because this list
   * is paged: a search run over the rows already fetched would be searching
   * one page of a book somebody is looking through.
   */
  const [exportFilter, setExportFilter] = useUrlFilter('export');
  const [companyFilter, setCompanyFilter] = useUrlFilter('company');
  const [q, setQ] = useUrlFilter('q');
  const companies = useCompanies();
  // Drawn only for a group that has more than one selling entity — a filter
  // offering one value is a control that can only ever do nothing.
  const showCompany = companies.length > 1;
  const can = useCan();
  /*
   * The planning step: tick jobs, press Plan. Selection is by id and lives
   * only on this page — it is not in the URL, since a half-ticked set is not
   * a view anybody bookmarks. Closed jobs cannot be ticked; the server refuses
   * them by name anyway, and a box that cannot be ticked says so sooner.
   */
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [planModal, setPlanModal] = useState(false);
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
  /*
   * The fold. `groupOpen` above is **not** this — that set means *"this
   * order's date pair is open"*, which is a different fold on the same row.
   *
   * `toggledGroups` holds the orders whose fold differs from the page's
   * current default, which is what lets one set serve a default that moves.
   * Keyed by order id and never by index, `Quotations.tsx`'s rule, so
   * filtering the list cannot open the wrong one.
   */
  /*
   * Two views over one list (2026-10-29, the client, a third time on this
   * page: *"make it more user friendly and increase its readibility"*).
   *
   * **The page was doing two jobs at once and paying fourteen columns for
   * it** — filling in dates for the 65 jobs nobody has planned, and watching
   * what is running. Measured at 1680 the width was already fully committed:
   * the four date columns alone were 432px, 31% of the table, and Customer
   * was truncated on six of eleven rows with nothing left to give it. Nothing
   * could be freed by rearranging, so readability had to come from drawing
   * **fewer** columns — and which ones depends on which of the two jobs you
   * are doing, which is the order book's own answer to the same problem.
   *
   * **Plan** drops Date raised, Made, SPOC and the output button and keeps all
   * four date cells, which are what you came to type into. **Progress** drops
   * the tick and the editable grid and shows the date that **stands** as one
   * pair with the slip under it — the order book's `JobDateCell`, imported
   * rather than copied. Nothing anybody asked for has left the page: every
   * column lives in one view or the other.
   *
   * Plan is the default because the book is 65 unplanned of 84, and the view
   * is in the URL so a narrowed list can still be linked to whole.
   */
  const [view, setView] = useUrlFilter('view');
  const planning = view !== 'progress';
  const [expandGroups, setExpandGroups] = useState<boolean>(readExpandGroups);
  const [toggledGroups, setToggledGroups] = useState<Set<number>>(new Set());
  const dirtyIds = Object.keys(dates).map(Number);
  const queryClient = useQueryClient();
  const mayPlan = can('work_order', 'full');
  const plannable = (w: WorkOrder) => !['done', 'cancelled'].includes(w.status);
  /*
   * Booking a shift from the list (2026-10-15, the client: *"Add a option to
   * log output for production"*).
   *
   * It has always been possible on the job's own page, which means finding the
   * job here, opening it, booking, and coming back — and this is the screen the
   * floor has open, for the reason the date grid was put on it: the list is
   * where the day's work is, and an action that belongs to a row belongs on the
   * row. The **same `LogOutput`** the job page opens, so there is one form that
   * knows what a shift is rather than two that will come to differ.
   *
   * `output: full`, which is its own function and not `work_order` — the floor
   * books what it made without being able to re-plan the job, which is exactly
   * the split the matrix draws. A **cancelled** job is not offered it: its
   * output counts towards nothing anywhere (`LIVE_OK`, the roll-ups and the
   * order ladder all skip it), so booking against one would be recording a
   * figure that then appears in no total. A **completed** job *is* offered it,
   * unlike the date cells: an over-run is ordinary and the column beside it
   * already colours *% over*.
   *
   * **It is a column of its own since 2026-10-19**, at the client's word
   * (*"Instead of clicking on made column, add a button to log output"*). It
   * was the Made figure itself, with a `+` that lifted under the pointer —
   * chosen to keep a twelfth column off a table that already scrolls inside
   * its card below 1680, and withdrawn because a figure that is also a button
   * is a control nobody looks for. What that reasoning bought is kept instead
   * by **drawing the column only for somebody who may book a shift**, the way
   * the tick column follows `mayPlan`: a `view` login sees the table it
   * always had, with no empty cells where a control would be.
   */
  const mayLog = can('output', 'full');
  const loggable = (w: WorkOrder) => mayLog && w.status !== 'cancelled';
  const [logging, setLogging] = useState<WorkOrder | null>(null);
  const toggle = (id: number, on: boolean) => setTicked((t) => {
    const next = new Set(t);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const query = new URLSearchParams();
  if (awaiting) query.set('awaiting', awaiting);
  if (exportFilter) query.set('export', exportFilter);
  if (companyFilter) query.set('company', companyFilter);
  if (q) query.set('q', q);
  // The default view of a shop floor, and a default rather than a rule: naming
  // a status says what is wanted, so the tick list wins over it.
  if (openOnly && statusTicked.length === 0) query.set('open', '1');
  for (const [k, v] of columns.params) query.set(k, v);

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

  /*
   * Two facts about the page, counted once over it.
   *
   * **How many jobs of each order are on it** decides whether that order gets
   * a header row at all. Clubbing by sales order (2026-09-15) earns its place
   * on a real group — the 5-job order says *5 jobs*, totals them and sets one
   * pair of dates across the lot. On a group of **one** it says nothing the
   * row below does not: the order number, then the customer the row states in
   * its own column, the pcs and made the row states in theirs, and *Set dates
   * for all 1*, which is what the row's own two boxes are. On the client's own
   * screen 9 of 10 orders had one job, so **half the height of the list was a
   * header for a group of one** — and, because a header is grey and a job row
   * is not, the list was striped every other row and could not be read down a
   * column. It is drawn where there is a group, and a singleton names its
   * order under its job number instead.
   *
   * **Which order each row belongs to** tints alternate ones, so a group still
   * reads as one block without a grey band between every pair of rows — the
   * order book's own rule about a three-line order.
   */
  const jobsPerOrder = new Map<number, number>();
  for (const j of jobs) jobsPerOrder.set(j.order_id, (jobsPerOrder.get(j.order_id) ?? 0) + 1);
  const groupIndex = jobs.reduce<number[]>((acc, j, i) => {
    acc.push(i === 0 ? 0 : acc[i - 1] + (jobs[i - 1].order_id === j.order_id ? 0 : 1));
    return acc;
  }, []);
  /** How many orders on this page have anything to fold — no control otherwise. */
  const foldable = [...jobsPerOrder.values()].filter((n) => n > 1).length;
  /*
   * **A list somebody is searching or filtering is one they are hunting a
   * particular job in**, so groups open. A fold that hid the match would be
   * the page refusing to answer what was asked — search `WO/26-27/149` and
   * find a folded order where the job should be. *Open jobs only* is not a
   * filter in this sense: it is the default view of a shop floor.
   */
  const hunting = !!q || !!awaiting || columns.filtered.length > 0;
  const groupsOpenByDefault = expandGroups || hunting;
  const groupIsOpen = (orderId: number) =>
    (toggledGroups.has(orderId) ? !groupsOpenByDefault : groupsOpenByDefault);
  const toggleGroup = (orderId: number) => setToggledGroups((prev) => {
    const next = new Set(prev);
    if (next.has(orderId)) next.delete(orderId); else next.add(orderId);
    return next;
  });
  /*
   * When the default flips — a filter arrives, or Expand orders is pressed —
   * the exceptions are dropped, or an order somebody opened would silently
   * come to mean *closed*. Guarded so an unchanged empty set is not a render.
   */
  useEffect(() => { setToggledGroups((prev) => (prev.size ? new Set() : prev)); }, [groupsOpenByDefault]);

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

  /**
   * One heading, with its filter beside it.
   *
   * The flex and `whitespace-nowrap` are not decoration: the funnel is an
   * inline element inside a heading narrow enough to wrap, and a heading broken
   * under its own control reads as a fault rather than as a control.
   */
  /*
   * Plan draws a banner row over its two date pairs, so every other heading
   * spans both rows; Progress has one pair and a single header row. Written
   * once, because a heading left at 2 under a one-row header silently eats
   * the row beneath it.
   */
  const headSpan = planning ? 2 : 1;

  const filterFor = (key: string, label?: string) => {
    const spec = JOB_FILTERS.find((c) => c.key === key);
    return (
      <ColumnFilter
        column={key}
        kind={JOB_FILTER_KIND.get(key) ?? 'values'}
        label={label ?? spec?.label ?? key}
        labels={spec?.labels}
        value={columns.get(key)}
        onChange={(v) => columns.set(key, v)}
        query={columns.params.toString()}
        path="/api/work-orders/facet"
      />
    );
  };

  return (
    <div>
      <PageHeader
        title="Work Orders"
        subtitle="What the floor is making, across every order"
      />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        {/* What the page is for this minute. Both views read the same query,
            so every filter survives the switch, and the strip below names any
            set on a column the current view does not draw. */}
        <SegmentedTabs
          value={planning ? 'plan' : 'progress'}
          onChange={(v) => setView(v === 'plan' ? '' : v)}
          tabs={[
            { key: 'plan', label: 'Plan' },
            { key: 'progress', label: 'Progress' },
          ]}
        />
        <ExportTabs value={exportFilter} onChange={setExportFilter} />
        {showCompany && (
          <Select value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)} className="max-w-56">
            <option value="">All companies</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.company_name || `Company ${c.id}`}</option>
            ))}
          </Select>
        )}
        <Input
          className="w-72"
          placeholder="Search job no., sales order, PO no., customer…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={openOnly}
            disabled={statusTicked.length > 0}
            onChange={(e) => setOpenOnly(e.target.checked)}
          />
          Open jobs only
        </label>
        <span className="ml-auto text-sm text-slate-500">
          {summary.jobs} job{summary.jobs === 1 ? '' : 's'} · {fmtQty(summary.made)} of {fmtQty(summary.planned)} pcs made
        </span>
        {/*
          The whole page at once, and **the control is the preference**: what it
          sets is remembered, so somebody who would rather see every job opens
          them once rather than every morning. Not drawn while hunting — the
          groups are open because of the filter, so it would be a control that
          appears to do nothing; the chevron on a row still folds one.
        */}
        {foldable > 0 && !hunting && (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-slate-50 hover:text-slate-900"
            onClick={() => setExpandGroups((v) => {
              try { localStorage.setItem(FOLD_KEY, v ? '1' : '0'); } catch { /* not worth failing over */ }
              return !v;
            })}
            title={`${expandGroups ? 'Fold' : 'Open'} the ${foldable} sales order${foldable === 1 ? '' : 's'} on this page with more than one job — remembered for next time`}
          >
            <Icon name={expandGroups ? 'chevron-down' : 'chevron-right'} size={12} />
            {expandGroups ? 'Fold orders' : 'Expand orders'}
          </button>
        )}
        {/* The queue: jobs the order raised that nobody has planned yet. A
            filter, not a count of its own — it links to exactly what it says. */}
        {statusTicked.length === 0 && unplanned > 0 && (
          <button
            className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 ring-1 ring-amber-200 hover:bg-amber-100"
            onClick={() => { setView(''); columns.set('status', { values: ['planned'] }); }}
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
            onClick={() => { if (!awaiting) setView(''); setAwaiting(awaiting ? '' : '1'); }}
            title={awaiting
              ? 'Show every job again'
              : 'Jobs whose start date has come with nobody saying whether they started — confirm, or revise the date'}
          >
            {toConfirm} to confirm
          </button>
        )}
        {planning && mayPlan && (
          <Button
            disabled={ticked.size === 0}
            onClick={() => setPlanModal(true)}
            title={ticked.size ? undefined : 'Tick the jobs to plan first'}
          >
            Plan {ticked.size || ''} job{ticked.size === 1 ? '' : 's'}…
          </Button>
        )}
      </div>
      {planModal && (
        <PlanJobsModal
          jobs={jobs.filter((w) => ticked.has(w.id))}
          onClose={() => setPlanModal(false)}
          onPlanned={() => { setPlanModal(false); setTicked(new Set()); }}
        />
      )}
      {/*
        * Booking a shift moves the row's Made figure, the summary over the
        * table and — through `syncJobStatus` — the job's own status pill, so
        * the list is invalidated by prefix rather than the one row patched.
        * The modal stays open afterwards, which is deliberate: a shift book is
        * two or three entries more often than one, and it shows what has been
        * booked as it goes.
        *
        * Pending date edits are untouched by the refetch — they are keyed by
        * job id in state of their own, which is what lets them survive paging
        * and filtering too.
        */}
      {logging && (
        <LogOutput
          job={logging}
          onClose={() => setLogging(null)}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ['work-orders'] })}
        />
      )}

      <FilteredByStrip
        columns={columns.filtered}
        onClear={(key) => columns.set(key, {})}
        onClearAll={columns.clearAll}
      />

      <Card className="overflow-x-auto">
        {jobs.length === 0 ? (
          <EmptyState message="No work orders match. A sales order raises its jobs when it is booked." />
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className={`${TH_CLASS} ${planning ? 'border-b-0' : ''}`}>
                {/* Ticking is for planning, so the column is Plan's. */}
                {planning && mayPlan && (
                  <th className="pb-2 pr-2" rowSpan={headSpan}>
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
                <th className="whitespace-nowrap pb-2 pr-3" rowSpan={headSpan}>
                  <span className="flex items-center gap-0.5">Job{filterFor('job')}</span>
                </th>
                {/* Who it is for. The group header above each run names the
                    order and the customer, and this repeats it per row at the
                    client's word (2026-10-08) — which is what makes the table
                    readable as a flat list once a filter has cut it down to a
                    handful of jobs across several orders. */}
                {/* When the job was raised, beside the number that names it
                    — where the sales order book puts its own Date, which is
                    the list this one is read next to. */}
                {/* The day the job was raised is a fact about the record
                    rather than about planning it, so it rides Progress. */}
                {!planning && (
                  <th className="whitespace-nowrap pb-2 pr-3" rowSpan={headSpan}>
                    <span className="flex items-center gap-0.5">Date{filterFor('created')}</span>
                  </th>
                )}
                <th className="whitespace-nowrap pb-2 pr-3" rowSpan={headSpan}>
                  <span className="flex items-center gap-0.5">Customer{filterFor('customer')}</span>
                </th>
                <th className="whitespace-nowrap pb-2 pr-3" rowSpan={headSpan}>
                  <span className="flex items-center gap-0.5">Item{filterFor('item')}</span>
                </th>
                <th className="whitespace-nowrap pb-2 pr-3" rowSpan={headSpan}>
                  <span className="flex items-center gap-0.5">Colour{filterFor('color')}</span>
                </th>
                {/*
                  Both pairs are drawn (2026-09-29, the client with one pair and
                  a `rev.` marker in front of them: *"This page should show both
                  planned and revised dates"*). One pair showing whichever date
                  stands answers *when does this run* and hides the other half of
                  the question the two columns exist to answer — what was
                  promised, and by how much it has moved. The original was on
                  hover, which is not somewhere a column can be read from.
                */}
                {planning ? (
                  <>
                    <th className={`${GROUP_EDGE} pb-1 pl-3 pr-3`} colSpan={2}>Planned</th>
                    <th className={`${GROUP_EDGE} pb-1 pl-3 pr-3`} colSpan={2}>Revised</th>
                  </>
                ) : (
                  /*
                    One pair, and it is the date that **stands** — the revised
                    one where set, else the planned one — with the slip under
                    it where it has moved. Watching asks *when does this run
                    and is it late*, which is one date, not four.
                    **No funnel on these two**: the stored columns are
                    `planned_*` and `revised_*` and this is derived from both,
                    so a tick list headed *Start* that filtered the planned
                    column would be wrong on every revised job. The four date
                    filters live on Plan, where the four columns are, and the
                    strip above names one set from here.
                  */
                  <>
                    <th className={`${GROUP_EDGE} whitespace-nowrap pb-2 pl-3 pr-3`}>Start</th>
                    <th className="whitespace-nowrap pb-2 pr-3">Finish</th>
                  </>
                )}
                <th className={`${GROUP_EDGE} whitespace-nowrap pb-2 pl-3 pr-3 text-right`} rowSpan={headSpan}>
                  <span className="flex items-center justify-end gap-0.5">Pcs{filterFor('qty')}</span>
                </th>
                {/* What has been booked, and who to tell about it: both are
                    things you read rather than things you plan. */}
                {!planning && (
                  <th className="whitespace-nowrap pb-2 pr-3 text-right" rowSpan={headSpan}>
                    <span className="flex items-center justify-end gap-0.5">Made{filterFor('made')}</span>
                  </th>
                )}
                {!planning && (
                  <th className="whitespace-nowrap pb-2 pr-3" rowSpan={headSpan}>
                    <span className="flex items-center gap-0.5">SPOC{filterFor('spoc')}</span>
                  </th>
                )}
                <th className="whitespace-nowrap pb-2 pr-3" rowSpan={headSpan}>
                  <span className="flex items-center gap-0.5">Status{filterFor('status')}</span>
                </th>
                {/* No heading: the buttons under it say what they are, and a
                    word here would only widen the column past them. It carries
                    no funnel either — an action is not a value to filter on. */}
                {!planning && mayLog && <th className="pb-2" rowSpan={headSpan} aria-label="Book output" />}
              </tr>
              {/*
                The sub-row carries the rule and the banner above it carries
                none, or the heading reads as two stacked tables. Both are
                left-aligned over cells whose dates are left-aligned — a banner
                centred over its pair floats away from the column it names.
              */}
              {planning && (
                <tr className={`${CAPTION_CLASS} border-b border-slate-200 text-left font-normal text-slate-400`}>
                  <th className={`${GROUP_EDGE} whitespace-nowrap pb-2 pl-3 pr-1`}>
                    <span className="flex items-center gap-0.5">Start{filterFor('planned_start')}</span>
                  </th>
                  <th className="whitespace-nowrap pb-2 pl-1 pr-1">
                    <span className="flex items-center gap-0.5">Finish{filterFor('planned_end')}</span>
                  </th>
                  <th className={`${GROUP_EDGE} whitespace-nowrap pb-2 pl-3 pr-1`}>
                    <span className="flex items-center gap-0.5">Start{filterFor('revised_start')}</span>
                  </th>
                  <th className="whitespace-nowrap pb-2 pl-1 pr-1">
                    <span className="flex items-center gap-0.5">Finish{filterFor('revised_end')}</span>
                  </th>
                </tr>
              )}
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
                /* A header for a group of one repeats the row under it and
                   says nothing else — see `jobsPerOrder` above. */
                const grouped = (jobsPerOrder.get(w.order_id) ?? 1) > 1;
                const header = first && grouped;
                /* Alternate orders tinted, so a group reads as one block. The
                   ticked colour **replaces** it rather than sitting beside it:
                   two background utilities of equal specificity are settled by
                   stylesheet order, not by which was written last. */
                const tint = groupIndex[i] % 2 === 1 ? 'bg-slate-50/60' : '';
                /*
                 * A sales order with several jobs is drawn in colour (2026-10-29,
                 * the client: *"The sale order which has multiple work order is
                 * not clearly visible, maybe add a colour to it"*).
                 *
                 * It was `slate-50` against rows tinted `slate-50/60` — measured,
                 * **lightness 0.984 against 0.984**, which is to say no
                 * difference at all. Grey cannot fix that: the row has to leave
                 * the grey the rest of the table is drawn in.
                 *
                 * `brand-100` with a `brand-600` bar down its left edge, which
                 * is the sidebar's own way of saying *this one is different*.
                 * The bar is an **inset shadow on the row** rather than a
                 * border: a border in a collapsed table is negotiated with its
                 * neighbours and lands on 2.4px of a 3px rule, and one on the
                 * first cell would shift that cell's content — measured, the
                 * shadow costs **no width at all**. The member rows of an open
                 * order carry the same bar in `brand-100`, so the whole order
                 * reads as one block rather than a coloured row over plain ones.
                 *
                 * It cannot be read as *ticked*: that is `brand-50`, which is
                 * three steps paler and is what a job row takes, never a header.
                 */
                const GROUP_BAR = 'shadow-[inset_3px_0_0_var(--color-brand-600)]';
                const MEMBER_BAR = 'shadow-[inset_3px_0_0_var(--color-brand-100)]';
                /*
                 * A folded order is its header alone. A single-job order has no
                 * header to fold and is always drawn.
                 *
                 * The three summaries below are built only while folded, and
                 * each lands **under the columns it summarises** — the items
                 * under Item and Colour, the span under the date columns, the
                 * status mix under Status. That is what makes a fold possible
                 * with no new column and no re-spanned header.
                 */
                const open = !grouped || groupIsOpen(w.order_id);
                const folded = header && !open;
                const groupTicked = groupPlannable.filter((x) => ticked.has(x.id)).length;
                /* What a folded row would otherwise hide: edits waiting to be
                   saved, and a job nobody has confirmed the start of. */
                const groupDated = group.filter((x) => dates[x.id]).length;
                const groupDue = group.filter((x) => x.due_to_start).length;
                const items = folded ? groupItems(group) : '';
                const mix = folded ? statusMix(group) : [];
                const span = folded ? dateSpan(group) : { from: '', to: '' };
                return [
                  header && (
                    /*
                      The whole header is the hit target, the shape the Raw
                      Material Required rows use — a bare chevron on a row this
                      wide is a control nobody finds. Each cell holding a
                      control of its own stops the click, so a control added to
                      one later is covered by forgetting rather than by
                      remembering.
                    */
                    <tr
                      key={`order-${w.order_id}`}
                      className={`cursor-pointer border-t border-slate-200 bg-brand-100 ${GROUP_BAR}`}
                      onClick={() => toggleGroup(w.order_id)}
                      title={open ? `Fold ${w.order_number} back into one row` : `Show the ${group.length} jobs on ${w.order_number}`}
                    >
                      {planning && mayPlan && (
                        <td className="py-1.5 pr-2" onClick={(e) => e.stopPropagation()}>
                          {groupPlannable.length > 0 && (
                            <input
                              type="checkbox"
                              title="Tick every job on this sales order that can be planned"
                              /* Some but not all. Without this a part-ticked
                                 order reads as untouched — already slightly
                                 wrong, and worse once its rows are folded. */
                              ref={(el) => { if (el) el.indeterminate = groupTicked > 0 && groupTicked < groupPlannable.length; }}
                              checked={groupPlannable.length > 0 && groupTicked === groupPlannable.length}
                              onChange={(e) => setTicked((t) => {
                                const next = new Set(t);
                                for (const x of groupPlannable) { if (e.target.checked) next.add(x.id); else next.delete(x.id); }
                                return next;
                              })}
                            />
                          )}
                        </td>
                      )}
                      {/* Job, Customer, Item and Colour — and Date raised too
                          on Progress, which is the view that draws it. */}
                      <td className="py-1.5 pr-3 font-semibold" colSpan={planning ? 4 : 5}>
                        <div className="flex min-w-0 items-center gap-2">
                          <Icon
                            name="chevron-right"
                            size={12}
                            className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}
                          />
                          <Link
                            to={`/orders/${w.order_id}`}
                            className="shrink-0 whitespace-nowrap text-brand-700 hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {w.order_number}
                          </Link>
                          <span className="max-w-[14rem] shrink-0 truncate font-normal text-slate-600" title={w.customer_name || undefined}>
                            {w.customer_name}
                          </span>
                          {/* What is being made. On a five-job order of one
                              product the colour is the only thing telling the
                              jobs apart, so without this the fold hides the
                              point. Clipped with the whole list on hover — a
                              summary that wrapped would undo the height the
                              fold just bought. */}
                          {!!items && (
                            <span className="min-w-0 flex-1 truncate text-xs font-normal text-slate-500" title={items}>
                              {items}
                            </span>
                          )}
                        </div>
                      </td>
                      {/*
                        The order's own pair: two dates that fill every job under
                        it. Quiet until asked for, like the cells below — an
                        order already fully dated does not need a control over
                        it, and one that does needs it only once.
                      */}
                      <td className={`${GROUP_EDGE} py-1.5 pl-3 pr-2 text-xs text-slate-500`} colSpan={planning ? 4 : 2} onClick={(e) => e.stopPropagation()}>
                        <span className="mr-3">{group.length} job{group.length === 1 ? '' : 's'}</span>
                        {/* When it runs, by the date that stands on each job.
                            Only while folded: open, every row says its own. */}
                        {!!(span.from || span.to) && (
                          <span className="mr-3 whitespace-nowrap tabular-nums" title="Earliest start to latest finish across this order's jobs">
                            {span.from ? fmtDate(span.from) : '—'}
                            <span className="px-1 text-slate-300">→</span>
                            {span.to ? fmtDate(span.to) : '—'}
                          </span>
                        )}
                        {/* Dates typed into rows that are now folded away. The
                            bar below counts them, so a folded order holding
                            some has to say so — or Save would write a date
                            from a row nobody can see. */}
                        {folded && groupDated > 0 && (
                          <span className="mr-3 whitespace-nowrap font-medium text-brand-700" title="Dates typed on this order and not yet saved">
                            {groupDated} dated
                          </span>
                        )}
                        {folded && groupDue > 0 && (
                          <span className="mr-3 whitespace-nowrap font-medium text-red-700" title="Due to start with nobody saying whether it has — open the order to answer">
                            {groupDue} to confirm
                          </span>
                        )}
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
                      {!planning && (
                        <td className="py-1.5 pr-3 text-right text-xs tabular-nums text-slate-500">{fmtQty(groupMade)}</td>
                      )}
                      {/*
                        **SPOC is the order's, not the job's.** It is
                        `orders.spoc` read off the join, so every job under this
                        header carries the same value and a folded row can state
                        it rather than losing it — which is what it did when
                        this cell was inside the status mix's span, on the
                        reasoning that SPOC and the output button were both the
                        row's own. The button is; this is not.
                      */}
                      {!planning && (
                        <td className="whitespace-nowrap py-1.5 pr-3 text-slate-600">
                          {folded && (w.spoc || <span className="text-slate-300">—</span>)}
                        </td>
                      )}
                      {/* The output button is the row's own — a shift is booked
                          against a job, and an order is not a job. Status an
                          order can answer for, so a folded header answers it:
                          the mix, commonest first, in the pills its rows wear.
                          Spanning Status and the button puts the pills under
                          the Status heading, where the rows' own pills are. */}
                      <td colSpan={planning ? 1 : (mayLog ? 2 : 1)} className="py-1.5 pr-3">
                        {mix.length > 0 && (
                          <span
                            className="flex flex-wrap items-center gap-1"
                            title={mix.map(({ status, n }) => `${n} ${workOrderStatusLabel(status)}`).join(' · ')}
                          >
                            {mix.slice(0, 2).map(({ status, n }) => (
                              <span
                                key={status}
                                className={`inline-block whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] font-medium ${workOrderStatusStyle[status]}`}
                              >
                                {n} {workOrderStatusLabel(status)}
                              </span>
                            ))}
                            {mix.length > 2 && <span className="text-xs text-slate-400">+{mix.length - 2}</span>}
                          </span>
                        )}
                      </td>
                    </tr>
                  ),
                  /* A folded order is its header alone — see `open` above. */
                  open && (
                    <tr
                      key={w.id}
                      className={`border-b border-slate-100 last:border-0 hover:bg-brand-50/60 ${
                        ticked.has(w.id) ? 'bg-brand-50' : tint
                      } ${first && !header ? 'border-t border-slate-200' : ''} ${grouped ? MEMBER_BAR : ''}`}
                    >
                      {planning && mayPlan && (
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
                      <td className={`whitespace-nowrap py-2 pr-3 font-medium ${grouped ? 'pl-4' : ''}`}>
                        <Link to={`/work-orders/${w.id}`} className="text-brand-600 hover:underline">{w.number}</Link>
                        {/* The one thing the header said that the row cannot:
                            which sales order raised this job. Drawn where there
                            is no header to say it — a grouped job is indented
                            under one that does. */}
                        {first && !header && (
                          <div className="mt-px text-[10px] font-normal leading-none">
                            <Link to={`/orders/${w.order_id}`} className="text-slate-400 hover:text-brand-600 hover:underline">
                              {w.order_number}
                            </Link>
                          </div>
                        )}
                      </td>
                      {/* When the job was raised. Already this desk's own date
                          when it arrives — the stamp is UTC and the conversion
                          is done beside the filter that reads it. */}
                      {!planning && (
                        <td className="whitespace-nowrap py-1.5 pr-3 text-slate-600">
                          {w.created_date ? fmtDate(w.created_date) : <span className="text-slate-300">—</span>}
                        </td>
                      )}
                      {/* One line, with the whole name on hover — the rule the
                          order book's own lines view follows about its customer
                          column, and for the same reason: a name that wraps makes
                          every row in the table two lines tall to serve one. */}
                      <td className="py-1.5 pr-3 text-slate-600">
                        <div className="max-w-[11rem] truncate" title={w.customer_name || undefined}>
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
                          className="max-w-[12.5rem] truncate"
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
                      {planning && ([[false, false], [false, true], [true, false], [true, true]] as const).map(([revised, isEnd]) => {
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
                            className={`whitespace-nowrap py-1.5 pr-1 text-xs ${
                              flag ? 'font-medium text-red-600'
                              // The date that **stands** is the one being asked about, which is
                              // not the same cell as the one that takes the answer: a job with no
                              // revision is due on its plan, and answering *No* opens the revised
                              // box beside it.
                              : (!isEnd && !!w.due_to_start && revised === !!w.revised_start) ? 'font-medium text-red-700'
                              : 'text-slate-600'
                            } ${isEnd ? '' : `${GROUP_EDGE} pl-1`}`}
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
                      {/*
                        Watching asks *when does this run, and is it late* —
                        which is one date, not four. The date that **stands**,
                        with the plan it replaced and the slip in days under it
                        where it has moved: `JobDateCell`, imported from the
                        order book rather than copied, since that list answers
                        the same question about the same two columns.
                        Read-only — revising a plan is a planning act, and the
                        four boxes that do it are one tab away.
                      */}
                      {!planning && (
                        <>
                          <td className={`${GROUP_EDGE} whitespace-nowrap py-1.5 pl-3 pr-3 text-xs`}>
                            <JobDateCell
                              value={w.revised_start || w.planned_start}
                              planned={w.planned_start}
                              overdue={false}
                            />
                          </td>
                          <td className="whitespace-nowrap py-1.5 pr-3 text-xs">
                            <JobDateCell value={standingEnd} planned={w.planned_end} overdue={late} />
                          </td>
                        </>
                      )}
                      <td className={`${GROUP_EDGE} py-1.5 pl-3 pr-3 text-right tabular-nums`}>{fmtQty(w.qty_planned)}</td>
                      {/* The percentage sits beside the figure rather than under
                          it: stacked, it made every one of eighty rows two lines
                          tall to say something one word wide. */}
                      {/*
                        * The figure, and the control that moves it. Putting the
                        * button *on* the made figure rather than in a column of
                        * its own was how this was first built; it is a column
                        * now (see `mayLog` above), so the figure is a figure.
                        */}
                      {!planning && (
                      <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums">
                        {(() => {
                          const produced = w.progress?.produced ?? 0;
                          /*
                           * Nothing made yet is one quiet figure. `0 0%` says it
                           * twice, and on the client's own book 60 of 79 jobs are
                           * not even planned — so that was the whole column. The
                           * percentage earns its place once there is something
                           * for it to be a percentage of.
                           */
                          if (produced === 0) return <span className="text-slate-300">0</span>;
                          const pct = w.qty_planned > 0 ? Math.round((produced / w.qty_planned) * 100) : null;
                          return (
                            <>
                              {fmtQty(produced)}
                              {pct != null && (
                                // Past the plan is a fact worth a colour: the figure
                                // is right, and it is the plan that is now wrong.
                                <span className={`ml-1.5 text-xs ${pct > 100 ? 'font-medium text-amber-700' : 'text-slate-400'}`} title={pct > 100 ? 'More made than planned — the plan is behind the floor' : undefined}>
                                  {pct}%{pct > 100 ? ' over' : ''}
                                </span>
                              )}
                            </>
                          );
                        })()}
                      </td>
                      )}
                      {/* One word on this book, so it does not wrap; a job whose
                          order names nobody reads as an absence rather than a gap. */}
                      {!planning && (
                        <td className="whitespace-nowrap py-1.5 pr-3 text-slate-600">
                          {w.spoc || <span className="text-slate-300">—</span>}
                        </td>
                      )}
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

                          **Plan only**, because *No* opens a box that only Plan
                          draws — on Progress it would be an answer with nowhere
                          to land. The *to confirm* chip switches to Plan for the
                          same reason.
                        */}
                        {planning && !!w.due_to_start && mayPlan && (
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
                      {/* The action, in a cell of its own. Empty on a cancelled
                          job rather than dashed: an em-dash reads as a value
                          that is absent, and there is no value here to be. */}
                      {!planning && mayLog && (
                        <td className="py-1.5 pr-3">
                          {loggable(w) && (
                            <button
                              type="button"
                              onClick={() => setLogging(w)}
                              title={`Book a shift against ${w.number}`}
                              className="whitespace-nowrap rounded border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600 transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
                            >
                              Log output
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ),
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
