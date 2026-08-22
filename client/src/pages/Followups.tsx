import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Followup, Customer } from '../types';
import { Button, Input, Textarea, Select, Field, PageHeader, EmptyState, ErrorText, Modal, Card, Pagination } from '../components/ui';
import { fmtDate, today } from '../lib/format';
import { usePagedList, PAGE_SIZE } from '../lib/usePagedList';

const docTypeLabel: Record<string, string> = {
  enquiry: 'Enquiry', quotation: 'Quotation', proforma: 'Proforma', invoice: 'Invoice', general: 'General',
};

export default function FollowupsPage() {
  const queryClient = useQueryClient();
  const [showDone, setShowDone] = useState(false);
  const [creating, setCreating] = useState(false);
  const [dueDate, setDueDate] = useState(today());
  const [note, setNote] = useState('');
  const [customerId, setCustomerId] = useState<number | ''>('');

  const list = usePagedList<Followup>(
    ['followups', showDone],
    `/api/followups${showDone ? '' : '?pending=1'}`,
  );
  const followups = list.rows;
  const { data: customers = [] } = useQuery({ queryKey: ['customers', ''], queryFn: () => api.get<Customer[]>('/api/customers') });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['followups'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const toggle = useMutation({
    mutationFn: (f: Followup) => api.put(`/api/followups/${f.id}`, { done: !f.done }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/followups/${id}`),
    onSuccess: invalidate,
  });
  const create = useMutation({
    mutationFn: () => api.post('/api/followups', { doc_type: 'general', customer_id: customerId || null, due_date: dueDate, note }),
    onSuccess: () => {
      invalidate();
      setCreating(false);
      setNote('');
    },
  });

  const t = today();

  return (
    <div>
      <PageHeader
        title="Follow-ups"
        subtitle="Never lose a customer to a missed follow-up"
        actions={
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-sm text-slate-600">
              <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
              Show completed
            </label>
            <Button onClick={() => setCreating(true)}>+ New Follow-up</Button>
          </div>
        }
      />
      <ErrorText error={toggle.error ?? remove.error} />
      <Card className="overflow-x-auto">
        {followups.length === 0 ? (
          <EmptyState message="Nothing pending. Schedule follow-ups from any quotation, proforma or invoice." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-2 pr-3 w-8" />
                <th className="pb-2 pr-3">Due</th>
                <th className="pb-2 pr-3">Customer</th>
                <th className="pb-2 pr-3">Regarding</th>
                <th className="pb-2 pr-3">Note</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {followups.map((f) => {
                const overdue = !f.done && f.due_date < t;
                const isToday = !f.done && f.due_date === t;
                return (
                  <tr key={f.id} className={`border-b border-slate-100 last:border-0 ${f.done ? 'opacity-50' : ''}`}>
                    <td className="py-2 pr-3">
                      <input type="checkbox" checked={!!f.done} onChange={() => toggle.mutate(f)} title="Mark done" />
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <span className={overdue ? 'font-semibold text-red-600' : isToday ? 'font-semibold text-amber-600' : ''}>
                        {fmtDate(f.due_date)}{overdue && ' ⚠'}{isToday && ' · today'}
                      </span>
                    </td>
                    <td className="py-2 pr-3">{f.customer_name || '—'}</td>
                    <td className="py-2 pr-3">{docTypeLabel[f.doc_type] ?? f.doc_type}{f.doc_number ? ` ${f.doc_number}` : ''}</td>
                    <td className="py-2 pr-3 max-w-md">{f.note || '—'}</td>
                    <td className="py-2 text-right">
                      <Button variant="danger" className="border-0" onClick={() => remove.mutate(f.id)}>Delete</Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <Pagination
          page={list.page} pages={list.pages} total={list.total} limit={PAGE_SIZE}
          onPage={list.setPage} noun="reminders"
        />
      </Card>

      {creating && (
        <Modal title="New Follow-up" onClose={() => setCreating(false)}>
          <div className="space-y-3">
            <Field label="Customer (optional)">
              <Select value={customerId} onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : '')}>
                <option value="">— none —</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Due Date">
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
            <Field label="Note">
              <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <ErrorText error={create.error} />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
              <Button onClick={() => create.mutate()} disabled={create.isPending || !dueDate}>Create</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
