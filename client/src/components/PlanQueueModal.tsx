import { useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useCan } from '../App';
import type { PlannedJob, PlanPreview, PlanSortKey } from '../types';
import { Button, Input, Select, Modal, ErrorText, TH_CLASS } from './ui';
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
 *
 * ---
 *
 * **Reworked 2026-11-17** against the client's own first screenful of it —
 * 47 jobs — which is what showed the difference between a screen that works
 * on a fixture and one that works on a book. Five things it got wrong at that
 * size, each fixed here and each a rule rather than a tweak:
 *
 * 1. **The decision sat below the rows.** Cancel and *Fill in N dates* were
 *    under forty-seven of them, so the only way to reach the button was to
 *    scroll past everything the button commits to. The table scrolls **inside
 *    itself** now under a sticky head, and the summary and the footer stay on
 *    screen whatever the queue's length — which is also the whole of what
 *    makes this work at two hundred jobs rather than fifty.
 * 2. **Nothing said what the plan came to.** A planner pressing a button that
 *    dates 47 jobs is committing the floor into January, and no figure on the
 *    page said so. `summary` is the server's own fold of the same rows.
 * 3. **Every rate was a bare number.** Hover is not where a fact can be read
 *    down a column of forty-seven, and a rate is the one input the planner
 *    has to be able to disbelieve. Each now states what it was measured over,
 *    and marks itself where the evidence is thin, stale or skewed.
 * 4. **Reordering was one place at a time.** Thirty-nine presses to move the
 *    fortieth row to the front. The order is a **rule** now, picked once,
 *    with the arrows left for the correction they are good at.
 * 5. **Every *Needed* cell was an em-dash**, which reads as a column that
 *    does not work rather than as a fact about the book. It is said in
 *    words, and it says which of the two it is.
 */

/** How a queue opens, in the planner's own words. */
const SORTS: { key: PlanSortKey; label: string }[] = [
  { key: 'due', label: 'What the customer needs first' },
  { key: 'shortest', label: 'Shortest jobs first' },
  { key: 'longest', label: 'Longest jobs first' },
  { key: 'order', label: 'Keep each sales order together' },
];

/**
 * A date in the plan, short enough to read down a column: *17 Nov*, with the
 * year only where the plan crosses into another one. `fmtDate`'s own
 * `17/11/2026` is right on a document and twice the width needed here, and
 * this column states a pair of them on every row.
 */
function planDay(iso: string, baseYear: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return '—';
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m[2] - 1];
  return `${+m[3]} ${month}${m[1] === baseYear ? '' : ` '${m[1].slice(2)}`}`;
}

/** The span a whole plan occupies, said once rather than read off two rows. */
const planSpan = (from: string, to: string): string =>
  (from && to ? `${planDay(from, from.slice(0, 4))} → ${planDay(to, from.slice(0, 4))}` : '—');

/**
 * Whether a measured rate is worth leaning on, and if not, why — stated in
 * the cell rather than left on a hover, because the whole queue's dates are
 * computed from this column and a planner scanning it has to be able to see
 * which figures to disbelieve.
 *
 * **Skewed** is the one that matters and the one the client met: the rate is
 * the median of the days booked, so a mean far above it means the shift book
 * holds a bulk or back-dated entry — a week's output keyed to one date. That
 * is worth correcting at the source, and until it is, the median is already
 * protecting the plan from it.
 */
function rateDoubt(p: PlannedJob): { mark: string; why: string } | null {
  const r = p.rate;
  if (!r) return null;
  const m = r.source === 'measured' ? r : r.measured;
  if (!m) return null;
  const mean = 'mean_per_day' in m ? m.mean_per_day : undefined;
  if (mean != null && m.pcs_per_day > 0 && mean > m.pcs_per_day * 1.5) {
    return {
      mark: 'uneven',
      why: `The days booked are uneven — they average ${fmtQty(mean)}/day against a typical day of ${fmtQty(m.pcs_per_day)}. That is the signature of a bulk or back-dated shift entry; the plan uses the typical day, but the shift book is worth a look.`,
    };
  }
  if (m.days <= 2) {
    return {
      mark: 'thin',
      why: `Only ${m.days} day${m.days === 1 ? '' : 's'} of shifts behind this — enough to compute a rate and not much to judge it on. Type a figure on the product if you know better.`,
    };
  }
  const months = m.last_run ? (Date.now() - Date.parse(`${m.last_run}T00:00:00Z`)) / 2_592_000_000 : 0;
  if (months >= 6) {
    return { mark: 'old', why: `Last run ${fmtDate(m.last_run)} — this rate is over six months old.` };
  }
  return null;
}

/** Where the figure came from, in full, on the hover. */
function rateTitle(p: PlannedJob): string | undefined {
  const r = p.rate;
  if (!r) return undefined;
  if (r.source === 'measured') {
    return `A typical day of the ${r.days} the floor has booked for this product — the median, so one unusually big day cannot pull it up. Last run ${fmtDate(r.last_run)}.`;
  }
  // An override is printed **against** what it overrides: a figure typed over
  // a measurement nobody saw is how a wrong one goes unnoticed.
  const m = r.measured;
  return m
    ? `Typed on the product. The shifts already booked work out at ${fmtQty(m.pcs_per_day)}/day over ${m.days} day${m.days === 1 ? '' : 's'}.`
    : 'Typed on the product — the floor has never booked a shift for it.';
}

/**
 * What the *Needed by* cell says, and the point of it: a date, or **why there
 * is not one**. An em-dash on every row of a 47-job queue reads as a column
 * that does not work, where on the client's book it meant something precise —
 * the two boxes that held a customer's date came off the sales order form on
 * 2026-09-25, so nothing raised since states one anywhere.
 */
const DUE_NOTE: Record<string, string> = {
  order: 'Promised on the sales order.',
  line: 'Promised on this order line.',
  jobs: 'Not a promise — this is the latest finish already planned on the rest of this order.',
  none: 'Nothing on this sales order says when the customer needs it, so nothing here can say whether the plan is late. Put a date on the order line (the Promised column on the sales order) to see it.',
};

export default function PlanQueueModal({ queue, replan, onClose, onStage }: {
  /**
   * The jobs to plan, **over the whole filtered list rather than the page**.
   * Ids rather than rows: most of a 131-job queue is not on screen, and the
   * preview answers about every one of them in full.
   */
  queue: number[];
  /**
   * Jobs that already carry a plan and have not started — what a **re-plan**
   * is about. Offered rather than assumed: giving a job new dates moves a
   * date somebody may have told a customer, so it is a press.
   */
  replan: number[];
  onClose: () => void;
  /** Hands the dated rows back to the list, which stages them like any typed date. */
  onStage: (plan: PlannedJob[]) => void;
}) {
  const can = useCan();
  const [start, setStart] = useState(today());
  /**
   * Jobs the plant runs at once. Blank means *what the shift book says*,
   * which is the answer in nearly every case — a figure typed here wins, the
   * rule a typed output rate follows over a measured one.
   */
  const [lanes, setLanes] = useState('');
  /** Whether the already-dated jobs have been pulled into the queue. */
  const [withReplan, setWithReplan] = useState(false);
  const [sort, setSort] = useState<PlanSortKey>('due');
  /*
   * The order to run them in. Empty until somebody moves a row — the rule
   * above is what decides it until then, and `keep_order` is what says "this
   * is mine now".
   */
  const [order, setOrder] = useState<number[]>([]);
  /** Jobs taken out of this queue. Reversible, and never written anywhere. */
  const [dropped, setDropped] = useState<Set<number>>(new Set());

  const asked = useMemo(
    () => (withReplan ? [...queue, ...replan] : queue),
    [queue, replan, withReplan],
  );
  const ids = useMemo(
    () => (order.length ? order : asked).filter((id) => !dropped.has(id)),
    [asked, order, dropped],
  );

  const preview = useQuery({
    queryKey: ['plan-preview', ids.join(','), start, sort, order.length > 0, lanes],
    queryFn: () => api.post<PlanPreview>('/api/work-orders/plan/preview', {
      ids, start, sort, keep_order: order.length > 0,
      ...(Number(lanes) >= 1 ? { lanes: Number(lanes) } : {}),
    }),
    enabled: !!start && ids.length > 0,
    /*
     * Reordering changes the key, and without this the table emptied to
     * *Working it out…* on **every** press of an arrow — so a second press
     * read no rows and did nothing. Keeping the last answer on screen is what
     * makes nudging a row feel like moving it rather than reloading a page.
     */
    placeholderData: keepPreviousData,
  });

  const rows = preview.data?.jobs ?? [];
  const summary = preview.data?.summary;
  /** What the shift book says the plant runs at once, under the typed box. */
  const measured = preview.data?.lanes_measured;
  const datable = rows.filter((p) => !p.blocked);
  const baseYear = (summary?.from || start).slice(0, 4);

  /** Move a row, which is what makes the order the planner's own. */
  const move = (id: number, to: 'up' | 'down' | 'top') => {
    const list = rows.map((p) => p.id);
    const i = list.indexOf(id);
    if (i < 0) return;
    list.splice(i, 1);
    list.splice(to === 'top' ? 0 : to === 'up' ? Math.max(0, i - 1) : Math.min(list.length, i + 1), 0, id);
    setOrder(list);
  };

  const num = 'whitespace-nowrap py-1.5 pr-3 text-right tabular-nums';
  const arrow = 'rounded px-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-25 disabled:hover:bg-transparent';

  return (
    <Modal title={`Plan ${ids.length} job${ids.length === 1 ? '' : 's'}`} onClose={onClose} wide="xl">
      <div className="space-y-3">
        {/* What the plan is computed from — two controls, on one line. */}
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Start from</span>
            <Input type="date" className="w-40" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Run in order of</span>
            <Select
              className="w-60"
              value={order.length ? 'manual' : sort}
              onChange={(e) => {
                // Picking a rule gives up a hand-made order, which is what the
                // rule is for — and says so rather than silently keeping both.
                setOrder([]);
                setSort(e.target.value as PlanSortKey);
              }}
            >
              {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              {order.length > 0 && <option value="manual">The order you have put them in</option>}
            </Select>
          </label>
          {/*
            How big the plant is. Measured from the shift book — how many jobs
            the floor actually books output against on a typical day — and
            typed over where somebody knows better, the rule the output rate
            beside it already follows.

            This is the figure that decides whether the plan is usable at all:
            laid on one line, the open book on the client's own screen is over
            two years of work, which is not a plan anybody works to.
          */}
          <label className="text-sm">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Lines at once</span>
            <Input
              type="number" min={1} max={50} className="w-24 text-right"
              value={lanes}
              placeholder={measured ? String(measured.lanes) : '1'}
              onChange={(e) => setLanes(e.target.value)}
              title={measured && measured.days
                ? `The floor books ${measured.lanes} job${measured.lanes === 1 ? '' : 's'} on a typical day, measured over ${measured.days} day${measured.days === 1 ? '' : 's'} of shifts (busiest ${measured.busiest}, average ${measured.mean}). Leave blank to use that.`
                : 'Nothing has been booked yet, so this starts at one line. Type what the plant runs at once.'}
            />
          </label>
          <p className="max-w-[20rem] pb-1 text-xs text-slate-500">
            Each job takes what is <strong>left to make</strong> divided by how
            fast that product goes, and runs on the line that frees first.
            Seven days a week.
          </p>
        </div>

        {/*
          What the plant is already committed to, stated before the press
          rather than discovered afterwards. The lines are filled **as they
          come free**, so a second press can no longer lay its queue on top of
          the first — which is exactly what it did, measured, before this.
        */}
        {preview.data && (
          <p className="text-xs text-slate-500">
            {preview.data.committed_to ? (
              <>
                <strong className="text-slate-700">{preview.data.committed_jobs} job{preview.data.committed_jobs === 1 ? '' : 's'}</strong>{' '}
                already have dates and run to <strong className="tabular-nums text-slate-700">{planDay(preview.data.committed_to, baseYear)}</strong>.
                {' '}This queue takes each line as it comes free.
              </>
            ) : (
              <>Nothing else is planned, so all {preview.data.lanes} line{preview.data.lanes === 1 ? '' : 's'} are free from the start date.</>
            )}
            {replan.length > 0 && (
              <>
                {' '}
                {withReplan ? (
                  <>
                    Re-planning {replan.length} job{replan.length === 1 ? '' : 's'} that already carry dates.{' '}
                    <button className="underline hover:text-slate-700" onClick={() => { setOrder([]); setWithReplan(false); }}>
                      Leave them alone
                    </button>
                  </>
                ) : (
                  <>
                    <button className="underline hover:text-slate-700" onClick={() => { setOrder([]); setWithReplan(true); }}>
                      Re-plan the {replan.length} dated job{replan.length === 1 ? '' : 's'}
                    </button>
                    {' '}that have not started as well.
                  </>
                )}
              </>
            )}
          </p>
        )}

        {/* The decision, before the rows rather than under them. */}
        {summary && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
            <span className="font-semibold text-slate-700">
              {summary.jobs} job{summary.jobs === 1 ? '' : 's'}
            </span>
            <span className="text-slate-500">
              <strong className="tabular-nums text-slate-700">{fmtQty(summary.pieces)}</strong> pcs
            </span>
            {/*
              Line-days, not calendar days, and the two are different facts on
              a plant of several lines: how much line time the work costs,
              against how long the calendar takes to absorb it. Saying
              *production days* over a span a third as long was the figure
              reading as a contradiction.
            */}
            <span className="text-slate-500" title={`Line time the work costs, across ${preview.data?.lanes ?? 1} line${(preview.data?.lanes ?? 1) === 1 ? '' : 's'}. The span beside it is what that comes to on the calendar.`}>
              <strong className="tabular-nums text-slate-700">{summary.days}</strong> line-day{summary.days === 1 ? '' : 's'}
              {(preview.data?.lanes ?? 1) > 1 && <span className="text-slate-400"> on {preview.data?.lanes} lines</span>}
            </span>
            <span className="tabular-nums text-slate-700">{planSpan(summary.from, summary.to)}</span>
            <span className="grow" />
            {summary.late > 0 && (
              <span className="font-semibold text-red-600" title="These finish after the date the customer was promised.">
                {summary.late} late
              </span>
            )}
            {summary.blocked > 0 && (
              <span className="font-semibold text-amber-700" title="Listed below with the reason — they take no slot in the queue.">
                {summary.blocked} cannot be dated
              </span>
            )}
            {summary.undated > 0 && (
              <span className="text-slate-500" title="Nothing on file says when the customer needs these, so nothing can say whether the plan is late.">
                {summary.undated} with no customer date
              </span>
            )}
          </div>
        )}

        {preview.isError && <ErrorText error={preview.error} />}
        {preview.isPending ? (
          <div className="py-6 text-center text-sm text-slate-400">Working it out…</div>
        ) : (
          /*
           * The rows scroll inside the table rather than inside the dialog, so
           * the summary above and the button below stay on screen at any
           * length of queue.
           *
           * The cap is measured rather than chosen: the dialog's fixed parts
           * come to about 223px, so a table under `50vh` keeps the whole
           * dialog inside `Modal`'s own `max-h-[85vh]` down to a 700px-tall
           * window, and the `44rem` ceiling is what stops it growing past
           * useful on a very tall one. Past either, the rows scroll and
           * everything else stays put.
           */
          <div className="max-h-[min(50vh,44rem)] overflow-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226,232,240)]">
                <tr className={TH_CLASS}>
                  <th className="py-2 pl-3 pr-3">Job</th>
                  <th className="py-2 pr-3">Item</th>
                  <th className="py-2 pr-3 text-right">To make</th>
                  <th className="py-2 pr-3 text-right">Rate</th>
                  <th className="py-2 pr-3 text-right">Days</th>
                  <th className="py-2 pr-3">Runs</th>
                  <th className="py-2 pr-3">Needed by</th>
                  <th className="py-2 pr-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((p, i) => {
                  const doubt = rateDoubt(p);
                  return (
                    <tr key={p.id} className={`border-t border-slate-100 ${p.blocked ? 'bg-amber-50/40' : ''}`}>
                      {/* The customer under the job number, so neither column
                          has to be wide enough for both. */}
                      <td className="whitespace-nowrap py-1.5 pl-3 pr-3 align-top">
                        <div className="font-medium text-slate-700">{p.number}</div>
                        <div className="max-w-[7.5rem] truncate text-xs text-slate-400" title={`${p.customer_name} · ${p.order_number}`}>
                          {p.customer_name}
                        </div>
                      </td>
                      <td className="max-w-[9rem] truncate py-1.5 pr-3 align-top" title={p.item}>{p.item || '—'}</td>
                      <td className={`${num} align-top`}>{fmtQty(p.pieces)}</td>

                      {/* The one input the planner has to be able to disbelieve,
                          so it states what it was measured over. */}
                      <td className={`${num} align-top`} title={rateTitle(p)}>
                        {p.rate ? (
                          <>
                            <div>{fmtQty(p.rate.pcs_per_day)}<span className="text-slate-400">/day</span></div>
                            <div className="text-xs font-normal text-slate-400">
                              {p.rate.source === 'stated'
                                ? 'typed'
                                : `${p.rate.days} day${p.rate.days === 1 ? '' : 's'}`}
                              {doubt && <span className="ml-1 text-amber-600" title={doubt.why}>· {doubt.mark}</span>}
                            </div>
                          </>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className={`${num} align-top`}>{p.days ?? <span className="text-slate-400">—</span>}</td>

                      <td className="py-1.5 pr-3 align-top">
                        {p.blocked ? (
                          <span className="text-xs text-amber-700">
                            {p.blocked === 'no-rate' ? 'No rate for this product' : 'Nothing left to make'}
                            {p.blocked === 'no-rate' && p.product_id && can('product', 'full') && (
                              <>
                                {' · '}
                                <Link
                                  className="underline hover:text-amber-900"
                                  to={`/products?q=${encodeURIComponent(p.item)}&rate=${p.product_id}`}
                                  onClick={onClose}
                                >Set one</Link>
                              </>
                            )}
                          </span>
                        ) : (
                          <span className="tabular-nums">
                            {planDay(p.planned_start, baseYear)} <span className="text-slate-400">→</span> {planDay(p.planned_end, baseYear)}
                          </span>
                        )}
                      </td>

                      {/* A date, or **why there is not one** — an em-dash here
                          reads as a broken column rather than as an absence. */}
                      <td className="whitespace-nowrap py-1.5 pr-3 align-top text-xs" title={DUE_NOTE[p.due_source]}>
                        {p.due ? (
                          <>
                            <div className={`tabular-nums ${p.late ? 'font-semibold text-red-600' : 'text-slate-500'}`}>
                              {planDay(p.due, baseYear)}
                              {p.due_source === 'jobs' && <span className="ml-1 text-slate-400">plan</span>}
                            </div>
                            {p.late && <div className="font-semibold text-red-600">{p.late_days}d late</div>}
                          </>
                        ) : (
                          <span className="text-slate-300">not stated</span>
                        )}
                      </td>

                      <td className="whitespace-nowrap py-1.5 pr-2 align-top text-right">
                        {/* A word rather than a glyph: `⤒` beside `▲` is two up
                            arrows meaning different things, and an uncommon
                            glyph is drawn by whichever font happens to have it
                            — the finding the sidebar's own icons record. */}
                        <button
                          className="rounded px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-25 disabled:hover:bg-transparent"
                          disabled={i === 0} onClick={() => move(p.id, 'top')} title="Run this one first"
                        >Top</button>
                        <button className={arrow} disabled={i === 0} onClick={() => move(p.id, 'up')} title="Run this one earlier">▲</button>
                        <button className={arrow} disabled={i === rows.length - 1} onClick={() => move(p.id, 'down')} title="Run this one later">▼</button>
                        <button
                          className="rounded px-1 text-slate-300 hover:bg-red-50 hover:text-red-500"
                          onClick={() => setDropped((d) => new Set(d).add(p.id))}
                          title="Take this job out of the queue — it keeps whatever dates it already has"
                        >✕</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Taking a job out has to be undoable, or it is a decision made by a
            stray click with the dialog as the only way back. */}
        {dropped.size > 0 && (
          <p className="text-xs text-slate-500">
            {dropped.size} job{dropped.size === 1 ? '' : 's'} taken out of this queue.{' '}
            <button className="underline hover:text-slate-700" onClick={() => setDropped(new Set())}>Put {dropped.size === 1 ? 'it' : 'them'} back</button>
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-3">
          <div className="text-xs text-slate-500">
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
