import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Quotation } from '../types';
import { Button, Select, PageHeader, EmptyState, Card, ExportTabs, ErrorText } from '../components/ui';
import NewDocumentDialog from '../components/NewDocumentDialog';
import { fmtDate, fmtMoney } from '../lib/format';

const approvalBadge: Record<string, { cls: string; label: string }> = {
  pending: { cls: 'bg-amber-100 text-amber-700', label: 'Awaiting approval' },
  rejected: { cls: 'bg-red-100 text-red-700', label: 'Rejected' },
  not_submitted: { cls: 'bg-slate-100 text-slate-500', label: 'Not submitted' },
};

const STATUSES = ['draft', 'sent', 'negotiating', 'accepted', 'rejected', 'expired'];

// Tint the inline picker so the list still reads at a glance, like the badge did.
const statusTint: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700 border-slate-300',
  sent: 'bg-blue-50 text-blue-700 border-blue-300',
  negotiating: 'bg-amber-50 text-amber-800 border-amber-300',
  accepted: 'bg-green-50 text-green-700 border-green-300',
  rejected: 'bg-red-50 text-red-700 border-red-300',
  expired: 'bg-slate-100 text-slate-500 border-slate-300',
};

export default function QuotationsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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

  // Change status without leaving the list. The server still enforces the
  // approval rule, so a blocked change surfaces as an error here.
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      api.post<Quotation>(`/api/quotations/${id}/status`, { status }),
    onSuccess: (q) => {
      queryClient.invalidateQueries({ queryKey: ['quotations'] });
      queryClient.invalidateQueries({ queryKey: ['quotation', String(q.id)] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['approval-count'] });
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
      <ErrorText error={setStatus.error} />
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
                  {/* Editable in place — the click must not open the quotation. */}
                  <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                    <select
                      value={q.status}
                      disabled={setStatus.isPending}
                      onChange={(e) => {
                        setStatus.reset();
                        setStatus.mutate({ id: q.id, status: e.target.value });
                      }}
                      className={`cursor-pointer rounded-full border px-2 py-0.5 text-xs font-medium capitalize focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:opacity-50 ${statusTint[q.status] ?? 'bg-slate-100 text-slate-600 border-slate-300'}`}
                      title="Change status"
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s} className="bg-white text-slate-800">
                          {s[0].toUpperCase() + s.slice(1)}
                        </option>
                      ))}
                    </select>
                  </td>
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
