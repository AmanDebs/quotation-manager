import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Despatch, Location } from '../types';
import { PageHeader, Card, Select, Input, EmptyState , Pagination} from '../components/ui';
import { fmtQty, fmtDate } from '../lib/format';
import { usePagedList, PAGE_SIZE } from '../lib/usePagedList';

/**
 * The despatch register — the order desk's own sheet, roughly 465 lines a
 * month, with one column it could not have: which of these have not been
 * billed yet.
 */
export default function DespatchesPage() {
  const [location, setLocation] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [uninvoiced, setUninvoiced] = useState(false);

  const query = new URLSearchParams();
  if (location) query.set('location_id', location);
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  if (uninvoiced) query.set('uninvoiced', '1');

  const list = usePagedList<Despatch, { trips: number; pieces: number; boxes: number; unbilled: number }>(['despatches', 'all', query.toString()], `/api/despatches?${query.toString()}`);
  const trips = list.rows;
  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });

  // Over every matching despatch, not the page on screen — see `summary` in
  // routes/despatches.ts.
  const totals = list.summary ?? { trips: trips.length, pieces: 0, boxes: 0, unbilled: 0 };

  return (
    <div>
      <PageHeader title="Despatches" subtitle="What has left the plants, and what has not been billed yet" />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select className="w-44" value={location} onChange={(e) => setLocation(e.target.value)}>
          <option value="">All plants</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
        <Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-sm text-slate-400">to</span>
        <Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} />
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={uninvoiced} onChange={(e) => setUninvoiced(e.target.checked)} />
          Not billed yet
        </label>
        <span className="ml-auto text-sm text-slate-500">
          {totals.trips} despatch{totals.trips === 1 ? '' : 'es'} · {fmtQty(totals.pieces)} pcs · {fmtQty(totals.boxes)} boxes
          {totals.unbilled > 0 && <span className="ml-2 text-amber-700">{totals.unbilled} unbilled</span>}
        </span>
      </div>

      <Card className="overflow-x-auto">
        {trips.length === 0 ? (
          <EmptyState message="Nothing recorded. Despatches are entered from an order's Dispatch tab." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2 pr-3">From</th>
                <th className="pb-2 pr-3">Order</th>
                <th className="pb-2 pr-3">Customer</th>
                <th className="pb-2 pr-3">Destination</th>
                <th className="pb-2 pr-3">Transporter</th>
                <th className="pb-2 pr-3">CN / vehicle</th>
                <th className="pb-2 pr-3 text-right">Pieces</th>
                <th className="pb-2 pr-3 text-right">Boxes</th>
                <th className="pb-2 pr-3">Invoice</th>
              </tr>
            </thead>
            <tbody>
              {trips.map((d) => {
                const pieces = (d.items ?? []).reduce((s, it) => s + (it.qty ?? 0), 0);
                const boxes = (d.items ?? []).reduce((s, it) => s + (it.packs ?? 0), 0);
                return (
                  <tr key={d.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="py-2 pr-3">{fmtDate(d.date)}</td>
                    <td className="py-2 pr-3 text-slate-500">{d.location_name ?? '—'}</td>
                    <td className="py-2 pr-3">
                      <Link to={`/orders/${d.order_id}`} className="text-brand-600 hover:underline">{d.order_number}</Link>
                    </td>
                    <td className="py-2 pr-3">{d.customer_name}</td>
                    <td className="py-2 pr-3">{d.destination || '—'}</td>
                    <td className="py-2 pr-3">{d.transporter_name ?? '—'}</td>
                    <td className="py-2 pr-3 text-xs text-slate-500">
                      {[d.cn_no, d.vehicle_no].filter(Boolean).join(' · ') || '—'}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{pieces ? fmtQty(pieces) : '—'}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{boxes ? fmtQty(boxes) : '—'}</td>
                    <td className="py-2 pr-3">
                      {d.invoice_number
                        ? <span className="text-slate-600">{d.invoice_number}</span>
                        : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">not billed</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <Pagination
          page={list.page} pages={list.pages} total={list.total} limit={PAGE_SIZE}
          onPage={list.setPage} noun="despatches"
        />
      </Card>
    </div>
  );
}
