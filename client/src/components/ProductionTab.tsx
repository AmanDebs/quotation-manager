import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Order, WorkOrder, WorkOrderStatus, Location, Machine, Mould } from '../types';
import { Button, Input, Textarea, Select, Field, Card, EmptyState, ErrorText, Modal } from './ui';
import { fmtQty, today } from '../lib/format';

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

export default function ProductionTab({ order }: { order: Order }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [logging, setLogging] = useState<WorkOrder | null>(null);

  const key = ['work-orders', String(order.id)];
  const { data: jobs = [] } = useQuery({
    queryKey: key,
    queryFn: () => api.get<WorkOrder[]>(`/api/work-orders?order_id=${order.id}`),
  });
  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });
  const { data: machines = [] } = useQuery({ queryKey: ['master', 'machines', false], queryFn: () => api.get<Machine[]>('/api/machines') });
  const { data: moulds = [] } = useQuery({ queryKey: ['master', 'moulds', false], queryFn: () => api.get<Mould[]>('/api/moulds') });

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
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: WorkOrderStatus }) =>
      api.post(`/api/work-orders/${id}/status`, { status }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/work-orders/${id}`),
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
      // Default to what is still unmade on that line, which is the job you
      // almost always want to raise.
      qty_planned: Math.max(0, (line?.total_pcs ?? 0) - (line?.production?.produced ?? 0)),
      location_id: locations[0]?.id ?? null,
      machine_id: null,
      mould_id: null,
      planned_start: '',
      planned_end: '',
      notes: '',
    };
  };

  const set = (patch: Draft) => setEditing((prev) => (prev ? { ...prev, ...patch } : prev));

  return (
    <div className="space-y-4">
      <Card title="Sold vs made">
        {items.length === 0 ? (
          <EmptyState message="This order has no lines yet." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
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
                      {!it.is_charge && (
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

      <ErrorText error={remove.error ?? setStatus.error} />

      <Card title={`Work orders (${jobs.length})`}>
        {jobs.length === 0 ? (
          <EmptyState message="No jobs raised yet. Use “+ Job” on a line above." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="pb-2 pr-3">Job</th>
                  <th className="pb-2 pr-3">For</th>
                  <th className="pb-2 pr-3">Machine / mould</th>
                  <th className="pb-2 pr-3">Dates</th>
                  <th className="pb-2 pr-3 text-right">Planned</th>
                  <th className="pb-2 pr-3 text-right">Made</th>
                  <th className="pb-2 pr-3 text-right">Rejects</th>
                  <th className="pb-2 pr-3">Status</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {jobs.map((w) => (
                  <tr key={w.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="py-2 pr-3 font-medium">{w.number}</td>
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
                    <td className="whitespace-nowrap py-2 text-right">
                      <Button variant="ghost" onClick={() => setLogging(w)}>Log output</Button>
                      <Button variant="ghost" onClick={() => { save.reset(); setEditing(w); }}>Edit</Button>
                      <Button
                        variant="danger"
                        className="ml-1 border-0"
                        onClick={() => { if (confirm(`Delete job ${w.number}?`)) remove.mutate(w.id); }}
                      >
                        Delete
                      </Button>
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
          <div className="grid grid-cols-2 gap-3">
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

      {logging && <LogOutput job={logging} onClose={() => setLogging(null)} onSaved={refresh} />}
    </div>
  );
}

/** A day's output on one job, and the entries already booked against it. */
function LogOutput({ job, onClose, onSaved }: { job: WorkOrder; onClose: () => void; onSaved: () => void }) {
  const [entry, setEntry] = useState({ date: today(), shift: '', qty_ok: 0, qty_reject: 0, operator: '', notes: '' });

  const { data: full } = useQuery({
    queryKey: ['work-order', String(job.id)],
    queryFn: () => api.get<WorkOrder>(`/api/work-orders/${job.id}`),
  });
  const queryClient = useQueryClient();
  const after = () => {
    queryClient.invalidateQueries({ queryKey: ['work-order', String(job.id)] });
    onSaved();
  };

  const add = useMutation({
    mutationFn: () => api.post(`/api/work-orders/${job.id}/entries`, entry),
    onSuccess: () => { setEntry({ date: today(), shift: '', qty_ok: 0, qty_reject: 0, operator: '', notes: '' }); after(); },
  });
  const removeEntry = useMutation({
    mutationFn: (entryId: number) => api.del(`/api/work-orders/entries/${entryId}`),
    onSuccess: after,
  });

  const entries = full?.entries ?? [];

  return (
    <Modal title={`Output — ${job.number}`} onClose={onClose} wide>
      <div className="mb-3 flex flex-wrap gap-4 text-sm">
        <span>Planned <strong className="tabular-nums">{fmtQty(job.qty_planned)}</strong></span>
        <span>Made <strong className="tabular-nums">{fmtQty(full?.progress?.produced ?? 0)}</strong></span>
        <span>Left <strong className="tabular-nums">{fmtQty(full?.progress?.balance ?? job.qty_planned)}</strong></span>
        {full?.progress?.reject_pct != null && <span className="text-amber-700">Rejects {full.progress.reject_pct}%</span>}
      </div>

      <div className="grid grid-cols-6 gap-2 rounded-md border border-slate-200 bg-slate-50/70 p-3">
        <Field label="Date"><Input type="date" value={entry.date} onChange={(e) => setEntry({ ...entry, date: e.target.value })} /></Field>
        <Field label="Shift"><Input value={entry.shift} onChange={(e) => setEntry({ ...entry, shift: e.target.value })} placeholder="A / B" /></Field>
        <Field label="Good pcs"><Input type="number" min={0} step="any" value={entry.qty_ok || ''} onChange={(e) => setEntry({ ...entry, qty_ok: Number(e.target.value) })} /></Field>
        <Field label="Rejects"><Input type="number" min={0} step="any" value={entry.qty_reject || ''} onChange={(e) => setEntry({ ...entry, qty_reject: Number(e.target.value) })} /></Field>
        <Field label="Operator"><Input value={entry.operator} onChange={(e) => setEntry({ ...entry, operator: e.target.value })} /></Field>
        <div className="flex items-end">
          <Button className="w-full" onClick={() => add.mutate()} disabled={add.isPending}>Add</Button>
        </div>
      </div>
      <ErrorText error={add.error ?? removeEntry.error} />

      {entries.length === 0 ? (
        <EmptyState message="Nothing booked against this job yet." />
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
              <th className="pb-2 pr-3">Date</th>
              <th className="pb-2 pr-3">Shift</th>
              <th className="pb-2 pr-3 text-right">Good</th>
              <th className="pb-2 pr-3 text-right">Rejects</th>
              <th className="pb-2 pr-3">Operator</th>
              <th className="pb-2 pr-3">Entered by</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-b border-slate-100 last:border-0">
                <td className="py-2 pr-3">{e.date}</td>
                <td className="py-2 pr-3">{e.shift || '—'}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtQty(e.qty_ok)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{e.qty_reject ? fmtQty(e.qty_reject) : '—'}</td>
                <td className="py-2 pr-3">{e.operator || '—'}</td>
                <td className="py-2 pr-3 text-xs text-slate-400">{e.created_by_name ?? '—'}</td>
                <td className="py-2 text-right">
                  <button
                    className="text-slate-300 hover:text-red-500"
                    onClick={() => { if (confirm('Delete this entry?')) removeEntry.mutate(e.id); }}
                    title="Delete entry"
                  >✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
