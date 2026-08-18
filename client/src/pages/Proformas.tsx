import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Proforma } from '../types';
import { Button, Select, PageHeader, EmptyState, Card, ExportTabs, ErrorText } from '../components/ui';
import { useCompanies } from '../components/CompanySelect';
import NewDocumentDialog from '../components/NewDocumentDialog';
import { fmtDate, fmtMoney } from '../lib/format';
import { useUrlFilter } from '../lib/useUrlFilter';

const STATUSES = ['draft', 'sent', 'order_confirmed', 'advance_received', 'in_production', 'cancelled'];

// Tint the inline picker so the list still reads at a glance, the way the
// badge did. Mirrors the quotation list; the colours follow the stage rather
// than the word, so "cancelled" reads as a stop and not as a draft.
const statusTint: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700 border-slate-300',
  sent: 'bg-blue-50 text-blue-700 border-blue-300',
  order_confirmed: 'bg-green-50 text-green-700 border-green-300',
  advance_received: 'bg-green-50 text-green-700 border-green-300',
  in_production: 'bg-amber-50 text-amber-800 border-amber-300',
  cancelled: 'bg-red-50 text-red-700 border-red-300',
};

const label = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export default function ProformasPage() {
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
  const [creating, setCreating] = useState(false);
  const { data: proformas = [] } = useQuery({
    queryKey: ['proformas', statusFilter, exportFilter, companyFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (exportFilter) params.set('export', exportFilter);
      if (companyFilter) params.set('company', companyFilter);
      return api.get<Proforma[]>(`/api/proformas${params.toString() ? `?${params}` : ''}`);
    },
  });

  // Change status without opening the document. The server still owns the
  // approval rule — moving an unapproved proforma to an outgoing status comes
  // back as a 409, which surfaces above the table rather than failing silently.
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      api.post<Proforma>(`/api/proformas/${id}/status`, { status }),
    onSuccess: (p) => {
      queryClient.invalidateQueries({ queryKey: ['proformas'] });
      queryClient.invalidateQueries({ queryKey: ['proforma', String(p.id)] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['approval-count'] });
    },
  });

  return (
    <div>
      <PageHeader
        title="Proforma Invoices"
        subtitle="“This is what the final invoice will look like.”"
        actions={<Button onClick={() => setCreating(true)}>+ New Proforma Invoice</Button>}
      />
      {creating && <NewDocumentDialog basePath="/proformas" title="New Proforma Invoice" onClose={() => setCreating(false)} />}
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
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="max-w-52">
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{label(s)}</option>
          ))}
        </Select>
      </div>
      <ErrorText error={setStatus.error} />
      <Card className="overflow-x-auto">
        {proformas.length === 0 ? (
          <EmptyState message="No proforma invoices yet. Convert an accepted quotation, or create one directly." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-2 pr-3">Number</th>
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2 pr-3">Customer</th>
                {showCompany && <th className="pb-2 pr-3">Issued By</th>}
                <th className="pb-2 pr-3">Ref. Quotation</th>
                <th className="pb-2 pr-3 text-right">Total</th>
                <th className="pb-2 pr-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {proformas.map((p) => (
                <tr key={p.id} className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50" onClick={() => navigate(`/proformas/${p.id}`)}>
                  <td className="py-2 pr-3 font-medium text-brand-600"><Link to={`/proformas/${p.id}`}>{p.number}</Link></td>
                  <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(p.date)}</td>
                  <td className="py-2 pr-3">{p.customer_name}</td>
                  {showCompany && (
                    <td className="py-2 pr-3 text-xs text-slate-500">{p.company_name ?? "—"}</td>
                  )}
                  <td className="py-2 pr-3">{p.quotation_number || '—'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{fmtMoney(p.grand_total, p.currency)}</td>
                  {/* Editable in place — the click must not open the proforma. */}
                  <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                    <select
                      value={p.status}
                      disabled={setStatus.isPending}
                      onChange={(e) => {
                        setStatus.reset();
                        setStatus.mutate({ id: p.id, status: e.target.value });
                      }}
                      className={`cursor-pointer rounded-full border px-2 py-0.5 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:opacity-50 ${statusTint[p.status] ?? 'bg-slate-100 text-slate-600 border-slate-300'}`}
                      title="Change status"
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s} className="bg-white text-slate-800">{label(s)}</option>
                      ))}
                    </select>
                    {p.approval_status === 'pending' && (
                      <span className="ml-1 text-xs text-amber-700" title="Awaiting manager approval">⏳</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
