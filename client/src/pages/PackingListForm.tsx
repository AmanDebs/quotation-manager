import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { PackingList, PackingListItem, Customer } from '../types';
import { Button, Input, Textarea, Select, Field, PageHeader, ErrorText, Card } from '../components/ui';
import { fmtQty, today } from '../lib/format';
import { UNITS } from './Products';

interface Draft {
  customer_id: number | '';
  invoice_id: number | null;
  date: string;
  shipping_marks: string;
  remarks: string;
  items: PackingListItem[];
}

const emptyItem = (): PackingListItem => ({ description: '', qty: null, unit: 'unit', packages: '', dimensions: '', gross_weight: 0, net_weight: 0 });

export default function PackingListFormPage() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isNew = !id;
  const fromInvoice = search.get('from_invoice');

  const { data: customers = [] } = useQuery({ queryKey: ['customers', ''], queryFn: () => api.get<Customer[]>('/api/customers') });
  const { data: existing, error: loadError } = useQuery({
    queryKey: ['packing-list', id],
    queryFn: () => api.get<PackingList>(`/api/packing-lists/${id}`),
    enabled: !isNew,
  });

  const [draft, setDraft] = useState<Draft>({ customer_id: '', invoice_id: null, date: today(), shipping_marks: '', remarks: '', items: [] });
  const [prefilled, setPrefilled] = useState(false);

  useEffect(() => {
    if (existing) {
      setDraft({
        customer_id: existing.customer_id,
        invoice_id: existing.invoice_id,
        date: existing.date,
        shipping_marks: existing.shipping_marks,
        remarks: existing.remarks,
        items: existing.items ?? [],
      });
    }
  }, [existing]);

  useEffect(() => {
    if (isNew && fromInvoice && !prefilled) {
      api.get<{ invoice_id: number; customer_id: number; items: PackingListItem[] }>(`/api/packing-lists/prefill/from-invoice/${fromInvoice}`).then((p) => {
        setDraft((d) => ({
          ...d,
          invoice_id: p.invoice_id,
          customer_id: p.customer_id,
          items: p.items.map((it) => ({ ...emptyItem(), description: it.description, qty: it.qty, unit: it.unit })),
        }));
        setPrefilled(true);
      });
    }
  }, [isNew, fromInvoice, prefilled]);

  const save = useMutation({
    mutationFn: (d: Draft) => (isNew ? api.post<PackingList>('/api/packing-lists', d) : api.put<PackingList>(`/api/packing-lists/${id}`, d)),
    onSuccess: (pl) => {
      queryClient.invalidateQueries({ queryKey: ['packing-lists'] });
      queryClient.invalidateQueries({ queryKey: ['packing-list', String(pl.id)] });
      if (isNew) navigate(`/packing-lists/${pl.id}`, { replace: true });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/api/packing-lists/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['packing-lists'] });
      navigate('/packing-lists');
    },
  });

  if (loadError) return <ErrorText error={loadError} />;
  if (!isNew && !existing) return <div className="text-slate-400">Loading…</div>;

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setItem = (i: number, patch: Partial<PackingListItem>) =>
    set({ items: draft.items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) });

  const totalGross = draft.items.reduce((s, it) => s + (it.gross_weight || 0), 0);
  const totalNet = draft.items.reduce((s, it) => s + (it.net_weight || 0), 0);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={isNew ? 'New Packing List' : existing!.number}
        subtitle={isNew ? (fromInvoice ? 'Pre-filled from invoice — add packages, dimensions and weights' : undefined) : existing!.customer_name}
        actions={
          !isNew && (
            <a href={`/api/pdf/packing-list/${id}`} target="_blank" rel="noreferrer"><Button variant="secondary">📄 PDF</Button></a>
          )
        }
      />

      <div className="space-y-4">
        <Card title="Details">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Customer *">
              <Select value={draft.customer_id} onChange={(e) => set({ customer_id: e.target.value ? Number(e.target.value) : '' })}>
                <option value="">Select customer…</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.country})</option>)}
              </Select>
            </Field>
            <Field label="Date"><Input type="date" value={draft.date} onChange={(e) => set({ date: e.target.value })} /></Field>
            <div />
            <Field label="Shipping Marks" className="col-span-3">
              <Textarea rows={2} value={draft.shipping_marks} onChange={(e) => set({ shipping_marks: e.target.value })} placeholder="Marks and numbers printed on packages…" />
            </Field>
          </div>
        </Card>

        <Card title="Packages">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-1 pr-2">Description</th>
                <th className="pb-1 pr-2 w-20">Qty</th>
                <th className="pb-1 pr-2 w-24">Unit</th>
                <th className="pb-1 pr-2 w-28">Packages</th>
                <th className="pb-1 pr-2 w-32">Dimensions</th>
                <th className="pb-1 pr-2 w-24">Net Wt (kg)</th>
                <th className="pb-1 pr-2 w-24">Gross Wt (kg)</th>
                <th className="pb-1 w-8" />
              </tr>
            </thead>
            <tbody>
              {draft.items.map((it, i) => (
                <tr key={i} className="border-b border-slate-100 align-top">
                  <td className="py-1.5 pr-2"><Input value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} /></td>
                  <td className="py-1.5 pr-2">
                    <Input type="number" min={0} step="any" value={it.qty ?? ''} onChange={(e) => setItem(i, { qty: e.target.value === '' ? null : Number(e.target.value) })} />
                  </td>
                  <td className="py-1.5 pr-2">
                    <Select value={it.unit} onChange={(e) => setItem(i, { unit: e.target.value })}>
                      {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                    </Select>
                  </td>
                  <td className="py-1.5 pr-2"><Input value={it.packages} onChange={(e) => setItem(i, { packages: e.target.value })} placeholder="e.g. 10 cartons" /></td>
                  <td className="py-1.5 pr-2"><Input value={it.dimensions} onChange={(e) => setItem(i, { dimensions: e.target.value })} placeholder="60x40x40 cm" /></td>
                  <td className="py-1.5 pr-2"><Input type="number" min={0} step="any" value={it.net_weight || ''} onChange={(e) => setItem(i, { net_weight: Number(e.target.value) })} /></td>
                  <td className="py-1.5 pr-2"><Input type="number" min={0} step="any" value={it.gross_weight || ''} onChange={(e) => setItem(i, { gross_weight: Number(e.target.value) })} /></td>
                  <td className="py-1.5 text-right">
                    <button className="text-slate-300 hover:text-red-500" onClick={() => set({ items: draft.items.filter((_, idx) => idx !== i) })}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 flex items-center justify-between">
            <Button variant="secondary" onClick={() => set({ items: [...draft.items, emptyItem()] })}>+ Add Package Line</Button>
            <div className="text-sm text-slate-600">
              Net: <span className="font-semibold">{fmtQty(totalNet)} kg</span> · Gross: <span className="font-semibold">{fmtQty(totalGross)} kg</span>
            </div>
          </div>
        </Card>

        <Card title="Remarks">
          <Textarea rows={2} value={draft.remarks} onChange={(e) => set({ remarks: e.target.value })} />
        </Card>

        <ErrorText error={save.error ?? remove.error} />

        <div className="flex items-center justify-between">
          <div>
            {!isNew && <Button variant="danger" onClick={() => { if (confirm('Delete this packing list?')) remove.mutate(); }}>Delete</Button>}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => navigate('/packing-lists')}>Back</Button>
            <Button onClick={() => save.mutate(draft)} disabled={save.isPending || !draft.customer_id || draft.items.length === 0}>
              {save.isPending ? 'Saving…' : isNew ? 'Create Packing List' : 'Save Changes'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
