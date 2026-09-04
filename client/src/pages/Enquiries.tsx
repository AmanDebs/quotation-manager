import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Enquiry, EnquiryStatus, Customer } from '../types';
import {
  PageHeader, Card, Select, Input, Textarea, Field, Button, EmptyState, ErrorText, Modal, StatusBadge, Pagination, TH_CLASS,
} from '../components/ui';
import { fmtDate, today } from '../lib/format';
import { useUrlFilter } from '../lib/useUrlFilter';
import { usePagedList, PAGE_SIZE } from '../lib/usePagedList';

/**
 * The front of the funnel: somebody asked before there was anything to quote.
 *
 * Deliberately thin. An enquiry is a note with a date and a customer against
 * it — the moment it needs line items and a price it is a quotation, and
 * "Quote this" carries it there. The only figure on the page is derived:
 * how many live quotations answer it.
 *
 * Status moves by itself from open to quoted when a quotation is raised
 * against it, and `lost` is only ever a human's decision — the same two rules
 * an order's status follows.
 */

const STATUSES: EnquiryStatus[] = ['open', 'quoted', 'lost'];

const statusLabel = (s: string) => s.replace(/^./, (c) => c.toUpperCase());

const Dash = () => <span className="text-slate-300">—</span>;

/** "Kolkata, India" — either half may be missing, and neither leaves a stray comma. */
const place = (city?: string, country?: string) =>
  [city, country].map((v) => (v ?? '').trim()).filter(Boolean).join(', ');

/** A number is only dialable without its spaces; what is shown stays as typed. */
const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;

type Draft = Partial<Enquiry>;

export default function EnquiriesPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useUrlFilter('status');
  const [editing, setEditing] = useState<Draft | null>(null);

  const list = usePagedList<Enquiry>(
    ['enquiries', statusFilter],
    `/api/enquiries${statusFilter ? `?status=${statusFilter}` : ''}`,
  );
  const enquiries = list.rows;
  const { data: customers = [] } = useQuery({
    queryKey: ['customers', ''],
    queryFn: () => api.get<Customer[]>('/api/customers'),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['enquiries'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const save = useMutation({
    mutationFn: (d: Draft) =>
      d.id ? api.put<Enquiry>(`/api/enquiries/${d.id}`, d) : api.post<Enquiry>('/api/enquiries', d),
    onSuccess: () => { refresh(); setEditing(null); },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/enquiries/${id}`),
    onSuccess: refresh,
  });

  const openNew = () => {
    save.reset();
    setEditing({ customer_id: customers[0]?.id, date: today(), notes: '', status: 'open' });
  };

  // Shown under the customer picker while logging one, so a missing phone
  // number is noticed at the moment somebody would want to ring it.
  const editingCustomer = editing
    ? customers.find((c) => c.id === editing.customer_id)
    : undefined;

  // Over the whole list, not the page: the server's total for ?status=open.
  const openTotal = usePagedList<Enquiry>(['enquiries', 'open-count'], '/api/enquiries?status=open', { limit: 1 }).total;

  return (
    <div>
      <PageHeader
        title="Enquiries"
        subtitle="Who has asked, before there is anything to quote"
        actions={<Button onClick={openNew} disabled={customers.length === 0}>+ New enquiry</Button>}
      />

      {customers.length === 0 && (
        <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
          Add a customer first — an enquiry is always somebody asking.
        </div>
      )}

      <div className="mb-3 flex items-center gap-3">
        <div className="w-40">
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </Select>
        </div>
        {openTotal > 0 && !statusFilter && (
          <span className="text-sm text-slate-500">
            {openTotal} still open
          </span>
        )}
      </div>

      <Card className="overflow-x-auto">
        {enquiries.length === 0 ? (
          <EmptyState message={statusFilter
            ? 'Nothing matches that filter.'
            : 'No enquiries. Log one when a customer asks about something you have not quoted yet.'} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className={TH_CLASS}>
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2 pr-3">Customer</th>
                <th className="pb-2 pr-3">Contact</th>
                <th className="pb-2 pr-3">What they asked</th>
                <th className="pb-2 pr-3">Team member</th>
                <th className="pb-2 pr-3">Status</th>
                <th className="pb-2 pr-3 text-right">Quotations</th>
                <th className="pb-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {enquiries.map((e) => (
                <tr key={e.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="whitespace-nowrap py-2 pr-3">{fmtDate(e.date)}</td>
                  <td className="py-2 pr-3">
                    <div className="font-medium">{e.customer_name}</div>
                    {place(e.customer_city, e.customer_country) && (
                      <div className="text-xs text-slate-500">{place(e.customer_city, e.customer_country)}</div>
                    )}
                  </td>
                  {/* Everything here is the customer's, joined rather than
                      copied — it is what somebody chasing the enquiry needs to
                      hand, and it stays right when the customer is corrected. */}
                  <td className="py-2 pr-3">
                    {e.customer_contact || e.customer_phone || e.customer_email ? (
                      <>
                        {e.customer_contact && <div>{e.customer_contact}</div>}
                        {e.customer_phone && (
                          <a className="block whitespace-nowrap text-xs text-brand-700 hover:underline"
                             href={telHref(e.customer_phone)}>{e.customer_phone}</a>
                        )}
                        {e.customer_email && (
                          <a className="block text-xs text-brand-700 hover:underline"
                             href={`mailto:${e.customer_email}`}>{e.customer_email}</a>
                        )}
                      </>
                    ) : <Dash />}
                  </td>
                  <td className="max-w-md py-2 pr-3 text-slate-600">{e.notes || <Dash />}</td>
                  <td className="whitespace-nowrap py-2 pr-3 text-slate-600">{e.owner_name || <Dash />}</td>
                  <td className="py-2 pr-3"><StatusBadge status={e.status} /></td>
                  {/* A count, not a link: the quotations list filters by status
                      and export, not by customer or enquiry, so anything here
                      would land on the unfiltered list and look broken. */}
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {e.quotation_count || <Dash />}
                  </td>
                  <td className="whitespace-nowrap py-2 text-right">
                    {e.status !== 'lost' && (
                      <Button
                        variant="ghost"
                        onClick={() => navigate(`/quotations/new?enquiry=${e.id}&customer=${e.customer_id}`)}
                      >
                        Quote this
                      </Button>
                    )}
                    <Button variant="ghost" onClick={() => { save.reset(); setEditing(e); }}>Edit</Button>
                    <Button
                      variant="danger"
                      className="ml-1 border-0"
                      onClick={() => { if (confirm('Delete this enquiry?')) remove.mutate(e.id); }}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination
          page={list.page} pages={list.pages} total={list.total} limit={PAGE_SIZE}
          onPage={list.setPage} noun="enquiries"
        />
        <ErrorText error={remove.error} />
        <p className="mt-2 text-xs text-slate-400">
          An enquiry moves to <b>quoted</b> on its own when a quotation is raised against it. Marking one
          <b> lost</b> is your call, and quoting it later will not undo that.
        </p>
      </Card>

      {editing && (
        <Modal
          title={editing.id ? 'Edit enquiry' : 'New enquiry'}
          onClose={() => setEditing(null)}
        >
          <div className="space-y-3">
            <Field label="Customer">
              <Select
                value={editing.customer_id ?? ''}
                onChange={(e) => setEditing({ ...editing, customer_id: Number(e.target.value) })}
              >
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            {editingCustomer && (
              <div className="-mt-1 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 ring-1 ring-inset ring-slate-200">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span>{place(editingCustomer.city, editingCustomer.country) || <Dash />}</span>
                  <span>{editingCustomer.contact_person || <Dash />}</span>
                  <span>{editingCustomer.phone || <Dash />}</span>
                  <span>{editingCustomer.email || <Dash />}</span>
                </div>
                <div className="mt-1 text-slate-400">
                  {editingCustomer.owner_name
                    ? `Assigned to ${editingCustomer.owner_name}`
                    : 'Not assigned to anyone yet'}
                  {' · '}edit these on the customer
                </div>
              </div>
            )}
            <Field label="Date">
              <Input
                type="date"
                value={editing.date ?? today()}
                onChange={(e) => setEditing({ ...editing, date: e.target.value })}
              />
            </Field>
            <Field label="What they asked for">
              <Textarea
                rows={4}
                value={editing.notes ?? ''}
                onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                placeholder="e.g. Rang about 20L handles — wants a price for 50,000 pcs"
              />
            </Field>
            {editing.id && (
              <Field label="Status">
                <Select
                  value={editing.status ?? 'open'}
                  onChange={(e) => setEditing({ ...editing, status: e.target.value as EnquiryStatus })}
                >
                  {STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
                </Select>
              </Field>
            )}
            <ErrorText error={save.error} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button onClick={() => save.mutate(editing)} disabled={save.isPending || !editing.customer_id}>
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
