import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Order, Despatch } from '../types';
import { Card, EmptyState, TH_CLASS } from './ui';
import { fmtQty, fmtMoney, fmtDate } from '../lib/format';
import { piecesOrdered } from '../lib/pieces';

/**
 * Made, sent, billed — three different questions, shown together.
 *
 * *Sent* is the physical record: what left the gate, recorded by whoever
 * loaded the lorry. *Billed* is the invoice walk, which is the money truth.
 * They are deliberately not reconciled to each other: a lorry can leave before
 * the paperwork, and a gap between the two columns is information, not an
 * error to be smoothed over.
 *
 * **Read-only since 2026-09-14**, at the client's word: a dispatch is
 * recorded, edited and deleted from the Dispatches page under Sales
 * (`components/DespatchModal.tsx` is where the dialog went). This tab is the
 * order's own view of what left and what was billed, and prints the challan.
 */

export default function DispatchTab({ order }: { order: Order }) {
  const key = ['despatches', String(order.id)];
  const { data: trips = [] } = useQuery({
    queryKey: key,
    queryFn: () => api.get<Despatch[]>(`/api/despatches?order_id=${order.id}`),
  });

  const items = order.items ?? [];
  const invoices = order.invoices ?? [];
  const proformas = order.proformas ?? [];

  return (
    <div className="space-y-4">
      <Card title="Made, sent and billed">
        {items.length === 0 ? (
          <EmptyState message="This order has no lines yet." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className={TH_CLASS}>
                <th className="pb-2 pr-3">Line</th>
                <th className="pb-2 pr-3 text-right">Ordered</th>
                <th className="pb-2 pr-3 text-right">Made</th>
                <th className="pb-2 pr-3 text-right">Sent</th>
                <th className="pb-2 pr-3 text-right">Boxes</th>
                <th className="pb-2 pr-3 text-right">Billed</th>
                <th className="pb-2 pr-3 text-right">Left to send</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => {
                const ordered = piecesOrdered(it) ?? 0;
                const sent = it.despatched?.qty ?? 0;
                const billed = it.qty_dispatched ?? 0;
                // Billed is in the line's billing unit; sent is pieces. Only
                // compared when the two are the same basis.
                const comparable = it.unit === 'unit' || it.unit === 'per 1000';
                return (
                  <tr key={i} className="border-b border-slate-100 last:border-0">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{it.description || `Line ${i + 1}`}</div>
                      {it.despatched && it.despatched.trips > 0 && (
                        <div className="text-xs text-slate-400">
                          {it.despatched.trips} dispatch{it.despatched.trips === 1 ? '' : 'es'}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{ordered ? fmtQty(ordered) : '—'}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                      {it.production && it.production.work_orders > 0 ? fmtQty(it.production.produced) : '—'}
                    </td>
                    <td className="py-2 pr-3 text-right font-medium tabular-nums">{sent ? fmtQty(sent) : '—'}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                      {it.despatched?.packs ? fmtQty(it.despatched.packs) : '—'}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                      {billed ? `${fmtQty(billed)} ${comparable ? '' : it.unit}` : '—'}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {ordered ? fmtQty(Math.max(0, ordered - sent)) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-slate-100 pt-2 text-sm">
          <span>Order value <strong className="tabular-nums">{fmtMoney(order.grand_total, order.currency)}</strong></span>
          <span>Billed <strong className="tabular-nums text-green-700">{fmtMoney(order.dispatched_value ?? 0, order.currency)}</strong></span>
          <span>Still to bill <strong className="tabular-nums text-amber-700">{fmtMoney(order.pending_value ?? 0, order.currency)}</strong></span>
        </div>

        {(proformas.length > 0 || invoices.length > 0) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-400">Raised from this order</span>
            {proformas.map((p) => (
              <Link key={`p${p.id}`} to={`/proformas/${p.id}`} className="rounded border border-slate-200 px-2 py-1 hover:border-brand-600">
                PI {p.number}
              </Link>
            ))}
            {invoices.map((inv) => (
              <Link key={`i${inv.id}`} to={`/invoices/${inv.id}`} className="rounded border border-slate-200 px-2 py-1 hover:border-brand-600">
                Invoice {inv.number}
              </Link>
            ))}
          </div>
        )}

        <p className="mt-2 text-xs text-slate-400">
          <strong>Sent</strong> is what left the gate; <strong>billed</strong> comes from the invoices raised.
          They are shown separately on purpose — goods often go before the invoice, and the difference is
          worth seeing rather than smoothing over.
        </p>
      </Card>

      <Card title={`Dispatches (${trips.length})`}>
        {trips.length === 0 ? (
          <EmptyState message="Nothing recorded as sent yet. Dispatches are recorded on the Dispatches page." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={TH_CLASS}>
                  <th className="pb-2 pr-3">Date</th>
                  <th className="pb-2 pr-3">From</th>
                  <th className="pb-2 pr-3">To</th>
                  <th className="pb-2 pr-3">Transporter</th>
                  <th className="pb-2 pr-3">CN / vehicle</th>
                  <th className="pb-2 pr-3 text-right">Pieces</th>
                  <th className="pb-2 pr-3 text-right">Boxes</th>
                  <th className="pb-2 pr-3">Invoice</th>
                  <th className="pb-2" />
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
                      <td className="py-2 pr-3">{d.destination || '—'}</td>
                      <td className="py-2 pr-3">{d.transporter_name ?? '—'}</td>
                      <td className="py-2 pr-3 text-xs text-slate-500">
                        {[d.cn_no, d.vehicle_no].filter(Boolean).join(' · ') || '—'}
                        {/* A real ETA where the shipment has one; the free-text
                            "5-6 Days" is the domestic lorry's answer. */}
                        {d.eta
                          ? <div className="text-slate-400">ETA {fmtDate(d.eta)}</div>
                          : d.tentative_delivery && <div className="text-slate-400">ETA {d.tentative_delivery}</div>}
                        {(d.bl_no || d.container_no) && (
                          <div className="text-slate-400">{[d.bl_no, d.container_no].filter(Boolean).join(' · ')}</div>
                        )}
                        {/* Which lots travelled, where anyone recorded them. */}
                        {!!d.batches?.length && (
                          <div className="text-slate-500">
                            {d.batches.map((b) => b.number).join(' · ')}
                          </div>
                        )}
                        {d.docs_status && (
                          <div className={d.docs_status === 'received' ? 'text-green-700' : 'text-amber-700'}>
                            Docs {d.docs_status === 'received' ? 'received' : 'sent'}
                            {d.docs_method ? ` (${d.docs_method === 'telex' ? 'telex' : 'courier'})` : ''}
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{pieces ? fmtQty(pieces) : '—'}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{boxes ? fmtQty(boxes) : '—'}</td>
                      <td className="py-2 pr-3">
                        {d.invoice_number
                          ? <span className="text-slate-600">{d.invoice_number}</span>
                          : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">not billed</span>}
                      </td>
                      <td className="whitespace-nowrap py-2 text-right">
                        {/* The document that travels with the lorry. A plain
                            anchor rather than `PdfLink`: this prints the trip
                            as the server holds it, and nothing on this tab is
                            an unsaved draft that could be ahead of it. */}
                        <a
                          href={`/api/pdf/challan/${d.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="mr-1 rounded-lg px-2 py-1 text-sm text-brand-600 hover:bg-brand-50"
                          title="Delivery challan"
                        >📄 Challan</a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

    </div>
  );
}

