import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Invoice } from '../types';
import { Button, Select, Input, PageHeader, EmptyState, Card, ExportTabs, ErrorText, Pagination } from '../components/ui';
import { useCompanies } from '../components/CompanySelect';
import NewDocumentDialog from '../components/NewDocumentDialog';
import { fmtDate, fmtMoney } from '../lib/format';
import { useUrlFilter } from '../lib/useUrlFilter';
import { usePagedList, PAGE_SIZE } from '../lib/usePagedList';

const STATUSES = ['draft', 'final', 'dispatched', 'paid'];

// Tint the inline picker so the column still reads at a glance, like the badge
// did. The ramp follows the stage: nothing sent yet, issued, gone, settled.
const statusTint: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700 border-slate-300',
  final: 'bg-blue-50 text-blue-700 border-blue-300',
  dispatched: 'bg-amber-50 text-amber-800 border-amber-300',
  paid: 'bg-green-50 text-green-700 border-green-300',
};

const label = (s: string) => s[0].toUpperCase() + s.slice(1);

export default function InvoicesPage() {
  // Only worth a column once the group has more than one entity.
  const companies = useCompanies();
  const showCompany = companies.length > 1;
  const [companyFilter, setCompanyFilter] = useUrlFilter('company');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // In the URL, so the dashboard can link to one slice of the list and the
  // back button undoes a filter instead of leaving the page.
  const [statusFilter, setStatusFilter] = useUrlFilter('status');
  const [exportFilter, setExportFilter] = useUrlFilter('export');
  // Server-side, not a filter over the rows on screen: the list is paged,
  // so searching what has been fetched would only search the current page.
  const [search, setSearch] = useUrlFilter('q');
  const [creating, setCreating] = useState(false);
  const params = new URLSearchParams();
  if (statusFilter) params.set('status', statusFilter);
  if (exportFilter) params.set('export', exportFilter);
  if (companyFilter) params.set('company', companyFilter);
  if (search) params.set('q', search);
  const list = usePagedList<Invoice>(
    // search rides in the key, so typing returns to page 1 rather than
    // leaving somebody on page 7 of a three-row result.
    ['invoices', statusFilter, exportFilter, companyFilter, search],
    `/api/invoices${params.toString() ? `?${params}` : ''}`,
  );
  const invoices = list.rows;

  // Change status without opening the invoice. The server still owns the
  // approval rule — moving an unapproved invoice to an outgoing status comes
  // back as a 409, which surfaces above the table rather than failing silently.
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      api.post<Invoice>(`/api/invoices/${id}/status`, { status }),
    onSuccess: (inv) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice', String(inv.id)] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['approval-count'] });
    },
  });

  return (
    <div>
      <PageHeader
        title="Commercial Invoices"
        subtitle="“This is the final bill.”"
        actions={<Button onClick={() => setCreating(true)}>+ New Invoice</Button>}
      />
      {creating && <NewDocumentDialog basePath="/invoices" title="New Commercial Invoice" onClose={() => setCreating(false)} />}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <ExportTabs value={exportFilter} onChange={setExportFilter} />
        {showCompany && (
          <Select value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)} className="max-w-56">
            <option value="">All companies</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.company_name || `Company ${c.id}`}</option>
            ))}
          </Select>
        )}
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="max-w-45">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </Select>
        <Input
          className="max-w-64"
          placeholder="Search number or customer…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <ErrorText error={setStatus.error} />
      <Card className="overflow-x-auto">
        {invoices.length === 0 ? (
          <EmptyState
            message={
              search || statusFilter || exportFilter || companyFilter
                ? 'Nothing matches those filters.'
                : 'No commercial invoices yet. Create one from a confirmed proforma invoice at dispatch time.'
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-2 pr-3">Number</th>
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2 pr-3">Customer</th>
                {showCompany && <th className="pb-2 pr-3">Issued By</th>}
                <th className="pb-2 pr-3">Ref. PI</th>
                <th className="pb-2 pr-3 text-right">Total</th>
                <th className="pb-2 pr-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50" onClick={() => navigate(`/invoices/${inv.id}`)}>
                  <td className="py-2 pr-3 font-medium text-brand-600"><Link to={`/invoices/${inv.id}`}>{inv.number}</Link></td>
                  <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(inv.date)}</td>
                  <td className="py-2 pr-3">{inv.customer_name}</td>
                  {showCompany && (
                    <td className="py-2 pr-3 text-xs text-slate-500">{inv.company_name ?? "—"}</td>
                  )}
                  <td className="py-2 pr-3">{inv.pi_number || '—'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{fmtMoney(inv.grand_total, inv.currency)}</td>
                  {/* Editable in place — the click must not open the invoice. */}
                  <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                    <select
                      value={inv.status}
                      disabled={setStatus.isPending}
                      onChange={(e) => {
                        setStatus.reset();
                        setStatus.mutate({ id: inv.id, status: e.target.value });
                      }}
                      className={`cursor-pointer rounded-full border px-2 py-0.5 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:opacity-50 ${statusTint[inv.status] ?? 'bg-slate-100 text-slate-600 border-slate-300'}`}
                      title="Change status"
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s} className="bg-white text-slate-800">{label(s)}</option>
                      ))}
                    </select>
                    {inv.approval_status === 'pending' && (
                      <span className="ml-1 text-xs text-amber-700" title="Awaiting manager approval">⏳</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination
          page={list.page} pages={list.pages} total={list.total} limit={PAGE_SIZE}
          onPage={list.setPage} noun="invoices"
        />
      </Card>
    </div>
  );
}
