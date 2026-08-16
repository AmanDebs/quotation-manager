import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { PurchaseOrder, PoStatus, PoItem, Supplier, Material, Location, TaxType } from '../types';
import { PageHeader, Card, Select, Input, Textarea, Field, Button, EmptyState, ErrorText, Modal } from '../components/ui';
import { fmtMoney, fmtQty, fmtDate, today } from '../lib/format';

/**
 * Buying material. Manager-only in full, so there is no read-only mode here.
 *
 * How much has arrived is never stored: every line's received figure is a sum
 * over the receipt rows in the ledger, which is what lets a part delivery be
 * booked without keying the same number twice.
 */

const STATUSES: PoStatus[] = ['draft', 'sent', 'part_received', 'received', 'cancelled'];

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

  const { data: pos = [] } = useQuery({
    queryKey: ['purchase-orders', openOnly],
    queryFn: () => api.get<PurchaseOrder[]>(`/api/purchase-orders${openOnly ? '?open=1' : ''}`),
  });
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
        actions={<Button onClick={openNew} disabled={suppliers.length === 0}>+ New PO</Button>}
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
      </Card>

      {editing && (
        <Modal title={editing.id ? `Edit ${editing.number}` : 'New purchase order'} onClose={() => setEditing(null)} wide>
          <div className="grid grid-cols-3 gap-3">
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
      <div className="grid grid-cols-2 gap-3">
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
