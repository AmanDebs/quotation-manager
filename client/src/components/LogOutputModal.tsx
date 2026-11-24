import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { WorkOrder } from '../types';
import { Button, EmptyState, ErrorText, Field, Input, Modal, TH_CLASS, Select } from './ui';
import { SHIFTS } from './DocFields';
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
        {/*
          A list rather than a box (2026-11-24). `production_entries.shift` has
          been free text since the table was written, so the same shift reached
          the book as `A`, `a` and `Shift A` — which is fine for a label and
          not enough to *measure* a per-shift rate over, which the planner now
          does. The server upper-cases and trims what it reads, so the three
          already on file fold together.

          **Only the two, with no escape hatch for an off-list value**, which
          is the one thing this dialog does *not* need: it only ever creates a
          new entry — the form resets after each save and nothing here opens an
          existing one — so `entry.shift` can only be blank, A or B, and an
          option for a value already on a row could never draw. That would be
          the dead control this codebase keeps refusing. The **record** still
          keeps whatever was typed before the list existed: `normaliseShift`
          trims and upper-cases but never discards, so an entry reading `NIGHT`
          goes on reading `NIGHT` and is listed below as it stands.

          Blank stays offered, because *nobody wrote it down* is a real answer
          and is what every entry on the book before today says.
        */}
        <Field label="Shift">
          <Select value={entry.shift} onChange={(e) => setEntry({ ...entry, shift: e.target.value })}>
            <option value="">— not recorded —</option>
            {SHIFTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </Field>
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
