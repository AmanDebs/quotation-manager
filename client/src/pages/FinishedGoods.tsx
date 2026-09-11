import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useCan } from '../App';
import type { Location, Product, FgReport, FgAdjustment } from '../types';
import { PageHeader, Card, Select, Input, Textarea, Field, Button, EmptyState, ErrorText, Modal, Tabs, DownloadButton, TH_CLASS } from '../components/ui';
import { fmtQty, fmtDate, today } from '../lib/format';
import { useUrlFilter } from '../lib/useUrlFilter';

/**
 * Finished goods on hand — made, less dispatched, plus returned, plus what a
 * count corrected. Every column is a sum over records somebody else keeps for
 * their own reasons (`services/finishedGoods.ts`); the only thing this page
 * writes is the count.
 */

const REASON_LABEL: Record<string, string> = { opening: 'Opening balance', count: 'Stock count', other: 'Other' };

export default function FinishedGoodsPage() {
  const can = useCan();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'on-hand' | 'counts'>('on-hand');
  const [location, setLocation] = useUrlFilter('location');
  const [search, setSearch] = useState('');
  const [counting, setCounting] = useState<null | { product_id: number; location_id: number | null; on_hand: number }>(null);

  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });
  const { data: report } = useQuery({
    queryKey: ['finished-goods', location],
    queryFn: () => api.get<FgReport>(`/api/finished-goods${location ? `?location_id=${location}` : ''}`),
  });
  const { data: counts = [] } = useQuery({
    queryKey: ['finished-goods', 'adjustments'],
    queryFn: () => api.get<FgAdjustment[]>('/api/finished-goods/adjustments'),
    enabled: tab === 'counts',
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/finished-goods/adjust/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['finished-goods'] }),
  });

  const rows = (report?.rows ?? []).filter((r) => !search
    || r.product_name.toLowerCase().includes(search.toLowerCase())
    || r.color.toLowerCase().includes(search.toLowerCase()));
  const negative = rows.filter((r) => r.on_hand < 0).length;
  const mayCount = can('fg', 'full');

  return (
    <div>
      <PageHeader
        title="Finished Goods"
        subtitle="What is on the shelf: made, less what left, plus what came back"
        actions={
          <div className="flex items-center gap-2">
            <DownloadButton href={`/api/finished-goods/export${location ? `?location_id=${location}` : ''}`} />
            {mayCount && <Button onClick={() => setCounting({ product_id: 0, location_id: location ? Number(location) : null, on_hand: 0 })}>+ Count / opening</Button>}
          </div>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select className="w-52" value={location} onChange={(e) => setLocation(e.target.value)}>
          <option value="">All plants</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
        <Input className="max-w-64" placeholder="Search product or colour…" value={search} onChange={(e) => setSearch(e.target.value)} />
        {negative > 0 && (
          <span className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800" title="More has left than the record says was made — usually stock made before this app. An opening balance corrects it.">
            {negative} line{negative === 1 ? '' : 's'} below zero
          </span>
        )}
        {report && (report.unplaced.dispatched > 0 || report.unplaced.returned > 0) && (
          <span className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600" title="Pieces on lines that name no catalogue product — a custom line — so they cannot be placed against a product here.">
            {fmtQty(report.unplaced.dispatched)} dispatched{report.unplaced.returned > 0 ? ` · ${fmtQty(report.unplaced.returned)} returned` : ''} on lines with no product
          </span>
        )}
      </div>

      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ key: 'on-hand', label: 'On hand' }, { key: 'counts', label: 'Counts & opening balances' }]} />

      {tab === 'on-hand' && (
        <Card className="overflow-x-auto">
          {rows.length === 0 ? (
            <EmptyState message={search ? 'Nothing matches that search.' : 'Nothing has been made, shipped or counted yet.'} />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className={TH_CLASS}>
                  <th className="pb-2 pr-3">Product</th>
                  <th className="pb-2 pr-3">Plant</th>
                  <th className="pb-2 pr-3 text-right">Made</th>
                  <th className="pb-2 pr-3 text-right">Dispatched</th>
                  <th className="pb-2 pr-3 text-right">Returned</th>
                  <th className="pb-2 pr-3 text-right">Counted</th>
                  <th className="pb-2 pr-3 text-right">On hand</th>
                  {mayCount && <th className="pb-2" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.product_id}-${r.location_id}`} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="py-2 pr-3 font-medium">
                      {r.product_name}
                      {r.color && <span className="ml-1 font-normal text-slate-500">{r.color}</span>}
                    </td>
                    <td className="py-2 pr-3">{r.location_name ?? <span className="text-slate-400">Plant not recorded</span>}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-600">{fmtQty(r.made)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-600">{r.dispatched ? `−${fmtQty(r.dispatched)}` : '—'}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-600">{r.returned ? `+${fmtQty(r.returned)}` : '—'}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-600">{r.adjusted ? `${r.adjusted > 0 ? '+' : '−'}${fmtQty(Math.abs(r.adjusted))}` : '—'}</td>
                    <td className={`py-2 pr-3 text-right tabular-nums font-semibold ${r.on_hand < 0 ? 'text-red-600' : ''}`}>{fmtQty(r.on_hand)} pcs</td>
                    {mayCount && (
                      <td className="py-2 text-right">
                        <button className="text-xs text-brand-600 hover:underline" onClick={() => setCounting({ product_id: r.product_id, location_id: r.location_id, on_hand: r.on_hand })}>
                          Count
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-xs text-slate-400">
            Made is live output from the shift log (a scrapped lot is not stock); Dispatched is every trip line, placed against
            the order line’s product; Returned is what an approved credit note brought back. A figure below zero means more left
            than the record says was made — usually stock made before this app — and an opening balance is the correction.
          </p>
        </Card>
      )}

      {tab === 'counts' && (
        <Card className="overflow-x-auto">
          {counts.length === 0 ? (
            <EmptyState message="No counts or opening balances recorded." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className={TH_CLASS}>
                  <th className="pb-2 pr-3">Date</th>
                  <th className="pb-2 pr-3">Product</th>
                  <th className="pb-2 pr-3">Plant</th>
                  <th className="pb-2 pr-3">Reason</th>
                  <th className="pb-2 pr-3 text-right">Correction</th>
                  <th className="pb-2 pr-3">Notes</th>
                  <th className="pb-2 pr-3">By</th>
                  {mayCount && <th className="pb-2 w-8" />}
                </tr>
              </thead>
              <tbody>
                {counts.map((a) => (
                  <tr key={a.id} className="border-b border-slate-100 last:border-0">
                    <td className="whitespace-nowrap py-2 pr-3">{fmtDate(a.date)}</td>
                    <td className="py-2 pr-3 font-medium">{a.product_name}</td>
                    <td className="py-2 pr-3">{a.location_name ?? <span className="text-slate-400">—</span>}</td>
                    <td className="py-2 pr-3 text-slate-500">{REASON_LABEL[a.reason] ?? a.reason}</td>
                    <td className={`py-2 pr-3 text-right tabular-nums ${a.qty < 0 ? 'text-red-600' : 'text-green-700'}`}>{a.qty > 0 ? '+' : '−'}{fmtQty(Math.abs(a.qty))}</td>
                    <td className="py-2 pr-3 text-xs text-slate-500">{a.notes || '—'}</td>
                    <td className="py-2 pr-3 text-xs text-slate-500">{a.created_by_name || '—'}</td>
                    {mayCount && (
                      <td className="py-2 text-right">
                        <button className="text-slate-300 hover:text-red-500" title="Delete this correction" onClick={() => { if (confirm('Delete this count? The on-hand figure goes back to what the record alone says.')) remove.mutate(a.id); }}>✕</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <ErrorText error={remove.error} />
        </Card>
      )}

      {counting && (
        <CountModal
          start={counting}
          locations={locations}
          onClose={() => setCounting(null)}
          onSaved={() => { setCounting(null); queryClient.invalidateQueries({ queryKey: ['finished-goods'] }); }}
        />
      )}
    </div>
  );
}

/**
 * Record a count. Two ways to say the same thing — "the shelf holds N" or
 * "N more / fewer than the record" — and the arithmetic between them is done
 * here, where the figure it starts from is on screen; the server takes the
 * signed correction and nothing else, so a mis-keyed count can be read back.
 */
function CountModal({ start, locations, onClose, onSaved }: {
  start: { product_id: number; location_id: number | null; on_hand: number };
  locations: Location[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data: products = [] } = useQuery({ queryKey: ['products', ''], queryFn: () => api.get<Product[]>('/api/products') });
  const [productId, setProductId] = useState(start.product_id || '');
  const [locationId, setLocationId] = useState(start.location_id ?? '');
  const [mode, setMode] = useState<'set' | 'delta'>(start.product_id ? 'set' : 'delta');
  const [figure, setFigure] = useState('');
  const [reason, setReason] = useState(start.product_id ? 'count' : 'opening');
  const [date, setDate] = useState(today());
  const [notes, setNotes] = useState('');

  const { data: current } = useQuery({
    queryKey: ['finished-goods', 'one', productId, locationId],
    queryFn: () => api.get<FgReport>(`/api/finished-goods?product_id=${productId}${locationId ? `&location_id=${locationId}` : ''}`),
    enabled: !!productId,
  });
  const onHand = current?.rows.find((r) => r.location_id === (locationId ? Number(locationId) : null))?.on_hand ?? 0;
  const n = Number(figure);
  const qty = mode === 'set' ? n - onHand : n;

  const save = useMutation({
    mutationFn: () => api.post('/api/finished-goods/adjust', {
      product_id: Number(productId), location_id: locationId ? Number(locationId) : null, qty, reason, date, notes,
    }),
    onSuccess: onSaved,
  });

  return (
    <Modal title="Count / opening balance" onClose={onClose}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Product">
          <Select value={productId} onChange={(e) => setProductId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Select product…</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}{p.color ? ` · ${p.color}` : ''}</option>)}
          </Select>
        </Field>
        <Field label="Plant">
          <Select value={locationId} onChange={(e) => setLocationId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Plant not recorded</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
        <Field label="Reason">
          <Select value={reason} onChange={(e) => setReason(e.target.value)}>
            {Object.entries(REASON_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label={mode === 'set' ? 'The shelf holds (pcs)' : 'Correction (± pcs)'}>
          <Input type="number" step="any" value={figure} onChange={(e) => setFigure(e.target.value)} autoFocus />
        </Field>
        <Field label="Entered as">
          <Select value={mode} onChange={(e) => setMode(e.target.value as 'set' | 'delta')}>
            <option value="set">What the shelf holds</option>
            <option value="delta">More / fewer than the record</option>
          </Select>
        </Field>
      </div>
      {!!productId && (
        <p className="mt-2 text-sm text-slate-600">
          Record says <span className="font-semibold tabular-nums">{fmtQty(onHand)} pcs</span>
          {figure !== '' && Number.isFinite(n) && (
            <> → correction of <span className={`font-semibold tabular-nums ${qty < 0 ? 'text-red-600' : 'text-green-700'}`}>{qty > 0 ? '+' : ''}{fmtQty(qty)}</span></>
          )}
        </p>
      )}
      <Field label="Notes" className="mt-3"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Physical count on 11 Sep, rack B" /></Field>
      <ErrorText error={save.error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending || !productId || figure === '' || !Number.isFinite(n) || qty === 0}>
          {save.isPending ? 'Saving…' : 'Record'}
        </Button>
      </div>
    </Modal>
  );
}
