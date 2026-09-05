import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Customer, User } from '../types';
import { useCan } from '../App';
import { Button, Input, Textarea, Select, Field, ErrorText, Modal } from './ui';
import CompanySelect, { useCompanies } from './CompanySelect';

/**
 * The customer form, in a dialog.
 *
 * It lives here rather than inside the list page because there are now two
 * places to edit a customer from — the list and the customer's own page — and
 * a second copy of an eighteen-field form is how the two come to ask for
 * different things. It owns its own save, so neither caller has to.
 */

/** A new customer's starting values. Exported so a caller can open the dialog empty. */
export const emptyCustomer: Omit<Customer, 'id'> = {
  name: '', contact_person: '', email: '', phone: '', address: '', city: '', country: 'India',
  gstin: '', currency: 'INR', consignee: '', notify_party: '', notify_party_2: '', notes: '',
  is_export: 0,
};

export default function CustomerDialog({ initial, onClose, onSaved }: {
  initial: Customer | Omit<Customer, 'id'>;
  onClose: () => void;
  /** The saved row, so a caller can navigate to a customer it has just created. */
  onSaved?: (saved: Customer) => void;
}) {
  const queryClient = useQueryClient();
  const can = useCan();
  // The owner column pulls the staff list, which is the team function.
  const isManager = can('team');
  const companies = useCompanies();
  const [draft, setDraft] = useState<Customer | Omit<Customer, 'id'>>(initial);

  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<User[]>('/api/users'),
    enabled: isManager,
  });

  const save = useMutation({
    mutationFn: (c: Customer | Omit<Customer, 'id'>) =>
      'id' in c ? api.put<Customer>(`/api/customers/${c.id}`, c) : api.post<Customer>('/api/customers', c),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      // The detail page reads its own two keys, and an edit changes both.
      queryClient.invalidateQueries({ queryKey: ['customer'] });
      onSaved?.(saved);
      onClose();
    },
  });

  const set = (patch: Partial<Customer>) => setDraft((prev) => ({ ...prev, ...patch }));

  return (
    <Modal title={'id' in draft ? `Edit ${draft.name}` : 'New Customer'} onClose={onClose} wide>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Company / Customer Name *" className="sm:col-span-2">
          <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Contact Person"><Input value={draft.contact_person} onChange={(e) => set({ contact_person: e.target.value })} /></Field>
        <Field label="Email"><Input value={draft.email} onChange={(e) => set({ email: e.target.value })} /></Field>
        <Field label="Phone"><Input value={draft.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
        <Field label="City"><Input value={draft.city} onChange={(e) => set({ city: e.target.value })} /></Field>
        <Field label="Address" className="sm:col-span-2">
          <Textarea rows={2} value={draft.address} onChange={(e) => set({ address: e.target.value })} />
        </Field>
        <Field label="Country">
          <Input
            value={draft.country}
            onChange={(e) => {
              const country = e.target.value;
              set({ country, is_export: country.trim().toLowerCase() !== 'india' && country ? 1 : 0 });
            }}
          />
        </Field>
        <Field label="Business Type">
          <Select value={draft.is_export ? '1' : '0'} onChange={(e) => set({ is_export: Number(e.target.value) })}>
            <option value="0">🇮🇳 Domestic (GST applies)</option>
            <option value="1">🌍 Export</option>
          </Select>
        </Field>
        {isManager && (
          <Field label="Assigned To (owner)">
            <Select value={draft.owner_id ?? ''} onChange={(e) => set({ owner_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">— me —</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
            </Select>
          </Field>
        )}
        {/* Renders nothing when the group has only one entity. */}
        {companies.length > 1 && (
          <Field label="Invoiced By">
            <CompanySelect allowDefault value={draft.company_id ?? null} onChange={(id) => set({ company_id: id })} />
          </Field>
        )}
        <Field label="Preferred Currency">
          <Select value={draft.currency} onChange={(e) => set({ currency: e.target.value })}>
            <option value="INR">INR — Indian Rupee</option>
            <option value="USD">USD — US Dollar</option>
            <option value="EUR">EUR — Euro</option>
          </Select>
        </Field>
        <Field label="GSTIN (for domestic customers)"><Input value={draft.gstin} onChange={(e) => set({ gstin: e.target.value })} /></Field>
        <Field label="Default Consignee (if different from buyer)" className="sm:col-span-2">
          <Textarea rows={2} value={draft.consignee} onChange={(e) => set({ consignee: e.target.value })} placeholder="Name and address of consignee" />
        </Field>
        <Field label="Default Notify Party 1 (for exports)" className="sm:col-span-2">
          <Textarea rows={2} value={draft.notify_party} onChange={(e) => set({ notify_party: e.target.value })} />
        </Field>
        <Field label="Default Notify Party 2 (optional)" className="sm:col-span-2">
          <Textarea rows={2} value={draft.notify_party_2} onChange={(e) => set({ notify_party_2: e.target.value })} />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea rows={2} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      </div>
      <div className="mt-4 space-y-2">
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate(draft)} disabled={save.isPending || !draft.name.trim()}>
            {'id' in draft ? 'Save Changes' : 'Create Customer'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
