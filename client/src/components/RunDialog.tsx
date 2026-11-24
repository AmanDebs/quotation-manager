import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import type { ProductionRun, RunOptions, RunSetup, WorkOrder } from '../types';
import { Button, ErrorText, Field, Input, Modal, Select, SearchSelect, TH_CLASS } from './ui';
import { fmtQty } from '../lib/format';

/**
 * Planning one run — a line, a shift, a day, and the work orders it is for.
 *
 * **The picker is the whole design.** A run is one product and one colour, so
 * the dialog asks for *one* job first and then offers only the jobs that could
 * share a run with it — which the server measures (`/production-runs/options`)
 * rather than the client filtering a page of the job list. Offering anything
 * else would be offering a refusal, which is the form-offers-what-the-API-
 * refuses trap this codebase records twice.
 *
 * Each of those jobs says how much of it **no run has claimed yet**, so the
 * planner is allocating what is actually outstanding rather than doing the
 * subtraction in their head — the same complaint the whole planner answers.
 */
export default function RunDialog({ run, seed, setup, onClose, onSaved }: {
  /** The run being edited, or null to plan a new one. */
  run: ProductionRun | null;
  /** Where a new one starts: the cell that was clicked. */
  seed: { date: string; machine_id: number; shift: string };
  setup: RunSetup;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [date, setDate] = useState(run?.date ?? seed.date);
  const [machineId, setMachineId] = useState(run?.machine_id ?? seed.machine_id);
  const [shift, setShift] = useState(run?.shift ?? seed.shift);
  const [notes, setNotes] = useState(run?.notes ?? '');
  /** work_order_id → pieces. The run's own allocations. */
  const [alloc, setAlloc] = useState<Record<number, number>>(
    () => Object.fromEntries((run?.allocations ?? []).map((a) => [a.work_order_id, a.qty_planned])),
  );
  /** The job whose product and colour this run is, once one is chosen. */
  const [seedJob, setSeedJob] = useState<number | null>(run?.allocations[0]?.work_order_id ?? null);
  const [error, setError] = useState('');

  /* Every open job, for choosing the first one. Asked once; the options query
     below is what narrows to the ones that can actually share a run. */
  const { data: jobs = [] } = useQuery({
    queryKey: ['work-orders', 'plannable'],
    queryFn: async () => {
      const b = await api.get<{ rows: WorkOrder[] }>('/api/work-orders?open=1&limit=200');
      return b.rows;
    },
    enabled: seedJob === null,
  });

  const { data: options } = useQuery<RunOptions>({
    queryKey: ['run-options', String(seedJob), String(run?.id ?? '')],
    queryFn: () => api.get<RunOptions>(
      `/api/production-runs/options?like=${seedJob}${run ? `&except=${run.id}` : ''}`),
    enabled: seedJob !== null,
  });

  // The seed job is itself an option, and starts allocated at what is left of
  // it or what the shift can take — whichever is smaller, so the commonest
  // press needs no typing and cannot be refused for either reason.
  useEffect(() => {
    if (!options || run || seedJob === null || alloc[seedJob] !== undefined) return;
    const me = options.options.find((o) => o.work_order_id === seedJob);
    if (me) setAlloc({ [seedJob]: me.unplanned });
  }, [options, run, seedJob, alloc]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        date, machine_id: machineId, shift, notes,
        lines: Object.entries(alloc)
          .filter(([, qty]) => Number(qty) > 0)
          .map(([id, qty]) => ({ work_order_id: Number(id), qty_planned: Number(qty) })),
      };
      return run
        ? api.put<ProductionRun>(`/api/production-runs/${run.id}`, body)
        : api.post<ProductionRun>('/api/production-runs', body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['production-runs'] });
      queryClient.invalidateQueries({ queryKey: ['run-options'] });
      // The plan is what the product planning screen calls "instructed", so it
      // follows a run being saved.
      queryClient.invalidateQueries({ queryKey: ['product-plan'] });
      onSaved();
    },
    onError: (e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not save that run'),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/api/production-runs/${run!.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['production-runs'] });
      queryClient.invalidateQueries({ queryKey: ['run-options'] });
      queryClient.invalidateQueries({ queryKey: ['product-plan'] });
      onSaved();
    },
  });

  const total = Object.values(alloc).reduce((sum, n) => sum + (Number(n) || 0), 0);
  const line = setup.lines.find((l) => l.id === machineId);

  return (
    <Modal
      title={run ? `Run on ${run.line_name} — ${run.date}` : 'Plan a run'}
      onClose={onClose}
      wide
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Date *">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Line *">
            <Select value={String(machineId)} onChange={(e) => setMachineId(Number(e.target.value))}>
              {setup.lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}{l.shifts_per_day === 0 ? ' — not running' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Shift *">
            <Select value={shift} onChange={(e) => setShift(e.target.value)}>
              {setup.shifts.map((s) => (
                // A shift the line does not run is not offered: the server
                // refuses it, and a picker that offers a refusal is the trap
                // above. `shifts_per_day` is how many of the list it runs.
                setup.shifts.indexOf(s) < (line?.shifts_per_day ?? 0)
                  ? <option key={s.key} value={s.key}>{s.label}</option>
                  : null
              ))}
            </Select>
          </Field>
        </div>

        {seedJob === null ? (
          <Field label="What is this run making? *">
            <SearchSelect
              value=""
              onChange={(v) => setSeedJob(Number(v))}
              placeholder="Pick a work order…"
              options={jobs.map((j) => ({
                value: String(j.id),
                label: j.number,
                // Colour is on the hint rather than the label because it is
                // what decides whether two jobs can share a run — the thing
                // somebody is actually scanning this list for.
                hint: [j.product_name || j.description, j.color, j.customer_name]
                  .filter(Boolean).join(' · '),
                keywords: `${j.order_number ?? ''} ${j.customer_name ?? ''} ${j.color ?? ''}`,
              }))}
            />
            <p className="mt-1 text-xs text-slate-500">
              One run is one product and one colour. Pick the first work order and the
              rest of that colour is offered beside it.
            </p>
          </Field>
        ) : !options ? (
          <p className="text-sm text-slate-500">Working out what can share this run…</p>
        ) : (
          <div>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-sm font-semibold text-slate-900">
                {options.product_name || 'Custom item'}
                {options.color && <span className="ml-2 font-normal text-slate-500">{options.color}</span>}
              </div>
              <button
                type="button"
                className="text-xs text-brand-600 hover:underline"
                onClick={() => { setSeedJob(null); setAlloc({}); }}
              >
                Make something else
              </button>
            </div>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-xs">
                <thead>
                  <tr className={TH_CLASS}>
                    <th className="px-2 py-1.5 text-left">Work order</th>
                    <th className="px-2 py-1.5 text-right">Ordered</th>
                    <th className="px-2 py-1.5 text-right">Made</th>
                    <th className="px-2 py-1.5 text-right">Not yet planned</th>
                    <th className="px-2 py-1.5 text-right">On this run</th>
                  </tr>
                </thead>
                <tbody>
                  {options.options.map((o) => (
                    <tr key={o.work_order_id} className="border-t border-slate-100">
                      <td className="px-2 py-1">{o.number}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtQty(o.qty_planned)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtQty(o.made)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {o.unplanned > 0
                          ? fmtQty(o.unplanned)
                          : <span className="text-slate-300" title="Every piece of this job is on a run already">—</span>}
                      </td>
                      <td className="px-2 py-1 text-right">
                        <Input
                          className="w-28 text-right"
                          type="number"
                          min={0}
                          value={alloc[o.work_order_id] ?? ''}
                          placeholder="0"
                          onChange={(e) => setAlloc((prev) => {
                            const next = { ...prev };
                            if (e.target.value === '') delete next[o.work_order_id];
                            else next[o.work_order_id] = Number(e.target.value);
                            return next;
                          })}
                        />
                      </td>
                    </tr>
                  ))}
                  {!options.options.length && (
                    <tr><td colSpan={5} className="px-2 py-3 text-center text-slate-400">
                      No open work order of this product and colour.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              This run: <strong className="tabular-nums text-slate-900">{fmtQty(total)}</strong> pieces
              {/*
                Capacity is the line's own and is worked out by the server, so
                it is only known for a run that already exists. On a **new**
                one this said *no output rate for this product yet*, which is a
                different claim and was often simply untrue — the wrong-wording
                defect this codebase records as a real one. A new run says
                nothing about capacity instead: the save refuses an oversized
                one in its own words, which the dialog then prints.
              */}
              {run && run.capacity !== null && (
                <> of about <span className="tabular-nums">{fmtQty(run.capacity)}</span> the shift can take</>
              )}
              {run && run.capacity === null && (
                <> — no output rate for this product yet, so the shift&rsquo;s capacity is not known</>
              )}
            </p>
          </div>
        )}

        <Field label="Notes">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </Field>

        <ErrorText error={error} />

        <div className="flex items-center justify-between gap-2">
          {run ? (
            <Button
              variant="danger"
              onClick={() => { if (confirm(`Delete this run on ${run.line_name}?`)) remove.mutate(); }}
            >Delete run</Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={() => { setError(''); save.mutate(); }} disabled={total <= 0 || save.isPending}>
              {run ? 'Save run' : 'Plan it'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
