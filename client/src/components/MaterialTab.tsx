import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Order, WorkOrder, Material, Location, StockRow } from '../types';
import { Button, Input, Select, Field, Card, EmptyState, ErrorText, Modal } from './ui';
import { fmtQty, today } from '../lib/format';

/**
 * What this order needs, and whether it is in the store.
 *
 * Requirement comes from the recipes on the open jobs; on hand is the sum of
 * the ledger. A job whose product has no recipe is named rather than counted
 * as needing nothing — that distinction is the whole point, because a
 * shortfall report that silently skips half the floor is worse than none.
 */
export default function MaterialTab({ order }: { order: Order }) {
  const queryClient = useQueryClient();
  const [issuing, setIssuing] = useState<WorkOrder | null>(null);

  const { data: jobs = [] } = useQuery({
    queryKey: ['work-orders', String(order.id)],
    queryFn: () => api.get<WorkOrder[]>(`/api/work-orders?order_id=${order.id}`),
  });
  const { data: stock = [] } = useQuery({
    queryKey: ['stock'],
    queryFn: () => api.get<StockRow[]>('/api/stock'),
  });

  const open = jobs.filter((w) => !['done', 'cancelled'].includes(w.status));

  // Requirement for what is left to make on each open job, added per material.
  // Remaining, not the whole plan: resin for pieces already moulded has been
  // consumed, and counting it again would order it twice.
  const { data: details = [] } = useQuery({
    queryKey: ['work-order-details', String(order.id), open.map((w) => w.id).join()],
    queryFn: () => Promise.all(open.map((w) => api.get<WorkOrder>(`/api/work-orders/${w.id}`))),
    enabled: open.length > 0,
  });

  const need = new Map<number, { name: string; unit: string; qty: number; issued: number }>();
  const uncosted: WorkOrder[] = [];
  for (const w of details) {
    if (!w.material?.has_recipe) { uncosted.push(w); continue; }
    const remaining = Math.max(0, w.qty_planned - (w.progress?.produced ?? 0));
    const share = w.qty_planned > 0 ? remaining / w.qty_planned : 0;
    for (const l of w.material.lines) {
      const seen = need.get(l.material_id);
      const qty = l.qty * share;
      if (seen) { seen.qty += qty; seen.issued += l.issued; }
      else need.set(l.material_id, { name: l.name, unit: l.unit, qty, issued: l.issued });
    }
  }

  const onHandFor = (materialId: number) =>
    stock.filter((s) => s.material_id === materialId).reduce((t, s) => t + s.qty, 0);
  const onOrderFor = (materialId: number) =>
    stock.find((s) => s.material_id === materialId)?.on_order ?? 0;

  return (
    <div className="space-y-4">
      <Card title="Material for what is still to make">
        {open.length === 0 ? (
          <EmptyState message="No open jobs on this order, so nothing is needed." />
        ) : need.size === 0 && uncosted.length === 0 ? (
          <EmptyState message="Loading…" />
        ) : (
          <>
            {need.size > 0 && (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                    <th className="pb-2 pr-3">Material</th>
                    <th className="pb-2 pr-3 text-right">Needed</th>
                    <th className="pb-2 pr-3 text-right">Issued</th>
                    <th className="pb-2 pr-3 text-right">In store</th>
                    <th className="pb-2 pr-3 text-right">On order</th>
                    <th className="pb-2 pr-3 text-right">Short</th>
                  </tr>
                </thead>
                <tbody>
                  {[...need].map(([id, n]) => {
                    const have = onHandFor(id);
                    const coming = onOrderFor(id);
                    const short = Math.max(0, n.qty - have - coming);
                    return (
                      <tr key={id} className="border-b border-slate-100 last:border-0">
                        <td className="py-2 pr-3 font-medium">{n.name}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{fmtQty(n.qty)} {n.unit}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-slate-500">{n.issued ? fmtQty(n.issued) : '—'}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{fmtQty(have)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-slate-500">{coming ? fmtQty(coming) : '—'}</td>
                        <td className={`py-2 pr-3 text-right tabular-nums ${short > 0 ? 'font-semibold text-red-600' : 'text-green-700'}`}>
                          {short > 0 ? fmtQty(short) : 'covered'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {uncosted.length > 0 && (
              <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <strong>Not costed:</strong>{' '}
                {uncosted.map((w) => w.number).join(', ')} — the product has no recipe, so nothing above
                accounts for {uncosted.length === 1 ? 'it' : 'them'}. Add one under Products → Recipe.
              </div>
            )}
          </>
        )}
      </Card>

      <Card title="Issue material to a job">
        {open.length === 0 ? (
          <EmptyState message="Nothing open to issue against." />
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {open.map((w) => (
                <tr key={w.id} className="border-b border-slate-100 last:border-0">
                  <td className="py-2 pr-3 font-medium">{w.number}</td>
                  <td className="py-2 pr-3">{w.description || w.product_name || '—'}</td>
                  <td className="py-2 pr-3 text-xs text-slate-500">{w.location_name ?? 'no plant set'}</td>
                  <td className="py-2 text-right">
                    <Button variant="ghost" onClick={() => setIssuing(w)}>Issue</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-xs text-slate-400">
          Issuing takes material out of the plant’s stock and records it against the job, so planned
          consumption can be compared with what was actually drawn.
        </p>
      </Card>

      {issuing && (
        <IssueModal
          job={issuing}
          onClose={() => setIssuing(null)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ['stock'] });
            queryClient.invalidateQueries({ queryKey: ['work-order-details'] });
          }}
        />
      )}
    </div>
  );
}

function IssueModal({ job, onClose, onSaved }: { job: WorkOrder; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    material_id: '', qty: 0, date: today(), location_id: String(job.location_id ?? ''), note: '',
  });
  const { data: materials = [] } = useQuery({ queryKey: ['master', 'materials', false], queryFn: () => api.get<Material[]>('/api/materials') });
  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });

  const issue = useMutation({
    mutationFn: () => api.post('/api/stock/issue', {
      work_order_id: job.id,
      material_id: Number(form.material_id),
      qty: form.qty,
      date: form.date,
      location_id: form.location_id ? Number(form.location_id) : null,
      note: form.note,
    }),
    onSuccess: () => { onSaved(); onClose(); },
  });

  const unit = materials.find((m) => m.id === Number(form.material_id))?.unit ?? '';

  return (
    <Modal title={`Issue to ${job.number}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Material *" className="col-span-2">
          <Select value={form.material_id} onChange={(e) => setForm({ ...form, material_id: e.target.value })}>
            <option value="">— choose —</option>
            {materials.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.unit})</option>)}
          </Select>
        </Field>
        <Field label={`Quantity ${unit ? `(${unit})` : ''} *`}>
          <Input type="number" min={0} step="any" value={form.qty || ''} onChange={(e) => setForm({ ...form, qty: Number(e.target.value) })} />
        </Field>
        <Field label="Date"><Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
        <Field label="Out of which plant *" className="col-span-2">
          <Select value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })}>
            <option value="">— choose —</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
        <Field label="Note" className="col-span-2">
          <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
      </div>
      <ErrorText error={issue.error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => issue.mutate()} disabled={issue.isPending || !form.material_id || !form.qty}>
          {issue.isPending ? 'Issuing…' : 'Issue'}
        </Button>
      </div>
    </Modal>
  );
}
