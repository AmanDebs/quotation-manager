import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import type { ShiftPlanPreview } from '../types';
import { Button, ErrorText, Field, Input, Modal, Select, TH_CLASS, CAPTION_CLASS } from './ui';
import { fmtQty, fmtDate, today } from '../lib/format';

/**
 * Working the shift plan out — the press that turns a book of jobs into a
 * board (2026-11-24, phase four).
 *
 * The shape the day planner's own queue established: **the server works it
 * out, the planner reads it, one press applies it.** What differs is what it
 * produces — shifts on named lines rather than date ranges across anonymous
 * lanes — and so what it can say: which slot each job lands in, where a
 * changeover is being paid for, and which promises the plan breaks.
 *
 * **It never shows a plan it cannot write.** The preview and the press work
 * the plan out through the same function on the same book, so what is applied
 * is what was read — a client that sent its own rows back would be the only
 * thing standing between a press and a plan nobody computed.
 */

/** How the queue opens. The server's own four rules, named for a planner. */
const SORTS = [
  { value: 'due', label: 'What the customer needs first' },
  { value: 'shortest', label: 'Shortest jobs first' },
  { value: 'longest', label: 'Longest jobs first' },
  { value: 'order', label: 'Keep each sales order together' },
] as const;

const WHY: Record<string, string> = {
  'no-rate': 'No output rate — type one on the product, or plan it by hand',
  'nothing-left': 'Nothing left to plan — it is made, or already on the board',
  'no-line': 'No production line can make it',
};

export default function ShiftPlanModal({ onClose, onApplied }: {
  onClose: () => void;
  onApplied: () => void;
}) {
  const queryClient = useQueryClient();
  const [start, setStart] = useState(today());
  const [sort, setSort] = useState<string>('due');
  const [release, setRelease] = useState(true);
  const [error, setError] = useState('');

  const { data, isPending } = useQuery<ShiftPlanPreview>({
    // Keyed on what decides the plan, so changing either works it out again.
    queryKey: ['shift-plan-preview', start, sort],
    queryFn: () => api.post<ShiftPlanPreview>('/api/production-runs/plan/preview', { start, sort }),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(start),
    // The rows stay on screen while the next plan is worked out, so changing
    // the rule reads as the board moving rather than as the page emptying.
    placeholderData: (prev) => prev,
  });

  const apply = useMutation({
    mutationFn: () => api.post<{ runs: number; jobs: number }>(
      '/api/production-runs/plan/apply', { start, sort, release }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['production-runs'] });
      queryClient.invalidateQueries({ queryKey: ['work-orders'] });
      queryClient.invalidateQueries({ queryKey: ['product-plan'] });
      queryClient.invalidateQueries({ queryKey: ['run-options'] });
      onApplied();
    },
    onError: (e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not apply that plan'),
  });

  const s = data?.summary;
  const blocked = (data?.jobs ?? []).filter((j) => j.blocked);
  const late = (data?.jobs ?? []).filter((j) => !j.blocked && j.late);
  const nothing = !s || s.runs === 0;

  return (
    <Modal title="Work out the shift plan" onClose={onClose} wide="xl">
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Start from">
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Order">
            <Select value={sort} onChange={(e) => setSort(e.target.value)}>
              {SORTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </Field>
          <Field label="Release">
            <label className="flex h-[30px] items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" checked={release} onChange={(e) => setRelease(e.target.checked)} />
              Mark the jobs scheduled
            </label>
          </Field>
        </div>

        {isPending && !data ? (
          <p className="text-sm text-slate-500">Working it out…</p>
        ) : nothing ? (
          <p className="text-sm text-slate-500">
            Nothing to plan from {fmtDate(start)}. Every open job is either already on the board,
            finished, or has no output rate to plan by.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              {([
                ['Jobs', fmtQty(s.jobs)],
                ['Runs', fmtQty(s.runs)],
                ['Shifts', fmtQty(s.shifts)],
                ['Pieces', fmtQty(s.pieces)],
                ['Changeovers', fmtQty(s.changeovers)],
              ] as const).map(([label, value]) => (
                <div key={label}>
                  <div className={CAPTION_CLASS}>{label}</div>
                  <div className="text-sm font-semibold tabular-nums text-slate-900">{value}</div>
                </div>
              ))}
              <div>
                <div className={CAPTION_CLASS}>Span</div>
                <div className="text-sm font-semibold text-slate-900">
                  {fmtDate(s.from)} → {fmtDate(s.to)}
                </div>
              </div>
            </div>

            {/* The prize: a plan that says which promises it breaks. */}
            {(late.length > 0 || s.undated > 0) && (
              <p className="text-xs text-amber-700">
                {late.length > 0 && (
                  <>
                    <strong>{late.length}</strong> job{late.length === 1 ? '' : 's'} would finish after
                    the customer&rsquo;s date
                    {late.length <= 4 && (
                      <> — {late.map((j) => `${j.number} by ${j.late_days}d`).join(', ')}</>
                    )}.{' '}
                  </>
                )}
                {s.undated > 0 && (
                  <>{s.undated} {s.undated === 1 ? 'has' : 'have'} no customer date to be judged against.</>
                )}
              </p>
            )}

            <div className="max-h-[42vh] overflow-auto rounded-lg border border-slate-200">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-white">
                  <tr className={TH_CLASS}>
                    <th className="px-2 py-1.5 text-left">Date</th>
                    <th className="px-2 py-1.5 text-left">Shift</th>
                    <th className="px-2 py-1.5 text-left">Line</th>
                    <th className="px-2 py-1.5 text-left">Making</th>
                    <th className="px-2 py-1.5 text-right">Pieces</th>
                    <th className="px-2 py-1.5 text-left">For</th>
                  </tr>
                </thead>
                <tbody>
                  {data!.runs.map((r, i) => (
                    <tr key={`${r.date}|${r.machine_id}|${r.shift}|${i}`} className="border-t border-slate-100">
                      <td className="px-2 py-1 whitespace-nowrap">{fmtDate(r.date)}</td>
                      <td className="px-2 py-1">{r.shift}</td>
                      <td className="max-w-[10rem] truncate px-2 py-1" title={r.line_name}>{r.line_name}</td>
                      <td className="px-2 py-1">
                        <span className="text-slate-900">{r.product_name || 'Custom item'}</span>
                        {r.color && <span className="ml-1.5 text-slate-500">{r.color}</span>}
                        {/* Stated rather than hidden: a changeover is time the
                            line is not making anything, and it is the one cost
                            on this page somebody can actually plan away. */}
                        {r.changeover && (
                          <span className="ml-1.5 text-amber-700" title="This slot opens with a product or colour change on that line">
                            ⟳
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {fmtQty(r.qty_planned)}
                        <span className="text-slate-400"> of {fmtQty(r.capacity)}</span>
                      </td>
                      <td className="max-w-[12rem] truncate px-2 py-1 text-slate-500"
                          title={r.allocations.map((a) => a.number).join(', ')}>
                        {r.allocations.map((a) => a.number).join(', ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {blocked.length > 0 && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <div className={CAPTION_CLASS}>Not planned</div>
                <ul className="mt-1 space-y-0.5 text-xs text-slate-500">
                  {blocked.slice(0, 8).map((j) => (
                    <li key={j.id}>
                      <span className="text-slate-700">{j.number}</span>
                      {j.product_name && <span className="ml-1.5">{j.product_name}</span>}
                      {' — '}{WHY[j.blocked!] ?? j.blocked}
                    </li>
                  ))}
                  {blocked.length > 8 && <li>and {blocked.length - 8} more</li>}
                </ul>
              </div>
            )}
          </>
        )}

        <ErrorText error={error} />

        {/*
          With nothing to plan there is the sentence and **Close**, not a
          disabled press beside a Cancel: a button that can only ever refuse is
          the dead control this codebase keeps removing — the empty COA picker
          is the precedent, and it reads the same way here.
        */}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{nothing ? 'Close' : 'Cancel'}</Button>
          {!nothing && (
            <Button onClick={() => { setError(''); apply.mutate(); }} disabled={apply.isPending}>
              Put {fmtQty(s!.runs)} run{s!.runs === 1 ? '' : 's'} on the board
            </Button>
          )}
        </div>

        {!nothing && (
          <p className="text-xs text-slate-500">
            Applying writes these runs and dates each job from the span of its own, so the board and
            the Work Orders grid say the same thing. A job that already carries a plan takes these as
            its <strong>revised</strong> dates, which is what keeps the slip visible.
          </p>
        )}
      </div>
    </Modal>
  );
}
