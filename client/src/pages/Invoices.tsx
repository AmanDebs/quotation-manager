import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Invoice } from '../types';
import { Button, Select, PageHeader, EmptyState, Card, StatusBadge, ExportTabs } from '../components/ui';
import { useCompanies } from '../components/CompanySelect';
import NewDocumentDialog from '../components/NewDocumentDialog';
import { fmtDate, fmtMoney } from '../lib/format';

export default function InvoicesPage() {
  // Only worth a column once the group has more than one entity.
  const companies = useCompanies();
  const showCompany = companies.length > 1;
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState('');
  const [exportFilter, setExportFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const { data: invoices = [] } = useQuery({
    queryKey: ['invoices', statusFilter, exportFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (exportFilter) params.set('export', exportFilter);
      return api.get<Invoice[]>(`/api/invoices${params.toString() ? `?${params}` : ''}`);
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
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="max-w-45">
          <option value="">All statuses</option>
          {['draft', 'final', 'dispatched', 'paid'].map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
        </Select>
      </div>
      <Card className="overflow-x-auto">
        {invoices.length === 0 ? (
          <EmptyState message="No commercial invoices yet. Create one from a confirmed proforma invoice at dispatch time." />
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
                  <td className="py-2 pr-3">
                    <StatusBadge status={inv.status} />
                    {inv.approval_status === 'pending' && <span className="ml-1 text-xs text-amber-700">⏳</span>}
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
