import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Enquiry, Customer } from '../types';
import { Button, Input, Textarea, Select, Field, PageHeader, EmptyState, ErrorText, Modal, Card, StatusBadge } from '../components/ui';
import { fmtDate, today } from '../lib/format';

type Draft = { id?: number; customer_id: number | ''; date: string; notes: string; status: Enquiry['status'] };

export default function EnquiriesPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState('');
  const [editing, setEditing] = useState<Draft | null>(null);

  const { data: enquiries = [] } = useQuery({
    queryKey: ['enquiries', statusFilter],
    queryFn: () => api.get<Enquiry[]>(`/api/enquiries${statusFilter ? `?status=${statusFilter}` : ''}`),
  });
  const { data: customers = [] } = useQuery({ queryKey: ['customers', ''], queryFn: () => api.get<Customer[]>('/api/customers') });

  const save = useMutation({
    mutationFn: (d: Draft) => (d.id ? api.put<Enquiry>(`/api/enquiries/${d.id}`, d) : api.post<Enquiry>('/api/enquiries', d)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['enquiries'] });
      setEditing(null);
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/enquiries/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['enquiries'] }),
  });

  const set = (patch: Partial<Draft>) => setEditing((prev) => (prev ? { ...prev, ...patch } : prev));

  return (
    <div>
      <PageHeader
        title="Enquiries"
        subtitle="Incoming customer requests for quotations"
        actions={<Button onClick={() => { save.reset(); setEditing({ customer_id: '', date: today(), notes: '', status: 'open' }); }}>+ New Enquiry</Button>}
      />
      <div className="mb-3 max-w-45">
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="quoted">Quoted</option>
          <option value="lost">Lost</option>
        </Select>
      </div>
      <ErrorText error={remove.error} />
      <Card className="overflow-x-auto">
        {enquiries.length === 0 ? (
          <EmptyState message="No enquiries. Log an enquiry when a customer asks for prices." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2 pr-3">Customer</th>
                <th className="pb-2 pr-3">Notes</th>
                <th className="pb-2 pr-3">Status</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {enquiries.map((e) => (
                <tr key={e.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(e.date)}</td>
                  <td className="py-2 pr-3 font-medium">{e.customer_name}</td>
                  <td className="py-2 pr-3 max-w-md truncate">{e.notes || '—'}</td>
                  <td className="py-2 pr-3"><StatusBadge status={e.status} /></td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {e.status === 'open' && (
                      <Button variant="ghost" onClick={() => navigate(`/quotations/new?enquiry=${e.id}&customer=${e.customer_id}`)}>
                        Create Quotation
                      </Button>
                    )}
                    <Button variant="ghost" onClick={() => { save.reset(); setEditing({ id: e.id, customer_id: e.customer_id, date: e.date, notes: e.notes, status: e.status }); }}>Edit</Button>
                    <Button variant="danger" className="ml-1 border-0" onClick={() => { if (confirm('Delete this enquiry?')) remove.mutate(e.id); }}>Delete</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {editing && (
        <Modal title={editing.id ? 'Edit Enquiry' : 'New Enquiry'} onClose={() => setEditing(null)}>
          <div className="space-y-3">
            <Field label="Customer *">
              <Select value={editing.customer_id} onChange={(e) => set({ customer_id: e.target.value ? Number(e.target.value) : '' })}>
                <option value="">Select customer…</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.country})</option>)}
              </Select>
            </Field>
            <Field label="Date">
              <Input type="date" value={editing.date} onChange={(e) => set({ date: e.target.value })} />
            </Field>
            <Field label="What is the customer asking for?">
              <Textarea rows={3} value={editing.notes} onChange={(e) => set({ notes: e.target.value })} />
            </Field>
            {editing.id && (
              <Field label="Status">
                <Select value={editing.status} onChange={(e) => set({ status: e.target.value as Enquiry['status'] })}>
                  <option value="open">Open</option>
                  <option value="quoted">Quoted</option>
                  <option value="lost">Lost</option>
                </Select>
              </Field>
            )}
            <ErrorText error={save.error} />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
              <Button onClick={() => save.mutate(editing)} disabled={save.isPending || !editing.customer_id}>
                {editing.id ? 'Save Changes' : 'Log Enquiry'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
