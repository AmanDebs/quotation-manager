import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Despatch, Location, Customer } from '../types';
import { PageHeader, Card, Select, Input, EmptyState, Pagination, DownloadButton, TH_CLASS } from '../components/ui';
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
 */

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

export default function DespatchesPage() {
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
        actions={<DownloadButton href={`/api/despatches/export${query.toString() ? `?${query}` : ''}`} />}
      />

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
            : 'Nothing recorded. Dispatches are entered from an order’s Dispatch tab.'} />
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
    </div>
  );
}
