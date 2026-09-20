import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type {
  PurchaseOrder, PoStatus, Supplier, Location, TaxType,
  ShortfallDraft, ShortfallDraftLine,
} from '../types';
import { PageHeader, Card, Select, Input, Field, Button, EmptyState, ErrorText, Modal, Pagination, SegmentedTabs, CAPTION_CLASS, TH_CLASS } from '../components/ui';
import { fmtMoney, fmtQty, fmtDate, today } from '../lib/format';
import { usePagedList, PAGE_SIZE } from '../lib/usePagedList';
import type { PoDraft } from './PurchaseOrderForm';

/**
 * Buying material. Manager-only in full, so there is no read-only mode here.
 *
 * How much has arrived is never stored: every line's received figure is a sum
 * over the receipt rows in the ledger, which is what lets a part delivery be
 * booked without keying the same number twice.
 *
 * The order itself is a page of its own since 2026-09-20 (`PurchaseOrderForm`);
 * this list keeps what a list does — the rows, receiving, cancelling,
 * deleting — and the shortfall picker, which hands its draft to the page.
 */

// The order of the keys below is the ladder; `poStatusStyle` is the list itself,
// so a separate STATUSES array was one more place to forget to update.
export const poStatusStyle: Record<PoStatus, string> = {
  draft: 'bg-slate-100 text-slate-600',
  sent: 'bg-blue-100 text-blue-700',
  part_received: 'bg-amber-100 text-amber-700',
  received: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
};
export const poStatusLabel = (s: PoStatus) => s.replace(/_/g, ' ');

export default function PurchaseOrdersPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [openOnly, setOpenOnly] = useState(false);
  const [receiving, setReceiving] = useState<PurchaseOrder | null>(null);
  const [fromShortfall, setFromShortfall] = useState(false);

  const list = usePagedList<PurchaseOrder>(
    ['purchase-orders', openOnly],
    `/api/purchase-orders${openOnly ? '?open=1' : ''}`,
  );
  const pos = list.rows;
  const { data: suppliers = [] } = useQuery({ queryKey: ['master', 'suppliers', false], queryFn: () => api.get<Supplier[]>('/api/suppliers') });
  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
    queryClient.invalidateQueries({ queryKey: ['stock'] });
    queryClient.invalidateQueries({ queryKey: ['stock-shortfall'] });
  };

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: PoStatus }) => api.post(`/api/purchase-orders/${id}/status`, { status }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/purchase-orders/${id}`),
    onSuccess: refresh,
  });

  /**
   * Turn one supplier's slice of the shortfall into a draft, then hand it to
   * the order's page. The server has already worked out the quantities, the
   * suggested rates and who we last bought each material from; nothing is
   * recomputed here, and nothing is saved until the buyer presses Save like
   * any other purchase order.
   */
  const openFromShortfall = (draft: ShortfallDraft, supplierId: number, lines: ShortfallDraftLine[]) => {
    setFromShortfall(false);
    const handed: PoDraft = {
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
    };
    navigate('/purchase-orders/new', { state: { draft: handed } });
  };

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
            <Button onClick={() => navigate('/purchase-orders/new')} disabled={suppliers.length === 0}>+ New PO</Button>
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
              <tr className={TH_CLASS}>
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
                  <td className="py-2 pr-3 font-medium"><Link to={`/purchase-orders/${po.id}`} className="text-brand-700 hover:underline">{po.number}</Link></td>
                  <td className="py-2 pr-3">{fmtDate(po.date)}</td>
                  <td className="py-2 pr-3">{po.supplier_name}</td>
                  <td className="py-2 pr-3 text-slate-500">{po.location_name ?? '—'}</td>
                  <td className="py-2 pr-3 text-slate-500">{po.expected_date ? fmtDate(po.expected_date) : '—'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{fmtMoney(po.grand_total, po.currency)}</td>
                  <td className="py-2 pr-3">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${poStatusStyle[po.status]}`}>
                      {poStatusLabel(po.status)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-2 text-right">
                    {!['received', 'cancelled'].includes(po.status) && (
                      <Button variant="ghost" onClick={async () => setReceiving(await api.get<PurchaseOrder>(`/api/purchase-orders/${po.id}`))}>
                        Receive
                      </Button>
                    )}
                    <a href={`/api/pdf/purchase-order/${po.id}`} target="_blank" rel="noreferrer">
                      <Button variant="ghost">PDF</Button>
                    </a>
                    <Link to={`/purchase-orders/${po.id}`}><Button variant="ghost">Edit</Button></Link>
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
  /*
   * Keyed by the line's **position**, which is what the server books against.
   * Keying it by material was the old shape and could not tell two lines of
   * one material apart — nor receive a line naming a product at all, since
   * that has no material to key on.
   */
  const [qty, setQty] = useState<Record<number, number>>(
    Object.fromEntries((po.items ?? []).map((it, i) => [i, it.qty_pending ?? 0]))
  );
  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });

  const receive = useMutation({
    mutationFn: () => api.post(`/api/purchase-orders/${po.id}/receipts`, {
      date,
      location_id: locationId ? Number(locationId) : null,
      items: Object.entries(qty).map(([line, q]) => ({ line: Number(line), qty: q })),
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
          <tr className={TH_CLASS}>
            <th className="pb-2 pr-3">Line</th>
            <th className="pb-2 pr-3 text-right">Ordered</th>
            <th className="pb-2 pr-3 text-right">Already in</th>
            <th className="pb-2 pr-3 text-right">Outstanding</th>
            <th className="w-32 pb-2 pr-3 text-right">Receiving now</th>
          </tr>
        </thead>
        <tbody>
          {(po.items ?? []).map((it, i) => (
            <tr key={i} className="border-b border-slate-100 last:border-0">
              <td className="py-2 pr-3">
                {it.material_name ?? it.product_name ?? it.description}
                {/*
                  * Said on the row rather than hidden: a product line records
                  * what arrived and closes the order, but there is no
                  * finished-goods ledger for it to land in.
                  */}
                {it.product_id ? <span className="ml-1.5 text-xs text-slate-400">(not stocked)</span> : null}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{fmtQty(it.qty ?? 0)} {it.unit}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-500">{fmtQty(it.qty_received ?? 0)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{fmtQty(it.qty_pending ?? 0)}</td>
              <td className="py-2 pr-3">
                <Input
                  type="number" min={0} step="any"
                  value={qty[i] || ''}
                  onChange={(e) => setQty({ ...qty, [i]: Number(e.target.value) })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-slate-400">
        A material line’s quantity also becomes a stock movement at that plant; a product line is
        recorded against the order only, since finished goods are not held in stock. The order moves
        to “part received” or “received” by comparing what has arrived with what was ordered —
        nothing to set by hand.
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
  /*
   * Which question the figures answer.
   *
   * *Order book* is what customers have ordered and nobody has made yet;
   * *planned jobs* is what the work orders raised so far are short of. They
   * are alternatives, never added — a planned-but-unmade piece is also an
   * ordered-but-unmade one — and the order book is the default because resin
   * has to be committed to before the plan exists, which is the whole reason
   * to ask it one step earlier.
   */
  const [basis, setBasis] = useState<'orders' | 'jobs'>('orders');
  const { data: draft, isLoading } = useQuery({
    queryKey: ['po-shortfall-draft', basis],
    queryFn: () => api.get<ShortfallDraft>(`/api/purchase-orders/prefill/from-shortfall?basis=${basis}`),
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
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SegmentedTabs
          value={basis}
          onChange={setBasis}
          tabs={[
            { key: 'orders', label: 'What is ordered' },
            { key: 'jobs', label: 'What is planned' },
          ]}
        />
        <span className="text-xs text-slate-400">
          {basis === 'orders'
            ? 'Everything the open orders need and nobody has made yet — before any job is raised.'
            : 'Only what the work orders already raised are short of.'}
        </span>
      </div>

      {isLoading && <p className="text-sm text-slate-400">Working out what is needed…</p>}

      {draft && draft.items.length === 0 && (
        <EmptyState message={basis === 'orders'
          ? 'Nothing is short. Everything still to make on the open orders is covered by stock and what is already on order.'
          : 'Nothing is short. Every open job has the material it needs, counting what is already on order.'} />
      )}

      {/* A job with no recipe needs an unknown amount, not none. Saying so is
          the difference between a shortfall report and a misleading one. */}
      {!!draft?.uncosted.length && (
        <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <b>
            {draft.uncosted.length} {basis === 'orders' ? 'order line' : 'job'}
            {draft.uncosted.length === 1 ? ' has' : 's have'} no recipe
          </b>, so nothing below covers {draft.uncosted.length === 1 ? 'it' : 'them'}:{' '}
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
                  <tr className={`${CAPTION_CLASS} border-b border-slate-100 text-left`}>
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
          To buy is what {basis === 'orders' ? 'the order book' : 'planned jobs'} need, less what is on hand and
          less what is already on order — so raising these will not order the same material twice. Rates
          are what we last paid; check them before sending.
        </p>
      )}
    </Modal>
  );
}
