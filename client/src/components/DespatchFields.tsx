import type { Order, Despatch, DespatchItem, Location, Transporter, OrderBatch } from '../types';
import { Input, Textarea, Select, Field, Card, FIELD_GRID, CAPTION_CLASS } from './ui';
import { fmtQty, today } from '../lib/format';
import { piecesOrdered } from '../lib/pieces';

/**
 * Recording a dispatch: the form's fields and its two prefills.
 *
 * This lived inside the sales order's Dispatch tab as a dialog until
 * 2026-09-14, when the client asked for that tab to be read-only and for
 * dispatches to be recorded from the Dispatches page under Sales; a day later
 * they asked for *"a whole new page to record dispatch, not a pop up"*, so
 * the dialog became `pages/DespatchForm.tsx` and this is what it draws. The
 * fields, the prefills and every rule about them are unchanged — what moved,
 * twice, is the frame around them.
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

/**
 * The same arithmetic read the other way: pieces for a number of boxes
 * (2026-09-18, the client with the form in front of them: *"after changing
 * boxes the qty did not get updated"*). A count is as often taken in boxes as
 * in pieces — the lorry is loaded by the carton — so whichever of the two is
 * typed into drives the other. Whole pieces; a part box at 500/box is still
 * 250 pieces, never 250.4.
 */
function piecesFor(boxes: number | null | undefined, pcsPerPack: number | null | undefined): number | null {
  const per = Number(pcsPerPack) || 0;
  if (!per || boxes == null || !Number.isFinite(Number(boxes))) return null;
  return Math.round(Number(boxes) * per);
}

/** The lines table's group band and the sub-heading under it. */
// The tint is the caller's, not a default here: two background utilities of
// equal specificity are settled by stylesheet order, not by which is written
// last (the trap `setsWidth()` exists for).
const GROUP = 'border-b border-white py-1.5 text-center';
const SUB = 'pb-1.5 pr-2 pt-1 text-right';

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
  // Every goods line, defaulted to what is still unsent. A charge line —
  // freight, insurance — never goes on a lorry and is not offered (2026-09-16,
  // at the client's word); positions are kept, since `order_line` is the
  // index over *all* lines, charges included.
  items: items.flatMap((it, i) => {
    if (it.is_charge) return [];
    const qty = Math.max(0, (piecesOrdered(it) ?? 0) - (it.despatched?.qty ?? 0)) || null;
    return [{ order_line: i, description: it.description, qty, packs: boxesFor(qty, it.pcs_per_pack) }];
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
  // A charge line is left out, as on a new trip — unless this trip already
  // carries a figure against it, which is a record and stays visible.
  const onOrder: DespatchItem[] = items.flatMap((it, i) => (it.is_charge && !saved.has(i) ? [] : [{
    order_line: i,
    description: it.description,
    qty: saved.get(i)?.qty ?? null,
    packs: saved.get(i)?.packs ?? null,
    notes: saved.get(i)?.notes ?? '',
  }]));
  const orphans = (d.items ?? []).filter((it) => it.order_line >= items.length);
  return { ...d, items: [...onOrder, ...orphans], batch_ids: (d.batches ?? []).map((b) => b.id) };
}


export function DespatchFields({
  draft, items, ownSent, locations, transporters, invoices, isExport, orderBatches, orderDate, onChange,
}: {
  draft: Partial<Despatch>;
  /** The sales order's own date: a trip cannot leave before it (the server refuses one that does). */
  orderDate?: string;
  items: NonNullable<Order['items']>;
  /** Pieces and boxes already on file for *this* despatch, per line, to be excluded. */
  ownSent: Map<number, { qty: number; packs: number }>;
  orderBatches: OrderBatch[];
  locations: Location[];
  transporters: Transporter[];
  invoices: NonNullable<Order['invoices']>;
  /** Whether this order ships in a container, which decides the sea-leg block. */
  isExport: boolean;
  onChange: (d: Partial<Despatch>) => void;
}) {
  const set = (patch: Partial<Despatch>) => onChange({ ...draft, ...patch });
  const rows: DespatchItem[] = draft.items ?? [];
  const setRow = (i: number, patch: Partial<DespatchItem>) =>
    set({ items: rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) });

  /*
   * Pieces and boxes are one figure in two units, and the one being typed
   * into drives the other (2026-09-18). Until then boxes followed the pieces
   * and a typed box count was frozen — right for a count taken off the real
   * lorry, and wrong the moment the count was the *boxes*: changing 500 to
   * 450 left the pieces at 30,00,000, which the user found. So the rule is
   * simply that the last figure typed is the truth and the other is read from
   * it at the line's pcs-per-box; on a line stating none, nothing is derived
   * either way. A saved row keeps both figures exactly as they were until
   * somebody types — deriving nothing is what protects a count recorded off
   * the real trip, and typing into it is the one thing that says otherwise.
   */
  const setPieces = (i: number, qty: number | null) => {
    const packs = boxesFor(qty, items[rows[i].order_line]?.pcs_per_pack);
    setRow(i, packs === null && qty !== null ? { qty } : { qty, packs });
  };
  const setBoxes = (i: number, packs: number | null) => {
    const qty = piecesFor(packs, items[rows[i].order_line]?.pcs_per_pack);
    setRow(i, qty === null && packs !== null ? { packs } : { qty, packs });
  };

  return (
    <div className="space-y-4">
      <Card title="Trip">
      <div className={FIELD_GRID}>
        {/* Bounded on the box (2026-09-17): not before the order, not after today.
            The server refuses either anyway; this keeps the picker honest. */}
        <Field label="Date *"><Input type="date" min={orderDate || undefined} max={today()} value={draft.date ?? ''} onChange={(e) => set({ date: e.target.value })} /></Field>
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
          <div className={`mt-1 ${FIELD_GRID}`}>
            <Field label="BL number"><Input value={draft.bl_no ?? ''} onChange={(e) => set({ bl_no: e.target.value })} placeholder="e.g. Maersk-259385658" /></Field>
            <Field label="Container number"><Input value={draft.container_no ?? ''} onChange={(e) => set({ container_no: e.target.value })} placeholder="e.g. 262183004" /></Field>
            {/* Real dates, unlike Tentative delivery above: an arrivals list has
                to sort and count down, which "5-6 Days" cannot do. */}
            <Field label="ETD"><Input type="date" min={draft.date || undefined} value={draft.etd ?? ''} onChange={(e) => set({ etd: e.target.value })} /></Field>
            <Field label="ETA"><Input type="date" min={draft.etd || draft.date || undefined} value={draft.eta ?? ''} onChange={(e) => set({ eta: e.target.value })} /></Field>
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

      </Card>

      <Card title="Lines">
      <table className="w-full text-sm">
        <thead>
          {/* Ordered, sent on other trips, what is left, and this trip — the
              figures the pieces box is checked against, asked for as columns
              (2026-09-15) rather than a caption under the line; each in
              quantity and boxes since 2026-09-20 ("make 4 columns Ordered >>
              Sent >> Balance >> Current Dispatch and two sub columns in each
              Quantity and boxes"), the lorry being loaded by the carton. */}
          {/* Each group is a tinted band over its pair, the current dispatch —
              the only pair typed into — in the brand tint so the editable
              zone reads as one; the sub-row is lighter and carries no rules of
              its own, the band above already saying where a group starts. */}
          <tr className={CAPTION_CLASS}>
            <th rowSpan={2} className="border-b border-slate-200 pb-2 pr-3 text-left align-bottom">Line</th>
            <th colSpan={2} className={`${GROUP} bg-slate-50`}>Ordered</th>
            <th colSpan={2} className={`${GROUP} bg-slate-50`} title="Sent on other trips">Sent</th>
            <th colSpan={2} className={`${GROUP} bg-slate-50`}>Balance</th>
            <th colSpan={2} className={`${GROUP} bg-brand-50 text-brand-700`}>Current dispatch</th>
            <th rowSpan={2} className="w-56 border-b border-slate-200 pb-2 pl-3 text-left align-bottom">Note</th>
          </tr>
          <tr className="border-b border-slate-200 text-[10.5px] font-medium uppercase leading-4 tracking-wide text-slate-400">
            <th className={`w-24 ${SUB} pl-3`}>Quantity</th>
            <th className={`w-20 ${SUB}`}>Boxes</th>
            <th className={`w-24 ${SUB} pl-3`}>Quantity</th>
            <th className={`w-20 ${SUB}`}>Boxes</th>
            <th className={`w-24 ${SUB} pl-3`}>Quantity</th>
            <th className={`w-20 ${SUB}`}>Boxes</th>
            <th className={`w-32 ${SUB} bg-brand-50/60 pl-3 text-brand-600`}>Quantity</th>
            <th className={`w-24 ${SUB} bg-brand-50/60 text-brand-600`}>Boxes</th>
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
            const ordered = line ? piecesOrdered(line) : null;
            // Everything sent on this order *except* what this despatch itself
            // already has on file — the server's own `exceptDespatchId` rule,
            // without which an edit counts a trip against itself.
            const own = ownSent.get(r.order_line) ?? { qty: 0, packs: 0 };
            const sentElsewhere = (line?.despatched?.qty ?? 0) - own.qty;
            const left = ordered ? Math.max(0, ordered - sentElsewhere) : null;
            const ceiling = left === null ? undefined : Math.round(left * 1.1);
            const over = ceiling !== undefined && (r.qty ?? 0) > ceiling;
            /*
             * The same three figures in boxes. Ordered is the line's own box
             * count, else its pieces at the catalogue's pcs-per-box; sent is
             * what the other trips recorded, box counts being typed off the
             * lorry rather than derived; and **balance is the pieces left at
             * pcs-per-box**, not ordered less sent — the first cut did the
             * subtraction and the real book read *0 boxes* beside 30,00,000
             * pieces, because a trip's typed box count is a count of what was
             * loaded and says nothing about how the rest will be packed. The
             * subtraction stands in only on a line stating a box count but no
             * pcs-per-box. A line stating neither says nothing, not 0.
             */
            const orderedBoxes = line ? (line.packs || boxesFor(ordered, line.pcs_per_pack)) : null;
            const sentBoxes = orderedBoxes != null ? Math.max(0, (line?.despatched?.packs ?? 0) - own.packs) : null;
            const leftBoxes = left != null && line?.pcs_per_pack ? boxesFor(left, line.pcs_per_pack)
              : orderedBoxes != null && sentBoxes != null ? Math.max(0, Math.round((orderedBoxes - sentBoxes) * 100) / 100)
              : null;
            const num = (v: number | null, cls = 'text-slate-500') => (
              <td className={`py-2.5 pr-2 text-right tabular-nums ${cls}`}>{v != null ? fmtQty(v) : <span className="text-slate-300">—</span>}</td>
            );
            return (
            <tr key={i} className="border-b border-slate-100">
              <td className="py-2.5 pr-3">
                <div className="font-medium text-slate-800">{line?.description || r.description || `Line ${r.order_line + 1}`}</div>
                {/* The pcs-per-box sits under the line rather than under the
                    boxes box: it is a fact about the line, every box figure on
                    the row is read by it, and out of the cell the row stays
                    one line tall. */}
                {!!line?.pcs_per_pack && (
                  <div className="text-xs text-slate-400">{fmtQty(line.pcs_per_pack)} pcs / box</div>
                )}
                {/* The order has been edited since this lorry left. The row is
                    kept rather than merged away — dropping it would delete the
                    record of goods that physically went — but it is said out
                    loud, because there is nothing left to check it against. */}
                {!line && (
                  <div className="text-xs text-amber-700">no longer a line on this order</div>
                )}
              </td>
              {/* A weight-billed line states no piece count, and says nothing
                  rather than 0 — the ceiling below follows the same rule. */}
              {num(ordered || null, 'pl-3 text-slate-500')}
              {num(orderedBoxes)}
              {num(ordered ? Math.max(0, sentElsewhere) : null, 'pl-3 text-slate-500')}
              {num(sentBoxes)}
              {num(left, `pl-3 font-semibold ${left === 0 ? 'text-slate-400' : 'text-slate-900'}`)}
              {num(leftBoxes, `font-semibold ${leftBoxes === 0 ? 'text-slate-400' : 'text-slate-900'}`)}
              <td className="bg-brand-50/40 py-2 pl-3 pr-2">
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
              <td className="bg-brand-50/40 py-2 pr-3">
                <Input
                  type="number" min={0} step="any"
                  className="w-full text-right tabular-nums"
                  value={r.packs ?? ''}
                  placeholder={line?.pcs_per_pack ? '' : '—'}
                  onChange={(e) => setBoxes(i, e.target.value === '' ? null : Number(e.target.value))}
                />
              </td>
              <td className="py-2 pl-3">
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

      <Field label="Notes" className="mt-4">
        <Textarea rows={2} value={draft.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
      </Card>
    </div>
  );
}
