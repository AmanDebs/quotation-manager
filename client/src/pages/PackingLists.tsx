import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { PackingList } from '../types';
import { Button, PageHeader, EmptyState, Card } from '../components/ui';
import { fmtDate, fmtQty } from '../lib/format';

export default function PackingListsPage() {
  const navigate = useNavigate();
  const { data: lists = [] } = useQuery({ queryKey: ['packing-lists'], queryFn: () => api.get<PackingList[]>('/api/packing-lists') });

  return (
    <div>
      <PageHeader
        title="Packing Lists"
        subtitle="“This is what is inside each package.”"
        actions={<Button onClick={() => navigate('/packing-lists/new')}>+ New Packing List</Button>}
      />
      <Card className="overflow-x-auto">
        {lists.length === 0 ? (
          <EmptyState message="No packing lists yet. Create one from a commercial invoice at dispatch." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-2 pr-3">Number</th>
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2 pr-3">Customer</th>
                <th className="pb-2 pr-3">Ref. Invoice</th>
              </tr>
            </thead>
            <tbody>
              {lists.map((pl) => (
                <tr key={pl.id} className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50" onClick={() => navigate(`/packing-lists/${pl.id}`)}>
                  <td className="py-2 pr-3 font-medium text-brand-600"><Link to={`/packing-lists/${pl.id}`}>{pl.number}</Link></td>
                  <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(pl.date)}</td>
                  <td className="py-2 pr-3">{pl.customer_name}</td>
                  <td className="py-2 pr-3">{pl.invoice_number || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
