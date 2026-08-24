import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type {
  PurchaseOrder, PoStatus, PoItem, Supplier, Material, Location, TaxType,
  ShortfallDraft, ShortfallDraftLine,
} from '../types';
import { PageHeader, Card, Select, Input, Textarea, Field, Button, EmptyState, ErrorText, Modal , Pagination} from '../components/ui';
import { fmtMoney, fmtQty, fmtDate, today } from '../lib/format';
import { usePagedList, PAGE_SIZE } from '../lib/usePagedList';

/**
 * Buying material. Manager-only in full, so there is no read-only mode here.
 *
 * How much has arrived is never stored: every line's received figure is a sum
 * over the receipt rows in the ledger, which is what lets a part delivery be
 * booked without keying the same number twice.
 */

// The order of the keys below is the ladder; `statusStyle` is the list itself,
// so a separate STATUSES array was one more place to forget to update.
const statusStyle: Record<PoStatus, string> = {
  draft: 'bg-slate-100 text-slate-600',
  sent: 'bg-blue-100 text-blue-700',
  part_received: 'bg-amber-100 text-amber-700',
  received: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
};

type Draft = Partial<PurchaseOrder> & { items: PoItem[] };

const emptyItem = (): PoItem => ({ material_id: null, description: '', qty: null, unit: 'kg', rate: 0, tax_pct: 18 });

export default function PurchaseOrdersPage() {
  const queryClient = useQueryClient();
  const [openOnly, setOpenOnly] = useState(false);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [receiving, setReceiving] = useState<PurchaseOrder | null>(null);
  const [fromShortfall, setFromShortfall] = useState(false);

  const list = usePagedList<PurchaseOrder>(
    ['purchase-orders', openOnly],
    `/api/purchase-orders${openOnly ? '?open=1' : ''}`,
  );
  const pos = list.rows;
  const { data: suppliers = [] } = useQuery({ queryKey: ['master', 'suppliers', false], queryFn: () => api.get<Supplier[]>('/api/suppliers') });
  const { data: materials = [] } = useQuery({ queryKey: ['master', 'materials', false], queryFn: () => api.get<Material[]>('/api/materials') });
  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
    queryClient.invalidateQueries({ queryKey: ['stock'] });
    queryClient.invalidateQueries({ queryKey: ['stock-shortfall'] });
  };

  const save = useMutation({
    mutationFn: (d: Draft) =>
      d.id ? api.put<PurchaseOrder>(`/api/purchase-orders/${d.id}`, d) : api.post<PurchaseOrder>('/api/purchase-orders', d),
    onSuccess: () => { refresh(); setEditing(null); },
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: PoStatus }) => api.post(`/api/purchase-orders/${id}/status`, { status }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/purchase-orders/${id}`),
    onSuccess: refresh,
  });

  const set = (patch: Partial<Draft>) => setEditing((prev) => (prev ? { ...prev, ...patch } : prev));
  const setItem = (i: number, patch: Partial<PoItem>) =>
    setEditing((prev) => prev ? { ...prev, items: prev.items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) } : prev);

  const openNew = () => {
    save.reset();
    setEditing({
      supplier_id: suppliers[0]?.id, location_id: locations[0]?.id ?? null,
      date: today(), expected_date: '', currency: 'INR', tax_type: 'igst' as TaxType,
      payment_terms: '', notes: '', items: [emptyItem()],
    });
  };

  /**
   * Turn one supplier's slice of the shortfall into a draft, then hand it to
   * the ordinary edit modal. The server has already worked out the quantities,
   * the suggested rates and who we last bought each material from; nothing is
   * recomputed here, and nothing is saved until the buyer presses Save like
   * any other purchase order.
   */
  const openFromShortfall = (draft: ShortfallDraft, supplierId: number, lines: ShortfallDraftLine[]) => {
    save.reset();
    setFromShortfall(false);
    setEditing({
      supplier_id: supplierId,
      location_id: draft.location_id ?? locations[0]?.id ?? null,
      date: draft.date,
      expected_date: '',
      currency: draft.currency,
      tax_type: draft.tax_type as TaxType,
      payment_terms: '',
      notes: '',
      // Only the document's own fields survive: the shortfall working figures
      // were for deciding, not for recording.
      items: lines.map(({ material_id, description, unit, qty, rate, tax_pct }) =>
        ({ material_id, description, unit, qty, rate, tax_pct })),
    });
  };

  const openExisting = async (po: PurchaseOrder) => {
    save.reset();
    const full = await api.get<PurchaseOrder>(`/api/purchase-orders/${po.id}`);
    setEditing({ ...full, items: full.items ?? [] });
  };

  // Preview only — the server recomputes on save, as it does for every document.
  const preview = (editing?.items ?? []).reduce((s, it) => s + (it.qty ?? 0) * (it.rate || 0), 0);

  return (
    <div>
      <PageHeader
        title="Purchase Orders"
        subtitle="Material bought in — receipts land straight in the stock ledger"
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setFromShortfall(true)} disabled={suppliers.length === 0}>
              From shortfall
            </Button>
            <Button onClick={openNew} disabled={suppliers.length === 0}>+ New PO</Button>
          </div>
        }
      />

      {suppliers.length === 0 && (
        <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Add a supplier under Production Masters first — a purchase order needs someone to buy from.
        </div>
      )}

      <div className="mb-3 flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
          Open orders only
        </label>
      </div>

      <ErrorText error={remove.error ?? setStatus.error} />

      <Card className="overflow-x-auto">
        {pos.length === 0 ? (
          <EmptyState message="No purchase orders yet." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-2 pr-3">Number</th>
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2 pr-3">Supplier</th>
                <th className="pb-2 pr-3">Deliver to</th>
                <th className="pb-2 pr-3">Expected</th>
                <th className="pb-2 pr-3 text-right">Value</th>
                <th className="pb-2 pr-3">Status</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {pos.map((po) => (
                <tr key={po.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="py-2 pr-3 font-medium">{po.number}</td>
                  <td className="py-2 pr-3">{fmtDate(po.date)}</td>
                  <td className="py-2 pr-3">{po.supplier_name}</td>
                  <td className="py-2 pr-3 text-slate-500">{po.location_name ?? '—'}</td>
                  <td className="py-2 pr-3 text-slate-500">{po.expected_date ? fmtDate(po.expected_date) : '—'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{fmtMoney(po.grand_total, po.currency)}</td>
                  <td className="py-2 pr-3">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${statusStyle[po.status]}`}>
                      {po.status.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-2 text-right">
                    {!['received', 'cancelled'].includes(po.status) && (
                      <Button variant="ghost" onClick={async () => setReceiving(await api.get<PurchaseOrder>(`/api/purchase-orders/${po.id}`))}>
                        Receive
                      </Button>
                    )}
                    <Button variant="ghost" onClick={() => openExisting(po)}>Edit</Button>
                    {po.status !== 'cancelled' && (
                      <Button variant="ghost" onClick={() => setStatus.mutate({ id: po.id, status: 'cancelled' })}>Cancel</Button>
                    )}
                    <Button
                      variant="danger"
                      className="ml-1 border-0"
                      onClick={() => { if (confirm(`Delete ${po.number}?`)) remove.mutate(po.id); }}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination
          page={list.page} pages={list.pages} total={list.total} limit={PAGE_SIZE}
          onPage={list.setPage} noun="purchase orders"
        />
      </Card>

      {editing && (
        <Modal title={editing.id ? `Edit ${editing.number}` : 'New purchase order'} onClose={() => setEditing(null)} wide>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Supplier *">
              <Select value={editing.supplier_id ?? ''} onChange={(e) => set({ supplier_id: Number(e.target.value) })}>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="Deliver to">
              <Select value={editing.location_id ?? ''} onChange={(e) => set({ location_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— none —</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </Field>
            <Field label="Date"><Input type="date" value={editing.date ?? ''} onChange={(e) => set({ date: e.target.value })} /></Field>
            <Field label="Expected"><Input type="date" value={editing.expected_date ?? ''} onChange={(e) => set({ expected_date: e.target.value })} /></Field>
            <Field label="Tax">
              <Select value={editing.tax_type ?? 'igst'} onChange={(e) => set({ tax_type: e.target.value as TaxType })}>
                <option value="igst">IGST</option>
                <option value="cgst_sgst">CGST + SGST</option>
                <option value="none">None</option>
              </Select>
            </Field>
            <Field label="Payment terms"><Input value={editing.payment_terms ?? ''} onChange={(e) => set({ payment_terms: e.target.value })} /></Field>
          </div>

          <table className="mt-4 w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-2 pr-2">Material</th>
                <th className="w-24 pb-2 pr-2 text-right">Qty</th>
                <th className="w-20 pb-2 pr-2">Unit</th>
                <th className="w-24 pb-2 pr-2 text-right">Rate</th>
                <th className="w-20 pb-2 pr-2 text-right">Tax %</th>
                <th className="w-28 pb-2 pr-2 text-right">Amount</th>
                <th className="w-8 pb-2" />
              </tr>
            </thead>
            <tbody>
              {editing.items.map((it, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="py-2 pr-2">
                    <Select
                      value={it.material_id ?? ''}
                      onChange={(e) => {
                        const m = materials.find((x) => x.id === Number(e.target.value));
                        setItem(i, {
                          material_id: e.target.value ? Number(e.target.value) : null,
                          description: m?.name ?? it.description,
                          unit: m?.unit ?? it.unit,
                        });
                      }}
                    >
                      <option value="">— choose —</option>
                      {materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </Select>
                  </td>
                  <td className="py-2 pr-2"><Input type="number" min={0} step="any" value={it.qty ?? ''} onChange={(e) => setItem(i, { qty: e.target.value === '' ? null : Number(e.target.value) })} /></td>
                  <td className="py-2 pr-2"><Input value={it.unit} onChange={(e) => setItem(i, { unit: e.target.value })} /></td>
                  <td className="py-2 pr-2"><Input type="number" min={0} step="any" value={it.rate || ''} onChange={(e) => setItem(i, { rate: Number(e.target.value) })} /></td>
                  <td className="py-2 pr-2"><Input type="number" min={0} step="any" value={it.tax_pct ?? ''} onChange={(e) => setItem(i, { tax_pct: Number(e.target.value) })} /></td>
                  <td className="py-2 pr-2 pt-4 text-right tabular-nums">{fmtMoney((it.qty ?? 0) * (it.rate || 0), editing.currency ?? 'INR')}</td>
                  <td className="py-2 text-right">
                    <button
                      className="text-slate-300 hover:text-red-500"
                      onClick={() => set({ items: editing.items.filter((_, idx) => idx !== i) })}
                    >✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 flex items-center justify-between">
            <Button variant="secondary" onClick={() => set({ items: [...editing.items, emptyItem()] })}>+ Add line</Button>
            <span className="text-sm text-slate-600">
              Subtotal <strong className="tabular-nums">{fmtMoney(preview, editing.currency ?? 'INR')}</strong>
            </span>
          </div>

          <Field label="Notes" className="mt-3">
            <Textarea rows={2} value={editing.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
          </Field>

          <ErrorText error={save.error} />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={() => save.mutate(editing)} disabled={save.isPending || !editing.supplier_id}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </Modal>
      )}

      {receiving && <ReceiveModal po={receiving} onClose={() => setReceiving(null)} onSaved={refresh} />}
      {fromShortfall && (
        <ShortfallModal
          suppliers={suppliers}
          onClose={() => setFromShortfall(false)}
          onPick={openFromShortfall}
        />
      )}
    </div>
  );
}

/** Book a delivery. Defaults each line to what is still outstanding on it. */
function ReceiveModal({ po, onClose, onSaved }: { po: PurchaseOrder; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(today());
  const [locationId, setLocationId] = useState(String(po.location_id ?? ''));
  const [qty, setQty] = useState<Record<number, number>>(
    Object.fromEntries((po.items ?? []).filter((i) => i.material_id).map((i) => [i.material_id!, i.qty_pending ?? 0]))
  );
  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });

  const receive = useMutation({
    mutationFn: () => api.post(`/api/purchase-orders/${po.id}/receipts`, {
      date,
      location_id: locationId ? Number(locationId) : null,
      items: Object.entries(qty).map(([materialId, q]) => ({ material_id: Number(materialId), qty: q })),
    }),
    onSuccess: () => { onSaved(); onClose(); },
  });

  return (
    <Modal title={`Receive against ${po.number}`} onClose={onClose} wide>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Received on"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Into which plant *">
          <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">— choose —</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
      </div>

      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
            <th className="pb-2 pr-3">Material</th>
            <th className="pb-2 pr-3 text-right">Ordered</th>
            <th className="pb-2 pr-3 text-right">Already in</th>
            <th className="pb-2 pr-3 text-right">Outstanding</th>
            <th className="w-32 pb-2 pr-3 text-right">Receiving now</th>
          </tr>
        </thead>
        <tbody>
          {(po.items ?? []).filter((i) => i.material_id).map((it) => (
            <tr key={it.material_id} className="border-b border-slate-100 last:border-0">
              <td className="py-2 pr-3">{it.material_name ?? it.description}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{fmtQty(it.qty ?? 0)} {it.unit}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-500">{fmtQty(it.qty_received ?? 0)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{fmtQty(it.qty_pending ?? 0)}</td>
              <td className="py-2 pr-3">
                <Input
                  type="number" min={0} step="any"
                  value={qty[it.material_id!] || ''}
                  onChange={(e) => setQty({ ...qty, [it.material_id!]: Number(e.target.value) })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-slate-400">
        Each quantity becomes a stock movement at that plant. The order moves to “part received” or
        “received” by comparing what has arrived with what was ordered — nothing to set by hand.
      </p>

      <ErrorText error={receive.error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => receive.mutate()} disabled={receive.isPending || !locationId}>
          {receive.isPending ? 'Booking…' : 'Book receipt'}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * "What are we short of, and who do we buy it from?"
 *
 * One purchase order goes to one supplier, so the shortfall is grouped by the
 * supplier we last bought each material from — derived from the purchase
 * history, since a material belongs to no one supplier. A material never
 * bought before has nobody to suggest and lands in its own group, where the
 * buyer picks.
 *
 * Nothing here writes. Choosing a group opens the ordinary edit modal with the
 * lines filled in, and it is saved like any other purchase order.
 */
function ShortfallModal({ suppliers, onClose, onPick }: {
  suppliers: Supplier[];
  onClose: () => void;
  onPick: (draft: ShortfallDraft, supplierId: number, lines: ShortfallDraftLine[]) => void;
}) {
  const [pickedSupplier, setPickedSupplier] = useState('');
  const { data: draft, isLoading } = useQuery({
    queryKey: ['po-shortfall-draft'],
    queryFn: () => api.get<ShortfallDraft>('/api/purchase-orders/prefill/from-shortfall'),
  });

  // Grouped by the suggested supplier; the unmatched ones keep id 0 so they
  // sort last and can be given a supplier by hand.
  const groups = new Map<number, { name: string; lines: ShortfallDraftLine[] }>();
  for (const line of draft?.items ?? []) {
    const id = line.last_supplier_id ?? 0;
    const group = groups.get(id) ?? { name: line.last_supplier_name || 'Not bought before', lines: [] };
    group.lines.push(line);
    groups.set(id, group);
  }
  const ordered = [...groups.entries()].sort((a, b) => (a[0] === 0 ? 1 : b[0] === 0 ? -1 : 0));

  return (
    <Modal title="Raise a purchase order from the shortfall" onClose={onClose} wide>
      {isLoading && <p className="text-sm text-slate-400">Working out what the open jobs need…</p>}

      {draft && draft.items.length === 0 && (
        <EmptyState message="Nothing is short. Every open job has the material it needs, counting what is already on order." />
      )}

      {/* A job with no recipe needs an unknown amount, not none. Saying so is
          the difference between a shortfall report and a misleading one. */}
      {!!draft?.uncosted.length && (
        <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <b>{draft.uncosted.length} job{draft.uncosted.length === 1 ? ' has' : 's have'} no recipe</b>, so
          nothing below covers {draft.uncosted.length === 1 ? 'it' : 'them'}:{' '}
          {draft.uncosted.map((u) => u.number).join(', ')}. Add materials to those products to include them.
        </div>
      )}

      <div className="space-y-4">
        {ordered.map(([supplierId, group]) => {
          const target = supplierId || Number(pickedSupplier);
          return (
            <div key={supplierId} className="rounded-lg border border-slate-200">
              <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
                <div className="text-sm font-semibold text-slate-700">
                  {group.name}
                  <span className="ml-2 font-normal text-slate-400">
                    {group.lines.length} material{group.lines.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {supplierId === 0 && (
                    <div className="w-52">
                      <Select value={pickedSupplier} onChange={(e) => setPickedSupplier(e.target.value)}>
                        <option value="">— choose a supplier —</option>
                        {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </Select>
                    </div>
                  )}
                  <Button
                    onClick={() => draft && onPick(draft, target, group.lines)}
                    disabled={!target}
                  >
                    Raise PO
                  </Button>
                </div>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-xs uppercase text-slate-500">
                    <th className="px-3 py-1">Material</th>
                    <th className="px-3 py-1 text-right">Needed</th>
                    <th className="px-3 py-1 text-right">On hand</th>
                    <th className="px-3 py-1 text-right">On order</th>
                    <th className="px-3 py-1 text-right">To buy</th>
                    <th className="px-3 py-1 text-right">Rate</th>
                    <th className="px-3 py-1">Last bought</th>
                  </tr>
                </thead>
                <tbody>
                  {group.lines.map((line) => (
                    <tr key={line.material_id} className="border-b border-slate-50 last:border-0">
                      <td className="px-3 py-1.5">{line.description}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{fmtQty(line.shortfall.required)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{fmtQty(line.shortfall.on_hand)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{fmtQty(line.shortfall.on_order)}</td>
                      <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                        {fmtQty(line.qty)} {line.unit}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {line.rate ? fmtMoney(line.rate, draft?.currency ?? 'INR') : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-slate-400">
                        {line.last_purchase_date
                          ? `${fmtDate(line.last_purchase_date)} · ${line.last_purchase_number}`
                          : 'never'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>

      {!!draft?.items.length && (
        <p className="mt-3 text-xs text-slate-400">
          To buy is what the open jobs need, less what is on hand and less what is already on order — so
          raising these will not order the same material twice. Rates are what we last paid; check them
          before sending.
        </p>
      )}
    </Modal>
  );
}
