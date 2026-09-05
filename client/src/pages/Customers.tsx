import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Customer } from '../types';
import { useCan } from '../App';
import { Button, Input, PageHeader, EmptyState, ErrorText, Card, ExportTabs, Pagination, TH_CLASS } from '../components/ui';
import CustomerDialog, { emptyCustomer } from '../components/CustomerDialog';
import { useUrlFilter } from '../lib/useUrlFilter';
import { usePagedList, PAGE_SIZE } from '../lib/usePagedList';

export default function CustomersPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const can = useCan();
  const isManager = can('team');
  // In the URL, so Top Customers on the dashboard can land on one name.
  const [q, setQ] = useUrlFilter('q');
  const [exportFilter, setExportFilter] = useUrlFilter('export');
  const [editing, setEditing] = useState<Customer | Omit<Customer, 'id'> | null>(null);
  const list = usePagedList<Customer>(
    ['customers', q, exportFilter],
    `/api/customers?q=${encodeURIComponent(q)}${exportFilter ? `&export=${exportFilter}` : ''}`,
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
        actions={<Button onClick={() => setEditing({ ...emptyCustomer })}>+ New Customer</Button>}
      />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <ExportTabs value={exportFilter} onChange={setExportFilter} />
        <Input placeholder="Search by name, contact or country…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
      </div>
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
                {isManager && <th className="pb-2 pr-3">Owner</th>}
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
                  {isManager && <td className="py-2 pr-3">{c.owner_name ?? '—'}</td>}
                  <td className="py-2 text-right whitespace-nowrap">
                    <Button variant="ghost" onClick={() => setEditing(c)}>Edit</Button>
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
    </div>
  );
}
