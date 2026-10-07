import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Customer } from '../types';
import { useCan, useUser } from '../App';
import { Button, Input, PageHeader, EmptyState, ErrorText, Card, ExportTabs, Pagination, TH_CLASS } from '../components/ui';
import CustomerDialog, { emptyCustomer } from '../components/CustomerDialog';
import CustomerImportModal from '../components/CustomerImportModal';
import { Icon } from '../components/icons';
import { useUrlFilter } from '../lib/useUrlFilter';
import { usePagedList, PAGE_SIZE } from '../lib/usePagedList';

export default function CustomersPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const can = useCan();
  const user = useUser();
  /*
   * Sales is the one team whose **documents** are scoped to the customers
   * assigned to them, and since the master began listing everybody that is a
   * difference worth saying out loud: this page shows 820 while the New
   * Quotation picker shows the handful that are theirs, and an unexplained
   * gap between two lists of the same thing reads as a fault.
   */
  const scoped = user?.team_role === 'sales';
  const mine = (c: Customer) => !scoped || Number(c.owner_id) === Number(user?.id);
  // In the URL, so Top Customers on the dashboard can land on one name.
  const [q, setQ] = useUrlFilter('q');
  const [exportFilter, setExportFilter] = useUrlFilter('export');
  const [editing, setEditing] = useState<Customer | Omit<Customer, 'id'> | null>(null);
  const [importing, setImporting] = useState(false);
  /*
   * `all=1` — this page is the customer **master**, so it lists every customer
   * whoever owns them (2026-10-07, the client: *"every user should have access
   * to all customers in customer master"*).
   *
   * The endpoint's default is still scoped, because the same endpoint feeds
   * the New Quotation picker and the document forms, and a document may only
   * be raised for a customer assigned to you. This page is the one caller that
   * asks to see past that, which is why the flag is here rather than there.
   */
  const list = usePagedList<Customer>(
    ['customers', 'all', q, exportFilter],
    `/api/customers?all=1&q=${encodeURIComponent(q)}${exportFilter ? `&export=${exportFilter}` : ''}`,
  );
  const customers = list.rows;

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/customers/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['customers'] }),
  });

  return (
    <div>
      <PageHeader
        title="Customers"
        subtitle={`${list.total} customer${list.total === 1 ? '' : 's'}`}
        actions={
          <>
            {/* Adding customers in bulk is adding customers: the same cell the
                button beside it needs. */}
            {can('customer', 'full') && (
              <Button variant="secondary" onClick={() => setImporting(true)} className="inline-flex items-center gap-1.5">
                <Icon name="upload" /> Import from Excel
              </Button>
            )}
            <Button onClick={() => setEditing({ ...emptyCustomer })}>+ New Customer</Button>
          </>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <ExportTabs value={exportFilter} onChange={setExportFilter} />
        <Input placeholder="Search by name, contact or country…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
      </div>
      {scoped && (
        <p className="mb-3 text-xs text-slate-500">
          This is the whole customer book, and <span className="font-medium">any of them can be quoted, ordered or
          invoiced for</span>. The Owner column says who handles each — their existing documents stay with them, and
          anything you raise yourself shows on your own lists.
        </p>
      )}
      <ErrorText error={remove.error} />
      <Card className="overflow-x-auto">
        {customers.length === 0 ? (
          <EmptyState message={q || exportFilter
            ? 'Nothing matches those filters.'
            : 'No customers yet. Add your first customer to start creating quotations.'} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className={TH_CLASS}>
                <th className="pb-2 pr-3">Name</th>
                <th className="pb-2 pr-3">Contact</th>
                <th className="pb-2 pr-3">Country</th>
                <th className="pb-2 pr-3">Type</th>
                <th className="pb-2 pr-3">Currency</th>
                <th className="pb-2 pr-3">Owner</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  {/* The name opens the customer rather than the edit dialog:
                      the usual reason to click a customer is to see what is
                      going on with them, not to correct their address. */}
                  <td className="py-2 pr-3 font-medium">
                    <Link to={`/customers/${c.id}`} className="text-brand-600 hover:underline">{c.name}</Link>
                  </td>
                  <td className="py-2 pr-3">{c.contact_person || c.email || '—'}</td>
                  <td className="py-2 pr-3">{c.country}</td>
                  <td className="py-2 pr-3 text-xs">{c.is_export ? '🌍 Export' : '🇮🇳 Domestic'}</td>
                  <td className="py-2 pr-3">{c.currency}</td>
                  <td className="py-2 pr-3">{c.owner_name ?? '—'}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <Button variant="ghost" onClick={() => setEditing(c)}>Edit</Button>
                    {/* Editing follows the permission cell, so it is offered on
                        every row; deleting stays with the owner, so it is drawn
                        only where it would not answer 404. */}
                    {mine(c) && (
                      <Button
                        variant="danger"
                        className="ml-1 border-0"
                        onClick={() => { if (confirm(`Delete customer "${c.name}"?`)) remove.mutate(c.id); }}
                      >
                        Delete
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination
          page={list.page} pages={list.pages} total={list.total} limit={PAGE_SIZE}
          onPage={list.setPage} noun="customers"
        />
      </Card>

      {editing && (
        <CustomerDialog
          initial={editing}
          onClose={() => setEditing(null)}
          // A customer just created is almost always about to be worked on, so
          // land on their page rather than back on page one of the list.
          onSaved={(saved) => { if (!('id' in editing)) navigate(`/customers/${saved.id}`); }}
        />
      )}

      {importing && <CustomerImportModal onClose={() => setImporting(false)} />}
    </div>
  );
}
