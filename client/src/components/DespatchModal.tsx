import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Order, Despatch, DespatchItem, Location, Transporter, OrderBatch } from '../types';
import { Button, Input, Textarea, Select, Field, Modal, ErrorText, TH_CLASS, CAPTION_CLASS } from './ui';
import { fmtQty, today } from '../lib/format';

/**
 * Recording a dispatch: the dialog, its two prefills, and the editor that
 * fetches what they need.
 *
 * This lived inside the sales order's Dispatch tab until 2026-09-14, when the
 * client asked for that tab to be read-only and for dispatches to be recorded
 * from the Dispatches page under Sales instead. The dialog is unchanged; what
 * moved is who opens it. `DespatchEditor` is the piece the register needs and
 * the tab never did: given an order id it fetches the order in full (lines,
 * invoices, proformas and the lots the picker offers), because a register row
 * does not carry them and the dialog cannot be filled from one.
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

export function newTrip(order: Order, locations: Location[], transporters: Transporter[]): Partial<Despatch> {
const items = order.items ?? [];
return {
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
};
}

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
export function editTrip(order: Order, d: Despatch): Partial<Despatch> {
const items = order.items ?? [];
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
}


/**
 * The dialog with its data around it: the order it is for, the masters, and
 * the save. `despatch` absent means a new trip on that order.
 */
export function DespatchEditor({ orderId, despatch, onClose }: {
  orderId: number;
  despatch?: Despatch;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: order } = useQuery({ queryKey: ['order', String(orderId)], queryFn: () => api.get<Order>(`/api/orders/${orderId}`) });
  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });
  const { data: transporters = [] } = useQuery({ queryKey: ['master', 'transporters', false], queryFn: () => api.get<Transporter[]>('/api/transporters') });
  const [draft, setDraft] = useState<Partial<Despatch> | null>(null);
  // The draft is built once the order has arrived: a new trip prefills every
  // line at what is still unsent, an edit merges the saved rows in by position.
  if (order && draft === null) {
    setDraft(despatch ? editTrip(order, despatch) : newTrip(order, locations, transporters));
  }
  const save = useMutation({
    mutationFn: (d: Partial<Despatch>) =>
      d.id ? api.put<Despatch>(`/api/despatches/${d.id}`, d) : api.post<Despatch>('/api/despatches', d),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['despatches'] });
      queryClient.invalidateQueries({ queryKey: ['order', String(orderId)] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onClose();
    },
  });
  if (!order || !draft) return null;
  /*
   * What this trip itself already has on file, per line, to be excluded from
   * "already sent": `items[i].despatched.qty` sums every despatch on the
   * order including this one, and the server has never counted a trip against
   * itself (`despatchLimitError` takes an `exceptDespatchId`). Read from the
   * saved record, not from the draft being typed into.
   */
  const ownSent = new Map<number, number>();
  for (const it of despatch?.items ?? []) ownSent.set(it.order_line, (ownSent.get(it.order_line) ?? 0) + (it.qty ?? 0));
  return (
    <DespatchModal
      key={despatch?.id ?? 'new'}
      draft={draft}
      items={order.items ?? []}
      ownSent={ownSent}
      locations={locations}
      transporters={transporters}
      invoices={order.invoices ?? []}
      isExport={!!order.is_export}
      orderBatches={order.batches ?? []}
      error={save.error}
      saving={save.isPending}
      onChange={setDraft}
      onClose={onClose}
      onSave={() => save.mutate(draft)}
    />
  );
}

export function DespatchModal({
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
