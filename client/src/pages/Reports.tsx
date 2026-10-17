import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type {
  ReportPivot, DispatchReport, DueReport, DueGroup, DueColour,
  BookReport, BookDoc, PriceHistory, PricePoint, Customer, Product,
} from '../types';
import {
  PageHeader, Card, Select, Input, SegmentedTabs, EmptyState, DownloadButton,
  SearchSelect, TH_CLASS, CAPTION_CLASS,
} from '../components/ui';
// The dashboard's own palette rather than a second one — see its comment.
import { BLUE, BLUE_PALE } from './Dashboard';
import { PivotTable } from '../components/PivotTable';
import { useCompanies } from '../components/CompanySelect';
import { useCan } from '../App';
import { fmtMoney, fmtMoneyRound, fmtQty, fmtRate, rateBasis, fmtDate, fiscalYearRange } from '../lib/format';
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
type View = 'planned' | 'unscheduled' | 'dispatch' | 'due' | 'book' | 'price-history';

const TABS: { key: View; label: string; needs: string; subtitle: string }[] = [
  { key: 'planned', label: 'Planned for production', needs: 'proforma', subtitle: 'Proformas with a sales order booked, by the date production is planned for' },
  { key: 'unscheduled', label: 'Yet to be scheduled', needs: 'proforma', subtitle: 'Proformas with the buyer, and those confirmed but not yet given a production date' },
  { key: 'dispatch', label: 'Dispatch by month', needs: 'invoice', subtitle: 'Commercial invoices raised, by the month of the invoice' },
  { key: 'due', label: 'Due', needs: 'payment', subtitle: 'Every invoice still owing money that is overdue or falls due within two weeks' },
  /*
   * Gated on `order`, which is the broadest of the three it spans — the
   * server decides per document kind (see `bookDocs`) and tells the page
   * which it included, so a login holding `order` alone gets the sales
   * orders and is told so rather than shown a short book.
   */
  { key: 'book', label: 'Sales book', needs: 'order', subtitle: 'Every sales order, and the proformas and quotations still open — by customer or by where the goods are going' },
  /*
   * Gated on `order` like the sales book, and for the same reason: it
   * spans the three selling documents and the server decides per kind.
   */
  { key: 'price-history', label: 'Price history', needs: 'order', subtitle: 'What one product has been priced at over time, and to whom — every rate shown per 1000 pieces' },
];

/**
 * The last two years, ending today — the window the price history opens on.
 *
 * A **default, not a rule**: it is written into the boxes so it is on screen
 * and editable before anything is asked for, the call `DEFAULT_VALIDITY_DAYS`
 * records. Built from UTC date parts rather than from an ISO string cut up,
 * which lands a day out either side of Greenwich.
 */
function lastTwoYears(): { from: string; to: string } {
  const n = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const to = new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
  const from = new Date(Date.UTC(n.getFullYear() - 2, n.getMonth(), n.getDate()));
  return { from: iso(from), to: iso(to) };
}

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
  // The sheets are read per person — *Meisha Total*, *Tannistha Total* — so a
  // SPOC filter, and a subtotal line per SPOC when nobody is chosen.
  const [spoc, setSpoc] = useUrlFilter('spoc');
  const [subtotals, setSubtotals] = useUrlFilter('subtotals');
  // Customer or country, on the Sales book alone. In the URL like every
  // other filter here, so a grouping is a link somebody can send.
  const [by, setBy] = useUrlFilter('by');
  // The price history's own three, in the URL like the rest, so a
  // product's trend for one buyer is a link somebody can send.
  const [product, setProduct] = useUrlFilter('product');
  const [customerId, setCustomerId] = useUrlFilter('customer_id');
  const companies = useCompanies();
  const fy = fiscalYearRange();
  const twoYears = lastTwoYears();
  // Both are **filters** over documents, so both stay scoped — the rule
  // `useCustomerBook` states about which controls may widen.
  const { data: customers = [] } = useQuery({
    queryKey: ['customers', ''], queryFn: () => api.get<Customer[]>('/api/customers'),
    enabled: view === 'price-history',
  });
  const { data: catalogue = [] } = useQuery({
    queryKey: ['products', ''], queryFn: () => api.get<Product[]>('/api/products'),
    enabled: view === 'price-history',
  });

  const params = new URLSearchParams();
  if (company) params.set('company', company);
  if (view === 'dispatch') {
    if (from) params.set('from', from);
    if (to) params.set('to', to);
  }
  if (view === 'book' && by) params.set('by', by);
  if (view === 'price-history') {
    if (product) params.set('product', product);
    if (customerId) params.set('customer_id', customerId);
    // The window the boxes are showing, whether or not it was typed —
    // a default the form draws has to be the one the server answers.
    params.set('from', from || twoYears.from);
    params.set('to', to || twoYears.to);
  }
  const query = params.toString();
  const { data, isPending } = useQuery({
    queryKey: ['report', view, query],
    queryFn: () => api.get<ReportPivot | DispatchReport | DueReport | BookReport | PriceHistory>(`/api/reports/${view}${query ? `?${query}` : ''}`),
    // Without a product the price history has no question to answer, and
    // the route refuses it — so nothing is asked until one is picked.
    enabled: tabs.length > 0 && (view !== 'price-history' || !!product),
  });

  /** Every list link keeps the company the report is showing. */
  const listUrl = (path: string, extra: Record<string, string> = {}) => {
    const p = new URLSearchParams();
    if (company) p.set('company', company);
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
    return p.toString() ? `${path}?${p}` : path;
  };

  const tab = TABS.find((t) => t.key === view)!;
  /*
   * The Sales book states its currencies as per-currency totals rather than
   * one per row, so it is read from those — weighted by how many lines each
   * carries, which is what `pickCurrency` means by *the one most rows are in*.
   */
  const bookData = view === 'book' ? (data as BookReport | undefined) : undefined;
  const priceData = view === 'price-history' ? (data as PriceHistory | undefined) : undefined;
  const currencyRows: { currency: string }[] = bookData
    ? bookData.totals.flatMap((t) => Array.from({ length: t.lines }, () => ({ currency: t.currency })))
    : priceData
      ? priceData.series.flatMap((s) => s.points.map((p) => ({ currency: p.currency })))
      : !data || view === 'book' || view === 'price-history'
        ? []
        : 'groups' in data
          ? (data as DueReport).groups
          : (data as ReportPivot | DispatchReport).rows;
  const present = [...new Set(currencyRows.map((r) => r.currency))].sort();
  const active = pickCurrency(currency, currencyRows);
  const spocs = data && view !== 'book' && view !== 'price-history' && !('groups' in data)
    ? [...new Set((data as ReportPivot | DispatchReport).rows.map((r) => r.spoc))].sort()
    : [];
  const exportParams = new URLSearchParams(params);
  if (active) exportParams.set('currency', active);
  const exportHref = `/api/reports/${view}/export${exportParams.toString() ? `?${exportParams}` : ''}`;

  if (tabs.length === 0) return <EmptyState message="Nothing here is yours to read." />;

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle={tab.subtitle}
        actions={(
          <>
            {/* Nothing to download until a product is named. */}
            {(view !== 'price-history' || !!product) && (
              <DownloadButton href={exportHref} title="Download this sheet, in the currency shown, as a spreadsheet" />
            )}
            <SegmentedTabs<View>
              value={view}
              onChange={(v) => setView(v === tabs[0].key ? '' : v)}
              tabs={tabs.map((t) => ({ key: t.key, label: t.label }))}
            />
          </>
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
        {view === 'price-history' && (
          <>
            {/* The catalogue is the one list long enough to need a
                searchable picker — `SearchSelect`'s own rule. */}
            <SearchSelect
              className="w-72"
              value={product}
              onChange={setProduct}
              placeholder="Pick a product…"
              options={catalogue.map((p) => ({
                value: String(p.id),
                label: p.name,
                hint: [p.color, p.unit].filter(Boolean).join(' · '),
                keywords: p.hsn_code ?? '',
              }))}
            />
            <Select className="w-52" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">Every customer</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Input type="date" className="w-40" value={from || twoYears.from} onChange={(e) => setFrom(e.target.value === twoYears.from ? '' : e.target.value)} />
            <Input type="date" className="w-40" value={to || twoYears.to} onChange={(e) => setTo(e.target.value === twoYears.to ? '' : e.target.value)} />
            {priceData && priceData.included.length < 3 && (
              <span className="text-xs text-amber-700" title="The server sends only the document kinds this login may read">
                {priceData.included.map((d) => PRICE_DOC_LABEL[d]).join(' and ')} only — the rest is not yours to read
              </span>
            )}
          </>
        )}
        {view === 'book' && (
          <>
            <SegmentedTabs<'customer' | 'country'>
              value={by === 'country' ? 'country' : 'customer'}
              onChange={(v) => setBy(v === 'customer' ? '' : v)}
              tabs={[{ key: 'customer', label: 'By customer' }, { key: 'country', label: 'By country' }]}
            />
            {bookData && bookData.included.length < 3 && (
              <span className="text-xs text-amber-700" title="The server sends only the document kinds this login may read">
                {bookData.included.map((d) => BOOK_DOC_LABEL[d]).join(' and ')} only — the rest is not yours to read
              </span>
            )}
          </>
        )}
        {view === 'dispatch' && (
          <>
            <Input type="date" className="w-40" value={from || fy.from} onChange={(e) => setFrom(e.target.value === fy.from ? '' : e.target.value)} />
            <span className="text-sm text-slate-400">to</span>
            <Input type="date" className="w-40" value={to || fy.to} onChange={(e) => setTo(e.target.value === fy.to ? '' : e.target.value)} />
          </>
        )}
        {view !== 'due' && spocs.length > 0 && (
          <Select className="w-40" value={spoc} onChange={(e) => setSpoc(e.target.value)}>
            <option value="">All SPOCs</option>
            {spocs.map((s) => <option key={s} value={s}>{s || '— none —'}</option>)}
          </Select>
        )}
        {view !== 'due' && !spoc && spocs.length > 1 && (
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" checked={subtotals === '1'} onChange={(e) => setSubtotals(e.target.checked ? '1' : '')} />
            Subtotal per SPOC
          </label>
        )}
        {present.length === 1 && <span className="text-sm text-slate-500">All figures in {present[0]}.</span>}
      </div>

      {view === 'price-history' && !product ? (
        <EmptyState message="Pick a product to see what it has been priced at, and to whom." />
      ) : isPending || !data ? (
        <div className="py-8 text-center text-sm text-slate-400">Loading…</div>
      ) : view === 'price-history' ? (
        <PriceChart report={data as PriceHistory} currency={active} listUrl={listUrl} />
      ) : view === 'book' ? (
        <BookTable report={data as BookReport} currency={active} listUrl={listUrl} />
      ) : view === 'due' ? (
        <DueTable report={data as DueReport} currency={active} listUrl={listUrl} />
      ) : (
        <Pivot view={view} data={data as ReportPivot | DispatchReport} currency={active} spoc={spoc} subtotals={!spoc && subtotals === '1'} listUrl={listUrl} />
      )}
    </div>
  );
}

/** The three customer × SPOC pivots, differing only in what a column is and where a cell links. */
function Pivot({ view, data, currency, spoc, subtotals, listUrl }: {
  view: Exclude<View, 'due'>;
  data: ReportPivot | DispatchReport;
  currency: string;
  /** One person's rows only; blank means everybody. */
  spoc: string;
  subtotals: boolean;
  listUrl: (path: string, extra?: Record<string, string>) => string;
}) {
  const rows = data.rows.filter((r) => r.currency === currency && (!spoc || r.spoc === spoc));
  // The grand total is the server's per-currency figure; narrowed to one
  // SPOC it is that person's rows added up, which is what the sheet's own
  // filter would show.
  const totals = spoc
    ? { currency, count: rows.reduce((n, r) => n + r.count, 0), total: rows.reduce((n, r) => n + r.total, 0),
        cells: Object.fromEntries(data.columns.map((c) => [c, rows.reduce((n, r) => n + (r.cells[c] ?? 0), 0)])) }
    : data.totals.find((t) => t.currency === currency);
  const customer = (id: number) => `/customers/${id}`;
  const proformas = (id: number, status: string) => listUrl('/proformas', { customer_id: String(id), status });
  const receivables = (id: number, extra: Record<string, string>) => listUrl('/payments', { view: 'receivables', customer_id: String(id), ...extra });

  if (view === 'planned') {
    return (
      <PivotTable
        columns={data.columns.map((d) => ({ key: d, label: dayLabel(d), title: d }))}
        rows={rows} totals={totals} currency={currency} subtotalBySpoc={subtotals}
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
        rows={rows} totals={totals} currency={currency} subtotalBySpoc={subtotals}
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
      rows={rows} totals={totals} currency={currency} subtotalBySpoc={subtotals}
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

/** What each document kind is called on screen. */
const BOOK_DOC_LABEL: Record<BookDoc, string> = {
  order: 'Sales Order',
  proforma: 'Proforma',
  quotation: 'Quotation',
};

const BOOK_DOC_PATH: Record<BookDoc, string> = {
  order: '/orders',
  proforma: '/proformas',
  quotation: '/quotations',
};

/**
 * The sales book: a group per customer or per destination, opening on the
 * lines it is made of (2026-10-16, the client: *"a summary … capturing date,
 * product info, qty, unit price and total"*).
 *
 * **A summary that opens**, the shape *Raw Material Required* uses: the live
 * book runs to several hundred lines, so a flat listing would be a sheet
 * nobody could read at the top, while a total with no way into it would not
 * answer the half of the question that names a product and a price. The group
 * row is the summary; the lines under it are the detail, and the group's total
 * is exactly the sum of them.
 *
 * **One currency at a time**, the rule this whole page follows: the lines are
 * narrowed to the currency shown and the group's figure is that currency's
 * own, never a sum across them.
 */
function BookTable({ report, currency, listUrl }: {
  report: BookReport;
  currency: string;
  listUrl: (path: string, extra?: Record<string, string>) => string;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const groups = report.groups
    .map((g) => ({ ...g, lines: g.lines.filter((l) => l.currency === currency) }))
    .filter((g) => g.lines.length > 0);
  const total = report.totals.find((t) => t.currency === currency);
  const byCountry = report.by === 'country';

  if (!groups.length) {
    return <EmptyState message="Nothing open in this currency. Every sales order is here, with the proformas and quotations not yet converted." />;
  }

  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className={TH_CLASS}>
            <th className="pb-2 pr-3">{byCountry ? 'Country / destination' : 'Customer'}</th>
            <th className="pb-2 pr-3 text-right">Sales orders</th>
            <th className="pb-2 pr-3 text-right">Proformas</th>
            <th className="pb-2 pr-3 text-right">Quotations</th>
            <th className="pb-2 pr-3 text-right">Lines</th>
            <th className="pb-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const isOpen = open.has(g.key);
            const sum = g.totals.find((t) => t.currency === currency);
            return (
              <React.Fragment key={g.key || '(none)'}>
                <tr
                  className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                  onClick={() => toggle(g.key)}
                >
                  <td className="py-2 pr-3 font-medium">
                    <span className="mr-1 inline-block w-3 text-slate-400">{isOpen ? '▾' : '▸'}</span>
                    {/* An absence reads as one rather than as a blank cell —
                        the *Dest Port* rule this codebase states. */}
                    {g.key ? g.label : <span className="text-amber-700">Not stated</span>}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{g.counts.order || <span className="text-slate-300">—</span>}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{g.counts.proforma || <span className="text-slate-300">—</span>}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{g.counts.quotation || <span className="text-slate-300">—</span>}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-slate-500">{g.lines.length}</td>
                  <td className="py-2 text-right font-medium tabular-nums">{fmtMoney(sum?.amount ?? 0, currency)}</td>
                </tr>
                {isOpen && (
                  <tr className="border-b border-slate-100 bg-slate-50/60">
                    <td colSpan={6} className="px-3 py-2">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className={CAPTION_CLASS}>
                            <th className="pb-1 pr-3 text-left">Document</th>
                            <th className="pb-1 pr-3 text-left">Date</th>
                            <th className="pb-1 pr-3 text-left">{byCountry ? 'Customer' : 'Country / destination'}</th>
                            <th className="pb-1 pr-3 text-left">Product</th>
                            <th className="pb-1 pr-3 text-left">Colour</th>
                            <th className="pb-1 pr-3 text-right">Qty</th>
                            <th className="pb-1 pr-3 text-right">Unit price</th>
                            <th className="pb-1 text-right">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.lines.map((l, i) => (
                            <tr key={`${l.doc}-${l.doc_id}-${i}`} className="border-t border-slate-200/70">
                              <td className="py-1 pr-3 whitespace-nowrap">
                                <Link
                                  to={`${BOOK_DOC_PATH[l.doc]}/${l.doc_id}`}
                                  className="text-brand-600 hover:underline"
                                  title={BOOK_DOC_LABEL[l.doc]}
                                >
                                  {l.number}
                                </Link>
                                <span className="ml-1 text-slate-400">{BOOK_DOC_LABEL[l.doc]}</span>
                              </td>
                              <td className="py-1 pr-3 whitespace-nowrap">{fmtDate(l.date)}</td>
                              <td className="py-1 pr-3">
                                {byCountry ? (
                                  <Link to={listUrl(`/customers/${l.customer_id}`)} className="hover:underline">{l.customer_name}</Link>
                                ) : (
                                  <span title={l.country_from === 'destination'
                                    ? 'The destination this document states'
                                    : l.country_from === 'customer'
                                      ? "The customer's own country — this document states no destination"
                                      : 'Neither a destination nor a country is recorded'}>
                                    {l.country || <span className="text-amber-700">Not stated</span>}
                                    {l.country_from === 'customer' && <span className="ml-1 text-slate-400">(customer)</span>}
                                  </span>
                                )}
                              </td>
                              {/* The catalogue product, with the line's own
                                  wording on hover where the two differ — the
                                  rule the order book's Item column follows. */}
                              <td className="py-1 pr-3" title={l.description !== l.product ? l.description : undefined}>{l.product}</td>
                              <td className="py-1 pr-3">{l.color || <span className="text-slate-300">—</span>}</td>
                              <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap">
                                {l.qty == null ? <span className="text-slate-300">—</span> : <>{fmtQty(l.qty)} <span className="text-slate-400">{l.unit}</span></>}
                              </td>
                              <td className="py-1 pr-3 text-right tabular-nums">{fmtMoney(l.unit_price, l.currency)}</td>
                              <td className="py-1 text-right tabular-nums">{fmtMoney(l.amount, l.currency)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-slate-200 font-medium">
            <td className="pt-2 pr-3">Total — {currency}</td>
            <td className="pt-2 pr-3" />
            <td className="pt-2 pr-3" />
            <td className="pt-2 pr-3" />
            <td className="pt-2 pr-3 text-right tabular-nums text-slate-500">{total?.lines ?? 0}</td>
            <td className="pt-2 text-right tabular-nums">{fmtMoney(total?.amount ?? 0, currency)}</td>
          </tr>
        </tfoot>
      </table>
      {report.unplaced > 0 && (
        <p className="mt-2 text-xs text-slate-500">
          {report.unplaced} line{report.unplaced === 1 ? '' : 's'} the record cannot place: the document states no
          destination and the customer no country. They are grouped under <em>Not stated</em> rather than left out.
        </p>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Price history
 * ------------------------------------------------------------------ */

/**
 * The three document kinds as a ramp of the one hue rather than three
 * colours, which is the dashboard's palette rule (*one hue carries the data*)
 * and happens to say something true here: a quotation becomes a proforma
 * becomes an order, so pale → deep reads as the chain moving forward.
 */
const DOC_TINT: Record<BookDoc, string> = {
  quotation: '#93c5fd',
  proforma: '#3b82f6',
  order: '#1d4ed8',
};

const PRICE_DOC_LABEL: Record<BookDoc, string> = {
  order: 'Sales Order',
  proforma: 'Proforma',
  quotation: 'Quotation',
};

const PRICE_DOC_PATH: Record<BookDoc, string> = {
  order: '/orders',
  proforma: '/proformas',
  quotation: '/quotations',
};

/**
 * A round step about a quarter of the span — 1, 2, 2.5 or 5 times a power of
 * ten, which is the set of intervals a price axis is actually read in.
 */
function niceStep(span: number): number {
  if (!(span > 0)) return 1;
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw)) ?? mag * 10;
}

/**
 * The y axis: the data's own range, padded, then widened to round numbers.
 * A single point (or a price that never moved) has no span of its own, so it
 * is given one rather than drawn on a flat line at the top of the card.
 */
function moneyAxis(min: number, max: number): { domain: [number, number]; ticks: number[] } {
  const span = max - min;
  const pad = span > 0 ? span * 0.15 : Math.max(Math.abs(max) * 0.1, 1);
  const step = niceStep((max + pad) - (min - pad));
  const lo = Math.floor((min - pad) / step) * step;
  const hi = Math.ceil((max + pad) / step) * step;
  const ticks: number[] = [];
  // Rounded on the way out: 0.1 + 0.2 arithmetic leaves a tick at 8449.999.
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { domain: [lo, hi], ticks };
}

/** `2026-03-04` → the millisecond, parsed as digits so no timezone touches it. */
function dayMs(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d) ? Date.UTC(y, m - 1, d) : NaN;
}

/** `Mar 25` — a price history is read by month, not by day. */
function monthTick(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
}

/**
 * A dot per point: filled where the document still stands, hollow where it
 * does not. That distinction is the one this chart exists for — a rejected
 * quotation is a price we asked and lost at, and drawing it the same as a
 * booked order would say we sold at it.
 */
function PriceDot(props: { cx?: number; cy?: number; payload?: PricePoint }) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || !payload) return null;
  const tint = DOC_TINT[payload.doc] ?? BLUE;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={payload.doc === 'order' ? 5 : 4}
      fill={payload.live ? tint : '#fff'}
      stroke={tint}
      strokeWidth={payload.live ? 1 : 2}
    />
  );
}

/**
 * What one product has been priced at, over time (2026-10-17, the user:
 * *"show me trends of rate per unit of product x sold to customer A in last 2
 * years along with date"*).
 *
 * **Every rate on the chart is per 1000 pieces**, which is the server's
 * normalisation and the only basis on which two lines quoted differently may
 * be compared at all — the axis says so, because a chart whose unit is
 * implied is one somebody will read in the wrong one.
 *
 * The line through the points is the trend in date order; the dots say which
 * document each price was on and whether that document still stands. One
 * currency at a time, the rule this whole page follows.
 */
function PriceChart({ report, currency, listUrl }: {
  report: PriceHistory;
  currency: string;
  listUrl: (path: string, extra?: Record<string, string>) => string;
}) {
  const series = report.series.find((s) => s.currency === currency);
  const held = report.incomparable.filter((p) => p.currency === currency);

  if (!series) {
    return (
      <EmptyState message={
        report.incomparable.length
          ? 'Nothing comparable in this currency. Every line of this product is quoted on a weight basis, which has no rate per 1000 pieces — they are listed below.'
          : 'No quotation, proforma or sales order has named this product in the period shown.'
      } />
    );
  }

  const data = series.points.map((p) => ({ ...p, t: dayMs(p.date) }));
  const axis = moneyAxis(series.min, series.max);
  const up = (series.change_pct ?? 0) > 0;

  return (
    <div className="space-y-3">
      <Card title={`Rate per 1000 pieces — ${currency}`}>
        {/* First to last, with the span under it. A single figure for the
            change would hide a book that swung and came back. */}
        <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <div>
            <div className={CAPTION_CLASS}>First → latest</div>
            <div className="text-lg font-semibold tabular-nums">
              {fmtMoney(series.first, currency)} <span className="text-slate-400">→</span> {fmtMoney(series.last, currency)}
              {series.change_pct != null && (
                <span className={`ml-2 text-sm font-medium ${up ? 'text-rose-600' : 'text-emerald-600'}`}>
                  {up ? '↑' : '↓'} {Math.abs(series.change_pct)}%
                </span>
              )}
            </div>
          </div>
          <div>
            <div className={CAPTION_CLASS}>Lowest</div>
            <div className="text-sm tabular-nums">{fmtMoney(series.min, currency)}</div>
          </div>
          <div>
            <div className={CAPTION_CLASS}>Highest</div>
            <div className="text-sm tabular-nums">{fmtMoney(series.max, currency)}</div>
          </div>
          <div>
            <div className={CAPTION_CLASS}>Points</div>
            <div className="text-sm tabular-nums">{series.points.length}</div>
          </div>
        </div>

        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
              <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
              {/* A real time axis, so two prices a fortnight apart are not
                  drawn as far apart as two a year apart. */}
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickFormatter={monthTick}
                tick={{ fontSize: 11 }}
                stroke="#94a3b8"
              />
              <YAxis
                domain={axis.domain}
                ticks={axis.ticks}
                tickFormatter={(v: number) => fmtMoneyRound(v, currency)}
                tick={{ fontSize: 11 }}
                width={82}
                stroke="#94a3b8"
              />
              <Tooltip content={<PriceTooltip currency={currency} />} />
              <Line
                type="linear"
                dataKey="per1000"
                stroke={BLUE_PALE}
                strokeWidth={2}
                isAnimationActive={false}
                dot={<PriceDot />}
                activeDot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-slate-500">
          {/* Only the kinds this login can actually be shown — a legend
              promising a mark that can never appear is the access rule
              leaking the other way. */}
          {(['quotation', 'proforma', 'order'] as BookDoc[]).filter((d) => report.included.includes(d)).map((d) => (
            <span key={d} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: DOC_TINT[d] }} />
              {PRICE_DOC_LABEL[d]}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-slate-400 bg-white" />
            Rejected, cancelled, lapsed or superseded — a price offered, not one sold at
          </span>
        </div>
      </Card>

      <Card title="Every price, newest first" className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className={TH_CLASS}>
              <th className="pb-2 pr-3">Date</th>
              <th className="pb-2 pr-3">Document</th>
              <th className="pb-2 pr-3">Customer</th>
              <th className="pb-2 pr-3">Colour</th>
              <th className="pb-2 pr-3 text-right">Qty</th>
              <th className="pb-2 pr-3 text-right">Rate as quoted</th>
              <th className="pb-2 pr-3 text-right">Per 1000 pcs</th>
              <th className="pb-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {[...series.points].reverse().map((p, i) => (
              <tr key={`${p.doc}-${p.doc_id}-${i}`} className="border-b border-slate-100">
                <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(p.date)}</td>
                <td className="py-2 pr-3 whitespace-nowrap">
                  <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: DOC_TINT[p.doc] }} />
                  <Link to={`${PRICE_DOC_PATH[p.doc]}/${p.doc_id}`} className="text-brand-600 hover:underline">{p.number}</Link>
                  <span className="ml-1 text-slate-400">{PRICE_DOC_LABEL[p.doc]}</span>
                </td>
                <td className="py-2 pr-3">
                  <Link to={listUrl(`/customers/${p.customer_id}`)} className="hover:underline">{p.customer_name}</Link>
                </td>
                <td className="py-2 pr-3">{p.color || <span className="text-slate-300">—</span>}</td>
                <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">
                  {p.pieces == null ? <span className="text-slate-300">—</span> : <>{fmtQty(p.pieces)} <span className="text-slate-400">pcs</span></>}
                </td>
                {/* Both figures, always: the stated rate is what the document
                    says and the normalised one is what the chart plots, and a
                    reader checking one against the other is the point. */}
                <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">
                  {fmtRate(p.unit_price, currency)} <span className="text-slate-400">{rateBasis(p.unit)}</span>
                </td>
                <td className="py-2 pr-3 text-right font-medium tabular-nums">{fmtMoney(p.per1000 ?? 0, currency)}</td>
                <td className="py-2">
                  {p.live
                    ? <span className="text-slate-500">{p.status}</span>
                    : <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500 ring-1 ring-slate-200">{p.status}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {held.length > 0 && (
        <Card title="Quoted on a weight basis">
          <p className="mb-2 text-xs text-slate-500">
            These lines state a real price and no comparable one — money divided by kilos is not a rate per 1000
            pieces, so they are listed rather than converted onto the chart above.
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className={TH_CLASS}>
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2 pr-3">Document</th>
                <th className="pb-2 pr-3">Customer</th>
                <th className="pb-2 pr-3 text-right">Qty</th>
                <th className="pb-2 text-right">Rate</th>
              </tr>
            </thead>
            <tbody>
              {held.map((p, i) => (
                <tr key={`h-${p.doc}-${p.doc_id}-${i}`} className="border-b border-slate-100">
                  <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(p.date)}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <Link to={`${PRICE_DOC_PATH[p.doc]}/${p.doc_id}`} className="text-brand-600 hover:underline">{p.number}</Link>
                    <span className="ml-1 text-slate-400">{PRICE_DOC_LABEL[p.doc]}</span>
                  </td>
                  <td className="py-2 pr-3">{p.customer_name}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{p.qty == null ? '—' : fmtQty(p.qty)} <span className="text-slate-400">{p.unit}</span></td>
                  <td className="py-2 text-right tabular-nums whitespace-nowrap">
                    {fmtRate(p.unit_price, currency)} <span className="text-slate-400">{rateBasis(p.unit)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

/** The document behind a point, which is what somebody hovering is asking about. */
function PriceTooltip({ active, payload, currency }: {
  active?: boolean;
  payload?: { payload: PricePoint }[];
  currency?: string;
}) {
  const p = active && payload?.length ? payload[0].payload : null;
  if (!p) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg">
      <div className="font-semibold text-slate-900">{fmtMoney(p.per1000 ?? 0, currency ?? p.currency)} <span className="font-normal text-slate-400">per 1000 pcs</span></div>
      <div className="mt-1 text-slate-600">{PRICE_DOC_LABEL[p.doc]} {p.number} · {fmtDate(p.date)}</div>
      <div className="text-slate-600">{p.customer_name}</div>
      <div className="mt-1 text-slate-500">
        {fmtRate(p.unit_price, currency ?? p.currency)} {rateBasis(p.unit)}
        {p.pieces != null && <> · {fmtQty(p.pieces)} pcs</>}
      </div>
      {!p.live && <div className="mt-1 text-amber-700">{p.status} — offered, not sold at</div>}
    </div>
  );
}
