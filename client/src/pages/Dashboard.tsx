import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { api } from '../api/client';
import type { Followup } from '../types';
import { Card, Select, PageHeader } from '../components/ui';
import { fmtDate, fmtMoney, today } from '../lib/format';

/* Chart colors from the validated reference palette (light mode) */
const SERIES_1 = '#2a78d6'; // blue — quoted / primary series
const SERIES_2 = '#008300'; // green — invoiced
const FUNNEL_STEPS = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab']; // ordinal blue ramp
const GRID = '#e1e0d9';
const MUTED = '#898781';

interface DashboardData {
  counts: { enquiries: number; quotations: number; orders: number; invoices: number };
  quotationsByStatus: { status: string; count: number }[];
  quotedByMonth: { month: string; currency: string; total: number }[];
  invoicedByMonth: { month: string; currency: string; total: number }[];
  topCustomers: { name: string; currency: string; total: number; quotes: number }[];
  topProducts: { name: string; times_quoted: number }[];
  currencyTotals: { currency: string; accepted_value: number; quoted_value: number }[];
  followups: { overdue: Followup[]; today: Followup[]; upcoming: Followup[] };
  funnel: { enquiries: number; quoted: number; accepted: number; invoiced: number };
  receivables: { currency: string; invoiced: number; received: number; outstanding: number }[];
}

const RANGES = [
  { label: 'This month', from: () => today().slice(0, 8) + '01' },
  { label: 'Last 3 months', from: () => { const d = new Date(); d.setMonth(d.getMonth() - 3); return d.toISOString().slice(0, 10); } },
  { label: 'This year', from: () => today().slice(0, 5) + '01-01' },
  { label: 'All time', from: () => '' },
];

export default function DashboardPage() {
  const queryClient = useQueryClient();
  const [rangeIdx, setRangeIdx] = useState(3);
  const [currency, setCurrency] = useState('');

  const from = RANGES[rangeIdx].from();
  const { data } = useQuery({
    queryKey: ['dashboard', from],
    queryFn: () => api.get<DashboardData>(`/api/dashboard${from ? `?from=${from}` : ''}`),
  });

  const markDone = useMutation({
    mutationFn: (id: number) => api.put(`/api/followups/${id}`, { done: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['followups'] });
    },
  });

  const currencies = useMemo(() => {
    const set = new Set<string>();
    data?.quotedByMonth.forEach((r) => set.add(r.currency));
    data?.invoicedByMonth.forEach((r) => set.add(r.currency));
    return [...set].sort();
  }, [data]);

  const activeCurrency = currency || currencies[0] || 'INR';

  const monthlyRows = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, { month: string; quoted: number; invoiced: number }>();
    for (const r of data.quotedByMonth.filter((r) => r.currency === activeCurrency)) {
      map.set(r.month, { month: r.month, quoted: r.total, invoiced: 0 });
    }
    for (const r of data.invoicedByMonth.filter((r) => r.currency === activeCurrency)) {
      const row = map.get(r.month) ?? { month: r.month, quoted: 0, invoiced: 0 };
      row.invoiced = r.total;
      map.set(r.month, row);
    }
    return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
  }, [data, activeCurrency]);

  const statusRows = useMemo(() => {
    const order = ['draft', 'sent', 'negotiating', 'accepted', 'rejected', 'expired'];
    return order.map((s) => ({
      status: s.replace(/_/g, ' '),
      count: data?.quotationsByStatus.find((r) => r.status === s)?.count ?? 0,
    }));
  }, [data]);

  if (!data) return <div className="text-slate-400">Loading dashboard…</div>;

  const funnelStages = [
    { label: 'Enquiries', value: data.funnel.enquiries },
    { label: 'Quoted', value: data.funnel.quoted },
    { label: 'Accepted', value: data.funnel.accepted },
    { label: 'Invoiced', value: data.funnel.invoiced },
  ];
  const funnelMax = Math.max(1, ...funnelStages.map((s) => s.value));

  const pendingCount = data.followups.overdue.length + data.followups.today.length;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Your order-to-dispatch pipeline at a glance"
        actions={
          <div className="flex gap-2">
            <Select value={rangeIdx} onChange={(e) => setRangeIdx(Number(e.target.value))} className="w-40">
              {RANGES.map((r, i) => <option key={r.label} value={i}>{r.label}</option>)}
            </Select>
          </div>
        }
      />

      {/* Stat tiles */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: 'Enquiries', value: data.counts.enquiries, to: '/enquiries' },
          { label: 'Quotations', value: data.counts.quotations, to: '/quotations' },
          { label: 'Confirmed Orders', value: data.counts.orders, to: '/proformas' },
          { label: 'Invoices', value: data.counts.invoices, to: '/invoices' },
        ].map((t) => (
          <Link key={t.label} to={t.to} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow">
            <div className="text-3xl font-bold text-slate-800">{t.value}</div>
            <div className="mt-1 text-sm text-slate-500">{t.label}</div>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* Follow-ups */}
        <Card
          title={`Pending Follow-ups${pendingCount ? ` (${pendingCount} need attention)` : ''}`}
          actions={<Link to="/followups" className="text-xs text-brand-600 hover:underline">View all</Link>}
        >
          {data.followups.overdue.length === 0 && data.followups.today.length === 0 && data.followups.upcoming.length === 0 ? (
            <p className="text-sm text-slate-400">No pending follow-ups. Schedule them from any document so no customer slips through.</p>
          ) : (
            <div className="space-y-1.5 text-sm">
              {[
                { label: 'Overdue', rows: data.followups.overdue, cls: 'text-red-600' },
                { label: 'Today', rows: data.followups.today, cls: 'text-amber-600' },
                { label: 'Upcoming', rows: data.followups.upcoming.slice(0, 5), cls: 'text-slate-500' },
              ].map((group) =>
                group.rows.map((f) => (
                  <div key={f.id} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-slate-50">
                    <input type="checkbox" onChange={() => markDone.mutate(f.id)} title="Mark done" />
                    <span className={`w-24 shrink-0 text-xs font-semibold ${group.cls}`}>{group.label} · {fmtDate(f.due_date)}</span>
                    <span className="truncate">{f.customer_name ? `${f.customer_name}: ` : ''}{f.note || f.doc_type}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </Card>

        {/* Conversion funnel */}
        <Card title="Conversion Funnel">
          <div className="space-y-2">
            {funnelStages.map((s, i) => (
              <div key={s.label} className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-xs text-slate-500">{s.label}</span>
                <div className="h-6 flex-1 rounded-r-sm bg-slate-50">
                  <div
                    className="flex h-6 items-center rounded-r-sm pl-2"
                    style={{ width: `${Math.max(3, (s.value / funnelMax) * 100)}%`, backgroundColor: FUNNEL_STEPS[i] }}
                  >
                    <span className="text-xs font-semibold text-white">{s.value}</span>
                  </div>
                </div>
              </div>
            ))}
            <p className="pt-1 text-xs text-slate-400">
              Conversion: {data.funnel.quoted ? Math.round((data.funnel.accepted / data.funnel.quoted) * 100) : 0}% of quotations accepted
            </p>
          </div>
        </Card>

        {/* Quotations by status */}
        <Card title="Quotations by Status">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={statusRows} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="0" stroke={GRID} vertical={false} />
              <XAxis dataKey="status" tick={{ fontSize: 11, fill: MUTED }} axisLine={{ stroke: GRID }} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: MUTED }} axisLine={false} tickLine={false} />
              <Tooltip cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
              <Bar dataKey="count" name="Quotations" fill={SERIES_1} radius={[4, 4, 0, 0]} maxBarSize={40} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        {/* Quoted vs invoiced by month */}
        <Card
          title={`Quoted vs Invoiced Value (${activeCurrency})`}
          actions={
            currencies.length > 1 ? (
              <Select value={activeCurrency} onChange={(e) => setCurrency(e.target.value)} className="w-24">
                {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            ) : undefined
          }
        >
          {monthlyRows.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">No documents in this period yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={monthlyRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="0" stroke={GRID} vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: MUTED }} axisLine={{ stroke: GRID }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: MUTED }} axisLine={false} tickLine={false} tickFormatter={(v: number) => Intl.NumberFormat('en', { notation: 'compact' }).format(v)} />
                <Tooltip cursor={{ fill: 'rgba(0,0,0,0.04)' }} formatter={(v: number) => fmtMoney(v, activeCurrency)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="quoted" name="Quoted" fill={SERIES_1} radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Bar dataKey="invoiced" name="Invoiced" fill={SERIES_2} radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        {/* Receivables */}
        <Card title="Receivables (all invoices)">
          {data.receivables.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">No invoices yet — outstanding balances will appear here.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="pb-1 pr-3">Currency</th>
                  <th className="pb-1 pr-3 text-right">Invoiced</th>
                  <th className="pb-1 pr-3 text-right">Received</th>
                  <th className="pb-1 text-right">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {data.receivables.map((r) => (
                  <tr key={r.currency} className="border-b border-slate-100 last:border-0">
                    <td className="py-1.5 pr-3 font-medium">{r.currency}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{fmtMoney(r.invoiced, r.currency)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-green-700">{fmtMoney(r.received, r.currency)}</td>
                    <td className={`py-1.5 text-right tabular-nums font-semibold ${r.outstanding > 0 ? 'text-red-600' : 'text-green-700'}`}>
                      {fmtMoney(r.outstanding, r.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {/* Top customers */}
        <Card title="Top Customers (by quoted value)">
          {data.topCustomers.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">No quotations yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="pb-1 pr-3">Customer</th>
                  <th className="pb-1 pr-3 text-right">Quotes</th>
                  <th className="pb-1 text-right">Quoted Value</th>
                </tr>
              </thead>
              <tbody>
                {data.topCustomers.map((c, i) => (
                  <tr key={i} className="border-b border-slate-100 last:border-0">
                    <td className="py-1.5 pr-3">{c.name}</td>
                    <td className="py-1.5 pr-3 text-right">{c.quotes}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmtMoney(c.total, c.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {/* Top products */}
        <Card title="Most Quoted Products">
          {data.topProducts.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">No quotations yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="pb-1 pr-3">Product</th>
                  <th className="pb-1 text-right">Times Quoted</th>
                </tr>
              </thead>
              <tbody>
                {data.topProducts.map((p, i) => (
                  <tr key={i} className="border-b border-slate-100 last:border-0">
                    <td className="py-1.5 pr-3">{p.name}</td>
                    <td className="py-1.5 text-right">{p.times_quoted}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}
