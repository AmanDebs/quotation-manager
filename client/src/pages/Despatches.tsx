import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Despatch, Location, Customer, Order, ReadyLine } from '../types';
import { PageHeader, Card, Select, Input, Button, Modal, EmptyState, ErrorText, Pagination, DownloadButton, SearchSelect, SegmentedTabs, TH_CLASS } from '../components/ui';
import { useCan } from '../App';
import { fmtQty, fmtDate } from '../lib/format';
import { useUrlFilter } from '../lib/useUrlFilter';
import { usePagedList, PAGE_SIZE } from '../lib/usePagedList';

/**
 * The despatch register — the order desk's own sheet, roughly 465 lines a
 * month, with one column it could not have: which of these have not been
 * billed yet.
 *
 * It is a **mixed book**: a lorry to Hazipur and a container to Mogadishu are
 * both trips, and they are described by different facts. So the reference
 * column shows whichever the trip actually carries — BL and container for a
 * shipment, CN and vehicle for a lorry — the same shape the invoice page's
 * despatch card uses, rather than four columns that are blank half the time.
 *
 * **ETA and Documents draw only when the filtered book has any**, the rule the
 * order book's Dest port column follows: a purely domestic desk should not
 * gain two columns empty on every row for ever. The counts come from the
 * server's `summary`, which is measured over the **whole filtered set** — over
 * the page in hand the columns would appear and disappear as you paged.
 *
 * Every filter is server-side and lives in the URL. Server-side because the
 * list is paged, so filtering here would only ever filter the page; in the URL
 * because "shipments whose documents are still out" is a view somebody will
 * want to keep.
 *
 * **Since 2026-09-14 a dispatch is recorded here**, not on the sales order:
 * the client asked for the order's tab to be read-only and for this page to
 * sit between Sales Orders and Commercial Invoices, which is where a trip
 * belongs in the chain. Recording starts by naming the order — a trip is a
 * fact about an order's lines, and the dialog is filled from the order in
 * full — so `+ Record dispatch` asks which order first and then opens the
 * same dialog the tab used to. Edit and Delete sit on each row for whoever
 * holds `dispatch: full`; a row somebody may only view carries the challan.
 */

/**
 * Which order the trip is for, newest first. A cancelled or completed order
 * is left out — `completed` reads *Fully dispatched* and is measured on the
 * dispatch record since 2026-09-20, so it has nothing left to send. (Between
 * 2026-09-16 and then it was offered, `completed` being measured on the
 * invoice and the invoice regularly preceding the lorry on this desk.)
 */
function PickOrder({ onPick, onClose }: { onPick: (id: number) => void; onClose: () => void }) {
  const { data } = useQuery({
    queryKey: ['orders', 'for-dispatch'],
    queryFn: () => api.get<{ rows: Order[] }>('/api/orders?page=1&limit=500'),
  });
  const [value, setValue] = useState('');
  const open = (data?.rows ?? []).filter((o) => o.status !== 'cancelled' && o.status !== 'completed');
  return (
    <Modal title="Record a dispatch" onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600">Which sales order is this dispatch against?</p>
      <SearchSelect
        value={value}
        onChange={setValue}
        placeholder="Search sales order or customer…"
        options={open.map((o) => ({ value: String(o.id), label: o.number, hint: o.customer_name ?? '' }))}
      />
      {data && open.length === 0 && (
        <p className="mt-2 text-sm text-slate-500">No open sales orders. A dispatch is recorded against an order that still has goods to send.</p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={!value} onClick={() => onPick(Number(value))}>Next</Button>
      </div>
    </Modal>
  );
}

interface Summary {
  trips: number; pieces: number; boxes: number; unbilled: number;
  with_eta: number; with_docs: number; docs_pending: number;
}

const EMPTY: Summary = {
  trips: 0, pieces: 0, boxes: 0, unbilled: 0, with_eta: 0, with_docs: 0, docs_pending: 0,
};

/** How a trip is identified: whichever references it actually carries. */
function reference(d: Despatch): string {
  const sea = [d.bl_no, d.container_no].filter(Boolean).join(' · ');
  const road = [d.cn_no, d.vehicle_no].filter(Boolean).join(' · ');
  return [sea, road].filter(Boolean).join(' · ');
}

/** Blank is not "no documents" but "not sent yet", which is the state to chase. */
function DocsCell({ d }: { d: Despatch }) {
  const isShipment = !!(d.bl_no || d.container_no || d.etd || d.eta);
  if (!isShipment) return <span className="text-slate-300">—</span>;
  if (d.docs_status === 'received') return <span className="text-green-700">Received</span>;
  const method = d.docs_method === 'telex' ? ' (telex)' : d.docs_method === 'courier' ? ' (courier)' : '';
  return d.docs_status === 'sent'
    ? <span className="text-amber-700">{`Sent${method}`}</span>
    : <span className="text-rose-700">Not sent</span>;
}

/**
 * *Ready to dispatch* — what can be loaded onto a lorry now.
 *
 * Asked for 2026-10-08: the floor books a shift, the job finishes itself, and
 * until this nothing told Logistics. **Every figure here is the server's**,
 * from the same guards `POST /despatches` runs, so a row that says it can go
 * can go — and a held row carries the sentence the save itself would give
 * rather than a copy of it.
 *
 * Since the same day it also waits on the **sales desk's release** (the
 * client: *"if he approves then it should go to ready to dispatch tab"*), so a
 * line reaches *Ready to load* only once the SPOC has signed it off.
 *
 * Held rows are drawn **under** the live ones rather than hidden: goods
 * waiting on an unpaid advance — or on the desk's release — are waiting on
 * Sales rather than on the floor, and a queue that simply omitted them would
 * leave finished goods sitting in the yard with nothing on any screen to say
 * why.
 */
function ReadyToDispatch() {
  const can = useCan();
  const navigate = useNavigate();
  const { data, isPending } = useQuery({
    queryKey: ['despatches', 'ready'],
    queryFn: () => api.get<{ rows: ReadyLine[]; ready: number; held: number; awaiting: number }>('/api/despatches/ready'),
  });
  const rows = data?.rows ?? [];
  const live = rows.filter((r) => r.ready > 0 && !r.held);
  const held = rows.filter((r) => r.held);

  if (isPending) return <Card><p className="text-sm text-slate-400">Working out what can go…</p></Card>;

  return (
    <div className="space-y-4">
      <Card title={`Ready to load${live.length ? ` · ${live.length}` : ''}`}>
        {live.length === 0 ? (
          <EmptyState message="Nothing is ready to dispatch. A line appears here once the floor has made some of it, it has passed QC, the order's own payment terms have been met and the order's SPOC has released it. A bought-in item is not made here, so it never appears — record its trip from the register." />
        ) : (
          <ReadyTable rows={live} canLink={can('work_order')} onRecord={(id) => navigate(`/despatches/new?order=${id}`)} />
        )}
      </Card>

      {held.length > 0 && (
        <Card title={`Held · ${held.length}`}>
          <p className="mb-2 text-xs text-slate-500">
            Made, but something is still in the way. These are not counted on the sidebar — the badge
            only ever says what can actually be loaded.
          </p>
          <ReadyTable rows={held} canLink={can('work_order')} />
        </Card>
      )}
    </div>
  );
}

/**
 * *Awaiting approval* — the sales desk's half of the same queue.
 *
 * Asked for 2026-10-08: *"When a product is ready, it should be first be
 * approved by the SPOC of that order, if he approves then it should go to
 * ready to dispatch tab so that logistic person can record dispatch."*
 *
 * **Nobody types a figure.** The button releases exactly what the floor has
 * made and not yet sent, which is the figure the row is already showing — so
 * the ordinary press is one click, and making more later brings the excess
 * back here rather than going out on an approval nobody gave it.
 *
 * A line this login may not release is drawn with the reason in place of the
 * button. `may_approve` is the server's own answer rather than a copy of the
 * rule — two readings of who the SPOC is would be two policies.
 */
function AwaitingApproval() {
  const can = useCan();
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery({
    queryKey: ['orders', 'dispatch-approval'],
    queryFn: () => api.get<{ rows: ReadyLine[]; awaiting: number }>('/api/orders/dispatch-approval'),
  });
  const release = useMutation({
    mutationFn: (v: { orderId: number; lines: { order_line: number }[] }) =>
      api.post(`/api/orders/${v.orderId}/dispatch-approval`, { lines: v.lines }),
    onSuccess: () => {
      /* Both queues and both badges move together: this is one answer read by
         two audiences, so releasing on one side must not leave the other
         saying something else. */
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['despatches'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
  const rows = data?.rows ?? [];
  /* One button per order as well as per line, because that is how a desk signs
     off — one customer, one shipment, every line of it at once. Only drawn
     where there is more than one line to save a press on. */
  const orders = [...new Set(rows.filter((r) => r.may_approve).map((r) => r.order_id))];

  if (isPending) return <Card><p className="text-sm text-slate-400">Working out what is waiting…</p></Card>;

  return (
    <div className="space-y-4">
      <ErrorText error={release.error} />
      <Card title={`Awaiting release${rows.length ? ` · ${rows.length}` : ''}`}>
        {rows.length === 0 ? (
          <EmptyState message="Nothing is waiting. A line appears here as soon as the floor has made some of it, and leaves when it is released for dispatch or the goods go." />
        ) : (
          <>
            <p className="mb-2 text-xs text-slate-500">
              The floor has made these and Logistics cannot load them yet. Releasing a line sends
              exactly what has been made to the Ready to dispatch queue; make more afterwards and
              the rest comes back here.
            </p>
            <ReadyTable
              rows={rows}
              canLink={can('work_order')}
              busy={release.isPending}
              onRelease={(orderId, line) => release.mutate({ orderId, lines: [{ order_line: line }] })}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              {orders.map((orderId) => {
                const mine = rows.filter((r) => r.order_id === orderId && r.may_approve);
                if (mine.length < 2) return null;
                return (
                  <Button
                    key={orderId}
                    variant="secondary"
                    disabled={release.isPending}
                    onClick={() => release.mutate({ orderId, lines: mine.map((r) => ({ order_line: r.order_line })) })}
                  >
                    {`Release all ${mine.length} lines on ${mine[0].order_number}`}
                  </Button>
                );
              })}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

/**
 * One row per order line, read by both queues.
 *
 * One table rather than two, the call `AccessGrid` records about its own two
 * views: the figures and their meaning are identical and only the action at
 * the end of the row differs — `onRecord` for Logistics, `onRelease` for the
 * desk, and neither on a row that is merely being explained.
 */
function ReadyTable({ rows, canLink, onRecord, onRelease, busy }: {
  rows: ReadyLine[];
  canLink: boolean;
  onRecord?: (orderId: number) => void;
  onRelease?: (orderId: number, line: number) => void;
  busy?: boolean;
}) {
  /*
   * Each of the three is drawn only where the rows actually have one, the
   * *Dest Port* rule: on the desk's tab *Ready* would otherwise be a column of
   * dashes, and on Logistics' *Awaiting* would be — while a row carrying both
   * is exactly the one worth seeing on either (twelve lakh released, five made
   * since). SPOC likewise: on a book where nobody filled the field in it would
   * be a column of dashes for ever.
   */
  const showReady = rows.some((r) => r.ready > 0);
  const showAwaiting = rows.some((r) => r.awaiting > 0);
  const showSpoc = rows.some((r) => r.spoc);
  const cols = 7 + (showReady ? 1 : 0) + (showAwaiting ? 1 : 0) + (showSpoc ? 1 : 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className={TH_CLASS}>
            <th className="pb-2 pr-3">Sales Order</th>
            <th className="pb-2 pr-3">Customer</th>
            {showSpoc && <th className="pb-2 pr-3">SPOC</th>}
            <th className="pb-2 pr-3">Item</th>
            <th className="pb-2 pr-3">Colour</th>
            <th className="pb-2 pr-3">Work Order</th>
            {showReady && <th className="pb-2 pr-3 text-right">Ready</th>}
            {showAwaiting && <th className="pb-2 pr-3 text-right">Awaiting</th>}
            <th className="pb-2 pr-3 text-right">Ordered</th>
            <th className="pb-2 pr-3 text-right">Sent</th>
            <th className="pb-2" />
          </tr>
        </thead>
        {rows.map((r) => (
          /* One tbody per line so a held row can carry its reason on a second
             row of its own, under the figures it explains. */
          <tbody key={`${r.order_id}:${r.order_line}`} className="border-b border-slate-100 last:border-0">
            <tr className={`align-top ${r.held ? 'text-slate-400' : ''}`}>
              <td className="whitespace-nowrap py-2 pr-3 font-medium">
                <Link to={`/orders/${r.order_id}`} className="text-brand-700 hover:underline">{r.order_number}</Link>
              </td>
              <td className="max-w-[12rem] truncate py-2 pr-3" title={r.customer_name}>{r.customer_name}</td>
              {/* Whose order it is — the name on the paperwork, which is who
                  releases it. Six desk names, so the cell never wraps. */}
              {showSpoc && (
                <td className="whitespace-nowrap py-2 pr-3">{r.spoc || <span className="text-slate-300">—</span>}</td>
              )}
              {/* The catalogue product, with the line's own wording on hover —
                  the rule the order book and the Work Orders list follow. */}
              <td className="max-w-[14rem] truncate py-2 pr-3" title={r.description || undefined}>
                {r.product_name || r.description || '—'}
              </td>
              <td className="whitespace-nowrap py-2 pr-3">{r.color || <span className="text-slate-300">—</span>}</td>
              {/* The half the client asked to be connected. A job a login
                  cannot open is named rather than linked — a link that only
                  ever answers 403 is worse than plain text. The dash is
                  defensive: output implies a live job, so every row has one. */}
              <td className="whitespace-nowrap py-2 pr-3">
                {r.jobs.length === 0
                  ? <span className="text-slate-300">—</span>
                  : r.jobs.map((j, i) => (
                    <span key={j.id}>
                      {i > 0 && <span className="text-slate-300">, </span>}
                      {canLink
                        ? <Link to={`/work-orders/${j.id}`} className="text-brand-700 hover:underline">{j.number}</Link>
                        : j.number}
                    </span>
                  ))}
              </td>
              {/* Who released it rides on hover rather than taking a column:
                  it is the answer to a question somebody asks about one row,
                  not something read down the table. */}
              {showReady && (
                <td
                  className="py-2 pr-3 text-right font-semibold tabular-nums"
                  title={r.approved_by_name ? `Released by ${r.approved_by_name} on ${fmtDate(r.approved_at.slice(0, 10))}` : undefined}
                >
                  {r.ready ? fmtQty(r.ready) : <span className="font-normal text-slate-300">—</span>}
                </td>
              )}
              {showAwaiting && (
                <td className="py-2 pr-3 text-right font-semibold tabular-nums text-amber-700">
                  {r.awaiting ? fmtQty(r.awaiting) : <span className="font-normal text-slate-300">—</span>}
                </td>
              )}
              <td className="py-2 pr-3 text-right tabular-nums text-slate-500">{fmtQty(r.ordered)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                {r.sent ? fmtQty(r.sent) : <span className="text-slate-300">—</span>}
              </td>
              <td className="whitespace-nowrap py-2 text-right">
                {onRelease
                  ? (r.may_approve
                    ? <Button variant="ghost" disabled={busy} onClick={() => onRelease(r.order_id, r.order_line)}>Release</Button>
                    : <span className="text-xs text-slate-400">Not yours</span>)
                  : onRecord
                    ? <Button variant="ghost" onClick={() => onRecord(r.order_id)}>Record dispatch</Button>
                    : <span className="text-xs font-medium text-amber-700">Held</span>}
              </td>
            </tr>
            {/* The guard's own sentence, not a copy: this is what the save
                would refuse with, so the queue explains the rule rather than
                keeping a second version of it. On the desk's tab the row is
                instead explained by what the release would do. */}
            {(r.held || (onRelease && !r.may_approve)) && (
              <tr>
                <td colSpan={cols} className="pb-2 pr-3 text-xs text-amber-700">
                  {onRelease && !r.may_approve
                    ? `This sales order is handled by ${r.spoc}, so ${r.spoc} releases it for dispatch.`
                    : r.held}
                </td>
              </tr>
            )}
          </tbody>
        ))}
      </table>
    </div>
  );
}

export default function DespatchesPage() {
  const can = useCan();
  const canWrite = can('dispatch', 'full');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Recording is a page (`/despatches/new?order=N`); a new trip starts here by
  // picking the order it is for, an edit goes straight to the page.
  const [picking, setPicking] = useState(false);
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/despatches/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['despatches'] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
  /*
   * Two readings of one page, in the URL like the order book's three — the
   * register, and what is waiting to be loaded. Default is the register: that
   * is what this page has always been, and a page that opens somewhere else
   * after an update reads as a page that broke.
   */
  const [view, setView] = useUrlFilter('view');
  /*
   * Three now, and each is drawn for whoever it is *for* rather than for
   * everybody who can open the page. The desk releases finished goods
   * (`order: full` — Sales and the super admin) and Logistics loads them
   * (`dispatch: full`), so a Sales login sees Register and Awaiting approval
   * while Logistics sees Register and Ready to dispatch; each route refuses
   * the other's, so offering a tab that only 403s would be the
   * form-offers-what-the-API-refuses trap.
   */
  const canRelease = can('order', 'full');
  const ready = view === 'ready' && canWrite;
  const approving = view === 'approve' && canRelease;
  const [location, setLocation] = useUrlFilter('location_id');
  const [customer, setCustomer] = useUrlFilter('customer_id');
  const [from, setFrom] = useUrlFilter('from');
  const [to, setTo] = useUrlFilter('to');
  const [docs, setDocs] = useUrlFilter('docs');
  const [etaFrom, setEtaFrom] = useUrlFilter('eta_from');
  const [etaTo, setEtaTo] = useUrlFilter('eta_to');
  const [uninvoiced, setUninvoiced] = useUrlFilter('uninvoiced');
  const [q, setQ] = useUrlFilter('q');

  const query = new URLSearchParams();
  for (const [key, value] of [
    ['location_id', location], ['customer_id', customer], ['from', from], ['to', to],
    ['docs', docs], ['eta_from', etaFrom], ['eta_to', etaTo],
    ['uninvoiced', uninvoiced], ['q', q],
  ] as [string, string][]) if (value) query.set(key, value);

  const list = usePagedList<Despatch, Summary>(
    ['despatches', 'all', query.toString()],
    `/api/despatches?${query.toString()}`,
  );
  const trips = list.rows;
  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });
  const { data: customers = [] } = useQuery({ queryKey: ['customers', ''], queryFn: () => api.get<Customer[]>('/api/customers') });

  // Over every matching despatch, not the page on screen — see `summary` in
  // routes/despatches.ts.
  const totals = list.summary ?? { ...EMPTY, trips: trips.length };
  const showEta = totals.with_eta > 0;
  const showDocs = totals.with_docs > 0 || totals.docs_pending > 0;
  const filtered = !!(location || customer || from || to || docs || etaFrom || etaTo || uninvoiced || q);

  return (
    <div>
      <PageHeader
        title="Dispatches"
        subtitle="What has left the plants, what is still at sea, and what has not been billed yet"
        // The desk reconciles this sheet in Excel, so the register it is
        // compared against has to come out of here — through the same filters,
        // so the download cannot disagree with the table above it.
        actions={(
          <div className="flex items-center gap-2">
            {/* The register's own download — hidden on the other tab, where it
                would not match the screen it sits above. */}
            {!ready && !approving && <DownloadButton href={`/api/despatches/export${query.toString() ? `?${query}` : ''}`} />}
            {canWrite && <Button onClick={() => setPicking(true)}>+ Record dispatch</Button>}
          </div>
        )}
      />
      <ErrorText error={remove.error} />

      {/* The register alone is no choice to offer, so the control appears only
          once there is a second reading this login can actually open. */}
      {(canWrite || canRelease) && (
        <div className="mb-3">
          <SegmentedTabs
            value={ready ? 'ready' : approving ? 'approve' : 'register'}
            onChange={(v) => setView(v === 'register' ? '' : v)}
            tabs={[
              { key: 'register', label: 'Register' },
              ...(canRelease ? [{ key: 'approve', label: 'Awaiting approval' }] : []),
              ...(canWrite ? [{ key: 'ready', label: 'Ready to dispatch' }] : []),
            ]}
          />
        </div>
      )}

      {approving ? <AwaitingApproval /> : ready ? <ReadyToDispatch /> : (
      <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          className="w-64"
          placeholder="Search container, BL, CN, vehicle, order…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Select className="w-44" value={location} onChange={(e) => setLocation(e.target.value)}>
          <option value="">All plants</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
        <Select className="w-52" value={customer} onChange={(e) => setCustomer(e.target.value)}>
          <option value="">All customers</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-sm text-slate-400">to</span>
        <Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} />
        {/* The buyer cannot clear the goods without the documents, so where
            they have got to is tracked apart from where the goods have. */}
        <Select className="w-52" value={docs} onChange={(e) => setDocs(e.target.value)}>
          <option value="">Documents: any</option>
          <option value="pending">Still outstanding</option>
          <option value="sent">Sent, not received</option>
          <option value="received">Received</option>
        </Select>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={uninvoiced === '1'}
            onChange={(e) => setUninvoiced(e.target.checked ? '1' : '')}
          />
          Not billed yet
        </label>
      </div>

      {/* Arrivals are their own question — "what lands next week" is asked of
          the ETA, not of the despatch date, which is when it left. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-500">Arriving</span>
        <Input type="date" className="w-40" value={etaFrom} onChange={(e) => setEtaFrom(e.target.value)} />
        <span className="text-sm text-slate-400">to</span>
        <Input type="date" className="w-40" value={etaTo} onChange={(e) => setEtaTo(e.target.value)} />
        <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500">
          <span>
            {totals.trips} dispatch{totals.trips === 1 ? '' : 'es'} · {fmtQty(totals.pieces)} pcs · {fmtQty(totals.boxes)} boxes
          </span>
          {totals.docs_pending > 0 && (
            <button
              type="button"
              className="text-rose-700 hover:underline"
              onClick={() => setDocs('pending')}
            >
              {totals.docs_pending} awaiting documents
            </button>
          )}
          {totals.unbilled > 0 && (
            <button
              type="button"
              className="text-amber-700 hover:underline"
              onClick={() => setUninvoiced('1')}
            >
              {totals.unbilled} unbilled
            </button>
          )}
        </span>
      </div>

      <Card className="overflow-x-auto">
        {trips.length === 0 ? (
          <EmptyState message={filtered
            ? 'Nothing matches those filters'
            : (canWrite ? 'Nothing recorded yet. Press + Record dispatch to enter the first.' : 'Nothing recorded yet.')} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className={TH_CLASS}>
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2 pr-3">From</th>
                <th className="pb-2 pr-3">Sales Order</th>
                <th className="pb-2 pr-3">Customer</th>
                <th className="pb-2 pr-3">Destination</th>
                <th className="pb-2 pr-3">Transporter</th>
                <th className="pb-2 pr-3">Reference</th>
                {showEta && <th className="pb-2 pr-3">ETA</th>}
                {showDocs && <th className="pb-2 pr-3">Documents</th>}
                <th className="pb-2 pr-3 text-right">Pieces</th>
                <th className="pb-2 pr-3 text-right">Boxes</th>
                <th className="pb-2 pr-3">Invoice</th>
                {/* Named rather than left blank. The link under it was a bare
                    emoji in an unlabelled last column, which is a document
                    nobody can find — the order tab's copy says "Challan"
                    beside its icon and that is the half that was missing. */}
                <th className="pb-2">Challan</th>
                {canWrite && <th className="pb-2" />}
              </tr>
            </thead>
            <tbody>
              {trips.map((d) => {
                const pieces = (d.items ?? []).reduce((s, it) => s + (it.qty ?? 0), 0);
                const boxes = (d.items ?? []).reduce((s, it) => s + (it.packs ?? 0), 0);
                return (
                  <tr key={d.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(d.date)}</td>
                    <td className="py-2 pr-3 text-slate-500">{d.location_name ?? '—'}</td>
                    <td className="py-2 pr-3">
                      <Link to={`/orders/${d.order_id}`} className="text-brand-600 hover:underline">{d.order_number}</Link>
                    </td>
                    <td className="py-2 pr-3">{d.customer_name}</td>
                    <td className="py-2 pr-3">{d.destination || '—'}</td>
                    <td className="py-2 pr-3">{d.transporter_name ?? '—'}</td>
                    <td className="py-2 pr-3 text-xs text-slate-500">{reference(d) || '—'}</td>
                    {showEta && (
                      <td className="py-2 pr-3 whitespace-nowrap">{d.eta ? fmtDate(d.eta) : <span className="text-slate-300">—</span>}</td>
                    )}
                    {showDocs && <td className="py-2 pr-3 text-xs"><DocsCell d={d} /></td>}
                    <td className="py-2 pr-3 text-right tabular-nums">{pieces ? fmtQty(pieces) : '—'}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{boxes ? fmtQty(boxes) : '—'}</td>
                    <td className="py-2 pr-3">
                      {d.invoice_number
                        ? <span className="text-slate-600">{d.invoice_number}</span>
                        : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">not billed</span>}
                    </td>
                    {/* The document that went with the lorry, reprintable from
                        the register as well as from the order it belongs to. */}
                    <td className="whitespace-nowrap py-2">
                      <a
                        href={`/api/pdf/challan/${d.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg px-2 py-1 text-brand-600 hover:bg-brand-50 hover:underline"
                        title="Delivery challan — the document that travelled with this trip"
                      >📄 Print</a>
                    </td>
                    {canWrite && (
                      <td className="whitespace-nowrap py-2 text-right">
                        <Button variant="ghost" onClick={() => navigate(`/despatches/${d.id}/edit`)}>Edit</Button>
                        <Button
                          variant="danger"
                          className="ml-1 border-0"
                          onClick={() => { if (confirm('Delete this dispatch record?')) remove.mutate(d.id); }}
                        >
                          Delete
                        </Button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <Pagination
          page={list.page} pages={list.pages} total={list.total} limit={PAGE_SIZE}
          onPage={list.setPage} noun="dispatches"
        />
      </Card>
      </>
      )}

      {picking && (
        <PickOrder onClose={() => setPicking(false)} onPick={(orderId) => { setPicking(false); navigate(`/despatches/new?order=${orderId}`); }} />
      )}
    </div>
  );
}
