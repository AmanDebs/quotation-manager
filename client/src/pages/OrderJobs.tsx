import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { OrderJobsView, UnmadeReason, WorkOrder } from '../types';
import { Button, Card, EmptyState, ErrorText, PageHeader, CAPTION_CLASS, TH_CLASS } from '../components/ui';
import { LogOutput } from '../components/LogOutputModal';
import QcCheckModal from '../components/QcCheckModal';
import PlanJobsModal from '../components/PlanJobsModal';
import { useCan } from '../App';
import { fmtDate, fmtQty } from '../lib/format';
import { workOrderStatusLabel, workOrderStatusStyle } from './WorkOrders';

/**
 * Every product on one sales order, at once.
 *
 * The client, with the Work Orders list in front of them: *"Work order should
 * open all product at once"*. An order raises one job per goods line — which is
 * what the QC gate, the order book's per-line state, the lots and the dispatch
 * ceiling all key on, and none of that moves here — so a five-product order is
 * five work orders, and since the order's Production tab went (2026-09-11) the
 * only way to reach any of them was the list, one at a time. Booking a shift
 * across an order was five round trips.
 *
 * So this page is **about the order**: a card per product, open, each holding
 * what that job has made, what has been inspected and what it will eat, with
 * the three things somebody comes here to do on it.
 *
 * Nothing here is a second opinion. Every figure is `getFull`'s, the same
 * function the job's own page reads, and the three dialogs are the job page's
 * own — `LogOutput`, `QcCheckModal` and `PlanJobsModal` — rather than copies:
 * two copies of a control is how the two come to behave differently.
 *
 * **Material and lots are read-only here.** Issuing material and opening a lot
 * stay on the job page, one click away: neither was asked for, and both would
 * double the page.
 */

/** Why a line has no job. Stated, never left as an absence — see `linesWithoutJobs`. */
const UNMADE: Record<UnmadeReason, string> = {
  charge: 'a charge line, so there is nothing to make',
  bought_in: 'bought in rather than made here',
  no_quantity: 'no quantity to make',
  order_cancelled: 'the sales order is cancelled',
};

const todayIso = new Date().toISOString().slice(0, 10);

/** A job that can still be planned — the server refuses the other two by name. */
const plannable = (w: WorkOrder) => !['done', 'cancelled'].includes(w.status);

export default function OrderJobsPage() {
  const { orderId } = useParams();
  const queryClient = useQueryClient();
  const can = useCan();

  /*
   * Every card is open: not having to open five things is the whole request. So
   * what is tracked is what somebody has **closed**, which needs no effect to
   * seed itself from the jobs once they arrive. Not in the URL — a fold is not a
   * view anybody bookmarks, the same call the list makes about its tick set.
   */
  const [closed, setClosed] = useState<Set<number>>(new Set());
  const [logging, setLogging] = useState<WorkOrder | null>(null);
  const [inspecting, setInspecting] = useState<WorkOrder | null>(null);
  /** The set being planned: one job from its own card, or the whole order. */
  const [planning, setPlanning] = useState<WorkOrder[] | null>(null);

  const { data, error } = useQuery({
    queryKey: ['work-orders', 'order', String(orderId)],
    queryFn: () => api.get<OrderJobsView>(`/api/work-orders/order/${orderId}`),
  });

  /*
   * `LogOutput` and `QcCheckModal` invalidate the job they were opened on and
   * nothing else, so this page would sit stale behind them. The key is under
   * `['work-orders']`, which is also what `PlanJobsModal` already invalidates,
   * so planning refreshes this page by prefix without being told to.
   */
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['work-orders'] });
    queryClient.invalidateQueries({ queryKey: ['work-order'] });
    queryClient.invalidateQueries({ queryKey: ['order', String(orderId)] });
    queryClient.invalidateQueries({ queryKey: ['order-lines'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  if (error) return <ErrorText error={error} />;
  if (!data) return null;

  const { order, jobs, unmade } = data;
  const planned = jobs.reduce((n, w) => n + (w.qty_planned || 0), 0);
  const made = jobs.reduce((n, w) => n + (w.progress?.produced ?? 0), 0);
  const unplanned = jobs.filter((w) => w.status === 'planned').length;
  const toPlan = jobs.filter(plannable);
  const allClosed = jobs.length > 0 && jobs.every((w) => closed.has(w.id));

  return (
    <div>
      <PageHeader
        title={`Work orders — ${order.number}`}
        subtitle={
          <>
            {order.customer_name} ·{' '}
            <Link to={`/orders/${order.id}`} className="text-brand-600 hover:underline">
              open the sales order
            </Link>
            {' · '}
            {jobs.length} job{jobs.length === 1 ? '' : 's'}
          </>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {jobs.length > 1 && (
              <Button
                variant="secondary"
                onClick={() => setClosed(allClosed ? new Set() : new Set(jobs.map((w) => w.id)))}
              >
                {allClosed ? 'Expand all' : 'Collapse all'}
              </Button>
            )}
            {/* Dates and release for every product in one press — one request,
                one transaction, and the order's status re-synced once. */}
            {can('work_order', 'full') && toPlan.length > 0 && (
              <Button onClick={() => setPlanning(toPlan)}>
                Plan {toPlan.length} job{toPlan.length === 1 ? '' : 's'}…
              </Button>
            )}
          </div>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-5 text-sm text-slate-600">
        <span>
          <span className="tabular-nums font-medium">{fmtQty(made)}</span> of{' '}
          <span className="tabular-nums">{fmtQty(planned)}</span> pcs made
        </span>
        {unplanned > 0 && (
          <span className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 ring-1 ring-amber-200">
            {unplanned} not planned
          </span>
        )}
      </div>

      {jobs.length === 0 && (
        <Card>
          <EmptyState message="No work orders on this sales order. One is raised per goods line when the order is booked." />
        </Card>
      )}

      <div className="space-y-4">
        {jobs.map((w) => {
          const isClosed = closed.has(w.id);
          const gone = w.status === 'cancelled';
          // The dates that stand: revised where set, else planned — the rule
          // every reader of a job's date follows. A plan that was moved is not
          // flagged late on a date nobody is working to.
          const start = w.revised_start || w.planned_start;
          const end = w.revised_end || w.planned_end;
          const revised = !!(w.revised_start || w.revised_end);
          const late = !!end && end < todayIso && !['done', 'cancelled'].includes(w.status);
          const pct = w.qty_planned > 0
            ? Math.round(((w.progress?.produced ?? 0) / w.qty_planned) * 100)
            : 0;
          const checks = w.qc?.checks ?? [];
          const entries = w.entries ?? [];

          return (
            <Card
              key={w.id}
              className={gone ? 'opacity-60' : ''}
              title={`Line ${w.order_line + 1} · ${w.product_name || w.description || 'Job'}`}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={`/work-orders/${w.id}`} className="text-sm text-brand-600 hover:underline">
                    {w.number}
                  </Link>
                  <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${workOrderStatusStyle[w.status]}`}>
                    {workOrderStatusLabel(w.status)}
                  </span>
                  <button
                    className="rounded px-1 text-sm text-slate-400 hover:text-slate-600"
                    onClick={() => setClosed((c) => {
                      const next = new Set(c);
                      if (isClosed) next.delete(w.id); else next.add(w.id);
                      return next;
                    })}
                    title={isClosed ? 'Show this product' : 'Hide this product'}
                  >
                    {isClosed ? '▾' : '▴'}
                  </button>
                </div>
              }
            >
              <div className="flex flex-wrap items-start gap-5 text-sm">
                <div>
                  <div className={CAPTION_CLASS}>Planned</div>
                  <div className="tabular-nums">{fmtQty(w.qty_planned)}</div>
                </div>
                <div>
                  <div className={CAPTION_CLASS}>Made</div>
                  <div className="tabular-nums">
                    {fmtQty(w.progress?.produced ?? 0)}
                    {w.qty_planned > 0 && (
                      // Past the plan is a fact worth a colour: the figure is
                      // right, and it is the plan that is now behind.
                      <span className={`ml-1 text-xs ${pct > 100 ? 'font-medium text-amber-700' : 'text-slate-400'}`}>
                        {pct}%{pct > 100 ? ' over' : ''}
                      </span>
                    )}
                  </div>
                </div>
                <div>
                  <div className={CAPTION_CLASS}>Left</div>
                  <div className="tabular-nums">{fmtQty(w.progress?.balance ?? w.qty_planned)}</div>
                </div>
                <div>
                  {/* Null, not zero, when nothing has been made: 0% reads as
                      "no rejects", which is a different claim from "not started". */}
                  <div className={CAPTION_CLASS}>Reject rate</div>
                  <div className="tabular-nums">
                    {w.progress?.reject_pct != null ? `${w.progress.reject_pct}%` : '—'}
                  </div>
                </div>
                <div>
                  <div className={CAPTION_CLASS}>Dates</div>
                  <div className={`text-xs ${late ? 'font-medium text-red-600' : 'text-slate-600'}`}>
                    {start || end ? `${start ? fmtDate(start) : '?'} → ${end ? fmtDate(end) : '?'}` : '—'}
                    {revised && (
                      <span
                        className="ml-1 font-normal text-amber-600"
                        title={`Planned ${w.planned_start ? fmtDate(w.planned_start) : '?'} → ${w.planned_end ? fmtDate(w.planned_end) : '?'}`}
                      >
                        rev.
                      </span>
                    )}
                    {late && <span className="ml-1">overdue</span>}
                  </div>
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {can('output', 'full') && !gone && (
                    <Button variant="secondary" onClick={() => setLogging(w)}>Log output</Button>
                  )}
                  {can('qc', 'full') && !gone && (
                    <Button variant="secondary" onClick={() => setInspecting(w)}>Record QC check</Button>
                  )}
                  {can('work_order', 'full') && plannable(w) && (
                    <Button variant="secondary" onClick={() => setPlanning([w])}>Plan</Button>
                  )}
                </div>
              </div>

              {!isClosed && (
                <>
                  <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-brand-600" style={{ width: `${Math.min(100, pct)}%` }} />
                  </div>

                  <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-2">
                    <div>
                      <div className={`${CAPTION_CLASS} mb-1.5`}>Output</div>
                      {entries.length === 0 ? (
                        <p className="text-sm text-slate-400">Nothing booked yet.</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className={TH_CLASS}>
                                <th className="pb-2 pr-3">Date</th>
                                <th className="pb-2 pr-3">Shift</th>
                                <th className="pb-2 pr-3">Operator</th>
                                <th className="pb-2 pr-3 text-right">Good</th>
                                <th className="pb-2 pr-3 text-right">Rejected</th>
                              </tr>
                            </thead>
                            <tbody>
                              {entries.map((e) => (
                                <tr key={e.id} className="border-b border-slate-100 last:border-0">
                                  <td className="whitespace-nowrap py-1.5 pr-3">{fmtDate(e.date)}</td>
                                  <td className="py-1.5 pr-3">{e.shift || '—'}</td>
                                  <td className="py-1.5 pr-3">{e.operator || '—'}</td>
                                  <td className="py-1.5 pr-3 text-right tabular-nums">{fmtQty(e.qty_ok)}</td>
                                  <td className="py-1.5 pr-3 text-right tabular-nums">{e.qty_reject ? fmtQty(e.qty_reject) : '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>

                    <div>
                      <div className={`${CAPTION_CLASS} mb-1.5`}>Quality</div>
                      {/* Whose tolerances applied is part of the answer: the same
                          part is measured differently for different buyers, and
                          no specification is no opinion rather than a pass. */}
                      <p className="mb-1.5 text-xs text-slate-500">
                        {w.qc?.spec_owner === 'customer'
                          ? `Measured against ${order.customer_name}’s own specification.`
                          : w.qc?.spec_owner === 'default'
                            ? 'Measured against the product’s default specification.'
                            : 'No specification recorded for this product — nothing here has an opinion, which is not the same as passing.'}
                      </p>
                      {checks.length === 0 ? (
                        <p className="text-sm text-slate-400">No checks recorded.</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className={TH_CLASS}>
                                <th className="pb-2 pr-3">Date</th>
                                <th className="pb-2 pr-3">Shift</th>
                                <th className="pb-2 pr-3">Inspector</th>
                                <th className="pb-2 pr-3">Verdict</th>
                              </tr>
                            </thead>
                            <tbody>
                              {checks.map((c) => (
                                <tr key={c.id} className="border-b border-slate-100 last:border-0">
                                  <td className="whitespace-nowrap py-1.5 pr-3">{fmtDate(c.date)}</td>
                                  <td className="py-1.5 pr-3">{c.shift || '—'}</td>
                                  <td className="py-1.5 pr-3">{c.inspector || '—'}</td>
                                  <td className="py-1.5 pr-3">
                                    {/* Nothing measured is not a pass, and is not
                                        a failure either — services/qc.ts's rule. */}
                                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${
                                      c.passed == null
                                        ? 'bg-slate-50 text-slate-500 ring-slate-200'
                                        : c.passed
                                          ? 'bg-green-50 text-green-700 ring-green-200'
                                          : 'bg-red-50 text-red-700 ring-red-200'
                                    }`}>
                                      {c.passed == null ? 'Not measured' : c.passed ? 'Pass' : 'Fail'}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>

                  {/*
                    Read-only: what this job will eat and what has gone to it.
                    `has_recipe: false` means unanswerable — not costed — never a
                    requirement of nothing. Issuing is on the job's own page.
                  */}
                  <div className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
                    <span className={CAPTION_CLASS}>Material</span>{' '}
                    {!w.material?.has_recipe
                      ? 'Not costed — no recipe recorded for this product.'
                      : (w.material.lines ?? []).map((l) => (
                          <span key={l.material_id} className="mr-3 whitespace-nowrap">
                            {l.name} <span className="tabular-nums">{fmtQty(l.qty)}</span> {l.unit} needed,{' '}
                            <span className="tabular-nums">{fmtQty(l.issued)}</span> issued
                          </span>
                        ))}
                    {(w.batches ?? []).length > 0 && (
                      <span className="ml-1">
                        · {w.batches!.length} lot{w.batches!.length === 1 ? '' : 's'}{' '}
                        <Link to={`/work-orders/${w.id}`} className="text-brand-600 hover:underline">on the job</Link>
                      </span>
                    )}
                  </div>
                </>
              )}
            </Card>
          );
        })}
      </div>

      {/*
        The lines the floor was given nothing for. Stated rather than left out:
        three jobs under a five-line order reads as a fault, where three jobs and
        a sentence about the freight line reads as an answer.
      */}
      {unmade.length > 0 && (
        <p className="mt-4 text-xs text-slate-500">
          Nothing to make on{' '}
          {unmade.map((u, i) => (
            <span key={u.line}>
              {i > 0 ? '; ' : ''}line {u.line + 1} ({u.label}) — {UNMADE[u.reason]}
            </span>
          ))}
          .
        </p>
      )}

      {logging && <LogOutput job={logging} onClose={() => setLogging(null)} onSaved={refresh} />}
      {inspecting && <QcCheckModal job={inspecting} onClose={() => setInspecting(null)} onSaved={refresh} />}
      {planning && (
        <PlanJobsModal
          jobs={planning}
          onClose={() => setPlanning(null)}
          onPlanned={() => { setPlanning(null); refresh(); }}
        />
      )}
    </div>
  );
}
