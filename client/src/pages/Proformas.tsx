import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Proforma } from '../types';
import { Button, Select, PageHeader, EmptyState, Card, StatusBadge } from '../components/ui';
import { fmtDate, fmtMoney } from '../lib/format';

export default function ProformasPage() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState('');
  const { data: proformas = [] } = useQuery({
    queryKey: ['proformas', statusFilter],
    queryFn: () => api.get<Proforma[]>(`/api/proformas${statusFilter ? `?status=${statusFilter}` : ''}`),
  });

  return (
    <div>
      <PageHeader
        title="Proforma Invoices"
        subtitle="“This is what the final invoice will look like.”"
        actions={<Button onClick={() => navigate('/proformas/new')}>+ New Proforma Invoice</Button>}
      />
      <div className="mb-3 max-w-52">
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {['draft', 'sent', 'order_confirmed', 'advance_received', 'in_production', 'cancelled'].map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </Select>
      </div>
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
                  <td className="py-2 pr-3">{p.quotation_number || '—'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{fmtMoney(p.grand_total, p.currency)}</td>
                  <td className="py-2 pr-3"><StatusBadge status={p.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
