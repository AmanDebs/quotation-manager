import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import type { ProductionRun } from '../types';
import { Button, ErrorText, Field, Input, Modal, CAPTION_CLASS, TH_CLASS } from './ui';
import { fmtQty, fmtDate } from '../lib/format';

/**
 * **What ran** — the execution half of the shift plan (2026-11-24).
 *
 * The supervisor's question is about a *shift*, not a job: here is Shift A on
 * IMM-01, it was planned for 50,000 across two work orders, what actually
 * happened? So one press books an entry per job, each carrying the run it was
 * against, which is what makes planned-against-actual answerable per shift at
 * all. The job's own *Log output* dialog is untouched and is still how output
 * is booked against a job with no run behind it.
 *
 * **It is deliberately a second dialog rather than a section of `RunDialog`.**
 * The two halves write differently: allocations are **replaced** on every save
 * and entries are **appended**, so one Save over both would be idempotent for
 * one half and cumulative for the other — press it twice and the plan is
 * unchanged while the output is booked again. They are also two different
 * permission cells, and the brief's own rule 6 asks that actual be kept
 * separate from planned.
 *
 * **Nothing is prefilled**, which is the opposite call to the dispatch form,
 * and for a reason worth keeping: that form's save *replaces* its lines, so a
 * guess costs nothing, where this one *adds* — a prefilled figure plus a
 * second press is a double booking of a day's production. What is already
 * booked is stated beside each box instead, so the shortfall can be read
 * without doing the subtraction.
 */
export default function RunActualDialog({ run, mayLog, onClose }: {
  run: ProductionRun;
  /** `output: full` — the floor's own cell, not the planner's. */
  mayLog: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [date, setDate] = useState(run.date);
  /** work_order_id → what this entry is recording. Blank, never guessed. */
  const [ok, setOk] = useState<Record<number, string>>({});
  const [reject, setReject] = useState<Record<number, string>>({});
  const [downtime, setDowntime] = useState('');
  const [operator, setOperator] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  /* Every figure on this screen comes back changed by a booking — the run's
     own, the job's status, the order's, the product planning screen's
     "instructed", and the planner's queue once a run is signed off. */
  const refresh = () => {
    for (const key of [
      ['production-runs'], ['product-plan'], ['work-orders'], ['order-lines'], ['dashboard'],
    ]) queryClient.invalidateQueries({ queryKey: key });
  };

  const record = useMutation({
    mutationFn: () => api.post<ProductionRun>(`/api/production-runs/${run.id}/entries`, {
      date,
      downtime_mins: Number(downtime) || 0,
      operator,
      notes,
      lines: run.allocations.map((a) => ({
        work_order_id: a.work_order_id,
        qty_ok: Number(ok[a.work_order_id]) || 0,
        qty_reject: Number(reject[a.work_order_id]) || 0,
      })),
    }),
    onSuccess: () => {
      refresh();
      // The boxes empty rather than the dialog closing: a shift is often
      // booked in two or three goes, and the figures above update as it is.
      setOk({});
      setReject({});
      setDowntime('');
      setError('');
    },
    onError: (e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not record that'),
  });

  const sign = useMutation({
    mutationFn: (open: boolean) =>
      api.post<ProductionRun>(`/api/production-runs/${run.id}/close`, open ? { open: true } : {}),
    onSuccess: () => { refresh(); onClose(); },
    onError: (e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not change that'),
  });

  const typed = run.allocations.some(
    (a) => Number(ok[a.work_order_id]) > 0 || Number(reject[a.work_order_id]) > 0,
  );
  const canRecord = mayLog && (typed || Number(downtime) > 0);
  const done = run.status === 'done';

  return (
    <Modal title={`What ran — ${run.line_name}, ${run.shift ? `Shift ${run.shift}` : 'shift'}`} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <strong className="text-slate-900">{run.product_name || 'Custom item'}</strong>
          {run.color && <span className="ml-1.5">{run.color}</span>}
          {' · '}{fmtDate(run.date)}
          {' · planned '}<span className="tabular-nums text-slate-900">{fmtQty(run.qty_planned)}</span>
          {' · made '}<span className="tabular-nums text-slate-900">{fmtQty(run.made)}</span>
          {run.shortfall > 0 && (
            <> · <span className="tabular-nums font-semibold text-amber-700">{fmtQty(run.shortfall)} short</span></>
          )}
          {run.rejected > 0 && <> · {fmtQty(run.rejected)} rejected</>}
          {run.downtime_mins > 0 && <> · {run.downtime_mins} min down</>}
        </div>

        {done && (
          /* A signed-off run is a closed book, and its allocations have
             already been handed back — booking more against it would record
             output against a claim that no longer exists. Reopening is right
             there, so this is a state rather than a dead end. */
          <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            This shift has been <strong>signed off</strong>, so anything it did not make has gone back
            to the planner. Reopen it below to record more against it.
          </p>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className={TH_CLASS}>
                <th className="px-2 py-1.5 text-left">Work order</th>
                <th className="px-2 py-1.5 text-right">Planned</th>
                <th className="px-2 py-1.5 text-right">Made so far</th>
                <th className="px-2 py-1.5 text-right">Good pieces</th>
                <th className="px-2 py-1.5 text-right">Rejected</th>
              </tr>
            </thead>
            <tbody>
              {run.allocations.map((a) => {
                const left = Math.max(0, a.qty_planned - a.made);
                return (
                  <tr key={a.work_order_id} className="border-t border-slate-100">
                    <td className="px-2 py-1.5">
                      <div className="font-medium text-slate-800">{a.number}</div>
                      <div className="text-[10px] text-slate-400">
                        {a.order_number} · {a.customer_name}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">{fmtQty(a.qty_planned)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">
                      {a.made > 0 ? fmtQty(a.made) : <span className="text-slate-300">—</span>}
                      {a.rejected > 0 && (
                        <div className="text-[10px] text-slate-400">{fmtQty(a.rejected)} rejected</div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Input
                        type="number"
                        className="w-28 text-right tabular-nums"
                        value={ok[a.work_order_id] ?? ''}
                        disabled={!mayLog || done}
                        onChange={(e) => setOk({ ...ok, [a.work_order_id]: e.target.value })}
                      />
                      {left > 0 && (
                        <div className="text-[10px] text-slate-400">{fmtQty(left)} still to go</div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Input
                        type="number"
                        className="w-24 text-right tabular-nums"
                        value={reject[a.work_order_id] ?? ''}
                        disabled={!mayLog || done}
                        onChange={(e) => setReject({ ...reject, [a.work_order_id]: e.target.value })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Field label="Date">
            <Input type="date" value={date} disabled={!mayLog || done}
              onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Downtime (min)">
            {/* Once for the shift rather than per job: the line was down, not
                the work order, and spreading it would count one stoppage
                twice when the run's minutes are added up. */}
            <Input type="number" className="text-right tabular-nums" value={downtime}
              disabled={!mayLog || done} onChange={(e) => setDowntime(e.target.value)} />
          </Field>
          <Field label="Operator">
            <Input value={operator} disabled={!mayLog || done}
              onChange={(e) => setOperator(e.target.value)} placeholder="Optional" />
          </Field>
          <Field label="Notes">
            <Input value={notes} disabled={!mayLog || done}
              onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
          </Field>
        </div>

        {mayLog && !done && (
          <p className={CAPTION_CLASS}>
            Each press records a new shift entry — the figures above are what has been booked
            already, so leave a box blank rather than repeating it.
          </p>
        )}

        <ErrorText error={error} />

        <div className="flex items-center justify-between gap-2">
          {/* The sign-off lives here rather than on the board, because what it
              does needs a sentence: it is what hands an unmade balance back to
              the planner, and a bare button in a cell would not say so. */}
          {mayLog ? (
            <div className="text-xs">
              {done ? (
                <Button variant="secondary" onClick={() => sign.mutate(true)} disabled={sign.isPending}>
                  Reopen this shift
                </Button>
              ) : (
                <>
                  <Button variant="secondary" onClick={() => sign.mutate(false)} disabled={sign.isPending}>
                    Sign this shift off
                  </Button>
                  {run.shortfall > 0 && (
                    <div className="mt-1 text-[10px] text-slate-500">
                      The <span className="tabular-nums">{fmtQty(run.shortfall)}</span> it did not make
                      goes back to the planner.
                    </div>
                  )}
                </>
              )}
            </div>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>Close</Button>
            {mayLog && !done && (
              <Button onClick={() => { setError(''); record.mutate(); }}
                disabled={!canRecord || record.isPending}>
                Record it
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
