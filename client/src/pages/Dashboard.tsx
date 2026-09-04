import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { api } from '../api/client';
import type { Followup, DashboardLayout, WorkOrderStatus } from '../types';
import { useIsManager, useUser, usePatchUser } from '../App';
import { Button, Card, Input, Select, PageHeader, Modal, CAPTION_CLASS, TH_CLASS } from '../components/ui';
import { Icon } from '../components/icons';
import { useCompanies } from '../components/CompanySelect';
import { ORDER_STATUSES, orderStatusLabel } from './Orders';
import { STATUSES as QUOTATION_STATUSES, quotationStatusLabel } from './Quotations';
import { fmtDate, fmtMoney, fmtQty, today } from '../lib/format';

/* Chart colors from the validated reference palette (light mode) */
const SERIES_1 = '#2a78d6'; // blue — quoted / primary series
const SERIES_2 = '#008300'; // green — invoiced
// Cash collected: a tint of the invoiced green rather than a new hue, because
// it is the same money one step further along. The palette is deliberately
// small, and a third unrelated colour would read as a third unrelated thing.
const SERIES_3 = '#69b169';
const FUNNEL_STEPS = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab']; // ordinal blue ramp
const GRID = '#e1e0d9';
const MUTED = '#898781';

const AGE_BUCKETS = ['0-30', '31-60', '61-90', '90+'];

/* ------------------------------------------------------------------ *
 * Surfaces
 *
 * The dashboard is thirteen cards and six tables, and it had been growing its
 * own versions of things `components/ui.tsx` already owns: tiles with the old
 * card look beside real Cards with the new one, three bar charts with three
 * different tracks, and column headings in a fourth kind of small grey type.
 * These three strings are the whole of it — a caption, a table heading and an
 * empty state — so a figure here is captioned exactly like a value on a form.
 * ------------------------------------------------------------------ */

/**
 * Both live in `components/ui.tsx` now — the customers and products lists
 * wanted the same headings, and three copies of a treatment is two too many.
 */
const CAPTION = CAPTION_CLASS;
const TH = TH_CLASS;
/** Tighter than `EmptyState`: this is one card in a two-column grid, not a page. */
const EMPTY = 'py-6 text-center text-sm text-slate-400';

/*
 * Each table below also sits in its own `overflow-x-auto`, which the lists have
 * had all along and this page had not. Receivables Ageing is six money columns
 * and wants 452px; with nothing to scroll it, it pushed the card, the card
 * pushed `<main>`, and the whole app carried a horizontal scrollbar on a phone
 * — the exact thing `min-w-0` was put on `<main>` to prevent. Measured at
 * 375px: the document was 479px wide and is now 375. Nothing changes above
 * `sm`, where every one of the six fits and no scrollbar appears.
 */

const WORK_ORDER_STATUSES: WorkOrderStatus[] = ['planned', 'released', 'running', 'paused', 'done', 'cancelled'];

interface ShortMaterial {
  material_id: number; name: string; unit: string;
  required: number; on_hand: number; on_order: number; short: number;
}

interface DashboardData {
  counts: { quotations: number; orders: number; invoices: number; pendingApprovals: number };
  quotationsByStatus: { status: string; count: number }[];
  ordersByStatus: { status: string; count: number; total: number; currency: string }[];
  /**
   * The document counts of the tiles above, per currency. Optional so a server
   * that has not been redeployed yet reads as zero rather than NaN, the way the
   * factory counts are typed.
   */
  countsByCurrency?: { currency: string; quotations: number; orders: number; invoices: number }[];
  businessSplit: { is_export: number; currency: string; count: number; total: number }[];
  quotedByMonth: { month: string; currency: string; total: number }[];
  invoicedByMonth: { month: string; currency: string; total: number }[];
  receivedByMonth?: { month: string; currency: string; total: number }[];
  topCustomers: { name: string; currency: string; total: number; quotes: number }[];
  topCustomersInvoiced: { name: string; currency: string; total: number; invoices: number }[];
  topProducts: { name: string; times_quoted: number }[];
  currencyTotals: { currency: string; accepted_value: number; quoted_value: number }[];
  followups: { overdue: Followup[]; today: Followup[]; upcoming: Followup[] };
  funnel: { quoted: number; accepted: number; orders: number; invoiced: number };
  receivables: { currency: string; invoiced: number; received: number; outstanding: number; overdue?: number }[];
  receivablesAgeing: { currency: string; bucket: string; outstanding: number; count: number }[];
  orderBook: { currency: string; open_value: number; pending_value: number; count: number }[];
  overdueOrders: number;
  attention: {
    overdueFollowups: number; followupsToday: number; overdueOrders: number;
    overdueInvoices: number; pendingApprovals: number; expiringQuotations: number;
    // The factory side. Optional because a server that has not been redeployed
    // yet will not send them, and a NaN in the strip is worse than a zero.
    // Material figures are group-wide on purpose — the store is not any one
    // customer's, and a buyer needs the whole picture.
    overdueWorkOrders?: number; unbilledDespatches?: number;
    materialShort?: number; materialBelowReorder?: number;
  };
  // Optional for the same reason: an older server simply has no factory card.
  production?: {
    workOrdersByStatus: { status: string; count: number }[];
    piecesMade: number; piecesRejected: number; rejectRate: number | null;
    piecesDespatched: number; despatches: number;
    shortMaterials: ShortMaterial[];
  };
}

/* ------------------------------------------------------------------ *
 * Date range
 *
 * Both ends, not just the start. Sending only `from` meant "This month"
 * quietly included a proforma dated three months ahead, and there was no way
 * to look at a month that had finished. `to` is the end of the named period
 * rather than today: a whole month is a whole month.
 * ------------------------------------------------------------------ */

const iso = (d: Date) => {
  // Built locally, not via toISOString(): a date at local midnight goes back a
  // day in UTC anywhere east of Greenwich, which is where this app runs.
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const monthStart = (offset = 0) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset); return iso(d); };
const monthEnd = (offset = 0) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset + 1); d.setDate(0); return iso(d); };

interface Range { key: string; label: string; from: () => string; to: () => string }

const RANGES: Range[] = [
  { key: 'this-month', label: 'This month', from: () => monthStart(), to: () => monthEnd() },
  { key: 'last-month', label: 'Last month', from: () => monthStart(-1), to: () => monthEnd(-1) },
  { key: 'last-3', label: 'Last 3 months', from: () => monthStart(-2), to: () => monthEnd() },
  {
    key: 'quarter',
    label: 'This quarter',
    from: () => monthStart(-(new Date().getMonth() % 3)),
    to: () => monthEnd(2 - (new Date().getMonth() % 3)),
  },
  {
    // Apr–Mar. The whole app is organised around the Indian fiscal year —
    // every document number carries it — so the dashboard offers it too.
    key: 'fy',
    label: 'This fiscal year',
    from: () => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${y}-04-01`; },
    to: () => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${y + 1}-03-31`; },
  },
  { key: 'year', label: 'This calendar year', from: () => `${new Date().getFullYear()}-01-01`, to: () => `${new Date().getFullYear()}-12-31` },
  { key: 'all', label: 'All time', from: () => '', to: () => '' },
  { key: 'custom', label: 'Custom…', from: () => '', to: () => '' },
];

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

/**
 * Ids named in `order` first and in that sequence, then everything else in the
 * built-in order. A card added in a later release therefore appears — at the
 * end, but visible — instead of vanishing from a layout saved before it existed.
 */
function applyOrder<T extends { id: string }>(cards: T[], order: string[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...cards].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
}

interface CardDef { id: string; title: string; wide?: boolean; body: ReactNode }

/** One clickable alert. Only rendered when the count is non-zero. */
function AttentionChip({ to, count, label, tone }: { to: string; count: number; label: string; tone: 'red' | 'amber' }) {
  if (!count) return null;
  // A tinted face inside a ring, like `StatusBadge` — the ring is a shadow, so
  // a row of these no longer pays a border's two pixels per chip.
  const styles = tone === 'red'
    ? 'bg-red-50 text-red-700 ring-red-200 hover:bg-red-100'
    : 'bg-amber-50 text-amber-800 ring-amber-200 hover:bg-amber-100';
  return (
    <Link to={to} className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm ring-1 ring-inset transition-colors ${styles}`}>
      <span className="text-base font-bold tabular-nums">{count}</span>
      <span>{label}</span>
    </Link>
  );
}

/** A headline number with its unit and a one-line explanation underneath. */
function MoneyTile({ label, value, currency, note, tone = 'plain', to }: {
  label: string; value: number; currency: string; note?: string; tone?: 'plain' | 'warn' | 'good'; to: string;
}) {
  const valueCls = tone === 'warn' ? 'text-red-600' : tone === 'good' ? 'text-green-700' : 'text-slate-900';
  return (
    // The same border, radius and hairline shadow a Card has, because these sit
    // in a row directly above a page of them. It answers the pointer the way a
    // field does — a border and a tint, never a size — so nothing shifts.
    <Link
      to={to}
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_1px_1px_rgba(15,23,42,0.03)] transition-colors hover:border-slate-300 hover:bg-slate-50/60"
    >
      <div className={CAPTION}>{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${valueCls}`}>{fmtMoney(value, currency)}</div>
      {note && <div className="mt-0.5 text-xs text-slate-400">{note}</div>}
    </Link>
  );
}

/**
 * A table row that behaves like a link. Navigating on click rather than
 * wrapping an anchor round the cells, because an <a> inside a <td> either
 * covers one cell or breaks the table layout.
 */
function DrillRow({ to, children }: { to: string; children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <tr
      onClick={() => navigate(to)}
      className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
    >
      {children}
    </tr>
  );
}

export default function DashboardPage() {
  const isManager = useIsManager();
  const user = useUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [rangeKey, setRangeKey] = useState('all');
  const [customFrom, setCustomFrom] = useState(monthStart(-2));
  const [customTo, setCustomTo] = useState(today());
  const [currency, setCurrency] = useState('');
  const [customerBasis, setCustomerBasis] = useState<'invoiced' | 'quoted'>('invoiced');
  // Only worth offering once the group actually has more than one entity.
  const companies = useCompanies();
  const [companyFilter, setCompanyFilter] = useState('');
  const showCompany = companies.length > 1;

  // The saved layout is the starting point, not the running truth: once the
  // page is open its own state is what draws, and the server only has to
  // remember it for next time.
  const [layout, setLayout] = useState<DashboardLayout>(
    () => user.dashboard_layout ?? { hidden: [], order: [] }
  );
  const [customising, setCustomising] = useState(false);
  const patchUser = usePatchUser();
  const saveLayout = useMutation({
    mutationFn: (next: DashboardLayout) => api.put<DashboardLayout>('/api/auth/dashboard-layout', next),
    // The signed-in user is read once on mount and held in state, so the
    // change has to be written back into it as well. Without this the card
    // came back the moment you left the dashboard and returned: this
    // component's own state was right, and the state it re-initialises from
    // was not. The server's reply is used rather than what was sent, since it
    // normalises the ids before storing them.
    onSuccess: (saved) => patchUser({ dashboard_layout: saved }),
  });
  const applyLayout = (next: DashboardLayout) => { setLayout(next); saveLayout.mutate(next); };

  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[RANGES.length - 2];
  const from = rangeKey === 'custom' ? customFrom : range.from();
  const to = rangeKey === 'custom' ? customTo : range.to();

  const { data } = useQuery({
    queryKey: ['dashboard', from, to, companyFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (companyFilter) params.set('company', companyFilter);
      return api.get<DashboardData>(`/api/dashboard${params.toString() ? `?${params}` : ''}`);
    },
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

  /**
   * INR unless the group does no rupee business at all.
   *
   * This used to be `currencies[0]`, and that list is sorted alphabetically —
   * so the front page opened on EUR, ahead of INR, ahead of USD, whatever the
   * relative size of the three. Every money tile then read in a currency
   * picked by the alphabet rather than by the business, which for a Kolkata
   * company with a handful of euro invoices is a headline figure about the
   * smallest part of the trade.
   *
   * INR is the home currency: it is what the schema defaults to, what a new
   * document starts in, and what the domestic book is kept in. Falling back to
   * the first available keeps a purely-export group working, and an explicit
   * choice from the selector always wins.
   */
  const activeCurrency = currency || (currencies.includes('INR') ? 'INR' : currencies[0]) || 'INR';

  const monthlyRows = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, { month: string; quoted: number; invoiced: number; received: number }>();
    const row = (month: string) => {
      const found = map.get(month) ?? { month, quoted: 0, invoiced: 0, received: 0 };
      map.set(month, found);
      return found;
    };
    for (const r of data.quotedByMonth.filter((r) => r.currency === activeCurrency)) row(r.month).quoted = r.total;
    for (const r of data.invoicedByMonth.filter((r) => r.currency === activeCurrency)) row(r.month).invoiced = r.total;
    for (const r of (data.receivedByMonth ?? []).filter((r) => r.currency === activeCurrency)) row(r.month).received = r.total;
    return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
  }, [data, activeCurrency]);

  const statusRows = useMemo(() => {
    const order = QUOTATION_STATUSES;
    return order.map((s) => ({
      key: s,
      status: quotationStatusLabel(s),
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

  /** A list URL that keeps whichever company the dashboard is showing. */
  const listUrl = (path: string, extra: Record<string, string> = {}) => {
    const params = new URLSearchParams();
    if (companyFilter) params.set('company', companyFilter);
    for (const [k, v] of Object.entries(extra)) if (v) params.set(k, v);
    return params.toString() ? `${path}?${params}` : path;
  };

  const funnelStages = [
    { label: 'Quoted', value: data.funnel.quoted, to: listUrl('/quotations') },
    { label: 'Accepted', value: data.funnel.accepted, to: listUrl('/quotations', { status: 'accepted' }) },
    { label: 'Orders', value: data.funnel.orders, to: listUrl('/orders') },
    { label: 'Invoiced', value: data.funnel.invoiced, to: listUrl('/invoices') },
  ];
  const funnelMax = Math.max(1, ...funnelStages.map((s) => s.value));
  const pipelineMax = Math.max(1, ...pipeline.map((s) => s.count));

  const pendingCount = data.followups.overdue.length + data.followups.today.length;
  // Defensive: a response from an older server build would lack these.
  const raw = data.attention ?? {
    overdueFollowups: 0, followupsToday: 0, overdueOrders: 0,
    overdueInvoices: 0, pendingApprovals: 0, expiringQuotations: 0,
  };
  const a = {
    ...raw,
    overdueWorkOrders: raw.overdueWorkOrders ?? 0,
    unbilledDespatches: raw.unbilledDespatches ?? 0,
    materialShort: raw.materialShort ?? 0,
    materialBelowReorder: raw.materialBelowReorder ?? 0,
  };
  const attentionTotal = a.overdueFollowups + a.followupsToday + a.overdueOrders + a.overdueInvoices
    + a.expiringQuotations + a.overdueWorkOrders + a.unbilledDespatches + a.materialShort
    + a.materialBelowReorder + (isManager ? a.pendingApprovals : 0);

  // Headline money, all in the selected currency.
  const cur = activeCurrency;
  const book = data.orderBook.find((r) => r.currency === cur);
  const recv = data.receivables.find((r) => r.currency === cur);
  // A tile states one currency's money, so it must count in that currency
  // too. Pairing an INR figure with a count of every document in the book
  // made a true zero read as a fault.
  const cc = data.countsByCurrency?.find((r) => r.currency === cur);
  const quotedPeriod = monthlyRows.reduce((s, r) => s + r.quoted, 0);
  const invoicedPeriod = monthlyRows.reduce((s, r) => s + r.invoiced, 0);
  const receivedPeriod = monthlyRows.reduce((s, r) => s + r.received, 0);

  const ageingFor = (c: string, bucket: string) =>
    data.receivablesAgeing.find((r) => r.currency === c && r.bucket === bucket)?.outstanding ?? 0;
  const ageingCurrencies = [...new Set(data.receivablesAgeing.map((r) => r.currency))].sort();

  const splitRows = data.businessSplit.filter((r) => r.currency === cur);
  const splitTotal = splitRows.reduce((s, r) => s + (r.total ?? 0), 0);

  const floor = data.production;
  const jobsAt = (status: string) => floor?.workOrdersByStatus.find((r) => r.status === status)?.count ?? 0;
  const openJobs = ['planned', 'released', 'running', 'paused'].reduce((s, st) => s + jobsAt(st), 0);

  /* ---------------------------------------------------------------- *
   * The cards, in their built-in order. Everything after this list is
   * layout: which of them are drawn, and in what sequence.
   * ---------------------------------------------------------------- */

  const cards: CardDef[] = [
    {
      id: 'attention',
      title: 'Needs attention',
      wide: true,
      body: (
        // Never filtered by the date range, because an old overdue item is the
        // most urgent kind, not the least. A Card like the other twelve: it is
        // an entry in the same registry and appears in the same Customise list,
        // so its own rounded box with its own caption inside was the odd one out.
        <Card title="Needs attention">
          {attentionTotal === 0 ? (
            <p className="text-sm text-slate-400">Nothing overdue. Follow-ups, orders and approvals are all up to date.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <AttentionChip to="/followups" count={a.overdueFollowups} label="follow-ups overdue" tone="red" />
              <AttentionChip to={listUrl('/orders', { open: '1' })} count={a.overdueOrders} label="orders past promised date" tone="red" />
              <AttentionChip to={listUrl('/invoices')} count={a.overdueInvoices} label="invoices unpaid over 60 days" tone="red" />
              <AttentionChip to="/followups" count={a.followupsToday} label="follow-ups due today" tone="amber" />
              <AttentionChip to={listUrl('/quotations', { status: 'sent' })} count={a.expiringQuotations} label="quotations expiring this week" tone="amber" />
              {isManager && <AttentionChip to="/approvals" count={a.pendingApprovals} label="awaiting your approval" tone="amber" />}
              {/* The floor. Short material is red because it stops production;
                  a reorder level is a warning, not a stoppage. */}
              <AttentionChip to="/work-orders" count={a.overdueWorkOrders} label="jobs past planned finish" tone="red" />
              <AttentionChip to="/stock" count={a.materialShort} label="materials short for open jobs" tone="red" />
              <AttentionChip to="/stock" count={a.materialBelowReorder} label="materials below reorder level" tone="amber" />
              <AttentionChip to="/despatches" count={a.unbilledDespatches} label="despatches not yet billed" tone="amber" />
            </div>
          )}
        </Card>
      ),
    },
    {
      id: 'money',
      title: 'Money headlines',
      wide: true,
      body: (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MoneyTile
            to={listUrl('/orders', { open: '1' })}
            label="Still to ship"
            value={book?.pending_value ?? 0}
            currency={cur}
            note={`${book?.count ?? 0} open order${book?.count === 1 ? '' : 's'} in the book`}
          />
          <MoneyTile
            to={listUrl('/invoices')}
            label="Outstanding"
            value={recv?.outstanding ?? 0}
            currency={cur}
            tone={(recv?.outstanding ?? 0) > 0 ? 'warn' : 'good'}
            note={(recv?.overdue ?? 0) ? `${recv!.overdue} invoice${recv!.overdue === 1 ? '' : 's'} over 60 days old` : 'nothing older than 60 days'}
          />
          <MoneyTile
            to={listUrl('/invoices')}
            label={`Invoiced · ${range.label.toLowerCase()}`}
            value={invoicedPeriod}
            currency={cur}
            tone="good"
            note={`${cc?.invoices ?? 0} invoice${(cc?.invoices ?? 0) === 1 ? '' : 's'} raised · ${fmtMoney(receivedPeriod, cur)} collected`}
          />
          <MoneyTile
            to={listUrl('/quotations')}
            label={`Quoted · ${range.label.toLowerCase()}`}
            value={quotedPeriod}
            currency={cur}
            note={`${cc?.quotations ?? 0} quotation${(cc?.quotations ?? 0) === 1 ? '' : 's'} · ${cc?.orders ?? 0} order${(cc?.orders ?? 0) === 1 ? '' : 's'}`}
          />
        </div>
      ),
    },
    {
      id: 'followups',
      title: 'Pending Follow-ups',
      body: (
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
                  <div key={f.id} className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-slate-50">
                    <input type="checkbox" onChange={() => markDone.mutate(f.id)} title="Mark done" />
                    <span className={`w-24 shrink-0 text-xs font-semibold ${group.cls}`}>{group.label} · {fmtDate(f.due_date)}</span>
                    <span className="truncate">{f.customer_name ? `${f.customer_name}: ` : ''}{f.note || f.doc_type}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </Card>
      ),
    },
    {
      id: 'pipeline',
      title: 'Production Pipeline',
      body: (
        <Card
          title="Production Pipeline"
          actions={<Link to={listUrl('/orders')} className="text-xs text-brand-600 hover:underline">View orders</Link>}
        >
          {pipeline.every((s) => s.count === 0) ? (
            <p className={EMPTY}>No orders in this period. Book one from an accepted quotation.</p>
          ) : (
            <div className="space-y-1">
              {pipeline.map((s) => (
                <button
                  key={s.status}
                  type="button"
                  onClick={() => navigate(listUrl('/orders', { status: s.status }))}
                  className="flex w-full items-center gap-2 rounded-md px-1 text-left text-sm hover:bg-slate-50"
                  title={`Show ${orderStatusLabel(s.status).toLowerCase()} orders`}
                >
                  <span className="w-32 shrink-0 text-xs text-slate-500">{orderStatusLabel(s.status)}</span>
                  <div className="h-5 flex-1 rounded-full bg-slate-100">
                    <div
                      className="h-5 rounded-full"
                      style={{ width: `${(s.count / pipelineMax) * 100}%`, backgroundColor: SERIES_1, opacity: s.count ? 1 : 0 }}
                    />
                  </div>
                  <span className="w-6 shrink-0 text-right text-xs font-semibold tabular-nums text-slate-700">{s.count}</span>
                  <span className="w-28 shrink-0 text-right text-xs tabular-nums text-slate-400">
                    {s.value ? fmtMoney(s.value, cur) : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Card>
      ),
    },
    {
      id: 'trend',
      title: 'Quoted · Invoiced · Collected',
      body: (
        <Card title={`Quoted · Invoiced · Collected (${cur})`}>
          {monthlyRows.length === 0 ? (
            <p className={EMPTY}>No documents in this period yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={monthlyRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="0" stroke={GRID} vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: MUTED }} axisLine={{ stroke: GRID }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: MUTED }} axisLine={false} tickLine={false} tickFormatter={(v: number) => Intl.NumberFormat('en', { notation: 'compact' }).format(v)} />
                <Tooltip cursor={{ fill: 'rgba(0,0,0,0.04)' }} formatter={(v: number) => fmtMoney(v, cur)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="quoted" name="Quoted" fill={SERIES_1} radius={[4, 4, 0, 0]} maxBarSize={24} />
                <Bar dataKey="invoiced" name="Invoiced" fill={SERIES_2} radius={[4, 4, 0, 0]} maxBarSize={24} />
                <Bar dataKey="received" name="Collected" fill={SERIES_3} radius={[4, 4, 0, 0]} maxBarSize={24} />
              </BarChart>
            </ResponsiveContainer>
          )}
          <p className="mt-1 text-xs text-slate-400">
            Collected is money banked in the month it arrived, against a proforma or an invoice — not necessarily
            the invoices in the green bar beside it.
          </p>
        </Card>
      ),
    },
    {
      id: 'ageing',
      title: 'Receivables Ageing',
      body: (
        <Card title="Receivables Ageing (by invoice age, all time)">
          {ageingCurrencies.length === 0 ? (
            <p className={EMPTY}>Nothing outstanding — every invoice is settled.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={TH}>
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
                      <DrillRow key={c} to={listUrl('/invoices')}>
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
                      </DrillRow>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs text-slate-400">Age is counted from the invoice date. Chase the right-hand columns first.</p>
        </Card>
      ),
    },
    {
      id: 'orderbook',
      title: 'Order Book',
      body: (
        <Card
          title={`Order Book${data.overdueOrders ? ` — ${data.overdueOrders} overdue` : ''}`}
          actions={<Link to={listUrl('/orders')} className="text-xs text-brand-600 hover:underline">View orders</Link>}
        >
          {data.orderBook.length === 0 ? (
            <p className={EMPTY}>No open orders. Book one from an accepted quotation.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={TH}>
                    <th className="pb-1 pr-3">Currency</th>
                    <th className="pb-1 pr-3 text-right">Open Orders</th>
                    <th className="pb-1 pr-3 text-right">Order Value</th>
                    <th className="pb-1 text-right">Still to Ship</th>
                  </tr>
                </thead>
                <tbody>
                  {data.orderBook.map((r) => (
                    <DrillRow key={r.currency} to={listUrl('/orders', { open: '1' })}>
                      <td className="py-1.5 pr-3 font-medium">{r.currency}</td>
                      <td className="py-1.5 pr-3 text-right">{r.count}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{fmtMoney(r.open_value, r.currency)}</td>
                      <td className="py-1.5 text-right tabular-nums font-semibold text-amber-700">{fmtMoney(r.pending_value, r.currency)}</td>
                    </DrillRow>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!!data.overdueOrders && (
            <p className="mt-2 text-xs text-red-600">
              ⚠ {data.overdueOrders} order{data.overdueOrders === 1 ? '' : 's'} past the promised despatch date.
            </p>
          )}
        </Card>
      ),
    },
    {
      id: 'receivables',
      title: 'Receivables',
      body: (
        <Card title="Receivables (all invoices)">
          {data.receivables.length === 0 ? (
            <p className={EMPTY}>No invoices yet — outstanding balances will appear here.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={TH}>
                    <th className="pb-1 pr-3">Currency</th>
                    <th className="pb-1 pr-3 text-right">Invoiced</th>
                    <th className="pb-1 pr-3 text-right">Received</th>
                    <th className="pb-1 text-right">Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {data.receivables.map((r) => (
                    <DrillRow key={r.currency} to={listUrl('/invoices')}>
                      <td className="py-1.5 pr-3 font-medium">{r.currency}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{fmtMoney(r.invoiced, r.currency)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-green-700">{fmtMoney(r.received, r.currency)}</td>
                      <td className={`py-1.5 text-right tabular-nums font-semibold ${r.outstanding > 0 ? 'text-red-600' : 'text-green-700'}`}>
                        {fmtMoney(r.outstanding, r.currency)}
                      </td>
                    </DrillRow>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs text-slate-400">Advances taken on a proforma are credited to the shipments raised against it.</p>
        </Card>
      ),
    },
    {
      id: 'factory',
      title: 'On the Floor',
      body: (
        <Card
          title="On the Floor"
          actions={<Link to="/work-orders" className="text-xs text-brand-600 hover:underline">View jobs</Link>}
        >
          {!floor ? (
            <p className={EMPTY}>This server build does not send production figures yet.</p>
          ) : (
            <div className="space-y-3">
              {/* Job counts are the state right now, like the order book — not
                  the date range, which would answer a different question. */}
              <div className="flex flex-wrap gap-2 text-sm">
                {WORK_ORDER_STATUSES.filter((s) => jobsAt(s) > 0).map((s) => (
                  <Link
                    key={s}
                    to={`/work-orders?status=${s}`}
                    className="rounded-lg border border-slate-200 px-2 py-1 text-xs transition-colors hover:border-slate-300 hover:bg-slate-50"
                  >
                    <span className="font-semibold tabular-nums">{jobsAt(s)}</span>{' '}
                    <span className="text-slate-500">{s}</span>
                  </Link>
                ))}
                {openJobs === 0 && <span className="text-sm text-slate-400">No jobs open.</span>}
              </div>

              <div className="grid grid-cols-3 gap-2 border-t border-slate-100 pt-3 text-sm">
                <div>
                  <div className={CAPTION}>Made · {range.label.toLowerCase()}</div>
                  <div className="font-semibold tabular-nums">{fmtQty(floor.piecesMade)}</div>
                </div>
                <div>
                  <div className={CAPTION}>Rejected</div>
                  <div className="font-semibold tabular-nums">
                    {fmtQty(floor.piecesRejected)}
                    {floor.rejectRate !== null && (
                      <span className={`ml-1 text-xs font-normal ${floor.rejectRate > 5 ? 'text-red-600' : 'text-slate-400'}`}>
                        {floor.rejectRate}%
                      </span>
                    )}
                  </div>
                </div>
                <div>
                  <div className={CAPTION}>Despatched</div>
                  <div className="font-semibold tabular-nums">
                    {fmtQty(floor.piecesDespatched)}
                    <span className="ml-1 text-xs font-normal text-slate-400">
                      {floor.despatches} trip{floor.despatches === 1 ? '' : 's'}
                    </span>
                  </div>
                </div>
              </div>

              {floor.shortMaterials.length > 0 && (
                <div className="border-t border-slate-100 pt-3">
                  <div className={`mb-1 ${CAPTION}`}>Short for open jobs</div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <tbody>
                        {floor.shortMaterials.map((m) => (
                          <DrillRow key={m.material_id} to="/stock">
                            <td className="py-1 pr-3">{m.name}</td>
                            <td className="py-1 pr-3 text-right tabular-nums text-slate-500">
                              {fmtQty(m.on_hand)} {m.unit} on hand
                            </td>
                            <td className="py-1 text-right font-semibold tabular-nums text-red-600">
                              short {fmtQty(m.short)} {m.unit}
                            </td>
                          </DrillRow>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-1 text-xs text-slate-400">
                    Group-wide, not narrowed by customer or company — the store is shared, and one purchase order covers it.
                  </p>
                </div>
              )}
            </div>
          )}
        </Card>
      ),
    },
    {
      id: 'split',
      title: 'Export vs Domestic',
      body: (
        <Card title={`Export vs Domestic — invoiced (${cur})`}>
          {splitRows.length === 0 ? (
            <p className={EMPTY}>No invoices in this period.</p>
          ) : (
            <div className="space-y-3">
              {[1, 0].map((isExport) => {
                const row = splitRows.find((r) => r.is_export === isExport);
                const total = row?.total ?? 0;
                const pct = splitTotal ? Math.round((total / splitTotal) * 100) : 0;
                return (
                  <button
                    key={isExport}
                    type="button"
                    onClick={() => navigate(listUrl('/invoices', { export: String(isExport) }))}
                    className="block w-full rounded-md px-1 text-left hover:bg-slate-50"
                  >
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
                  </button>
                );
              })}
            </div>
          )}
        </Card>
      ),
    },
    {
      id: 'funnel',
      title: 'Conversion Funnel',
      body: (
        <Card title="Conversion Funnel">
          <div className="space-y-2">
            {funnelStages.map((s, i) => (
              <button
                key={s.label}
                type="button"
                onClick={() => navigate(s.to)}
                className="flex w-full items-center gap-2 rounded-md text-left hover:bg-slate-50"
              >
                <span className="w-20 shrink-0 text-xs text-slate-500">{s.label}</span>
                <div className="h-6 flex-1 rounded-full bg-slate-100">
                  <div
                    className="flex h-6 items-center rounded-full pl-2.5"
                    style={{ width: `${Math.max(3, (s.value / funnelMax) * 100)}%`, backgroundColor: FUNNEL_STEPS[i] }}
                  >
                    <span className="text-xs font-semibold text-white">{s.value}</span>
                  </div>
                </div>
              </button>
            ))}
            <p className="pt-1 text-xs text-slate-400">
              Conversion: {data.funnel.quoted ? Math.round((data.funnel.accepted / data.funnel.quoted) * 100) : 0}% of quotations accepted
            </p>
          </div>
        </Card>
      ),
    },
    {
      id: 'quotation-status',
      title: 'Quotations by Status',
      body: (
        <Card title="Quotations by Status">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              data={statusRows}
              margin={{ top: 8, right: 8, left: -20, bottom: 0 }}
              onClick={(e: { activePayload?: { payload: { key: string } }[] }) => {
                const key = e?.activePayload?.[0]?.payload?.key;
                if (key) navigate(listUrl('/quotations', { status: key }));
              }}
            >
              <CartesianGrid strokeDasharray="0" stroke={GRID} vertical={false} />
              <XAxis dataKey="status" tick={{ fontSize: 11, fill: MUTED }} axisLine={{ stroke: GRID }} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: MUTED }} axisLine={false} tickLine={false} />
              <Tooltip cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
              <Bar dataKey="count" name="Quotations" fill={SERIES_1} radius={[4, 4, 0, 0]} maxBarSize={40} className="cursor-pointer" />
            </BarChart>
          </ResponsiveContainer>
          <p className="mt-1 text-xs text-slate-400">Click a bar to open that slice of the list.</p>
        </Card>
      ),
    },
    {
      id: 'top-customers',
      title: 'Top Customers',
      body: (
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
            <p className={EMPTY}>
              {customerBasis === 'invoiced' ? 'No invoices in this period.' : 'No quotations in this period.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={TH}>
                    <th className="pb-1 pr-3">Customer</th>
                    <th className="pb-1 pr-3 text-right">{customerBasis === 'invoiced' ? 'Invoices' : 'Quotes'}</th>
                    <th className="pb-1 text-right">{customerBasis === 'invoiced' ? 'Invoiced Value' : 'Quoted Value'}</th>
                  </tr>
                </thead>
                <tbody>
                  {(customerBasis === 'invoiced'
                    ? data.topCustomersInvoiced.map((c) => ({ ...c, n: c.invoices }))
                    : data.topCustomers.map((c) => ({ ...c, n: c.quotes }))
                  ).map((c, i) => (
                    <DrillRow key={i} to={`/customers?q=${encodeURIComponent(c.name)}`}>
                      <td className="py-1.5 pr-3">{c.name}</td>
                      <td className="py-1.5 pr-3 text-right">{c.n}</td>
                      <td className="py-1.5 text-right tabular-nums">{fmtMoney(c.total, c.currency)}</td>
                    </DrillRow>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ),
    },
    {
      id: 'top-products',
      title: 'Most Quoted Products',
      body: (
        <Card title="Most Quoted Products">
          {data.topProducts.length === 0 ? (
            <p className={EMPTY}>No quotations yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={TH}>
                    <th className="pb-1 pr-3">Product</th>
                    <th className="pb-1 text-right">Times Quoted</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topProducts.map((p, i) => (
                    // Straight to that product's order lines: "and what is on
                    // order for it" is the question a quoted-product list provokes.
                    <DrillRow key={i} to={listUrl('/orders', { view: 'by-product', q: p.name })}>
                      <td className="py-1.5 pr-3">{p.name}</td>
                      <td className="py-1.5 text-right">{p.times_quoted}</td>
                    </DrillRow>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ),
    },
  ];

  const hidden = new Set(layout.hidden);
  const ordered = applyOrder(cards, layout.order);
  const visible = ordered.filter((c) => !hidden.has(c.id));

  const move = (id: string, delta: number) => {
    const ids = ordered.map((c) => c.id);
    const at = ids.indexOf(id);
    const swap = at + delta;
    if (at < 0 || swap < 0 || swap >= ids.length) return;
    [ids[at], ids[swap]] = [ids[swap], ids[at]];
    applyLayout({ ...layout, order: ids });
  };

  const toggle = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id); else next.add(id);
    // The current order is written out alongside, so hiding a card does not
    // also discard an arrangement inherited from a card added since.
    applyLayout({ hidden: [...next], order: ordered.map((c) => c.id) });
  };

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={
          // Several cards below say "all invoices" / "all time", which means the
          // whole date range, not the whole group. Say which entity is in view.
          companyFilter
            ? `${companies.find((c) => String(c.id) === companyFilter)?.company_name ?? 'One company'} only`
            : 'Your order-to-dispatch pipeline at a glance'
        }
        actions={
          // Widths go straight on the controls: `Select` and `Input` only
          // default to `w-full` when the caller has not set one, so a wrapping
          // row no longer makes every control claim a line of its own.
          <div className="flex flex-wrap items-center justify-end gap-2">
            {showCompany && (
              <Select
                value={companyFilter}
                onChange={(e) => setCompanyFilter(e.target.value)}
                className="w-48 shrink-0"
                title="Which group entity these figures cover"
              >
                <option value="">All companies</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.company_name || `Company ${c.id}`}</option>
                ))}
              </Select>
            )}
            {currencies.length > 1 && (
              <Select
                value={activeCurrency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-24 shrink-0"
                title="Currency for all money figures"
              >
                {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            )}
            <Select
              value={rangeKey}
              onChange={(e) => setRangeKey(e.target.value)}
              className="w-44 shrink-0"
              title="Period every figure covers"
            >
              {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </Select>
            {rangeKey === 'custom' && (
              <>
                <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="w-36 shrink-0" title="From" />
                <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="w-36 shrink-0" title="To" />
              </>
            )}
            <Button variant="secondary" onClick={() => setCustomising(true)}>Customise</Button>
          </div>
        }
      />

      {visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white/60 p-8 text-center text-sm text-slate-400">
          Every card is hidden. Use <b>Customise</b> to bring some back.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {visible.map((c) => (
            <div key={c.id} className={c.wide ? 'xl:col-span-2' : ''}>{c.body}</div>
          ))}
        </div>
      )}

      {customising && (
        <Modal title="Customise dashboard" onClose={() => setCustomising(false)}>
          <p className="mb-3 text-sm text-slate-500">
            Untick a card to hide it, or move it up and down. Saved to your account, so it follows you to any machine.
          </p>
          <div className="space-y-1">
            {ordered.map((c, i) => (
              <div key={c.id} className="flex items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={!hidden.has(c.id)}
                  onChange={() => toggle(c.id)}
                  title={hidden.has(c.id) ? 'Show this card' : 'Hide this card'}
                />
                <span className={`flex-1 ${hidden.has(c.id) ? 'text-slate-400 line-through' : ''}`}>{c.title}</span>
                <button
                  type="button"
                  onClick={() => move(c.id, -1)}
                  disabled={i === 0}
                  className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                  title="Move up"
                ><Icon name="chevron-up" /></button>
                <button
                  type="button"
                  onClick={() => move(c.id, 1)}
                  disabled={i === ordered.length - 1}
                  className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                  title="Move down"
                ><Icon name="chevron-down" /></button>
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center justify-between">
            <Button variant="ghost" onClick={() => applyLayout({ hidden: [], order: [] })}>Reset to default</Button>
            <Button onClick={() => setCustomising(false)}>Done</Button>
          </div>
          {saveLayout.isError && (
            <p className="mt-2 text-xs text-red-600">Could not save the layout — it will apply for this visit only.</p>
          )}
        </Modal>
      )}
    </div>
  );
}
