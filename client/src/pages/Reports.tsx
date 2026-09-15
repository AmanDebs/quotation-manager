import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ReportPivot, DispatchReport, DueReport, DueGroup, DueColour } from '../types';
import { PageHeader, Card, Select, Input, SegmentedTabs, EmptyState, TH_CLASS } from '../components/ui';
import { PivotTable } from '../components/PivotTable';
import { useCompanies } from '../components/CompanySelect';
import { useCan } from '../App';
import { fmtMoney, fmtMoneyRound, fmtDate, fiscalYearRange } from '../lib/format';
import { useUrlFilter } from '../lib/useUrlFilter';

/**
 * The desk's own pivot sheets, drawn from the book rather than kept in Excel
 * (2026-09-15, from screenshots of four sheets): what is planned for
 * production and when, what is confirmed but not yet scheduled, what was
 * invoiced in each month, and who owes what by when. Each is one tab chosen
 * by `?view=`, and **every figure is a link** into the list it was summed
 * from — the "linked version" the client asked for.
 *
 * Three rules. **One currency at a time**: the server groups every row by
 * currency and never adds across them, and the selector here does what the
 * dashboard's does. **The tabs a person sees are the ones they may read** —
 * the proforma pivots are `proforma`, invoiced-by-month is `invoice`, the due
 * list is `payment`, and the server guards each route the same way. And the
 * date columns are the server's: a month with nothing in it is still a
 * column, so the sheet reads Apr…Mar with the gaps visible.
 */
type View = 'planned' | 'unscheduled' | 'dispatch' | 'due';

const TABS: { key: View; label: string; needs: string; subtitle: string }[] = [
  { key: 'planned', label: 'Planned for production', needs: 'proforma', subtitle: 'Proformas with a sales order booked, by the date production is planned for' },
  { key: 'unscheduled', label: 'Yet to be scheduled', needs: 'proforma', subtitle: 'Proformas with the buyer, and those confirmed but not yet given a production date' },
  { key: 'dispatch', label: 'Dispatch by month', needs: 'invoice', subtitle: 'Commercial invoices raised, by the month of the invoice' },
  { key: 'due', label: 'Due', needs: 'payment', subtitle: 'Every invoice still owing money that is overdue or falls due within two weeks' },
];

/** `2026-09-15` → `15-Sep`, the sheet's own heading. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return m >= 1 && m <= 12 ? `${d}-${MONTHS[m - 1]}` : iso;
}
/** `2026-04` → `Apr 2026`. */
function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m >= 1 && m <= 12 ? `${MONTHS[m - 1]} ${y}` : ym;
}
/** The last day of `YYYY-MM`. */
function monthEnd(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

/**
 * The chosen currency, else the one most of the rows are in. Not the
 * dashboard's INR-first rule: on an export desk that would open every sheet
 * on one domestic row while thirteen USD ones sat behind the selector.
 */
function pickCurrency(chosen: string, rows: { currency: string }[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
  if (chosen && counts.has(chosen)) return chosen;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
}

export default function ReportsPage() {
  const can = useCan();
  const tabs = TABS.filter((t) => can(t.needs));
  const [viewRaw, setView] = useUrlFilter('view');
  const view: View = (tabs.find((t) => t.key === viewRaw) ?? tabs[0])?.key ?? 'planned';
  const [company, setCompany] = useUrlFilter('company');
  const [currency, setCurrency] = useUrlFilter('currency');
  const [from, setFrom] = useUrlFilter('from');
  const [to, setTo] = useUrlFilter('to');
  const companies = useCompanies();
  const fy = fiscalYearRange();

  const params = new URLSearchParams();
  if (company) params.set('company', company);
  if (view === 'dispatch') {
    if (from) params.set('from', from);
    if (to) params.set('to', to);
  }
  const query = params.toString();
  const { data, isPending } = useQuery({
    queryKey: ['report', view, query],
    queryFn: () => api.get<ReportPivot | DispatchReport | DueReport>(`/api/reports/${view}${query ? `?${query}` : ''}`),
    enabled: tabs.length > 0,
  });

  /** Every list link keeps the company the report is showing. */
  const listUrl = (path: string, extra: Record<string, string> = {}) => {
    const p = new URLSearchParams();
    if (company) p.set('company', company);
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
    return p.toString() ? `${path}?${p}` : path;
  };

  const tab = TABS.find((t) => t.key === view)!;
  const currencyRows = data ? ('groups' in data ? data.groups : data.rows) : [];
  const present = [...new Set(currencyRows.map((r) => r.currency))].sort();
  const active = pickCurrency(currency, currencyRows);

  if (tabs.length === 0) return <EmptyState message="Nothing here is yours to read." />;

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle={tab.subtitle}
        actions={(
          <SegmentedTabs<View>
            value={view}
            onChange={(v) => setView(v === tabs[0].key ? '' : v)}
            tabs={tabs.map((t) => ({ key: t.key, label: t.label }))}
          />
        )}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {companies.length > 1 && (
          <Select className="w-48" value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value="">All companies</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.company_name}</option>)}
          </Select>
        )}
        {present.length > 1 && (
          <Select className="w-28" value={active} onChange={(e) => setCurrency(e.target.value)} title="Figures are shown one currency at a time and never added across them">
            {present.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        )}
        {view === 'dispatch' && (
          <>
            <Input type="date" className="w-40" value={from || fy.from} onChange={(e) => setFrom(e.target.value === fy.from ? '' : e.target.value)} />
            <span className="text-sm text-slate-400">to</span>
            <Input type="date" className="w-40" value={to || fy.to} onChange={(e) => setTo(e.target.value === fy.to ? '' : e.target.value)} />
          </>
        )}
        {present.length === 1 && <span className="text-sm text-slate-500">All figures in {present[0]}.</span>}
      </div>

      {isPending || !data ? (
        <div className="py-8 text-center text-sm text-slate-400">Loading…</div>
      ) : view === 'due' ? (
        <DueTable report={data as DueReport} currency={active} listUrl={listUrl} />
      ) : (
        <Pivot view={view} data={data as ReportPivot | DispatchReport} currency={active} listUrl={listUrl} />
      )}
    </div>
  );
}

/** The three customer × SPOC pivots, differing only in what a column is and where a cell links. */
function Pivot({ view, data, currency, listUrl }: {
  view: Exclude<View, 'due'>;
  data: ReportPivot | DispatchReport;
  currency: string;
  listUrl: (path: string, extra?: Record<string, string>) => string;
}) {
  const rows = data.rows.filter((r) => r.currency === currency);
  const totals = data.totals.find((t) => t.currency === currency);
  const customer = (id: number) => `/customers/${id}`;
  const proformas = (id: number, status: string) => listUrl('/proformas', { customer_id: String(id), status });
  const receivables = (id: number, extra: Record<string, string>) => listUrl('/payments', { view: 'receivables', customer_id: String(id), ...extra });

  if (view === 'planned') {
    return (
      <PivotTable
        columns={data.columns.map((d) => ({ key: d, label: dayLabel(d), title: d }))}
        rows={rows} totals={totals} currency={currency}
        rowHref={(r) => customer(r.customer_id)}
        cellHref={(r) => proformas(r.customer_id, 'in_production')}
        totalHref={(r) => proformas(r.customer_id, 'in_production')}
        emptyMessage="Nothing booked with a production date. Set the Revised Production Date on a sales order and it appears here."
        footnote="Each column is the sales order's revised production date (else its scheduled or promised one). A cell opens that customer's booked proformas."
      />
    );
  }
  if (view === 'unscheduled') {
    return (
      <PivotTable
        columns={[
          { key: 'confirmed', label: 'Confirmed – not scheduled', title: 'Order confirmed or advance received, or booked with no production date yet' },
          { key: 'pending', label: 'Pending', title: 'Sent to the buyer, not yet confirmed' },
        ]}
        rows={rows} totals={totals} currency={currency}
        rowHref={(r) => customer(r.customer_id)}
        cellHref={(r, col) => proformas(r.customer_id, col === 'pending' ? 'sent' : 'order_confirmed,advance_received,in_production')}
        totalHref={(r) => proformas(r.customer_id, 'sent,order_confirmed,advance_received,in_production')}
        emptyMessage="Nothing waiting: every live proforma is either lapsed, booked with a date, or finished."
        footnote="Pending is a proforma with the buyer; Confirmed – not scheduled is one confirmed or paid against, or booked with no production date yet. Lapsed offers are not counted."
      />
    );
  }
  const d = data as DispatchReport;
  return (
    <PivotTable
      columns={d.columns.map((m) => ({ key: m, label: monthLabel(m), title: m }))}
      rows={rows} totals={totals} currency={currency}
      rowHref={(r) => customer(r.customer_id)}
      cellHref={(r, m) => receivables(r.customer_id, { from: `${m}-01`, to: monthEnd(m) })}
      totalHref={(r) => receivables(r.customer_id, { from: d.from, to: d.to })}
      emptyMessage="No commercial invoices in this range."
      footnote={`Commercial invoices by the month of their date, ${fmtDate(d.from)} to ${fmtDate(d.to)}. A cell opens the Receivables tracker for that customer and month.`}
    />
  );
}

const TINT: Record<DueColour, string> = {
  red: 'bg-red-50 text-red-700',
  yellow: 'bg-amber-50 text-amber-800',
  green: 'bg-green-50 text-green-700',
};
const DOT: Record<DueColour, string> = { red: 'bg-red-500', yellow: 'bg-amber-400', green: 'bg-green-500' };

/**
 * Customer-wise: a header line per customer with what is invoiced and what
 * is due, then each invoice tinted by how close its due date is. The colours
 * are the client's own — red once the date has passed, yellow for the week in
 * front of it, green for the week after.
 */
function DueTable({ report, currency, listUrl }: {
  report: DueReport;
  currency: string;
  listUrl: (path: string, extra?: Record<string, string>) => string;
}) {
  const groups = report.groups.filter((g) => g.currency === currency);
  const num = 'whitespace-nowrap py-1.5 pr-3 text-right tabular-nums';
  if (groups.length === 0) {
    return <Card><EmptyState message={`Nothing overdue or falling due by ${fmtDate(report.until)}.`} /></Card>;
  }
  const sum = (pick: (g: DueGroup) => number) => groups.reduce((n, g) => n + pick(g), 0);
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className={TH_CLASS}>
            <th className="pb-2 pr-3">Customer / Invoice</th>
            <th className="pb-2 pr-3">Invoice date</th>
            <th className="pb-2 pr-3 text-right">Invoice amount</th>
            <th className="pb-2 pr-3 text-right">Due amount</th>
            <th className="pb-2 pr-3">Due date</th>
            <th className="pb-2 pr-3 text-right">Days</th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={`${g.customer_id}|${g.currency}`} className="border-b border-slate-200">
            <tr className="bg-slate-50 font-semibold">
              <td className="whitespace-nowrap py-2 pr-3">
                <Link to={`/customers/${g.customer_id}`} className="text-brand-600 hover:underline">{g.customer_name}</Link>
                <span className="ml-2 text-xs font-normal text-slate-400">
                  {g.invoices.length} invoice{g.invoices.length === 1 ? '' : 's'}
                </span>
              </td>
              <td />
              <td className={num}>{fmtMoneyRound(g.invoiced, currency)}</td>
              <td className={num}>
                <Link
                  to={listUrl('/payments', { view: 'receivables', customer_id: String(g.customer_id), status: 'pending' })}
                  className="rounded px-1 hover:bg-brand-50 hover:text-brand-700"
                  title="Open the Receivables tracker for this customer"
                >
                  {fmtMoneyRound(g.due, currency)}
                </Link>
              </td>
              <td colSpan={2} />
            </tr>
            {g.invoices.map((inv) => (
              <tr key={inv.id} className={inv.colour ? TINT[inv.colour] : ''}>
                <td className="whitespace-nowrap py-1.5 pl-6 pr-3">
                  {inv.colour && <span className={`mr-2 inline-block h-2 w-2 rounded-full ${DOT[inv.colour]}`} />}
                  <Link to={`/invoices/${inv.id}`} className="font-medium hover:underline">{inv.number}</Link>
                </td>
                <td className="whitespace-nowrap py-1.5 pr-3">{fmtDate(inv.date)}</td>
                <td className={num}>{fmtMoney(inv.grand_total, currency)}</td>
                <td className={`${num} font-semibold`}>{fmtMoney(inv.balance_due, currency)}</td>
                <td className="whitespace-nowrap py-1.5 pr-3">
                  {fmtDate(inv.due_date)}
                  {inv.due_on_arrival && <span className="ml-1 text-xs opacity-70">on arrival</span>}
                </td>
                <td className={num}>
                  {inv.days_to_due == null ? '—'
                    : inv.days_to_due < 0 ? `${-inv.days_to_due} overdue`
                      : inv.days_to_due === 0 ? 'today'
                        : `in ${inv.days_to_due}`}
                </td>
              </tr>
            ))}
            {g.undated.count > 0 && (
              <tr className="text-slate-500">
                <td className="py-1.5 pl-6 pr-3" colSpan={3}>
                  No due date recorded:{' '}
                  {g.undated.invoices.map((inv, i) => (
                    <span key={inv.id}>{i > 0 && ', '}<Link to={`/invoices/${inv.id}`} className="hover:underline">{inv.number}</Link></span>
                  ))}
                </td>
                <td className={num}>{fmtMoney(g.undated.due, currency)}</td>
                <td colSpan={2} className="py-1.5 pr-3 text-xs">set a due date on the invoice, or an ETA on its dispatch</td>
              </tr>
            )}
          </tbody>
        ))}
        <tfoot>
          <tr className="border-t-2 border-slate-300 font-semibold">
            <td className="py-2 pr-3" colSpan={2}>Grand Total</td>
            <td className={num}>{fmtMoneyRound(sum((g) => g.invoiced), currency)}</td>
            <td className={num}>{fmtMoneyRound(sum((g) => g.due), currency)}</td>
            <td colSpan={2} />
          </tr>
        </tfoot>
      </table>
      <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        <span><span className={`mr-1 inline-block h-2 w-2 rounded-full ${DOT.red}`} />Red — overdue</span>
        <span><span className={`mr-1 inline-block h-2 w-2 rounded-full ${DOT.yellow}`} />Yellow — due within 7 days</span>
        <span><span className={`mr-1 inline-block h-2 w-2 rounded-full ${DOT.green}`} />Green — due in 8 to 14 days</span>
        <span>Window to {fmtDate(report.until)}. Due date is the one typed on the invoice, else the shipment's ETA.</span>
      </p>
    </Card>
  );
}
