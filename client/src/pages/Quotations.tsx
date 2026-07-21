import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Quotation } from '../types';
import { Button, Select, PageHeader, EmptyState, Card, StatusBadge } from '../components/ui';
import { fmtDate, fmtMoney } from '../lib/format';

export default function QuotationsPage() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState('');
  const { data: quotations = [] } = useQuery({
    queryKey: ['quotations', statusFilter],
    queryFn: () => api.get<Quotation[]>(`/api/quotations${statusFilter ? `?status=${statusFilter}` : ''}`),
  });

  return (
    <div>
      <PageHeader
        title="Quotations"
        subtitle="“This is our price.”"
        actions={<Button onClick={() => navigate('/quotations/new')}>+ New Quotation</Button>}
      />
      <div className="mb-3 max-w-45">
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
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
                <th className="pb-2 pr-3">Valid Until</th>
                <th className="pb-2 pr-3 text-right">Total</th>
                <th className="pb-2 pr-3">Status</th>
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
                  <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(q.validity_date)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{q.grand_total ? fmtMoney(q.grand_total, q.currency) : '—'}</td>
                  <td className="py-2 pr-3"><StatusBadge status={q.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
