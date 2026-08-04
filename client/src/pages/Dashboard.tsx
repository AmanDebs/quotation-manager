import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { api } from '../api/client';
import type { Followup } from '../types';
import { useIsManager } from '../App';
import { Card, Select, PageHeader } from '../components/ui';
import { ORDER_STATUSES, orderStatusLabel } from './Orders';
import { fmtDate, fmtMoney, today } from '../lib/format';

/* Chart colors from the validated reference palette (light mode) */
const SERIES_1 = '#2a78d6'; // blue — quoted / primary series
const SERIES_2 = '#008300'; // green — invoiced
const FUNNEL_STEPS = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab']; // ordinal blue ramp
const GRID = '#e1e0d9';
const MUTED = '#898781';

const AGE_BUCKETS = ['0-30', '31-60', '61-90', '90+'];

interface DashboardData {
  counts: { quotations: number; orders: number; invoices: number; pendingApprovals: number };
  quotationsByStatus: { status: string; count: number }[];
  ordersByStatus: { status: string; count: number; total: number; currency: string }[];
  businessSplit: { is_export: number; currency: string; count: number; total: number }[];
  quotedByMonth: { month: string; currency: string; total: number }[];
  invoicedByMonth: { month: string; currency: string; total: number }[];
  topCustomers: { name: string; currency: string; total: number; quotes: number }[];
  topCustomersInvoiced: { name: string; currency: string; total: number; invoices: number }[];
  topProducts: { name: string; times_quoted: number }[];
  currencyTotals: { currency: string; accepted_value: number; quoted_value: number }[];
  followups: { overdue: Followup[]; today: Followup[]; upcoming: Followup[] };
  funnel: { quoted: number; accepted: number; orders: number; invoiced: number };
  receivables: { currency: string; invoiced: number; received: number; outstanding: number }[];
  receivablesAgeing: { currency: string; bucket: string; outstanding: number; count: number }[];
  orderBook: { currency: string; open_value: number; pending_value: number; count: number }[];
  overdueOrders: number;
  attention: {
    overdueFollowups: number; followupsToday: number; overdueOrders: number;
    overdueInvoices: number; pendingApprovals: number; expiringQuotations: number;
  };
}

const RANGES = [
  { label: 'This month', from: () => today().slice(0, 8) + '01' },
  { label: 'Last 3 months', from: () => { const d = new Date(); d.setMonth(d.getMonth() - 3); return d.toISOString().slice(0, 10); } },
  { label: 'This year', from: () => today().slice(0, 5) + '01-01' },
  { label: 'All time', from: () => '' },
];

/** One clickable alert. Only rendered when the count is non-zero. */
function AttentionChip({ to, count, label, tone }: { to: string; count: number; label: string; tone: 'red' | 'amber' }) {
  if (!count) return null;
  const styles = tone === 'red'
    ? 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
    : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100';
  return (
    <Link to={to} className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors ${styles}`}>
      <span className="text-base font-bold tabular-nums">{count}</span>
      <span>{label}</span>
    </Link>
  );
}

/** A headline number with its unit and a one-line explanation underneath. */
function MoneyTile({ label, value, currency, note, tone = 'plain', to }: {
  label: string; value: number; currency: string; note?: string; tone?: 'plain' | 'warn' | 'good'; to: string;
}) {
  const valueCls = tone === 'warn' ? 'text-red-600' : tone === 'good' ? 'text-green-700' : 'text-slate-800';
  return (
    <Link to={to} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${valueCls}`}>{fmtMoney(value, currency)}</div>
      {note && <div className="mt-0.5 text-xs text-slate-400">{note}</div>}
    </Link>
  );
}

export default function DashboardPage() {
  const isManager = useIsManager();
  const queryClient = useQueryClient();
  const [rangeIdx, setRangeIdx] = useState(3);
  const [currency, setCurrency] = useState('');
  const [customerBasis, setCustomerBasis] = useState<'invoiced' | 'quoted'>('invoiced');

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

  // Every currency that appears anywhere, so the selector covers the whole page.
  const currencies = useMemo(() => {
    const set = new Set<string>();
    data?.quotedByMonth.forEach((r) => set.add(r.currency));
    data?.invoicedByMonth.forEach((r) => set.add(r.currency));
    data?.receivables.forEach((r) => set.add(r.currency));
    data?.orderBook.forEach((r) => set.add(r.currency));
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

  // Production pipeline: how many orders sit at each stage, and what they're worth.
  const pipeline = useMemo(() => {
    if (!data) return [];
    return ORDER_STATUSES.filter((s) => s !== 'cancelled').map((status) => {
      const rows = data.ordersByStatus.filter((r) => r.status === status);
      return {
        status,
        count: rows.reduce((s, r) => s + r.count, 0),
        value: rows.filter((r) => r.currency === activeCurrency).reduce((s, r) => s + (r.total ?? 0), 0),
      };
    });
  }, [data, activeCurrency]);

  if (!data) return <div className="text-slate-400">Loading dashboard…</div>;

  const funnelStages = [
    { label: 'Quoted', value: data.funnel.quoted },
    { label: 'Accepted', value: data.funnel.accepted },
    { label: 'Orders', value: data.funnel.orders },
    { label: 'Invoiced', value: data.funnel.invoiced },
  ];
  const funnelMax = Math.max(1, ...funnelStages.map((s) => s.value));
  const pipelineMax = Math.max(1, ...pipeline.map((s) => s.count));

  const pendingCount = data.followups.overdue.length + data.followups.today.length;
  // Defensive: a response from an older server build would lack these.
  const a = data.attention ?? {
    overdueFollowups: 0, followupsToday: 0, overdueOrders: 0,
    overdueInvoices: 0, pendingApprovals: 0, expiringQuotations: 0,
  };
  const attentionTotal = a.overdueFollowups + a.followupsToday + a.overdueOrders + a.overdueInvoices
    + a.expiringQuotations + (isManager ? a.pendingApprovals : 0);

  // Headline money, all in the selected currency.
  const cur = activeCurrency;
  const book = data.orderBook.find((r) => r.currency === cur);
  const recv = data.receivables.find((r) => r.currency === cur);
  const quotedPeriod = monthlyRows.reduce((s, r) => s + r.quoted, 0);
  const invoicedPeriod = monthlyRows.reduce((s, r) => s + r.invoiced, 0);

  const ageingFor = (c: string, bucket: string) =>
    data.receivablesAgeing.find((r) => r.currency === c && r.bucket === bucket)?.outstanding ?? 0;
  const ageingCurrencies = [...new Set(data.receivablesAgeing.map((r) => r.currency))].sort();

  const splitRows = data.businessSplit.filter((r) => r.currency === cur);
  const splitTotal = splitRows.reduce((s, r) => s + (r.total ?? 0), 0);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Your order-to-dispatch pipeline at a glance"
        actions={
          <div className="flex gap-2">
            {currencies.length > 1 && (
              <Select value={activeCurrency} onChange={(e) => setCurrency(e.target.value)} className="w-24" title="Currency for all money figures">
                {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            )}
            <Select value={rangeIdx} onChange={(e) => setRangeIdx(Number(e.target.value))} className="w-40">
              {RANGES.map((r, i) => <option key={r.label} value={i}>{r.label}</option>)}
            </Select>
          </div>
        }
      />

      {/* What needs a human today — ahead of everything else, and never filtered
          by the date range, because an old overdue item is the most urgent kind. */}
      <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Needs attention</div>
        {attentionTotal === 0 ? (
          <p className="text-sm text-slate-400">Nothing overdue. Follow-ups, orders and approvals are all up to date.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <AttentionChip to="/followups" count={a.overdueFollowups} label="follow-ups overdue" tone="red" />
            <AttentionChip to="/orders" count={a.overdueOrders} label="orders past promised date" tone="red" />
            <AttentionChip to="/invoices" count={a.overdueInvoices} label="invoices unpaid over 60 days" tone="red" />
            <AttentionChip to="/followups" count={a.followupsToday} label="follow-ups due today" tone="amber" />
            <AttentionChip to="/quotations" count={a.expiringQuotations} label="quotations past validity" tone="amber" />
            {isManager && <AttentionChip to="/approvals" count={a.pendingApprovals} label="awaiting your approval" tone="amber" />}
          </div>
        )}
      </div>

      {/* Money headlines */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MoneyTile
          to="/orders"
          label="Still to ship"
          value={book?.pending_value ?? 0}
          currency={cur}
          note={`${book?.count ?? 0} open order${book?.count === 1 ? '' : 's'} in the book`}
        />
        <MoneyTile
          to="/invoices"
          label="Outstanding"
          value={recv?.outstanding ?? 0}
          currency={cur}
          tone={(recv?.outstanding ?? 0) > 0 ? 'warn' : 'good'}
          note={a.overdueInvoices ? `${a.overdueInvoices} invoice${a.overdueInvoices === 1 ? '' : 's'} over 60 days old` : 'nothing older than 60 days'}
        />
        <MoneyTile
          to="/invoices"
          label={`Invoiced · ${RANGES[rangeIdx].label.toLowerCase()}`}
          value={invoicedPeriod}
          currency={cur}
          tone="good"
          note={`${data.counts.invoices} invoice${data.counts.invoices === 1 ? '' : 's'} raised`}
        />
        <MoneyTile
          to="/quotations"
          label={`Quoted · ${RANGES[rangeIdx].label.toLowerCase()}`}
          value={quotedPeriod}
          currency={cur}
          note={`${data.counts.quotations} quotation${data.counts.quotations === 1 ? '' : 's'} · ${data.counts.orders} order${data.counts.orders === 1 ? '' : 's'}`}
        />
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

        {/* Production pipeline */}
        <Card
          title="Production Pipeline"
          actions={<Link to="/orders" className="text-xs text-brand-600 hover:underline">View orders</Link>}
        >
          {pipeline.every((s) => s.count === 0) ? (
            <p className="py-6 text-center text-sm text-slate-400">No orders in this period. Book one from an accepted quotation.</p>
          ) : (
            <div className="space-y-1">
              {pipeline.map((s) => (
                <div key={s.status} className="flex items-center gap-2 text-sm">
                  <span className="w-32 shrink-0 text-xs text-slate-500">{orderStatusLabel(s.status)}</span>
                  <div className="h-5 flex-1 rounded-sm bg-slate-50">
                    <div
                      className="h-5 rounded-sm"
                      style={{ width: `${(s.count / pipelineMax) * 100}%`, backgroundColor: SERIES_1, opacity: s.count ? 1 : 0 }}
                    />
                  </div>
                  <span className="w-6 shrink-0 text-right text-xs font-semibold tabular-nums text-slate-700">{s.count}</span>
                  <span className="w-28 shrink-0 text-right text-xs tabular-nums text-slate-400">
                    {s.value ? fmtMoney(s.value, cur) : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Quoted vs invoiced by month */}
        <Card title={`Quoted vs Invoiced Value (${cur})`}>
          {monthlyRows.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">No documents in this period yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={monthlyRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="0" stroke={GRID} vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: MUTED }} axisLine={{ stroke: GRID }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: MUTED }} axisLine={false} tickLine={false} tickFormatter={(v: number) => Intl.NumberFormat('en', { notation: 'compact' }).format(v)} />
                <Tooltip cursor={{ fill: 'rgba(0,0,0,0.04)' }} formatter={(v: number) => fmtMoney(v, cur)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="quoted" name="Quoted" fill={SERIES_1} radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Bar dataKey="invoiced" name="Invoiced" fill={SERIES_2} radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        {/* Receivables ageing */}
        <Card title="Receivables Ageing (by invoice age, all time)">
          {ageingCurrencies.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">Nothing outstanding — every invoice is settled.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="pb-1 pr-3">Currency</th>
                  {AGE_BUCKETS.map((b) => (
                    <th key={b} className={`pb-1 pr-3 text-right ${b === '90+' ? 'text-red-600' : ''}`}>{b} days</th>
                  ))}
                  <th className="pb-1 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {ageingCurrencies.map((c) => {
                  const cells = AGE_BUCKETS.map((b) => ageingFor(c, b));
                  const total = cells.reduce((s, v) => s + v, 0);
                  return (
                    <tr key={c} className="border-b border-slate-100 last:border-0">
                      <td className="py-1.5 pr-3 font-medium">{c}</td>
                      {cells.map((v, i) => (
                        <td
                          key={AGE_BUCKETS[i]}
                          className={`py-1.5 pr-3 text-right tabular-nums ${
                            !v ? 'text-slate-300' : i === 3 ? 'font-semibold text-red-600' : i === 2 ? 'text-amber-700' : 'text-slate-700'
                          }`}
                        >
                          {v ? fmtMoney(v, c) : '—'}
                        </td>
                      ))}
                      <td className="py-1.5 text-right font-semibold tabular-nums">{fmtMoney(total, c)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-xs text-slate-400">Age is counted from the invoice date. Chase the right-hand columns first.</p>
        </Card>

        {/* Order book */}
        <Card
          title={`Order Book${data.overdueOrders ? ` — ${data.overdueOrders} overdue` : ''}`}
          actions={<Link to="/orders" className="text-xs text-brand-600 hover:underline">View orders</Link>}
        >
          {data.orderBook.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">No open orders. Book one from an accepted quotation.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="pb-1 pr-3">Currency</th>
                  <th className="pb-1 pr-3 text-right">Open Orders</th>
                  <th className="pb-1 pr-3 text-right">Order Value</th>
                  <th className="pb-1 text-right">Still to Ship</th>
                </tr>
              </thead>
              <tbody>
                {data.orderBook.map((r) => (
                  <tr key={r.currency} className="border-b border-slate-100 last:border-0">
                    <td className="py-1.5 pr-3 font-medium">{r.currency}</td>
                    <td className="py-1.5 pr-3 text-right">{r.count}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{fmtMoney(r.open_value, r.currency)}</td>
                    <td className="py-1.5 text-right tabular-nums font-semibold text-amber-700">{fmtMoney(r.pending_value, r.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!!data.overdueOrders && (
            <p className="mt-2 text-xs text-red-600">
              ⚠ {data.overdueOrders} order{data.overdueOrders === 1 ? '' : 's'} past the promised despatch date.
            </p>
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
          <p className="mt-2 text-xs text-slate-400">Advances taken on a proforma are credited to the shipments raised against it.</p>
        </Card>

        {/* Export vs domestic */}
        <Card title={`Export vs Domestic — invoiced (${cur})`}>
          {splitRows.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">No invoices in this period.</p>
          ) : (
            <div className="space-y-3">
              {[1, 0].map((isExport) => {
                const row = splitRows.find((r) => r.is_export === isExport);
                const total = row?.total ?? 0;
                const pct = splitTotal ? Math.round((total / splitTotal) * 100) : 0;
                return (
                  <div key={isExport}>
                    <div className="mb-1 flex items-baseline justify-between text-sm">
                      <span>{isExport ? '🌍 Export' : '🇮🇳 Domestic'}</span>
                      <span className="tabular-nums">
                        <span className="font-semibold">{fmtMoney(total, cur)}</span>
                        <span className="ml-2 text-xs text-slate-400">{row?.count ?? 0} invoice{row?.count === 1 ? '' : 's'} · {pct}%</span>
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-slate-100">
                      <div className="h-2 rounded-full" style={{ width: `${pct}%`, backgroundColor: isExport ? SERIES_1 : SERIES_2 }} />
                    </div>
                  </div>
                );
              })}
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

        {/* Top customers — invoiced by default, since that is real business */}
        <Card
          title="Top Customers"
          actions={
            <Select value={customerBasis} onChange={(e) => setCustomerBasis(e.target.value as 'invoiced' | 'quoted')} className="w-28">
              <option value="invoiced">Invoiced</option>
              <option value="quoted">Quoted</option>
            </Select>
          }
        >
          {(customerBasis === 'invoiced' ? data.topCustomersInvoiced : data.topCustomers).length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">
              {customerBasis === 'invoiced' ? 'No invoices in this period.' : 'No quotations in this period.'}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="pb-1 pr-3">Customer</th>
                  <th className="pb-1 pr-3 text-right">{customerBasis === 'invoiced' ? 'Invoices' : 'Quotes'}</th>
                  <th className="pb-1 text-right">{customerBasis === 'invoiced' ? 'Invoiced Value' : 'Quoted Value'}</th>
                </tr>
              </thead>
              <tbody>
                {customerBasis === 'invoiced'
                  ? data.topCustomersInvoiced.map((c, i) => (
                      <tr key={i} className="border-b border-slate-100 last:border-0">
                        <td className="py-1.5 pr-3">{c.name}</td>
                        <td className="py-1.5 pr-3 text-right">{c.invoices}</td>
                        <td className="py-1.5 text-right tabular-nums">{fmtMoney(c.total, c.currency)}</td>
                      </tr>
                    ))
                  : data.topCustomers.map((c, i) => (
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
