import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Order, Despatch, DespatchItem, Location, Transporter } from '../types';
import { Button, Input, Textarea, Select, Field, Card, EmptyState, ErrorText, Modal } from './ui';
import { fmtQty, fmtMoney, fmtDate, today } from '../lib/format';

/**
 * Made, sent, billed — three different questions, shown together.
 *
 * *Sent* is the physical record: what left the gate, recorded by whoever
 * loaded the lorry. *Billed* is the invoice walk, which is the money truth.
 * They are deliberately not reconciled to each other: a lorry can leave before
 * the paperwork, and a gap between the two columns is information, not an
 * error to be smoothed over.
 */
export default function DispatchTab({ order }: { order: Order }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Partial<Despatch> | null>(null);

  const key = ['despatches', String(order.id)];
  const { data: trips = [] } = useQuery({
    queryKey: key,
    queryFn: () => api.get<Despatch[]>(`/api/despatches?order_id=${order.id}`),
  });
  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });
  const { data: transporters = [] } = useQuery({ queryKey: ['master', 'transporters', false], queryFn: () => api.get<Transporter[]>('/api/transporters') });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: key });
    queryClient.invalidateQueries({ queryKey: ['order', String(order.id)] });
  };

  const save = useMutation({
    mutationFn: (d: Partial<Despatch>) =>
      d.id ? api.put<Despatch>(`/api/despatches/${d.id}`, d) : api.post<Despatch>('/api/despatches', d),
    onSuccess: () => { refresh(); setEditing(null); },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/despatches/${id}`),
    onSuccess: refresh,
  });

  const items = order.items ?? [];
  const invoices = order.invoices ?? [];
  const proformas = order.proformas ?? [];

  const newTrip = (): Partial<Despatch> => ({
    order_id: order.id,
    date: today(),
    location_id: locations[0]?.id ?? null,
    transporter_id: transporters.find((t) => t.name === 'Self')?.id ?? transporters[0]?.id ?? null,
    destination: order.destination ?? '',
    cn_no: '', vehicle_no: '', tentative_delivery: '', freight_terms: '', invoice_id: null, notes: '',
    // Every line, defaulted to what is still unsent.
    items: items.map((it, i) => ({
      order_line: i,
      description: it.description,
      qty: Math.max(0, (it.total_pcs ?? 0) - (it.despatched?.qty ?? 0)) || null,
      packs: null,
    })),
  });

  return (
    <div className="space-y-4">
      <Card title="Made, sent and billed">
        {items.length === 0 ? (
          <EmptyState message="This order has no lines yet." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
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
                const ordered = it.total_pcs ?? 0;
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
                          {it.despatched.trips} despatch{it.despatched.trips === 1 ? '' : 'es'}
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

      <ErrorText error={remove.error} />

      <Card
        title={`Despatches (${trips.length})`}
        actions={<Button onClick={() => { save.reset(); setEditing(newTrip()); }}>+ Record despatch</Button>}
      >
        {trips.length === 0 ? (
          <EmptyState message="Nothing recorded as sent yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
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
                        {d.tentative_delivery && <div className="text-slate-400">ETA {d.tentative_delivery}</div>}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{pieces ? fmtQty(pieces) : '—'}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{boxes ? fmtQty(boxes) : '—'}</td>
                      <td className="py-2 pr-3">
                        {d.invoice_number
                          ? <span className="text-slate-600">{d.invoice_number}</span>
                          : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">not billed</span>}
                      </td>
                      <td className="whitespace-nowrap py-2 text-right">
                        <Button variant="ghost" onClick={() => { save.reset(); setEditing(d); }}>Edit</Button>
                        <Button
                          variant="danger"
                          className="ml-1 border-0"
                          onClick={() => { if (confirm('Delete this despatch record?')) remove.mutate(d.id); }}
                        >
                          Delete
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <DespatchModal
          draft={editing}
          items={items}
          locations={locations}
          transporters={transporters}
          invoices={invoices}
          error={save.error}
          saving={save.isPending}
          onChange={setEditing}
          onClose={() => setEditing(null)}
          onSave={() => save.mutate(editing)}
        />
      )}
    </div>
  );
}

function DespatchModal({
  draft, items, locations, transporters, invoices, error, saving, onChange, onClose, onSave,
}: {
  draft: Partial<Despatch>;
  items: NonNullable<Order['items']>;
  locations: Location[];
  transporters: Transporter[];
  invoices: NonNullable<Order['invoices']>;
  error: unknown;
  saving: boolean;
  onChange: (d: Partial<Despatch>) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const set = (patch: Partial<Despatch>) => onChange({ ...draft, ...patch });
  const rows: DespatchItem[] = draft.items ?? [];
  const setRow = (i: number, patch: Partial<DespatchItem>) =>
    set({ items: rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) });

  return (
    <Modal title={draft.id ? 'Edit despatch' : 'Record a despatch'} onClose={onClose} wide>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Date *"><Input type="date" value={draft.date ?? ''} onChange={(e) => set({ date: e.target.value })} /></Field>
        <Field label="Out of which plant">
          <Select value={draft.location_id ?? ''} onChange={(e) => set({ location_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">— none —</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
        <Field label="Destination"><Input value={draft.destination ?? ''} onChange={(e) => set({ destination: e.target.value })} placeholder="e.g. Mundra" /></Field>
        <Field label="Transporter">
          <Select value={draft.transporter_id ?? ''} onChange={(e) => set({ transporter_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">— none —</option>
            {transporters.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        <Field label="CN / LR number"><Input value={draft.cn_no ?? ''} onChange={(e) => set({ cn_no: e.target.value })} /></Field>
        <Field label="Vehicle number"><Input value={draft.vehicle_no ?? ''} onChange={(e) => set({ vehicle_no: e.target.value })} placeholder="WB11E9648" /></Field>
        <Field label="Tentative delivery"><Input value={draft.tentative_delivery ?? ''} onChange={(e) => set({ tentative_delivery: e.target.value })} placeholder="5-6 Days" /></Field>
        <Field label="Freight terms"><Input value={draft.freight_terms ?? ''} onChange={(e) => set({ freight_terms: e.target.value })} /></Field>
        <Field label="Invoice (if raised)">
          <Select value={draft.invoice_id ?? ''} onChange={(e) => set({ invoice_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">— not billed yet —</option>
            {invoices.map((i) => <option key={i.id} value={i.id}>{i.number}</option>)}
          </Select>
        </Field>
      </div>

      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
            <th className="pb-2 pr-2">Line</th>
            <th className="w-32 pb-2 pr-2 text-right">Pieces</th>
            <th className="w-24 pb-2 pr-2 text-right">Boxes</th>
            <th className="pb-2 pr-2">Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-slate-100">
              <td className="py-2 pr-2">{items[r.order_line]?.description || `Line ${r.order_line + 1}`}</td>
              <td className="py-2 pr-2">
                <Input type="number" min={0} step="any" value={r.qty ?? ''} onChange={(e) => setRow(i, { qty: e.target.value === '' ? null : Number(e.target.value) })} />
              </td>
              <td className="py-2 pr-2">
                <Input type="number" min={0} step="any" value={r.packs ?? ''} onChange={(e) => setRow(i, { packs: e.target.value === '' ? null : Number(e.target.value) })} />
              </td>
              <td className="py-2 pr-2">
                <Input value={r.notes ?? ''} onChange={(e) => setRow(i, { notes: e.target.value })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-slate-400">
        Leave a line blank if none of it went on this lorry — only lines with a figure are recorded.
      </p>

      <Field label="Notes" className="mt-3">
        <Textarea rows={2} value={draft.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
      </Field>

      <ErrorText error={error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save despatch'}</Button>
      </div>
    </Modal>
  );
}
