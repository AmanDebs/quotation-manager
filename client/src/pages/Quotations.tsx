import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Quotation } from '../types';
import { Button, Select, PageHeader, EmptyState, Card, StatusBadge, ExportTabs } from '../components/ui';
import NewDocumentDialog from '../components/NewDocumentDialog';
import { fmtDate, fmtMoney } from '../lib/format';

const approvalBadge: Record<string, { cls: string; label: string }> = {
  pending: { cls: 'bg-amber-100 text-amber-700', label: 'Awaiting approval' },
  rejected: { cls: 'bg-red-100 text-red-700', label: 'Rejected' },
  not_submitted: { cls: 'bg-slate-100 text-slate-500', label: 'Not submitted' },
};

export default function QuotationsPage() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState('');
  const [exportFilter, setExportFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const { data: quotations = [] } = useQuery({
    queryKey: ['quotations', statusFilter, exportFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (exportFilter) params.set('export', exportFilter);
      return api.get<Quotation[]>(`/api/quotations${params.toString() ? `?${params}` : ''}`);
    },
  });

  return (
    <div>
      <PageHeader
        title="Quotations"
        subtitle="“This is our price.”"
        actions={<Button onClick={() => setCreating(true)}>+ New Quotation</Button>}
      />
      {creating && <NewDocumentDialog basePath="/quotations" title="New Quotation" onClose={() => setCreating(false)} />}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <ExportTabs value={exportFilter} onChange={setExportFilter} />
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="max-w-45">
          <option value="">All statuses</option>
          {['draft', 'sent', 'negotiating', 'accepted', 'rejected', 'expired'].map((s) => (
            <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>
          ))}
        </Select>
      </div>
      <Card className="overflow-x-auto">
        {quotations.length === 0 ? (
          <EmptyState message="No quotations yet. Create one from an enquiry or directly." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-2 pr-3">Number</th>
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2 pr-3">Customer</th>
                <th className="pb-2 pr-3">Type</th>
                <th className="pb-2 pr-3 text-right">Total</th>
                <th className="pb-2 pr-3">Status</th>
                <th className="pb-2 pr-3">Approval</th>
              </tr>
            </thead>
            <tbody>
              {quotations.map((q) => (
                <tr key={q.id} className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50" onClick={() => navigate(`/quotations/${q.id}`)}>
                  <td className="py-2 pr-3 font-medium text-brand-600">
                    <Link to={`/quotations/${q.id}`}>{q.number}{q.revision > 0 && <span className="text-slate-400"> R{q.revision}</span>}</Link>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(q.date)}</td>
                  <td className="py-2 pr-3">{q.customer_name}</td>
                  <td className="py-2 pr-3 text-xs">{q.is_export ? '🌍 Export' : '🇮🇳 Domestic'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{q.grand_total ? fmtMoney(q.grand_total, q.currency) : '—'}</td>
                  <td className="py-2 pr-3"><StatusBadge status={q.status} /></td>
                  <td className="py-2 pr-3">
                    {q.approval_status === 'approved' ? (
                      <span className="text-xs text-green-700">✓ Approved</span>
                    ) : (
                      <span className={`rounded-full px-2 py-0.5 text-xs ${approvalBadge[q.approval_status]?.cls ?? ''}`}>
                        {approvalBadge[q.approval_status]?.label ?? q.approval_status}
                      </span>
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
