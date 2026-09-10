import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Order, Despatch, DespatchItem, Location, Transporter, OrderBatch } from '../types';
import { Button, Input, Textarea, Select, Field, Card, EmptyState, ErrorText, Modal, TH_CLASS, CAPTION_CLASS } from './ui';
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
/**
 * Boxes for a number of pieces, from the line's own pcs-per-box.
 *
 * The catalogue records `pcs_per_pack` and every order line carries it, so
 * asking somebody to divide 176,000 by 800 in their head — on the form where
 * the lorry is being recorded, at the end of a loading day — was work the app
 * already had the numbers to do.
 *
 * `null` rather than 0 when the line states no pcs-per-box: nobody has said
 * what fits in a carton, and 0 boxes is a claim where silence is the truth —
 * the rule `hasRecipe: false` and `has_spec: false` both follow.
 *
 * Not rounded to a whole box. A part box is a real thing (a short-filled
 * carton at the end of a run), and rounding up would put a figure on the
 * paperwork that the lorry does not carry; where the division is not exact it
 * is usually the piece count that wants a second look, which a 17.6 says and a
 * silent 18 hides.
 */
function boxesFor(pieces: number | null | undefined, pcsPerPack: number | null | undefined): number | null {
  const per = Number(pcsPerPack) || 0;
  if (!per || pieces == null || !Number.isFinite(Number(pieces))) return null;
  return Math.round((Number(pieces) / per) * 100) / 100;
}

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
  // Pieces this despatch itself has recorded, per order line — see the note
  // where it is passed down. Empty for a new trip, which has nothing on file.
  const ownSent = new Map<number, number>();
  for (const it of (editing?.id ? trips.find((t) => t.id === editing.id)?.items ?? [] : [])) {
    ownSent.set(it.order_line, (ownSent.get(it.order_line) ?? 0) + (it.qty ?? 0));
  }
  const proformas = order.proformas ?? [];

  const newTrip = (): Partial<Despatch> => ({
    order_id: order.id,
    date: today(),
    location_id: locations[0]?.id ?? null,
    transporter_id: transporters.find((t) => t.name === 'Self')?.id ?? transporters[0]?.id ?? null,
    destination: order.destination ?? '',
    cn_no: '', vehicle_no: '', tentative_delivery: '', freight_terms: '', invoice_id: null, notes: '',
    // Deliberately not prefilled with "every certified lot". Which lots went on
    // this lorry is a fact about the loading, and a guess at it would put lot
    // numbers on a challan nobody checked — the rule the box counts follow in
    // reverse, where a guess is safe because the piece count is beside it.
    batch_ids: [],
    // Every line, defaulted to what is still unsent.
    items: items.map((it, i) => {
      const qty = Math.max(0, (it.total_pcs ?? 0) - (it.despatched?.qty ?? 0)) || null;
      return { order_line: i, description: it.description, qty, packs: boxesFor(qty, it.pcs_per_pack) };
    }),
  });

  /**
   * A saved trip, opened with **every** order line on it.
   *
   * `saveItems` stores only the lines that carried a figure — right, since a
   * line with neither pieces nor boxes did not go on the lorry — but it meant
   * the edit form could only ever show what the trip already had. A line left
   * off by mistake, or loaded later and written on the same consignment note,
   * could not be added at all: the only way to record it was a second trip on
   * a date no lorry left.
   *
   * So the rows come from the **order**, with the saved values merged in by
   * position — the chain's own index rule, the same one `order_line` is. A
   * line the trip did not carry opens **blank rather than prefilled**: on a new
   * despatch "what is still unsent" is a helpful guess, but on a saved one it
   * would put figures on a trip nobody put them on. Blank rows are dropped
   * again on save, so opening a despatch and closing it changes nothing.
   *
   * A saved row whose line the order no longer has is **kept and labelled**
   * rather than merged away — an order can be edited after a lorry has left,
   * and silently dropping such a row on the next save would delete a record of
   * goods that physically went.
   */
  const editTrip = (d: Despatch): Partial<Despatch> => {
    const saved = new Map((d.items ?? []).map((it) => [it.order_line, it]));
    const onOrder: DespatchItem[] = items.map((it, i) => ({
      order_line: i,
      description: it.description,
      qty: saved.get(i)?.qty ?? null,
      packs: saved.get(i)?.packs ?? null,
      notes: saved.get(i)?.notes ?? '',
    }));
    const orphans = (d.items ?? []).filter((it) => it.order_line >= items.length);
    return { ...d, items: [...onOrder, ...orphans], batch_ids: (d.batches ?? []).map((b) => b.id) };
  };

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

      <ErrorText error={remove.error} />

      <Card
        title={`Dispatches (${trips.length})`}
        actions={<Button onClick={() => { save.reset(); setEditing(newTrip()); }}>+ Record dispatch</Button>}
      >
        {trips.length === 0 ? (
          <EmptyState message="Nothing recorded as sent yet." />
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
                        <Button variant="ghost" onClick={() => { save.reset(); setEditing(editTrip(d)); }}>Edit</Button>
                        <Button
                          variant="danger"
                          className="ml-1 border-0"
                          onClick={() => { if (confirm('Delete this dispatch record?')) remove.mutate(d.id); }}
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
          // Remount per trip, so the "which boxes were typed" set inside is
          // never carried from one despatch to the next.
          key={editing.id ?? 'new'}
          draft={editing}
          items={items}
          /*
           * What this trip itself already has on file, per line.
           *
           * `items[i].despatched.qty` sums *every* despatch on the order,
           * including the one being edited — so on an edit the form counted a
           * trip against itself, showed "0 left to ship" on every line and
           * capped each input at 0 in red. The server has never done that
           * (`despatchLimitError` takes an `exceptDespatchId` for exactly this
           * reason), so the form was refusing a save the API would have
           * accepted, which is the worst way round for a warning to be wrong.
           *
           * Read from the saved list rather than from `editing`, which is
           * being typed into: the figure to exclude is what is on file, not
           * what is on screen.
           */
          ownSent={ownSent}
          locations={locations}
          transporters={transporters}
          invoices={invoices}
          isExport={!!order.is_export}
          /*
           * Absent for a caller the server did not hand them to — Sales holds
           * `qc: none`, so the picker simply is not there rather than being an
           * empty box that looks broken.
           */
          orderBatches={order.batches ?? []}
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
  draft, items, ownSent, locations, transporters, invoices, isExport, orderBatches,
  error, saving, onChange, onClose, onSave,
}: {
  draft: Partial<Despatch>;
  items: NonNullable<Order['items']>;
  /** Pieces already on file for *this* despatch, per line, to be excluded. */
  ownSent: Map<number, number>;
  orderBatches: OrderBatch[];
  locations: Location[];
  transporters: Transporter[];
  invoices: NonNullable<Order['invoices']>;
  /** Whether this order ships in a container, which decides the sea-leg block. */
  isExport: boolean;
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

  /*
   * Which rows have had their box count typed into.
   *
   * Boxes follow the pieces — that is the point — but a **default, not a
   * rule**: the figure that matters is what actually went on the lorry, and
   * once somebody has counted it the app must not quietly recompute it from a
   * pcs-per-box the catalogue happens to hold. A row that arrives already
   * carrying a count is treated as touched for the same reason: on an edit
   * those numbers were recorded off the real trip.
   */
  const [typedBoxes, setTypedBoxes] = useState<Set<number>>(
    () => new Set(rows.map((r, i) => (r.packs != null ? i : -1)).filter((i) => i >= 0)),
  );

  /** Pieces changed: carry the box count with it, unless it has been typed. */
  const setPieces = (i: number, qty: number | null) => {
    const derived = typedBoxes.has(i) ? undefined : boxesFor(qty, items[rows[i].order_line]?.pcs_per_pack);
    setRow(i, derived === undefined ? { qty } : { qty, packs: derived });
  };

  return (
    <Modal title={draft.id ? 'Edit dispatch' : 'Record a dispatch'} onClose={onClose} wide>
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

      {/*
        The sea leg, on an export order only. A domestic lorry states CN/LR and
        a vehicle above and none of this; a container states these and usually
        not those. Shown on a domestic order that already carries one, the rule
        the quotation's Containers field follows — a value entered before this
        was gated must stay visible and clearable.
      */}
      {(isExport || draft.bl_no || draft.container_no || draft.etd || draft.eta || draft.docs_status) && (
        <>
          <div className={`${CAPTION_CLASS} mt-4`}>Shipment</div>
          <div className="mt-1 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="BL number"><Input value={draft.bl_no ?? ''} onChange={(e) => set({ bl_no: e.target.value })} placeholder="e.g. Maersk-259385658" /></Field>
            <Field label="Container number"><Input value={draft.container_no ?? ''} onChange={(e) => set({ container_no: e.target.value })} placeholder="e.g. 262183004" /></Field>
            <div />
            {/* Real dates, unlike Tentative delivery above: an arrivals list has
                to sort and count down, which "5-6 Days" cannot do. */}
            <Field label="ETD"><Input type="date" value={draft.etd ?? ''} onChange={(e) => set({ etd: e.target.value })} /></Field>
            <Field label="ETA"><Input type="date" value={draft.eta ?? ''} onChange={(e) => set({ eta: e.target.value })} /></Field>
            <div />
            <Field label="Documents">
              <Select value={draft.docs_status ?? ''} onChange={(e) => set({ docs_status: e.target.value })}>
                <option value="">Not sent</option>
                <option value="sent">Sent</option>
                <option value="received">Received by buyer</option>
              </Select>
            </Field>
            <Field label="Sent by">
              <Select value={draft.docs_method ?? ''} onChange={(e) => set({ docs_method: e.target.value })}>
                <option value="">— none —</option>
                <option value="telex">Telex release</option>
                <option value="courier">Courier</option>
              </Select>
            </Field>
            <Field label="Documents date"><Input type="date" value={draft.docs_date ?? ''} onChange={(e) => set({ docs_date: e.target.value })} /></Field>
          </div>
        </>
      )}

      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className={TH_CLASS}>
            <th className="pb-2 pr-2">Line</th>
            <th className="w-32 pb-2 pr-2 text-right">Pieces</th>
            <th className="w-24 pb-2 pr-2 text-right">Boxes</th>
            <th className="pb-2 pr-2">Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const line = items[r.order_line];
            /*
             * What this line still has to ship, and the most a trip may carry.
             * The same arithmetic the server refuses on (`despatchLimitError`),
             * so the form cannot offer a figure the save will reject — and the
             * ceiling is the outstanding quantity **plus the standard 10%
             * tolerance**, because a small over-shipment is expected and only a
             * slipped digit is being caught.
             *
             * A line with no piece count of its own — a weight-billed one — has
             * no ceiling to state, and says nothing rather than guessing.
             */
            const ordered = line?.total_pcs ?? null;
            // Everything sent on this order *except* what this despatch itself
            // already has on file — the server's own `exceptDespatchId` rule,
            // without which an edit counts a trip against itself.
            const sentElsewhere = (line?.despatched?.qty ?? 0) - (ownSent.get(r.order_line) ?? 0);
            const left = ordered ? Math.max(0, ordered - sentElsewhere) : null;
            const ceiling = left === null ? undefined : Math.round(left * 1.1);
            const over = ceiling !== undefined && (r.qty ?? 0) > ceiling;
            return (
            <tr key={i} className="border-b border-slate-100">
              <td className="py-2 pr-2">
                {line?.description || r.description || `Line ${r.order_line + 1}`}
                {left !== null && (
                  <div className="text-xs text-slate-400">{fmtQty(left)} left to ship</div>
                )}
                {/* The order has been edited since this lorry left. The row is
                    kept rather than merged away — dropping it would delete the
                    record of goods that physically went — but it is said out
                    loud, because there is nothing left to check it against. */}
                {!line && (
                  <div className="text-xs text-amber-700">no longer a line on this order</div>
                )}
              </td>
              <td className="py-2 pr-2">
                <Input
                  type="number" min={0} max={ceiling} step="any"
                  className={`w-full text-right tabular-nums ${over ? 'border-red-400 focus:border-red-500' : ''}`}
                  value={r.qty ?? ''}
                  onChange={(e) => setPieces(i, e.target.value === '' ? null : Number(e.target.value))}
                />
                {over && (
                  <div className="mt-0.5 text-xs text-red-600">at most {fmtQty(ceiling!)}</div>
                )}
              </td>
              <td className="py-2 pr-2">
                <Input
                  type="number" min={0} step="any"
                  className="w-full text-right tabular-nums"
                  value={r.packs ?? ''}
                  placeholder={line?.pcs_per_pack ? '' : '—'}
                  onChange={(e) => {
                    setTypedBoxes((prev) => new Set(prev).add(i));
                    setRow(i, { packs: e.target.value === '' ? null : Number(e.target.value) });
                  }}
                />
                {!!line?.pcs_per_pack && !typedBoxes.has(i) && (
                  <div className="mt-0.5 text-xs text-slate-400">{fmtQty(line.pcs_per_pack)}/box</div>
                )}
              </td>
              <td className="py-2 pr-2">
                <Input value={r.notes ?? ''} onChange={(e) => setRow(i, { notes: e.target.value })} />
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-slate-400">
        Leave a line blank if none of it went on this lorry — only lines with a figure are recorded.
      </p>

      {/*
        Which identified lots are on the lorry — the last leg of the
        traceability chain, and the only part of it somebody has to type.

        The whole block is absent unless the order has lots, so an order nobody
        has batched shows exactly the form it always did. An uncertified lot is
        **shown and disabled rather than hidden**, with the reason beside it: a
        picker that silently omits the batch somebody is looking for reads as a
        fault, where one that says *no COA yet* says what to do next. The
        server refuses the same lot with the same reason, so the screen is
        explaining that rule rather than keeping a second copy of it.
      */}
      {orderBatches.length > 0 && (
        <>
          <div className={`${CAPTION_CLASS} mt-4`}>Batches on this trip</div>
          <div className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2">
            {orderBatches.map((b) => {
              const on = (draft.batch_ids ?? []).includes(b.id);
              return (
                <label
                  key={b.id}
                  className={`flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm ring-1 ${
                    on ? 'bg-brand-50 ring-brand-200' : 'ring-slate-200'
                  } ${b.cleared ? 'cursor-pointer hover:bg-slate-50' : 'opacity-60'}`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={on}
                    disabled={!b.cleared}
                    onChange={(e) => set({
                      batch_ids: e.target.checked
                        ? [...(draft.batch_ids ?? []), b.id]
                        : (draft.batch_ids ?? []).filter((x) => x !== b.id),
                    })}
                  />
                  <span className="min-w-0">
                    <span className="font-medium">{b.number}</span>
                    <span className="ml-1 text-slate-500">
                      {b.product_name || items[b.order_line]?.description || `Line ${b.order_line + 1}`}
                    </span>
                    <span className="block text-xs">
                      {b.cleared
                        ? <span className="text-green-700">{b.coa_no}</span>
                        : <span className="text-amber-700">no COA yet — cannot be dispatched</span>}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </>
      )}

      <Field label="Notes" className="mt-3">
        <Textarea rows={2} value={draft.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
      </Field>

      <ErrorText error={error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save dispatch'}</Button>
      </div>
    </Modal>
  );
}
