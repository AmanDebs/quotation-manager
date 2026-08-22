import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Order, OrderStatus, OrderLine, ProductDemand, LineState } from '../types';
import { Button, Select, Input, PageHeader, EmptyState, Card, ExportTabs, ErrorText , Pagination} from '../components/ui';
import { useCompanies } from '../components/CompanySelect';
import { fmtDate, fmtMoney, fmtQty, today } from '../lib/format';
import { usePagedList, PAGE_SIZE, type PagedList } from '../lib/usePagedList';

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

/** Line state is derived, so it is shown as a label rather than a control. */
const LINE_STATE: Record<LineState, { label: string; className: string }> = {
  not_started: { label: 'Not started', className: 'bg-slate-100 text-slate-600' },
  in_production: { label: 'In production', className: 'bg-purple-100 text-purple-700' },
  made: { label: 'Made', className: 'bg-teal-100 text-teal-700' },
  part_shipped: { label: 'Part shipped', className: 'bg-amber-100 text-amber-800' },
  shipped: { label: 'Shipped', className: 'bg-green-100 text-green-700' },
};

type View = 'lines' | 'products' | 'orders';

const VIEWS: { key: View; label: string }[] = [
  { key: 'lines', label: 'Order lines' },
  { key: 'products', label: 'By product' },
  { key: 'orders', label: 'Orders' },
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
  const [statusFilter, setStatusFilter] = useState('');
  const [exportFilter, setExportFilter] = useState('');
  const [openOnly, setOpenOnly] = useState(false);

  const params = new URLSearchParams();
  if (statusFilter) params.set('status', statusFilter);
  if (exportFilter) params.set('export', exportFilter);
  if (companyFilter) params.set('company', companyFilter);
  if (openOnly) params.set('open', '1');
  if (q) params.set('q', q);
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
        title="Orders"
        subtitle="The order book — what's sold, what's in production, what's still to ship"
        actions={<Button onClick={() => navigate('/orders/new')}>+ New Order</Button>}
      />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              className={`rounded px-3 py-1 text-sm transition-colors ${
                view === v.key ? 'bg-brand-700 font-medium text-white' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
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
        {view !== 'orders' && (
          <Input
            className="max-w-56"
            placeholder="Search item, code or colour…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        )}
      </div>

      <ErrorText error={setStatus.error} />

      {view === 'lines' && (
        <LinesTable lines={lines} showCompany={showCompany} pager={lineList} />
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
          <Pagination
            page={orderList.page} pages={orderList.pages} total={orderList.total} limit={PAGE_SIZE}
            onPage={orderList.setPage} noun="orders"
          />
        </Card>
      )}
    </div>
  );
}

/** One row per item, the way the desk's own sheet reads. */
function LinesTable({ lines, showCompany, pager }: {
  lines: OrderLine[];
  showCompany: boolean;
  pager: PagedList<OrderLine>;
}) {
  const navigate = useNavigate();
  const t = today();

  return (
    <Card className="overflow-x-auto">
      {lines.length === 0 ? (
        <EmptyState message="No order lines match. Charge lines like freight are never listed here." />
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-2 pr-3">Order</th>
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2 pr-3">Customer</th>
                {showCompany && <th className="pb-2 pr-3">Issued By</th>}
                <th className="pb-2 pr-3">Item</th>
                <th className="pb-2 pr-3">Colour</th>
                <th className="pb-2 pr-3 text-right">Qty</th>
                <th className="pb-2 pr-3 text-right">Made</th>
                <th className="pb-2 pr-3 text-right">Sent</th>
                <th className="pb-2 pr-3">Promised</th>
                <th className="pb-2 pr-3">Added By</th>
                <th className="pb-2 pr-3">State</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                // The order number is printed once per order and dimmed on the
                // rows below it, so the eye groups them the way the sheet does.
                const repeat = i > 0 && lines[i - 1].order_id === l.order_id;
                const overdue = !!l.promised_date && l.promised_date < t && l.state !== 'shipped';
                return (
                  <tr
                    key={`${l.order_id}-${l.order_line}`}
                    className={`cursor-pointer border-slate-100 hover:bg-slate-50 ${repeat ? '' : 'border-t'}`}
                    onClick={() => navigate(`/orders/${l.order_id}`)}
                  >
                    <td className="py-1.5 pr-3 font-medium">
                      {repeat ? (
                        <span className="text-slate-300">↳</span>
                      ) : (
                        <Link to={`/orders/${l.order_id}`} className="text-brand-600" onClick={(e) => e.stopPropagation()}>
                          {l.order_number}
                        </Link>
                      )}
                    </td>
                    <td className={`whitespace-nowrap py-1.5 pr-3 ${repeat ? 'text-slate-300' : ''}`}>
                      {repeat ? '' : fmtDate(l.date)}
                    </td>
                    <td className={`py-1.5 pr-3 ${repeat ? 'text-slate-300' : ''}`}>
                      {repeat ? '' : l.customer_name}
                    </td>
                    {showCompany && (
                      <td className="py-1.5 pr-3 text-xs text-slate-500">{repeat ? '' : l.company_name ?? '—'}</td>
                    )}
                    <td className="py-1.5 pr-3">{l.description || '—'}</td>
                    <td className="py-1.5 pr-3 text-slate-500">{l.color || '—'}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{l.ordered ? fmtQty(l.ordered) : '—'}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-slate-500">{l.made ? fmtQty(l.made) : '—'}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-slate-500">
                      {l.sent || l.billed ? fmtQty(Math.max(l.sent, l.billed)) : '—'}
                    </td>
                    <td className={`whitespace-nowrap py-1.5 pr-3 ${overdue ? 'font-semibold text-red-600' : ''}`}>
                      {l.promised_date ? fmtDate(l.promised_date) : '—'}{overdue && ' ⚠'}
                    </td>
                    {/* A property of the order, not the line — printed once per
                        order like the number and the date above it. */}
                    <td className={`whitespace-nowrap py-1.5 pr-3 text-slate-500 ${repeat ? 'text-slate-300' : ''}`}>
                      {repeat ? '' : l.created_by_name || '—'}
                    </td>
                    <td className="py-1.5 pr-3">
                      <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${LINE_STATE[l.state].className}`}>
                        {LINE_STATE[l.state].label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-slate-400">
            {pager.total} line{pager.total === 1 ? '' : 's'}. Made, sent and state are worked out from the
            work orders, despatches and invoices recorded against each line — there is nothing here to keep
            up to date by hand.
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

/** The same lines folded up: what is on order per product, and what to run next. */
function DemandTable({ rows, onPick }: { rows: ProductDemand[]; onPick: (row: ProductDemand) => void }) {
  const t = today();

  return (
    <Card className="overflow-x-auto">
      {rows.length === 0 ? (
        <EmptyState message="Nothing on order." />
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-2 pr-3">Product</th>
                <th className="pb-2 pr-3">Code</th>
                <th className="pb-2 pr-3">Colour</th>
                <th className="pb-2 pr-3 text-right">On order</th>
                <th className="pb-2 pr-3 text-right">Made</th>
                <th className="pb-2 pr-3 text-right">Shipped</th>
                <th className="pb-2 pr-3 text-right">To ship</th>
                <th className="pb-2 pr-3 text-right">Orders</th>
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
          </p>
        </>
      )}
    </Card>
  );
}
