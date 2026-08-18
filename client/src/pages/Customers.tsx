import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Customer, User } from '../types';
import { useIsManager } from '../App';
import { Button, Input, Textarea, Select, Field, PageHeader, EmptyState, ErrorText, Modal, Card, ExportTabs } from '../components/ui';
import CompanySelect, { useCompanies } from '../components/CompanySelect';
import { useUrlFilter } from '../lib/useUrlFilter';

const empty: Omit<Customer, 'id'> = {
  name: '', contact_person: '', email: '', phone: '', address: '', city: '', country: 'India',
  gstin: '', currency: 'INR', consignee: '', notify_party: '', notify_party_2: '', notes: '',
  is_export: 0,
};

export default function CustomersPage() {
  const queryClient = useQueryClient();
  const isManager = useIsManager();
  const companies = useCompanies();
  // In the URL, so Top Customers on the dashboard can land on one name.
  const [q, setQ] = useUrlFilter('q');
  const [exportFilter, setExportFilter] = useUrlFilter('export');
  const [editing, setEditing] = useState<Customer | Omit<Customer, 'id'> | null>(null);
  const { data: customers = [] } = useQuery({
    queryKey: ['customers', q, exportFilter],
    queryFn: () => api.get<Customer[]>(`/api/customers?q=${encodeURIComponent(q)}${exportFilter ? `&export=${exportFilter}` : ''}`),
  });
  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<User[]>('/api/users'),
    enabled: isManager,
  });

  const save = useMutation({
    mutationFn: (c: Customer | Omit<Customer, 'id'>) =>
      'id' in c ? api.put<Customer>(`/api/customers/${c.id}`, c) : api.post<Customer>('/api/customers', c),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setEditing(null);
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/customers/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['customers'] }),
  });

  const set = (patch: Partial<Customer>) => setEditing((prev) => (prev ? { ...prev, ...patch } : prev));

  return (
    <div>
      <PageHeader
        title="Customers"
        subtitle={`${customers.length} customer${customers.length === 1 ? '' : 's'}`}
        actions={<Button onClick={() => { save.reset(); setEditing({ ...empty }); }}>+ New Customer</Button>}
      />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <ExportTabs value={exportFilter} onChange={setExportFilter} />
        <Input placeholder="Search by name, contact or country…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
      </div>
      <ErrorText error={remove.error} />
      <Card className="overflow-x-auto">
        {customers.length === 0 ? (
          <EmptyState message="No customers yet. Add your first customer to start creating quotations." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-2 pr-3">Name</th>
                <th className="pb-2 pr-3">Contact</th>
                <th className="pb-2 pr-3">Country</th>
                <th className="pb-2 pr-3">Type</th>
                <th className="pb-2 pr-3">Currency</th>
                {isManager && <th className="pb-2 pr-3">Owner</th>}
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="py-2 pr-3 font-medium">{c.name}</td>
                  <td className="py-2 pr-3">{c.contact_person || c.email || '—'}</td>
                  <td className="py-2 pr-3">{c.country}</td>
                  <td className="py-2 pr-3 text-xs">{c.is_export ? '🌍 Export' : '🇮🇳 Domestic'}</td>
                  <td className="py-2 pr-3">{c.currency}</td>
                  {isManager && <td className="py-2 pr-3">{c.owner_name ?? '—'}</td>}
                  <td className="py-2 text-right whitespace-nowrap">
                    <Button variant="ghost" onClick={() => { save.reset(); setEditing(c); }}>Edit</Button>
                    <Button
                      variant="danger"
                      className="ml-1 border-0"
                      onClick={() => { if (confirm(`Delete customer "${c.name}"?`)) remove.mutate(c.id); }}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {editing && (
        <Modal title={'id' in editing ? `Edit ${editing.name}` : 'New Customer'} onClose={() => setEditing(null)} wide>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Company / Customer Name *" className="col-span-2">
              <Input value={editing.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Contact Person"><Input value={editing.contact_person} onChange={(e) => set({ contact_person: e.target.value })} /></Field>
            <Field label="Email"><Input value={editing.email} onChange={(e) => set({ email: e.target.value })} /></Field>
            <Field label="Phone"><Input value={editing.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
            <Field label="City"><Input value={editing.city} onChange={(e) => set({ city: e.target.value })} /></Field>
            <Field label="Address" className="col-span-2">
              <Textarea rows={2} value={editing.address} onChange={(e) => set({ address: e.target.value })} />
            </Field>
            <Field label="Country">
              <Input
                value={editing.country}
                onChange={(e) => {
                  const country = e.target.value;
                  set({ country, is_export: country.trim().toLowerCase() !== 'india' && country ? 1 : 0 });
                }}
              />
            </Field>
            <Field label="Business Type">
              <Select value={editing.is_export ? '1' : '0'} onChange={(e) => set({ is_export: Number(e.target.value) })}>
                <option value="0">🇮🇳 Domestic (GST applies)</option>
                <option value="1">🌍 Export</option>
              </Select>
            </Field>
            {isManager && (
              <Field label="Assigned To (owner)">
                <Select value={editing.owner_id ?? ''} onChange={(e) => set({ owner_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— me —</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
                </Select>
              </Field>
            )}
            {/* Renders nothing when the group has only one entity. */}
            {companies.length > 1 && (
              <Field label="Invoiced By">
                <CompanySelect
                  allowDefault
                  value={editing.company_id ?? null}
                  onChange={(id) => set({ company_id: id })}
                />
              </Field>
            )}
            <Field label="Preferred Currency">
              <Select value={editing.currency} onChange={(e) => set({ currency: e.target.value })}>
                <option value="INR">INR — Indian Rupee</option>
                <option value="USD">USD — US Dollar</option>
                <option value="EUR">EUR — Euro</option>
              </Select>
            </Field>
            <Field label="GSTIN (for domestic customers)"><Input value={editing.gstin} onChange={(e) => set({ gstin: e.target.value })} /></Field>
            <div />
            <Field label="Default Consignee (if different from buyer)" className="col-span-2">
              <Textarea rows={2} value={editing.consignee} onChange={(e) => set({ consignee: e.target.value })} placeholder="Name and address of consignee" />
            </Field>
            <Field label="Default Notify Party 1 (for exports)" className="col-span-2">
              <Textarea rows={2} value={editing.notify_party} onChange={(e) => set({ notify_party: e.target.value })} />
            </Field>
            <Field label="Default Notify Party 2 (optional)" className="col-span-2">
              <Textarea rows={2} value={editing.notify_party_2} onChange={(e) => set({ notify_party_2: e.target.value })} />
            </Field>
            <Field label="Notes" className="col-span-2">
              <Textarea rows={2} value={editing.notes} onChange={(e) => set({ notes: e.target.value })} />
            </Field>
          </div>
          <div className="mt-4 space-y-2">
            <ErrorText error={save.error} />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
              <Button onClick={() => save.mutate(editing)} disabled={save.isPending || !editing.name.trim()}>
                {'id' in editing ? 'Save Changes' : 'Create Customer'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
