import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { WorkOrder } from '../types';
import { Button, EmptyState, ErrorText, Field, Input, Modal, TH_CLASS } from './ui';
import { fmtQty, today } from '../lib/format';

/** Shared with the work order's own page, which asks the same thing of one job. */
export function LogOutput({ job, onClose, onSaved }: { job: WorkOrder; onClose: () => void; onSaved: () => void }) {
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

      <div className="grid grid-cols-2 gap-2 rounded-md border border-slate-200 bg-slate-50/70 p-3 sm:grid-cols-3 lg:grid-cols-6">
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
            <tr className={TH_CLASS}>
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
