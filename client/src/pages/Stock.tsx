import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useIsManager } from '../App';
import type { StockRow, MaterialMove, Shortfall, Material, Location } from '../types';
import { PageHeader, Card, Tabs, Select, Input, Field, Button, EmptyState, ErrorText, Modal } from '../components/ui';
import { fmtQty, fmtMoney, fmtDate, today } from '../lib/format';

/**
 * The material ledger.
 *
 * Every figure here is a sum of movements — there is no stock column in the
 * database, so a balance cannot disagree with the history that produced it.
 * The Movements tab is that history, which is why a surprising balance is
 * always explainable.
 */

const sourceLabel: Record<string, string> = {
  opening: 'Opening', po_receipt: 'Received', issue: 'Issued',
  return: 'Returned', adjustment: 'Adjusted', transfer: 'Transfer',
};

export default function StockPage() {
  const [tab, setTab] = useState<'on-hand' | 'shortfall' | 'moves'>('on-hand');
  const [location, setLocation] = useState('');
  const [adjusting, setAdjusting] = useState(false);
  const isManager = useIsManager();

  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });
  const { data: rows = [] } = useQuery({
    queryKey: ['stock', location],
    queryFn: () => api.get<StockRow[]>(`/api/stock${location ? `?location_id=${location}` : ''}`),
  });
  const { data: short } = useQuery({
    queryKey: ['stock-shortfall', location],
    queryFn: () => api.get<Shortfall>(`/api/stock/shortfall${location ? `?location_id=${location}` : ''}`),
    enabled: tab === 'shortfall',
  });
  const { data: moves = [] } = useQuery({
    queryKey: ['stock-moves', location],
    queryFn: () => api.get<MaterialMove[]>(`/api/stock/moves${location ? `?location_id=${location}` : ''}`),
    enabled: tab === 'moves',
  });

  const lowCount = rows.filter((r) => r.below_reorder).length;
  // What the shed is worth, and how much of that figure is an estimate. Summing
  // the rows is safe: the value on each is that plant's quantity at the
  // material's own average, so the parts add up to the whole.
  const stockValue = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  // Per material, not per row — the same material is flagged at every plant it
  // sits at, and counting it once is what makes the sentence true.
  const unpricedMaterials = new Set(
    rows.filter((r) => (r.unpriced_qty ?? 0) > 0).map((r) => r.material_id)
  ).size;

  return (
    <div>
      <PageHeader
        title="Stock"
        subtitle="Material on hand, what is short, and every movement behind it"
        actions={isManager ? <Button onClick={() => setAdjusting(true)}>+ Opening / adjustment</Button> : undefined}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select className="w-52" value={location} onChange={(e) => setLocation(e.target.value)}>
          <option value="">All plants</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
        {lowCount > 0 && (
          <span className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">
            {lowCount} material{lowCount === 1 ? '' : 's'} below reorder level
          </span>
        )}
      </div>

      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'on-hand', label: 'On hand' },
          { key: 'shortfall', label: 'Shortfall' },
          { key: 'moves', label: 'Movements' },
        ]}
      />

      {tab === 'on-hand' && (
        <Card className="overflow-x-auto">
          {rows.length === 0 ? (
            <EmptyState message="Nothing has moved yet. Record an opening balance, or receive a purchase order." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="pb-2 pr-3">Material</th>
                  <th className="pb-2 pr-3">Category</th>
                  <th className="pb-2 pr-3">Plant</th>
                  <th className="pb-2 pr-3 text-right">On hand</th>
                  <th className="pb-2 pr-3 text-right">On order</th>
                  <th className="pb-2 pr-3 text-right">Reorder at</th>
                  <th className="pb-2 pr-3 text-right">Avg rate</th>
                  <th className="pb-2 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.material_id}-${r.location_id}`} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="py-2 pr-3 font-medium">{r.material_name}</td>
                    <td className="py-2 pr-3 capitalize text-slate-500">{r.category}</td>
                    <td className="py-2 pr-3">{r.location_name}</td>
                    <td className={`py-2 pr-3 text-right tabular-nums ${r.qty < 0 ? 'font-semibold text-red-600' : r.below_reorder ? 'font-semibold text-amber-700' : ''}`}>
                      {fmtQty(r.qty)} {r.unit}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-500">{r.on_order ? fmtQty(r.on_order) : '—'}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-400">{r.reorder_level ? fmtQty(r.reorder_level) : '—'}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                      {r.avg_rate ? fmtMoney(r.avg_rate, 'INR') : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {r.value ? fmtMoney(r.value, 'INR') : <span className="text-slate-300">—</span>}
                      {/* Some of this material arrived with no rate, so the
                          figure beside it is the known rate applied to stock
                          nobody costed. Say so on the row it affects. */}
                      {(r.unpriced_qty ?? 0) > 0 && (
                        <span
                          className="ml-1 cursor-help text-amber-600"
                          title={`${fmtQty(r.unpriced_qty)} ${r.unit} of this material has no purchase rate recorded — its value is estimated at the average of the rest.`}
                        >*</span>
                      )}
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2 border-slate-200 font-semibold">
                  <td className="py-2 pr-3" colSpan={6}>Total stock value</td>
                  <td className="py-2 text-right tabular-nums">{fmtMoney(stockValue, 'INR')}</td>
                </tr>
              </tbody>
            </table>
          )}
          {unpricedMaterials > 0 && (
            <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <b>{unpricedMaterials} material{unpricedMaterials === 1 ? '' : 's'}</b> (marked *) arrived
              without a purchase rate — usually an opening balance entered before costing existed. Their
              value is estimated at the average of the priced stock. Record a rate on those movements to
              make the total exact.
            </p>
          )}
          <p className="mt-2 text-xs text-slate-400">
            A negative balance means more was issued than the ledger knew about — the material really left, so
            it is shown rather than hidden. Book the opening balance or the missing receipt to clear it.
          </p>
        </Card>
      )}

      {tab === 'shortfall' && (
        <Card className="overflow-x-auto">
          {!short ? (
            <EmptyState message="Loading…" />
          ) : short.rows.length === 0 && short.uncosted.length === 0 ? (
            <EmptyState message="No open jobs need material." />
          ) : (
            <>
              {short.rows.length > 0 && (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                      <th className="pb-2 pr-3">Material</th>
                      <th className="pb-2 pr-3 text-right">Needed</th>
                      <th className="pb-2 pr-3 text-right">On hand</th>
                      <th className="pb-2 pr-3 text-right">On order</th>
                      <th className="pb-2 pr-3 text-right">Short</th>
                    </tr>
                  </thead>
                  <tbody>
                    {short.rows.map((r) => (
                      <tr key={r.material_id} className="border-b border-slate-100 last:border-0">
                        <td className="py-2 pr-3 font-medium">{r.material_name}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{fmtQty(r.required)} {r.unit}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{fmtQty(r.on_hand)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-slate-500">{r.on_order ? fmtQty(r.on_order) : '—'}</td>
                        <td className={`py-2 pr-3 text-right tabular-nums ${r.short > 0 ? 'font-semibold text-red-600' : 'text-green-700'}`}>
                          {r.short > 0 ? fmtQty(r.short) : 'covered'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {short.uncosted.length > 0 && (
                <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  <strong>{short.uncosted.length} open job{short.uncosted.length === 1 ? '' : 's'} not costed:</strong>{' '}
                  {short.uncosted.map((j) => j.number).join(', ')}. Their products have no recipe, so nothing
                  above accounts for them — the figures are a floor, not the whole requirement.
                </div>
              )}
              <p className="mt-2 text-xs text-slate-400">
                Needed counts what is still to make on open jobs, not the whole plan — material for pieces
                already moulded has been consumed, and counting it again would order it twice.
              </p>
            </>
          )}
        </Card>
      )}

      {tab === 'moves' && (
        <Card className="overflow-x-auto">
          {moves.length === 0 ? (
            <EmptyState message="No movements recorded." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="pb-2 pr-3">Date</th>
                  <th className="pb-2 pr-3">Material</th>
                  <th className="pb-2 pr-3">Plant</th>
                  <th className="pb-2 pr-3">What</th>
                  <th className="pb-2 pr-3">Against</th>
                  <th className="pb-2 pr-3 text-right">Qty</th>
                  <th className="pb-2 pr-3">By</th>
                </tr>
              </thead>
              <tbody>
                {moves.map((m) => (
                  <tr key={m.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="py-2 pr-3">{fmtDate(m.date)}</td>
                    <td className="py-2 pr-3">{m.material_name}</td>
                    <td className="py-2 pr-3 text-slate-500">{m.location_name}</td>
                    <td className="py-2 pr-3">{sourceLabel[m.source] ?? m.source}</td>
                    <td className="py-2 pr-3 text-xs text-slate-500">
                      {m.po_number ?? m.work_order_number ?? m.note ?? '—'}
                    </td>
                    <td className={`py-2 pr-3 text-right tabular-nums ${m.qty < 0 ? 'text-red-600' : 'text-green-700'}`}>
                      {m.qty > 0 ? '+' : ''}{fmtQty(m.qty)} {m.unit}
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-400">{m.created_by_name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {adjusting && <AdjustModal onClose={() => setAdjusting(false)} />}
    </div>
  );
}

/** Opening balances and corrections — manager-only, like the rest of purchasing. */
function AdjustModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ material_id: '', location_id: '', qty: 0, date: today(), source: 'opening', note: '' });
  const { data: materials = [] } = useQuery({ queryKey: ['master', 'materials', false], queryFn: () => api.get<Material[]>('/api/materials') });
  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });

  const save = useMutation({
    mutationFn: () => api.post('/api/stock/moves', {
      ...form, material_id: Number(form.material_id), location_id: Number(form.location_id), qty: form.qty,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stock'] });
      queryClient.invalidateQueries({ queryKey: ['stock-moves'] });
      onClose();
    },
  });

  const unit = materials.find((m) => m.id === Number(form.material_id))?.unit ?? '';

  return (
    <Modal title="Record a movement" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="What is this?" className="col-span-2">
          <Select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
            <option value="opening">Opening balance</option>
            <option value="adjustment">Adjustment after a stock check</option>
            <option value="return">Returned to store</option>
            <option value="transfer">Transfer in or out of this plant</option>
          </Select>
        </Field>
        <Field label="Material *" className="col-span-2">
          <Select value={form.material_id} onChange={(e) => setForm({ ...form, material_id: e.target.value })}>
            <option value="">— choose —</option>
            {materials.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.unit})</option>)}
          </Select>
        </Field>
        <Field label="Plant *">
          <Select value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })}>
            <option value="">— choose —</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
        <Field label={`Quantity ${unit ? `(${unit})` : ''} *`}>
          <Input type="number" step="any" value={form.qty || ''} onChange={(e) => setForm({ ...form, qty: Number(e.target.value) })} />
        </Field>
        <Field label="Date"><Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
        <Field label="Note"><Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
      </div>
      <p className="mt-2 text-xs text-slate-400">
        Negative takes stock out — a transfer to the other plant is a negative here and a positive there.
      </p>
      <ErrorText error={save.error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending || !form.material_id || !form.location_id || !form.qty}>
          {save.isPending ? 'Saving…' : 'Record'}
        </Button>
      </div>
    </Modal>
  );
}
