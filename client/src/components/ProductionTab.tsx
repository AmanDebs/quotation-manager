import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Order, WorkOrder, WorkOrderStatus, Location, Machine, Mould, Process } from '../types';
import { Button, Input, Textarea, Select, Field, Card, EmptyState, ErrorText, Modal, TH_CLASS } from './ui';
import { fmtQty } from '../lib/format';
import { useCan } from '../App';

/**
 * What the floor is doing about this order.
 *
 * Two things sit side by side deliberately: what was *sold* on each line, and
 * what has been *made* against it. Progress is a sum of shift entries computed
 * on the server, so a mis-keyed shift is corrected by deleting it — there is no
 * "produced" figure anywhere to fall out of step.
 */

const STATUSES: WorkOrderStatus[] = ['planned', 'released', 'running', 'paused', 'done', 'cancelled'];

const statusStyle: Record<WorkOrderStatus, string> = {
  planned: 'bg-slate-100 text-slate-600',
  released: 'bg-blue-100 text-blue-700',
  running: 'bg-purple-100 text-purple-700',
  paused: 'bg-amber-100 text-amber-700',
  done: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
};

type Draft = Partial<WorkOrder>;

/** One line offered by the bulk raise: what to make, how much, and whether to. */
interface BulkRow {
  order_line: number;
  description: string;
  qty_planned: number;
  on: boolean;
}

/**
 * Pieces on this line that no job covers yet.
 *
 * Ordered less **planned**, not ordered less *made* — which is the figure the
 * single raise used to prefill, and it over-planned every line that already
 * had a job: a line ordered at 120,000 with a job for 50,000 and 30,000 made
 * prefilled 90,000, when 50,000 of that is already somebody's instruction.
 * The two agree exactly where they used to be asked — a line with no job has
 * nothing planned — so nothing about the common case changes.
 *
 * One function rather than one per caller: the single **+ Job** and the bulk
 * raise answer the same question, and two copies of it is how the two come to
 * disagree on the screen they share.
 */
function stillToPlan(it: { total_pcs?: number | null; production?: { planned: number } | null }): number {
  return Math.max(0, (it.total_pcs ?? 0) - (it.production?.planned ?? 0));
}

export default function ProductionTab({ order }: { order: Order }) {
  const queryClient = useQueryClient();
  const can = useCan();
  const [editing, setEditing] = useState<Draft | null>(null);
  // The lines chosen for a bulk raise, or null when the dialog is closed.
  const [raising, setRaising] = useState<BulkRow[] | null>(null);

  const key = ['work-orders', String(order.id)];
  const { data: jobs = [] } = useQuery({
    queryKey: key,
    queryFn: () => api.get<WorkOrder[]>(`/api/work-orders?order_id=${order.id}`),
  });
  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });
  const { data: machines = [] } = useQuery({ queryKey: ['master', 'machines', false], queryFn: () => api.get<Machine[]>('/api/machines') });
  const { data: moulds = [] } = useQuery({ queryKey: ['master', 'moulds', false], queryFn: () => api.get<Mould[]>('/api/moulds') });
  const { data: processes = [] } = useQuery({ queryKey: ['master', 'processes', false], queryFn: () => api.get<Process[]>('/api/processes') });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: key });
    // The order's own per-line production is derived from these jobs.
    queryClient.invalidateQueries({ queryKey: ['order', String(order.id)] });
  };

  const save = useMutation({
    mutationFn: (d: Draft) =>
      d.id ? api.put<WorkOrder>(`/api/work-orders/${d.id}`, d) : api.post<WorkOrder>('/api/work-orders', d),
    onSuccess: () => { refresh(); setEditing(null); },
  });
  /*
   * Every chosen line in one request, so it is one transaction on the server:
   * six jobs are one act, and six separate posts would leave an order half
   * planned when the fourth failed.
   */
  const raiseAll = useMutation({
    mutationFn: (rows: BulkRow[]) => api.post('/api/work-orders/bulk', {
      order_id: order.id,
      lines: rows.map((r) => ({
        order_line: r.order_line, description: r.description, qty_planned: r.qty_planned,
      })),
    }),
    onSuccess: () => { refresh(); setRaising(null); },
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: WorkOrderStatus }) =>
      api.post(`/api/work-orders/${id}/status`, { status }),
    onSuccess: refresh,
  });

  const items = order.items ?? [];
  const lineLabel = (i: number) => items[i]?.description || `Line ${i + 1}`;

  const newJob = (lineIndex: number): Draft => {
    const line = items[lineIndex];
    return {
      order_id: order.id,
      order_line: lineIndex,
      product_id: line?.product_id ?? null,
      description: line?.description ?? '',
      // What no job covers yet, which is the job you almost always want.
      qty_planned: line ? stillToPlan(line) : 0,
      location_id: locations[0]?.id ?? null,
      machine_id: null,
      mould_id: null,
      process_id: null,
      planned_start: '',
      planned_end: '',
      notes: '',
    };
  };

  const set = (patch: Draft) => setEditing((prev) => (prev ? { ...prev, ...patch } : prev));

  /**
   * The lines a bulk raise would offer: goods with something no job covers.
   *
   * A line that **already has a job** is offered but starts unticked — raising
   * a second one against it is a real thing to do (a partial run, or a line
   * the first job under-planned) but it is a decision, not the default. A line
   * with nothing planned starts ticked, which is the ordinary case and the
   * whole point of the button.
   */
  const bulkRows = (): BulkRow[] => items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => !it.is_charge && stillToPlan(it) > 0)
    .map(({ it, i }) => ({
      order_line: i,
      description: it.description || `Line ${i + 1}`,
      qty_planned: stillToPlan(it),
      on: (it.production?.work_orders ?? 0) === 0,
    }));

  const canRaise = can('work_order', 'full');
  const eligible = canRaise ? bulkRows().length : 0;

  return (
    <div className="space-y-4">
      <Card
        title="Sold vs made"
        actions={canRaise && items.some((it) => !it.is_charge) ? (
          <Button
            variant="secondary"
            disabled={eligible === 0}
            title={eligible
              ? 'Raise a job on every line that still needs one'
              : 'Every line already has a job covering what was ordered'}
            onClick={() => { raiseAll.reset(); setRaising(bulkRows()); }}
          >
            Raise jobs
          </Button>
        ) : undefined}
      >
        {items.length === 0 ? (
          <EmptyState message="This order has no lines yet." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className={TH_CLASS}>
                <th className="pb-2 pr-3">Line</th>
                <th className="pb-2 pr-3 text-right">Ordered</th>
                <th className="pb-2 pr-3 text-right">Planned</th>
                <th className="pb-2 pr-3 text-right">Made</th>
                <th className="pb-2 pr-3 text-right">Left</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => {
                const p = it.production;
                const ordered = it.total_pcs ?? null;
                return (
                  <tr key={i} className="border-b border-slate-100 last:border-0">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{it.description || `Line ${i + 1}`}</div>
                      {it.color && <div className="text-xs text-slate-400">{it.color}</div>}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{ordered != null ? fmtQty(ordered) : '—'}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {p && p.work_orders > 0 ? fmtQty(p.planned) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {p && p.work_orders > 0 ? fmtQty(p.produced) : <span className="text-xs text-slate-400">not started</span>}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {ordered != null && p ? fmtQty(Math.max(0, ordered - p.produced)) : '—'}
                    </td>
                    <td className="py-2 text-right">
                      {/* Gated like the bulk button beside it: raising a job is
                          `work_order: full`, so Sales — which holds `view` —
                          was being offered a button that only ever answered
                          403. */}
                      {!it.is_charge && canRaise && (
                        <Button variant="ghost" onClick={() => { save.reset(); setEditing(newJob(i)); }}>
                          + Job
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-xs text-slate-400">
          Quantities here are pieces. “Made” is the sum of the shift entries on the jobs below — nothing stores it,
          so correcting an entry corrects this.
        </p>
      </Card>

      {raising && (
        <BulkRaiseModal
          rows={raising}
          onChange={setRaising}
          saving={raiseAll.isPending}
          error={raiseAll.error}
          onClose={() => setRaising(null)}
          onSave={(rows) => raiseAll.mutate(rows)}
        />
      )}

      <ErrorText error={setStatus.error} />

      <Card title={`Work orders (${jobs.length})`}>
        {jobs.length === 0 ? (
          <EmptyState message={canRaise
            ? 'No jobs raised yet. Use “Raise jobs” above for all of them at once, or “+ Job” on one line.'
            : 'No jobs raised yet.'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={TH_CLASS}>
                  <th className="pb-2 pr-3">Job</th>
                  <th className="pb-2 pr-3">For</th>
                  <th className="pb-2 pr-3">Machine / mould</th>
                  <th className="pb-2 pr-3">Dates</th>
                  <th className="pb-2 pr-3 text-right">Planned</th>
                  <th className="pb-2 pr-3 text-right">Made</th>
                  <th className="pb-2 pr-3 text-right">Rejects</th>
                  <th className="pb-2 pr-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((w) => (
                  <tr key={w.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="py-2 pr-3 font-medium">
                      {/* The job has its own page now: its output, the material
                          drawn against it and its inspections, without the
                          siblings this table shows beside it. */}
                      <Link to={`/work-orders/${w.id}`} className="text-brand-600 hover:underline">{w.number}</Link>
                    </td>
                    <td className="py-2 pr-3">
                      <div>{lineLabel(w.order_line)}</div>
                      {w.location_name && <div className="text-xs text-slate-400">{w.location_name}</div>}
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-500">
                      {[w.machine_name, w.mould_name].filter(Boolean).join(' · ') || '—'}
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-500">
                      {w.planned_start || w.planned_end
                        ? `${w.planned_start || '?'} → ${w.planned_end || '?'}`
                        : '—'}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{fmtQty(w.qty_planned)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {fmtQty(w.progress?.produced ?? 0)}
                      {w.progress && w.qty_planned > 0 && (
                        <div className="text-xs text-slate-400">
                          {Math.round((w.progress.produced / w.qty_planned) * 100)}%
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {w.progress?.rejected ? (
                        <>
                          {fmtQty(w.progress.rejected)}
                          <div className="text-xs text-amber-600">{w.progress.reject_pct}%</div>
                        </>
                      ) : '—'}
                    </td>
                    <td className="py-2 pr-3">
                      <Select
                        className="w-32"
                        value={w.status}
                        onChange={(e) => setStatus.mutate({ id: w.id, status: e.target.value as WorkOrderStatus })}
                      >
                        {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
                      </Select>
                      <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs ${statusStyle[w.status]}`}>
                        {w.progress?.entry_count ?? 0} {w.progress?.entry_count === 1 ? 'entry' : 'entries'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <Modal title={editing.id ? `Edit ${editing.number}` : 'New work order'} onClose={() => setEditing(null)} wide>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Against line" className="col-span-2">
              <Select
                value={editing.order_line ?? 0}
                disabled={!!editing.id}
                onChange={(e) => set({ order_line: Number(e.target.value) })}
              >
                {items.map((it, i) => (
                  <option key={i} value={i}>{i + 1}. {it.description || `Line ${i + 1}`}</option>
                ))}
              </Select>
            </Field>
            <Field label="Description" className="col-span-2">
              <Input value={editing.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
            </Field>
            <Field label="Pieces to make *">
              <Input
                type="number" min={0} step="any"
                value={editing.qty_planned || ''}
                onChange={(e) => set({ qty_planned: Number(e.target.value) })}
              />
            </Field>
            <Field label="Plant">
              <Select value={editing.location_id ?? ''} onChange={(e) => set({ location_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— none —</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </Field>
            <Field label="Machine">
              <Select value={editing.machine_id ?? ''} onChange={(e) => set({ machine_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— none —</option>
                {machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
            </Field>
            <Field label="Mould">
              <Select value={editing.mould_id ?? ''} onChange={(e) => set({ mould_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— none —</option>
                {moulds.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
            </Field>
            {/* The fourth master a job names, and the newest: moulding is not
                the only thing a job can be — assembly and camera inspection
                are jobs too, and the quality report says which was done. */}
            <Field label="Process">
              <Select value={editing.process_id ?? ''} onChange={(e) => set({ process_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— none —</option>
                {processes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
            <Field label="Planned start">
              <Input type="date" value={editing.planned_start ?? ''} onChange={(e) => set({ planned_start: e.target.value })} />
            </Field>
            <Field label="Planned finish">
              <Input type="date" value={editing.planned_end ?? ''} onChange={(e) => set({ planned_end: e.target.value })} />
            </Field>
            <Field label="Notes" className="col-span-2">
              <Textarea rows={2} value={editing.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
            </Field>
          </div>
          <ErrorText error={save.error} />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={() => save.mutate(editing)} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save job'}
            </Button>
          </div>
        </Modal>
      )}

    </div>
  );
}

/** A day's output on one job, and the entries already booked against it. */

/**
 * Raise a job on several lines at once.
 *
 * A list rather than a confirm, because the two things somebody wants to
 * change before pressing are **which** lines and **how many** pieces — and a
 * yes-or-no about a figure nobody can see or correct is how these get pressed
 * blindly. Every quantity is editable, so a partial run is typed here rather
 * than being a reason not to use the button.
 *
 * The jobs it raises are ordinary ones: status `planned`, no machine, mould,
 * process or dates. This saves the presses, not the judgement — what to run
 * where is still opened on each job afterwards.
 */
function BulkRaiseModal({ rows, onChange, saving, error, onClose, onSave }: {
  rows: BulkRow[];
  onChange: (rows: BulkRow[]) => void;
  saving: boolean;
  error: unknown;
  onClose: () => void;
  onSave: (rows: BulkRow[]) => void;
}) {
  const set = (i: number, patch: Partial<BulkRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const chosen = rows.filter((r) => r.on && r.qty_planned > 0);

  return (
    <Modal title="Raise jobs" onClose={onClose} wide>
      <p className="text-sm text-slate-600">
        One job per line, planned for what no existing job covers yet. Untick a line to leave it,
        or change a figure to plan a partial run.
      </p>
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className={TH_CLASS}>
            <th className="w-8 pb-2" />
            <th className="pb-2 pr-3">Line</th>
            <th className="w-40 pb-2 pr-3 text-right">Pieces to plan</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.order_line} className="border-b border-slate-100 last:border-0">
              <td className="py-2">
                <input type="checkbox" checked={r.on} onChange={(e) => set(i, { on: e.target.checked })} />
              </td>
              <td className={`py-2 pr-3 ${r.on ? '' : 'text-slate-400'}`}>{r.description}</td>
              <td className="py-2 pr-3">
                <Input
                  type="number" min={0} step="any"
                  className="w-full text-right tabular-nums"
                  value={r.qty_planned || ''}
                  disabled={!r.on}
                  onChange={(e) => set(i, { qty_planned: e.target.value === '' ? 0 : Number(e.target.value) })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-slate-400">
        Each job takes the next number in the series. Machine, mould, process and dates are set on the job
        afterwards.
      </p>
      <ErrorText error={error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => onSave(chosen)} disabled={saving || chosen.length === 0}>
          {saving ? 'Raising…' : `Raise ${chosen.length} ${chosen.length === 1 ? 'job' : 'jobs'}`}
        </Button>
      </div>
    </Modal>
  );
}
