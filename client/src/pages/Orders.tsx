import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Order, OrderStatus } from '../types';
import { Button, Select, PageHeader, EmptyState, Card, ExportTabs, ErrorText } from '../components/ui';
import { useCompanies } from '../components/CompanySelect';
import { fmtDate, fmtMoney, today } from '../lib/format';

export const ORDER_STATUSES: OrderStatus[] = [
  'pending', 'confirmed', 'scheduled', 'in_production', 'ready', 'partially_dispatched', 'completed', 'cancelled',
];

export const orderStatusLabel = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const statusTint: Record<string, string> = {
  pending: 'bg-slate-100 text-slate-700 border-slate-300',
  confirmed: 'bg-blue-50 text-blue-700 border-blue-300',
  scheduled: 'bg-indigo-50 text-indigo-700 border-indigo-300',
  in_production: 'bg-purple-50 text-purple-700 border-purple-300',
  ready: 'bg-teal-50 text-teal-700 border-teal-300',
  partially_dispatched: 'bg-amber-50 text-amber-800 border-amber-300',
  completed: 'bg-green-50 text-green-700 border-green-300',
  cancelled: 'bg-red-50 text-red-700 border-red-300',
};

export default function OrdersPage() {
  // Only worth a column once the group has more than one entity.
  const companies = useCompanies();
  const showCompany = companies.length > 1;
  const [companyFilter, setCompanyFilter] = useState('');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('');
  const [exportFilter, setExportFilter] = useState('');
  const [openOnly, setOpenOnly] = useState(false);

  const { data: orders = [] } = useQuery({
    queryKey: ['orders', statusFilter, exportFilter, openOnly, companyFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (exportFilter) params.set('export', exportFilter);
      if (companyFilter) params.set('company', companyFilter);
      if (openOnly) params.set('open', '1');
      return api.get<Order[]>(`/api/orders${params.toString() ? `?${params}` : ''}`);
    },
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => api.post<Order>(`/api/orders/${id}/status`, { status }),
    onSuccess: (o) => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['order', String(o.id)] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const t = today();
  const isOverdue = (o: Order) =>
    !!o.promised_date && o.promised_date < t && !['completed', 'cancelled'].includes(o.status);

  return (
    <div>
      <PageHeader
        title="Orders"
        subtitle="The order book — what's sold, what's in production, what's still to ship"
        actions={<Button onClick={() => navigate('/orders/new')}>+ New Order</Button>}
      />
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
          {ORDER_STATUSES.map((s) => <option key={s} value={s}>{orderStatusLabel(s)}</option>)}
        </Select>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
          Open orders only
        </label>
      </div>
      <ErrorText error={setStatus.error} />
      <Card className="overflow-x-auto">
        {orders.length === 0 ? (
          <EmptyState message="No orders yet. Book one from an accepted quotation, or create it directly." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-2 pr-3">Order No.</th>
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2 pr-3">Customer</th>
                {showCompany && <th className="pb-2 pr-3">Issued By</th>}
                <th className="pb-2 pr-3">Their PO</th>
                <th className="pb-2 pr-3">Promised</th>
                <th className="pb-2 pr-3 text-right">Value</th>
                <th className="pb-2 pr-3 text-right">Pending</th>
                <th className="pb-2 pr-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50" onClick={() => navigate(`/orders/${o.id}`)}>
                  <td className="py-2 pr-3 font-medium text-brand-600">
                    <Link to={`/orders/${o.id}`}>{o.number}</Link>
                    <span className="ml-1 text-xs text-slate-400">{o.is_export ? '🌍' : '🇮🇳'}</span>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(o.date)}</td>
                  <td className="py-2 pr-3">{o.customer_name}</td>
                  {showCompany && (
                    <td className="py-2 pr-3 text-xs text-slate-500">{o.company_name ?? "—"}</td>
                  )}
                  <td className="py-2 pr-3">{o.po_number || '—'}</td>
                  <td className={`py-2 pr-3 whitespace-nowrap ${isOverdue(o) ? 'font-semibold text-red-600' : ''}`}>
                    {fmtDate(o.promised_date)}{isOverdue(o) && ' ⚠'}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{fmtMoney(o.grand_total, o.currency)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {o.pending_value ? (
                      <span className="text-amber-700">{fmtMoney(o.pending_value, o.currency)}</span>
                    ) : (
                      <span className="text-green-700">shipped</span>
                    )}
                  </td>
                  {/* Editable in place, like the quotations list. */}
                  <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                    <select
                      value={o.status}
                      disabled={setStatus.isPending}
                      onChange={(e) => { setStatus.reset(); setStatus.mutate({ id: o.id, status: e.target.value }); }}
                      className={`cursor-pointer rounded-full border px-2 py-0.5 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:opacity-50 ${statusTint[o.status] ?? 'bg-slate-100 text-slate-600 border-slate-300'}`}
                      title="Change status"
                    >
                      {ORDER_STATUSES.map((s) => (
                        <option key={s} value={s} className="bg-white text-slate-800">{orderStatusLabel(s)}</option>
                      ))}
                    </select>
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
