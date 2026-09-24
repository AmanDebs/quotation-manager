import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Order, OrderStatus, OrderLine, ProductDemand, LineState } from '../types';
import { Button, Select, Input, PageHeader, EmptyState, Card, ExportTabs, ErrorText, Pagination, DownloadButton, SegmentedTabs, TH_CLASS, MultiSelectFilter } from '../components/ui';
import { useCompanies } from '../components/CompanySelect';
import { fmtDate, fmtMoney, fmtQty, today } from '../lib/format';
import { usePagedList, PAGE_SIZE, type PagedList } from '../lib/usePagedList';
import { useCan } from '../App';
import { Icon } from '../components/icons';
import OrderImportModal from '../components/OrderImportModal';
import { ColumnFilter, isFiltered, type ColumnFilterValue, type FilterKind } from '../components/ColumnFilter';

/**
 * The columns of the *Sales order lines* view that carry a header filter, and
 * what each one offers (2026-09-24: *"Is it possible to add filter in header
 * of each column like in excel"*).
 *
 * The labels are the headings' own words and the keys are the server's — one
 * list, because a key the server does not know would draw a control that
 * filters nothing, and there is no error anywhere to say so.
 *
 * Every filter lives in the URL beside the status and the search term, so a
 * filtered book is a link somebody can send. A tick list is **newline**
 * separated rather than comma separated: these are customer names and item
 * descriptions off the client's own book, and *Bisleri International Pvt.
 * Ltd., Kolkata* is one value containing a comma.
 */
const LINE_FILTERS: { key: string; label: string; kind: FilterKind }[] = [
  { key: 'order_number', label: 'Sales Order', kind: 'values' },
  { key: 'date', label: 'Date', kind: 'dates' },
  { key: 'customer', label: 'Customer', kind: 'values' },
  { key: 'port', label: 'Dest Port', kind: 'values' },
  { key: 'item', label: 'Item', kind: 'values' },
  { key: 'color', label: 'Colour', kind: 'values' },
  { key: 'qty', label: 'Qty', kind: 'numbers' },
  { key: 'sent', label: 'Sent', kind: 'numbers' },
  { key: 'balance', label: 'Balance', kind: 'numbers' },
  { key: 'promised', label: 'Orig. Prod.', kind: 'dates' },
  { key: 'revised', label: 'Rev. Prod.', kind: 'dates' },
  { key: 'added_by', label: 'Added By', kind: 'values' },
  { key: 'state', label: 'State', kind: 'values' },
];

const FILTER_KIND = new Map(LINE_FILTERS.map((c) => [c.key, c.kind]));

/** The URL keys one column owns, so clearing it clears all of them. */
function filterKeys(key: string): string[] {
  return FILTER_KIND.get(key) === 'values'
    ? [`f.${key}`]
    : FILTER_KIND.get(key) === 'dates'
      ? [`f.${key}_from`, `f.${key}_to`]
      : [`f.${key}_min`, `f.${key}_max`];
}

/**
 * A dispatch is recorded from the book (asked for 2026-09-14: "a button to
 * record Dispatch on right side of state on every sales order"). It opens
 * the record-a-dispatch page for that order, behind `dispatch: full`. A
 * cancelled order gets no button, and since 2026-09-20 neither does a
 * *completed* one: `completed` reads **Fully dispatched** and is measured on
 * the dispatch record, so there is nothing left to send. (It kept the button
 * from 2026-09-16, when `completed` was measured on the invoice walk and a
 * fully billed order was exactly the one about to leave.) The lines view
 * also drops it once every line on the page has physically gone.
 */
const recordDispatchUrl = (orderId: number) => `/despatches/new?order=${orderId}`;
const CLOSED: ReadonlySet<string> = new Set(['cancelled', 'completed']);

export const ORDER_STATUSES: OrderStatus[] = [
  'pending', 'confirmed', 'scheduled', 'in_production', 'ready', 'partially_dispatched', 'completed', 'cancelled',
];

/**
 * What a picker offers: `confirmed` — *Work Order* — is **retired, not
 * removed** (2026-09-11), the quotation's own call about `sent`. It meant "a
 * job has been raised", and every order now raises its jobs when it is
 * booked, so the rung says nothing. It stays in `ORDER_STATUSES` — labelled,
 * tinted, filterable, counted on the dashboard — because rows on file still
 * hold it and a status you cannot filter for is a row you cannot find. A
 * picker on such a row keeps it as an option so the control can show what is
 * there; nothing else is ever offered it.
 */
const RETIRED: ReadonlySet<string> = new Set(['confirmed', 'in_production', 'ready']);
export const offeredStatuses = (current?: string): OrderStatus[] =>
  ORDER_STATUSES.filter((s) => !RETIRED.has(s) || s === current);
/**
 * What the list's filter offers (2026-09-20, the client: "add these status
 * checkboxes in sales order filter"): the four the row reads plus Cancelled.
 * A retired status is not offered a box — the client's list has no word for
 * it — but *All statuses*, the default, still shows every row on file.
 */
const FILTER_STATUSES: OrderStatus[] = offeredStatuses();
/**
 * What the picker ticks with nothing asked for (the client: "These 3
 * checkboxes should be clicked by default") — the open book. The server
 * reads a blank as *not completed or cancelled*, so a row holding a retired
 * status is on the list too, though it has no box to tick.
 */
const OPEN_STATUSES: OrderStatus[] = ['pending', 'scheduled', 'partially_dispatched'];

/**
 * The order's vocabulary, where it differs from the value that is stored.
 *
 * `confirmed` reads **Work Order** (Aglo, 2026-09-07): what the desk means by
 * that step is that the job has been raised, not merely that the buyer said
 * yes — the buyer's yes is the proforma's *Order Confirmed*, one document
 * upstream, and two steps called Confirmed on two documents is how the two get
 * read for each other.
 *
 * A **display layer**, deliberately, and the same call the quotation makes in
 * labelling `accepted` as *Proforma Generated*. `orders.status` carries a CHECK
 * constraint listing all eight values, SQLite cannot ALTER one, and renaming
 * the stored string would mean rebuilding the table and rewriting every live
 * row — for wording. The string is also load-bearing in `orderStatus.ts`'s
 * forward-only ladder and in the list filters, none of which changes here.
 *
 * One consequence to know: the spreadsheet export writes the **stored** value,
 * so a downloaded order book says `confirmed` where the screen says Work Order.
 * That is how the export already reads for every status — it writes
 * `in_production`, not "In production" — so it stays uniform rather than
 * gaining one prettified special case.
 */
/*
 * The row reads **Not Scheduled → Scheduled → Partially dispatched → Fully
 * Dispatched** since 2026-09-20 (the client: *"Make this status as Not
 * Scheduled >> Scheduled >> Partially dispatched >> Fully Dispatched"*) —
 * the order line's own vocabulary, read for the whole order. `pending` and
 * `completed` are relabelled; `in_production` and `ready` are retired
 * alongside `confirmed` (folded into Scheduled by the ladder, offered only
 * on a row still holding one) and keep their labels for those rows.
 */
const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: 'Not scheduled',
  confirmed: 'Work Order',
  completed: 'Fully dispatched',
};

export const orderStatusLabel = (s: string) =>
  ORDER_STATUS_LABELS[s] ?? s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const statusTint: Record<string, string> = {
  pending: 'bg-slate-50 text-slate-700 border-slate-200',
  confirmed: 'bg-blue-50 text-blue-700 border-blue-200',
  scheduled: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  in_production: 'bg-purple-50 text-purple-700 border-purple-200',
  ready: 'bg-teal-50 text-teal-700 border-teal-200',
  partially_dispatched: 'bg-amber-50 text-amber-800 border-amber-200',
  completed: 'bg-green-50 text-green-700 border-green-200',
  cancelled: 'bg-red-50 text-red-700 border-red-200',
};

/** Line state is derived, so it is shown as a label rather than a control. */
const LINE_STATE: Record<LineState, { label: string; className: string }> = {
  not_scheduled: { label: 'Not scheduled', className: 'bg-slate-50 text-slate-600 ring-slate-200' },
  scheduled: { label: 'Scheduled', className: 'bg-blue-50 text-blue-700 ring-blue-200' },
  partially_dispatched: { label: 'Partially dispatched', className: 'bg-amber-50 text-amber-800 ring-amber-200' },
  fully_dispatched: { label: 'Fully dispatched', className: 'bg-green-50 text-green-700 ring-green-200' },
};

type View = 'lines' | 'products' | 'orders';

const VIEWS: { key: View; label: string }[] = [
  { key: 'lines', label: 'Sales order lines' },
  { key: 'products', label: 'By product' },
  { key: 'orders', label: 'Sales orders' },
];

/**
 * The order book, read three ways.
 *
 * **Order lines** is the default because it is how the desk's own sheet reads —
 * the order number repeating down the rows, one line per item and colour. **By
 * product** folds those same lines up to answer what to run next. **Orders**
 * is the per-order table, kept because it owns the money and the status
 * control, which neither line view should carry.
 *
 * Every figure in the two new views is derived on the server from what has been
 * made, despatched and invoiced. Nothing here is typed, which is why a line's
 * state is a label rather than a dropdown.
 */
export default function OrdersPage() {
  const companies = useCompanies();
  const showCompany = companies.length > 1;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // The view lives in the URL so a filtered product view can be bookmarked and
  // the back button behaves.
  const [search, setSearch] = useSearchParams();
  const view = (search.get('view') as View) ?? 'lines';
  const q = search.get('q') ?? '';
  const setView = (v: View) => {
    const next = new URLSearchParams(search);
    if (v === 'lines') next.delete('view'); else next.set('view', v);
    setSearch(next, { replace: true });
  };
  const setQ = (value: string) => {
    const next = new URLSearchParams(search);
    if (value) next.set('q', value); else next.delete('q');
    setSearch(next, { replace: true });
  };

  const [companyFilter, setCompanyFilter] = useState('');
  // In the URL rather than component state, so the dashboard's links
  // (`?status=`, `?open=1`) land on the filter they name and a filtered
  // book can be bookmarked. `open` reads `'1'` or nothing.
  const statusFilter = search.get('status') ?? '';
  // `?open=1` is what the dashboard's links say; it is the blank default now
  // (the open book), so the tick that used to set it is gone.
  const openOnly = search.get('open') === '1';
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value); else next.delete(key);
    setSearch(next, { replace: true });
  };
  const setStatusFilter = (v: string) => setParam('status', v);
  const [exportFilter, setExportFilter] = useState('');
  const [importing, setImporting] = useState(false);
  const can = useCan();
  const canDispatch = can('dispatch', 'full');

  /*
   * The header filters, read off the URL.
   *
   * A tick list is **present-and-empty when the blank value alone is ticked**
   * — `f.color=` means *the lines with no colour*, and no key at all means no
   * filter. `URLSearchParams.get` tells the two apart (`''` against `null`),
   * which is why `setParam` above cannot be reused to write them: it drops an
   * empty value, and that would silently throw the blank tick away on the
   * round trip somebody makes by copying the link.
   */
  const columnFilter = (key: string): ColumnFilterValue | undefined => {
    const kind = FILTER_KIND.get(key);
    if (kind === 'values') {
      const raw = search.get(`f.${key}`);
      return raw === null ? undefined : { values: raw.split('\n') };
    }
    const [lo, hi] = filterKeys(key);
    const from = search.get(lo) ?? '';
    const to = search.get(hi) ?? '';
    return from || to ? { from, to } : undefined;
  };

  const setColumnFilter = (key: string, v: ColumnFilterValue) => {
    const next = new URLSearchParams(search);
    for (const k of filterKeys(key)) next.delete(k);
    if (FILTER_KIND.get(key) === 'values') {
      if (v.values?.length) next.set(`f.${key}`, v.values.join('\n'));
    } else {
      const [lo, hi] = filterKeys(key);
      if (v.from) next.set(lo, v.from);
      if (v.to) next.set(hi, v.to);
    }
    setSearch(next, { replace: true });
  };

  const filteredColumns = LINE_FILTERS.filter((c) => isFiltered(columnFilter(c.key)));
  const clearColumnFilters = () => {
    const next = new URLSearchParams(search);
    for (const c of LINE_FILTERS) for (const k of filterKeys(c.key)) next.delete(k);
    setSearch(next, { replace: true });
  };

  const params = new URLSearchParams();
  if (statusFilter) params.set('status', statusFilter);
  if (exportFilter) params.set('export', exportFilter);
  if (companyFilter) params.set('company', companyFilter);
  if (openOnly) params.set('open', '1');
  if (q) params.set('q', q);
  // Carried on every view and on the download, so the spreadsheet holds what
  // the screen held — `lineFilters` on the server reads one set of keys for
  // the lines, the per-product fold and the export alike.
  for (const c of LINE_FILTERS) {
    const v = columnFilter(c.key);
    if (!v) continue;
    if (c.kind === 'values') { if (v.values) params.set(`f.${c.key}`, v.values.join('\n')); }
    else {
      const [lo, hi] = filterKeys(c.key);
      if (v.from) params.set(lo, v.from);
      if (v.to) params.set(hi, v.to);
    }
  }
  const query = params.toString();

  // `view` rides in each key so that switching views starts at page 1 — page 3
  // of the orders is not page 3 of the lines, and the two share one URL key.
  const orderList = usePagedList<Order>(
    ['orders', view, query], `/api/orders${query ? `?${query}` : ''}`, { enabled: view === 'orders' },
  );
  const lineList = usePagedList<OrderLine>(
    ['order-lines', view, query], `/api/orders/lines${query ? `?${query}` : ''}`, { enabled: view === 'lines' },
  );
  const orders = orderList.rows;
  const lines = lineList.rows;
  // The per-product view is deliberately not paged: it folds every matching
  // line into one row per product, and a total over one page of lines is not
  // the total. It is bounded by the catalogue rather than by trading volume.
  const { data: demand = [] } = useQuery({
    queryKey: ['order-demand', query],
    queryFn: () => api.get<ProductDemand[]>(`/api/orders/by-product${query ? `?${query}` : ''}`),
    enabled: view === 'products',
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
        title="Sales Orders"
        subtitle="The sales order book — what's sold, what's in production, what's still to ship"
        actions={
          <div className="flex items-center gap-2">
            <DownloadButton href={`/api/orders/export?view=${view}${query ? `&${query}` : ''}`} />
            {/* Booking a backlog is booking orders, so it sits behind the same
                cell as the button beside it. */}
            {can('order', 'full') && (
              <Button variant="secondary" onClick={() => setImporting(true)} className="inline-flex items-center gap-1.5">
                <Icon name="upload" /> Import Orders
              </Button>
            )}
            <Button onClick={() => navigate('/orders/new')}>+ New Sales Order</Button>
          </div>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <SegmentedTabs value={view} onChange={setView} tabs={VIEWS} />
        <ExportTabs value={exportFilter} onChange={setExportFilter} />
        {showCompany && (
          <Select value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)} className="max-w-56">
            <option value="">All companies</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.company_name || `Company ${c.id}`}</option>
            ))}
          </Select>
        )}
        <MultiSelectFilter
          options={FILTER_STATUSES.map((s) => ({ key: s, label: orderStatusLabel(s) }))}
          value={statusFilter}
          onChange={setStatusFilter}
          defaultLabel="Open orders"
          defaultKeys={OPEN_STATUSES}
          allLabel="All statuses"
        />
        {/*
          * Shown on all three views. It used to be hidden on Orders, because
          * the per-order list could not answer it — which meant a term typed
          * on one tab silently stopped applying when you switched to another.
          * `orderSearchClause` now gives all three the same six columns, so
          * the box means one thing wherever it is used and can always be here.
          */}
        <Input
          className="max-w-64"
          placeholder="Search sales order no., PO no., customer or item…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <ErrorText error={setStatus.error} />

      {/*
        Which columns are filtered, said above the table rather than left to be
        read off thirteen headings — and it is drawn on every view, because the
        per-product fold and the download obey these filters too, and a figure
        narrowed by a filter whose control is on another tab is exactly the
        kind of wrong somebody finds in a meeting.
      */}
      {filteredColumns.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-slate-500">Filtered by</span>
          {filteredColumns.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setColumnFilter(c.key, {})}
              title={`Clear the ${c.label} filter`}
              className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 font-medium text-brand-700 ring-1 ring-inset ring-brand-600/20 hover:bg-brand-100"
            >
              {c.label}
              <span aria-hidden="true" className="text-brand-600/60">×</span>
            </button>
          ))}
          <button type="button" onClick={clearColumnFilters} className="text-slate-500 underline hover:text-brand-600">
            Clear all
          </button>
        </div>
      )}

      {view === 'lines' && (
        <LinesTable lines={lines} pager={lineList} filters={{ get: columnFilter, set: setColumnFilter, query }} />
      )}
      {view === 'products' && (
        <DemandTable
          rows={demand}
          onPick={(row) => { setQ(row.description); setView('lines'); }}
        />
      )}

      {view === 'orders' && (
        <Card className="overflow-x-auto">
          {orders.length === 0 ? (
            <EmptyState message={statusFilter || exportFilter || companyFilter || openOnly
              ? 'Nothing matches those filters.'
              : 'No open sales orders. Fully dispatched and cancelled ones are hidden — pick “All statuses” to include them.'} />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className={TH_CLASS}>
                  <th className="pb-2 pr-3">Sales Order No.</th>
                  <th className="pb-2 pr-3">Date</th>
                  <th className="pb-2 pr-3">Customer</th>
                  {showCompany && <th className="pb-2 pr-3">Issued By</th>}
                  <th className="pb-2 pr-3">Their PO</th>
                  <th className="pb-2 pr-3">Promised</th>
                  <th className="pb-2 pr-3 text-right">Value</th>
                  <th className="pb-2 pr-3 text-right">Pending</th>
                  <th className="pb-2 pr-3">Status</th>
                  {canDispatch && <th className="pb-2" />}
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50" onClick={() => navigate(`/orders/${o.id}`)}>
                    <td className="py-2 pr-3 font-medium text-brand-600">
                      <Link to={`/orders/${o.id}`}>{o.number}</Link>
                      <span className="ml-1 text-xs text-slate-400">{o.is_export ? '🌍' : '🇮🇳'}</span>
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3">{fmtDate(o.date)}</td>
                    <td className="py-2 pr-3">{o.customer_name}</td>
                    {showCompany && (
                      <td className="py-2 pr-3 text-xs text-slate-500">{o.company_name ?? '—'}</td>
                    )}
                    <td className="py-2 pr-3">{o.po_number || '—'}</td>
                    <td className={`whitespace-nowrap py-2 pr-3 ${isOverdue(o) ? 'font-semibold text-red-600' : ''}`}>
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
                        {offeredStatuses(o.status).map((s) => (
                          <option key={s} value={s} className="bg-white text-slate-800">{orderStatusLabel(s)}</option>
                        ))}
                      </select>
                    </td>
                    {canDispatch && (
                      <td className="py-2 text-right" onClick={(e) => e.stopPropagation()}>
                        {!CLOSED.has(o.status) && (
                          <Button variant="secondary" className="px-2 py-0.5 text-xs" onClick={() => navigate(recordDispatchUrl(o.id))}>Record dispatch</Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Pagination
            page={orderList.page} pages={orderList.pages} total={orderList.total} limit={PAGE_SIZE}
            onPage={orderList.setPage} noun="orders"
          />
        </Card>
      )}

      {importing && <OrderImportModal onClose={() => setImporting(false)} />}
    </div>
  );
}

/** One row per item, the way the desk's own sheet reads. */
/*
 * Issued By, Made and In stock left this view on 2026-09-15 at the client's
 * word — the sheet is read for what is sold and what has gone. The per-order
 * and by-product views keep theirs, and the spreadsheet export is untouched.
 */
function LinesTable({ lines, pager, filters }: {
  lines: OrderLine[];
  pager: PagedList<OrderLine>;
  /** The header filters: what each column holds, how to set it, and the
   *  filters in force, which is what each tick list is measured against. */
  filters: {
    get: (key: string) => ColumnFilterValue | undefined;
    set: (key: string, v: ColumnFilterValue) => void;
    query: string;
  };
}) {
  const navigate = useNavigate();
  const t = today();
  const can = useCan();
  const canDispatch = can('dispatch', 'full');
  // A domestic book has no discharge port on any row, and a column that is
  // empty on every line for ever is worse than no column.
  const anyPort = lines.some((l) => l.port_of_discharge);

  /**
   * One heading, with its filter beside it.
   *
   * `whitespace-nowrap` and the flex are not decoration: the funnel is an
   * inline element inside a `<th>` narrow enough to wrap, and a heading broken
   * under its own control reads as a fault rather than as a control.
   */
  const head = (key: string, label: string, align: 'left' | 'right' = 'left', title?: string) => (
    <th key={key} className="whitespace-nowrap pb-2 pr-3" title={title}>
      <span className={`flex items-center gap-0.5 ${align === 'right' ? 'justify-end' : ''}`}>
        {label}
        <ColumnFilter
          column={key}
          kind={FILTER_KIND.get(key) ?? 'values'}
          label={title ?? label}
          value={filters.get(key)}
          onChange={(v) => filters.set(key, v)}
          query={filters.query}
        />
      </span>
    </th>
  );
  // Which order each row belongs to, counted from the top of the page, so
  // alternate orders can be tinted.
  const groupIndex = lines.reduce<number[]>((acc, l, i) => {
    acc.push(i === 0 ? 0 : acc[i - 1] + (lines[i - 1].order_id === l.order_id ? 0 : 1));
    return acc;
  }, []);
  const dash = <span className="text-slate-300">—</span>;
  // Orders whose every line on this page has physically gone — by the
  // dispatch record, not the invoice — so the button is not offered.
  const allSent = new Set(
    [...new Set(lines.map((l) => l.order_id))].filter((id) =>
      lines.filter((l) => l.order_id === id).every((l) => l.ordered > 0 && l.sent >= l.ordered)),
  );

  return (
    <Card className="overflow-x-auto">
      {lines.length === 0 ? (
        <EmptyState message="No order lines match. Charge lines like freight are never listed here." />
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className={TH_CLASS}>
                {/* Each heading carries its own filter, the spreadsheet habit
                    (2026-09-24). `head` keeps the funnel beside the words on
                    one line — a heading that wraps under its own control reads
                    as a fault — and every list is filled from the server,
                    since this table is one page of a long book. */}
                {head('order_number', 'Sales Order')}
                {head('date', 'Date')}
                {head('customer', 'Customer')}
                {/* Only where any row has one: a domestic book would carry an
                    empty column on every line for ever otherwise. */}
                {anyPort && head('port', 'Dest Port')}
                {head('item', 'Item')}
                {head('color', 'Colour')}
                {head('qty', 'Qty', 'right')}
                {head('sent', 'Sent', 'right')}
                {/* What is still to go: ordered less what has gone on a lorry
                    (2026-09-16, at the client's word). */}
                {head('balance', 'Balance', 'right')}
                {/* The order's two production dates (2026-09-15, at the
                    client's word, in place of the one Promised column): the
                    original, and the revised one where the plan has moved. */}
                {head('promised', 'Orig. Prod.', 'left', 'Original Production Date')}
                {head('revised', 'Rev. Prod.', 'left', 'Revised Production Date')}
                {head('added_by', 'Added By')}
                {head('state', 'State')}
                {canDispatch && <th className="pb-2" />}
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                // The order number is printed once per order and dimmed on the
                // rows below it, so the eye groups them the way the sheet does;
                // every second order is tinted so a three-line order reads as
                // one block rather than three rows that happen to touch.
                const repeat = i > 0 && lines[i - 1].order_id === l.order_id;
                const group = groupIndex[i];
                const tint = group % 2 === 1 ? 'bg-slate-50/70' : '';
                // Overdue is judged against the date that stands — the revised
                // one where set, else the original — and marked on that column.
                const due = l.revised_date || l.promised_date;
                const overdue = !!due && due < t && l.state !== 'fully_dispatched';
                // The dispatch record alone — an invoice is not a lorry (2026-09-16).
                const sent = l.sent;
                const balance = l.ordered ? Math.max(0, l.ordered - sent) : null;
                return (
                  <tr
                    key={`${l.order_id}-${l.order_line}`}
                    className={`cursor-pointer hover:bg-brand-50/60 ${tint} ${repeat ? '' : 'border-t border-slate-200'}`}
                    onClick={() => navigate(`/orders/${l.order_id}`)}
                  >
                    {/* A document number is one word; split across two lines it reads as two. */}
                    <td className="whitespace-nowrap py-2 pr-3 font-medium">
                      {repeat ? (
                        <span className="pl-1 text-slate-300">↳</span>
                      ) : (
                        <Link to={`/orders/${l.order_id}`} className="text-brand-600 hover:underline" onClick={(e) => e.stopPropagation()}>
                          {l.order_number}
                        </Link>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 text-slate-600">
                      {repeat ? '' : fmtDate(l.date)}
                    </td>
                    {/* One line, clipped, with the whole name on hover — a
                        three-line customer name made every row three lines tall. */}
                    <td className="max-w-[12rem] truncate py-2 pr-3" title={repeat ? undefined : l.customer_name}>
                      {repeat ? '' : l.customer_name}
                    </td>
                    {anyPort && (
                      <td className="whitespace-nowrap py-2 pr-3 text-slate-500">
                        {repeat ? '' : l.port_of_discharge || dash}
                      </td>
                    )}
                    {/* The catalogue product, not the line's wording (2026-09-16,
                        at the client's word) — the description is what was
                        typed on the document, on hover; a custom line has
                        only its description. */}
                    <td className="min-w-[13rem] py-2 pr-3" title={l.description}>{l.product_name || l.description || dash}</td>
                    <td className="whitespace-nowrap py-2 pr-3 text-slate-500">{l.color || dash}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{l.ordered ? fmtQty(l.ordered) : dash}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                      {sent ? fmtQty(sent) : dash}
                    </td>
                    <td className={`py-2 pr-3 text-right tabular-nums ${balance === 0 ? 'text-slate-400' : 'font-medium'}`}>
                      {balance == null ? dash : fmtQty(balance)}
                    </td>
                    <td className={`whitespace-nowrap py-2 pr-3 ${overdue && !l.revised_date ? 'font-semibold text-red-600' : 'text-slate-600'}`}>
                      {l.promised_date ? fmtDate(l.promised_date) : dash}{overdue && !l.revised_date && ' ⚠'}
                    </td>
                    <td className={`whitespace-nowrap py-2 pr-3 ${overdue && l.revised_date ? 'font-semibold text-red-600' : 'text-slate-600'}`}>
                      {l.revised_date ? fmtDate(l.revised_date) : dash}{overdue && !!l.revised_date && ' ⚠'}
                    </td>
                    {/* A property of the order, not the line — printed once per
                        order like the number and the date above it. */}
                    <td className="whitespace-nowrap py-2 pr-3 text-slate-500">
                      {repeat ? '' : l.created_by_name || dash}
                    </td>
                    <td className="py-2 pr-3">
                      <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${LINE_STATE[l.state].className}`}>
                        {LINE_STATE[l.state].label}
                      </span>
                    </td>
                    {/* Once per order, beside its first line: a trip is a fact
                        about the order, carrying every line at once. */}
                    {canDispatch && (
                      <td className="py-2 text-right" onClick={(e) => e.stopPropagation()}>
                        {!repeat && !CLOSED.has(l.order_status) && !allSent.has(l.order_id) && (
                          <Button variant="secondary" className="whitespace-nowrap px-2 py-0.5 text-xs" onClick={() => navigate(recordDispatchUrl(l.order_id))}>Record dispatch</Button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-slate-400">
            Sent and state are worked out from the work orders, despatches and invoices
            recorded against each line — there is nothing here to keep up to date by hand.
          </p>
          <Pagination
            page={pager.page} pages={pager.pages} total={pager.total} limit={PAGE_SIZE}
            onPage={pager.setPage} noun="lines"
          />
        </>
      )}
    </Card>
  );
}


/**
 * Finished goods on the shelf for a row's product. Drawn only when the server
 * sent the key — it withholds it from a caller without `fg` — and only when
 * some row has a figure, the `Dest Port` rule: a column empty on every line
 * for ever is worse than no column. Per product, not per line: nothing here
 * reserves stock to an order, so the same shelf prints against every open
 * line of that product, and the footnote says so.
 */
function StockCell({ value }: { value: number | null | undefined }) {
  if (value == null) return <td className="py-1.5 pr-3 text-right text-slate-300">—</td>;
  return (
    <td className={`py-1.5 pr-3 text-right tabular-nums ${value < 0 ? 'text-red-600' : value > 0 ? 'text-slate-700' : 'text-slate-400'}`}>
      {fmtQty(value)}
    </td>
  );
}
const anyStock = (rows: { in_stock?: number | null }[]) => rows.some((r) => r.in_stock != null);

/** The same lines folded up: what is on order per product, and what to run next. */
function DemandTable({ rows, onPick }: { rows: ProductDemand[]; onPick: (row: ProductDemand) => void }) {
  const t = today();
  const showStock = anyStock(rows);

  return (
    <Card className="overflow-x-auto">
      {rows.length === 0 ? (
        <EmptyState message="Nothing on order." />
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className={TH_CLASS}>
                <th className="pb-2 pr-3">Product</th>
                <th className="pb-2 pr-3">Code</th>
                <th className="pb-2 pr-3">Colour</th>
                <th className="pb-2 pr-3 text-right">On order</th>
                <th className="pb-2 pr-3 text-right">Made</th>
                <th className="pb-2 pr-3 text-right">Shipped</th>
                <th className="pb-2 pr-3 text-right">To ship</th>
                {showStock && <th className="pb-2 pr-3 text-right" title="Finished goods on the shelf, across every plant">In stock</th>}
                <th className="pb-2 pr-3 text-right">Sales orders</th>
                <th className="pb-2 pr-3">Next due</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const overdue = !!r.next_due && r.next_due < t;
                return (
                  <tr
                    key={r.key}
                    className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                    onClick={() => onPick(r)}
                    title="Show the individual order lines for this product"
                  >
                    <td className="py-2 pr-3 font-medium">{r.description || '—'}</td>
                    <td className="py-2 pr-3 text-slate-500">{r.code || '—'}</td>
                    <td className="py-2 pr-3 text-slate-500">{r.color || '—'}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{fmtQty(r.ordered)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-500">{r.made ? fmtQty(r.made) : '—'}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-green-700">{r.shipped ? fmtQty(r.shipped) : '—'}</td>
                    <td className={`py-2 pr-3 text-right tabular-nums ${r.to_ship > 0 ? 'font-semibold text-amber-700' : 'text-green-700'}`}>
                      {r.to_ship > 0 ? fmtQty(r.to_ship) : 'clear'}
                    </td>
                    {showStock && <StockCell value={r.in_stock} />}
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-500">{r.orders}</td>
                    <td className={`whitespace-nowrap py-2 pr-3 ${overdue ? 'font-semibold text-red-600' : ''}`}>
                      {r.next_due ? fmtDate(r.next_due) : '—'}{overdue && ' ⚠'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-slate-400">
            Ordered most-outstanding first. A line without a catalogue product groups by its description and
            colour, so a one-off still shows up as itself. Click a row for the orders behind it.
            {showStock && ' In stock is the shelf across every plant; against To ship it says what can go now and what still has to be made.'}
          </p>
        </>
      )}
    </Card>
  );
}
