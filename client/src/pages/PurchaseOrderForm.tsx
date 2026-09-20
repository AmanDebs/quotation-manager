import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { PurchaseOrder, PoItem, Supplier, Material, Location, TaxType, Product } from '../types';
import { Button, Input, Textarea, Select, Field, PageHeader, ErrorText, Card, SettledDocumentType, SearchSelect, FIELD_GRID, TH_CLASS, type SearchOption } from '../components/ui';
import { PdfLink } from '../components/PdfLink';
import CompanySelect from '../components/CompanySelect';
import { DocNumber } from '../components/DocFields';
import HistoryCard from '../components/HistoryCard';
import { productTypeLabel } from './Products';
import { fmtMoney, today } from '../lib/format';
import { useUnsavedChanges } from '../lib/useUnsavedChanges';
import { poStatusLabel, poStatusStyle } from './PurchaseOrders';

/**
 * The purchase order as a page of its own, in the proforma's shape
 * (2026-09-20, the client with the dialog in front of them: *"I want a new
 * page for purchase orders like proforma invoice"*). It was a modal on the
 * list — fifteen header fields and a line table scrolling inside a box the
 * height of the window — and a dialog cannot be navigated away from, linked
 * to, or left with its edits asked about. The fields, the picker over both
 * masters and the from-shortfall prefill are the modal's, unchanged; what
 * moved is the frame: a route per document, cards, and the unsaved-changes
 * contract every document form follows. Manager-only in full, so there is
 * no read-only mode.
 */

export type PoDraft = Partial<PurchaseOrder> & { items: PoItem[] };

export const emptyPoItem = (): PoItem => ({ material_id: null, product_id: null, description: '', qty: null, unit: 'kg', rate: 0, tax_pct: 18 });

/*
 * A line names a material or a product, so the picker's value has to say which
 * — `m:3` and `p:3` are different things. Encoded rather than kept as two
 * fields on the control, so there is exactly one selected value and it cannot
 * end up meaning both.
 */
const itemKey = (it: PoItem): string =>
  it.material_id ? `m:${it.material_id}` : it.product_id ? `p:${it.product_id}` : '';

const emptyDraft = (suppliers: Supplier[], locations: Location[]): PoDraft => ({
  supplier_id: suppliers[0]?.id, location_id: locations[0]?.id ?? null,
  date: today(), expected_date: '', currency: 'INR', tax_type: 'igst' as TaxType,
  payment_terms: '', notes: '', items: [emptyPoItem()],
});

export default function PurchaseOrderFormPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  const { data: existing } = useQuery({
    queryKey: ['purchase-order', String(id)],
    queryFn: () => api.get<PurchaseOrder>(`/api/purchase-orders/${id}`),
    enabled: !isNew,
  });
  const { data: suppliers = [] } = useQuery({ queryKey: ['master', 'suppliers', false], queryFn: () => api.get<Supplier[]>('/api/suppliers') });
  const { data: materials = [] } = useQuery({ queryKey: ['master', 'materials', false], queryFn: () => api.get<Material[]>('/api/materials') });
  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });
  // Aglo buys finished and semi-finished goods in as well as resin, so the
  // catalogue is on the picker beside the materials.
  const { data: products = [] } = useQuery({ queryKey: ['products', ''], queryFn: () => api.get<Product[]>('/api/products') });

  // A draft handed over by the shortfall picker arrives in the router state
  // rather than a query param: it is a computed document, not an id.
  const handed = (location.state as { draft?: PoDraft } | null)?.draft;
  const [draft, setDraft] = useState<PoDraft>(() => handed ?? { items: [emptyPoItem()] });
  const [defaulted, setDefaulted] = useState(!!handed);

  useEffect(() => {
    if (existing) setDraft({ ...existing, items: existing.items ?? [] });
  }, [existing]);
  // A new order opens on the first supplier and plant, once the masters are
  // in — read rather than waited for, and once, so a cleared box stays cleared.
  useEffect(() => {
    if (!isNew || defaulted || (!suppliers.length && !locations.length)) return;
    setDraft((d) => ({ ...emptyDraft(suppliers, locations), ...d, supplier_id: d.supplier_id ?? suppliers[0]?.id, location_id: d.location_id ?? locations[0]?.id ?? null }));
    setDefaulted(true);
  }, [isNew, defaulted, suppliers, locations]);

  const set = (patch: Partial<PoDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setItem = (i: number, patch: Partial<PoItem>) =>
    setDraft((d) => ({ ...d, items: d.items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) }));

  /**
   * One picker over both masters.
   *
   * The kind is in the hint and in the keywords, so typing "resin" or
   * "preform" narrows the list to one master without a second control asking
   * which one first — the question is "what am I buying", not "which table is
   * it in". Materials lead, because most purchase orders are for resin.
   */
  const buyOptions = useMemo<SearchOption[]>(() => [
    { value: '', label: '— custom —', sticky: true },
    ...materials.map((m) => ({
      value: `m:${m.id}`,
      label: m.name,
      hint: ['Material', m.category, m.unit].filter(Boolean).join(' · '),
      keywords: `material ${m.category ?? ''} ${m.hsn_code ?? ''}`,
    })),
    ...products.map((p) => ({
      value: `p:${p.id}`,
      label: p.name,
      hint: ['Product', productTypeLabel(p.product_type), p.unit].filter(Boolean).join(' · '),
      keywords: `product ${productTypeLabel(p.product_type)} ${p.hsn_code ?? ''}`,
    })),
  ], [materials, products]);

  /** Picking either master fills the unit from **that master's** own column. */
  const pickItem = (i: number, value: string) => {
    if (!value) return setItem(i, { material_id: null, product_id: null });
    const [kind, rawId] = value.split(':');
    const mid = Number(rawId);
    if (kind === 'm') {
      const m = materials.find((x) => x.id === mid);
      setItem(i, { material_id: mid, product_id: null, description: m?.name ?? '', unit: m?.unit || 'kg' });
    } else {
      const p = products.find((x) => x.id === mid);
      setItem(i, {
        material_id: null, product_id: mid, description: p?.name ?? '', unit: p?.unit || 'unit',
        pcs_per_pack: p?.pcs_per_pack ?? null,
      });
    }
  };

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
    queryClient.invalidateQueries({ queryKey: ['stock'] });
    queryClient.invalidateQueries({ queryKey: ['stock-shortfall'] });
  };

  const canSave = !!draft.supplier_id && draft.items.length > 0;
  const { markSaved, pdf, prompt } = useUnsavedChanges(draft, {
    run: () => save.mutateAsync(draft),
    can: canSave,
  });

  const save = useMutation({
    mutationFn: (d: PoDraft) => (isNew ? api.post<PurchaseOrder>('/api/purchase-orders', d) : api.put<PurchaseOrder>(`/api/purchase-orders/${id}`, d)),
    onSuccess: (po) => {
      markSaved();
      refresh();
      queryClient.setQueryData(['purchase-order', String(po.id)], po);
      if (isNew) navigate(`/purchase-orders/${po.id}`, { replace: true });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/purchase-orders/${id}`),
    onSuccess: () => {
      // The document is gone; there is nothing left to warn about losing.
      markSaved();
      refresh();
      navigate('/purchase-orders');
    },
  });

  if (!isNew && !existing) return <div className="text-sm text-slate-500">Loading…</div>;

  // Preview only — the server recomputes on save, as it does for every document.
  const preview = draft.items.reduce((s, it) => s + (it.qty ?? 0) * (it.rate || 0), 0);
  const cur = draft.currency ?? 'INR';

  return (
    <div>
      <PageHeader
        title={isNew ? 'New Purchase Order' : existing!.number}
        subtitle={isNew ? (handed ? 'Pre-filled from the shortfall — review and save' : undefined) : existing!.supplier_name}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {!isNew && (
              <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${poStatusStyle[existing!.status]}`}>
                {poStatusLabel(existing!.status)}
              </span>
            )}
            {!isNew && (
              <PdfLink href={`/api/pdf/purchase-order/${id}`} guard={pdf}>
                <Button variant="secondary">📄 PDF</Button>
              </PdfLink>
            )}
            <Button variant="secondary" onClick={() => navigate('/purchase-orders')}>Cancel</Button>
            <Button onClick={() => save.mutate(draft)} disabled={save.isPending || !canSave}>
              {save.isPending ? 'Saving…' : isNew ? 'Create Purchase Order' : 'Save Changes'}
            </Button>
          </div>
        }
      />

      {suppliers.length === 0 && (
        <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Add a supplier under Production Masters first — a purchase order needs someone to buy from.
        </div>
      )}

      <div className="space-y-4">
        <Card title="Details">
          <div className={FIELD_GRID}>
            {!isNew && (
              <Field label="PO Number">
                <DocNumber value={draft.number} title="Assigned from this company's series when the order was created" />
              </Field>
            )}
            <Field label="Supplier *">
              <Select value={draft.supplier_id ?? ''} onChange={(e) => set({ supplier_id: Number(e.target.value) })}>
                <option value="">Select supplier…</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="Issued By">
              <CompanySelect value={draft.company_id ?? null} locked={!isNew} onChange={(cid) => set({ company_id: cid ?? undefined })} />
            </Field>
            <Field label="Deliver to">
              <Select value={draft.location_id ?? ''} onChange={(e) => set({ location_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— none —</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </Field>
            <Field label="Date"><Input type="date" value={draft.date ?? ''} onChange={(e) => set({ date: e.target.value })} /></Field>
            <Field label="Expected"><Input type="date" value={draft.expected_date ?? ''} onChange={(e) => set({ expected_date: e.target.value })} /></Field>
            {/*
              * Editable only while the order is new, then stated — the number is
              * drawn from the domestic or the import series and never reissued,
              * so the server refuses a change afterwards. Same control and same
              * reason as on the proforma.
              */}
            <Field label="Type">
              {isNew ? (
                <Select
                  value={draft.is_import ? '1' : '0'}
                  onChange={(e) => set({ is_import: e.target.value === '1' ? 1 : 0, tax_type: e.target.value === '1' ? 'none' : (draft.tax_type === 'none' ? 'igst' : draft.tax_type) })}
                >
                  <option value="0">Domestic purchase</option>
                  <option value="1">Import</option>
                </Select>
              ) : (
                <SettledDocumentType isExport={!!draft.is_import} number={draft.number} />
              )}
            </Field>
            <Field label="Tax">
              <Select value={draft.tax_type ?? 'igst'} onChange={(e) => set({ tax_type: e.target.value as TaxType })}>
                <option value="igst">IGST (supplier in another state)</option>
                <option value="cgst_sgst">CGST + SGST (supplier in the same state)</option>
                <option value="none">No tax</option>
              </Select>
            </Field>
            <Field label="Currency">
              <Select value={cur} onChange={(e) => set({ currency: e.target.value })}>
                {['INR', 'USD', 'EUR'].map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="TCS %">
              <Input
                type="number" min={0} step="any" className="w-full text-right tabular-nums"
                value={draft.tcs_pct || ''}
                onChange={(e) => set({ tcs_pct: e.target.value === '' ? 0 : Number(e.target.value) })}
              />
            </Field>
            <Field label="Payment Terms"><Input value={draft.payment_terms ?? ''} onChange={(e) => set({ payment_terms: e.target.value })} /></Field>
            <Field label="Terms (FOB / Ex-factory)"><Input value={draft.inco_terms ?? ''} onChange={(e) => set({ inco_terms: e.target.value })} /></Field>
          </div>
        </Card>

        <Card title="Supplier & Shipment">
          <div className={FIELD_GRID}>
            <Field label="Kind Attn"><Input value={draft.attn ?? ''} onChange={(e) => set({ attn: e.target.value })} placeholder="Who at the supplier" /></Field>
            <Field label="Vendor ID"><Input value={draft.vendor_ref ?? ''} onChange={(e) => set({ vendor_ref: e.target.value })} placeholder="Their reference for us" /></Field>
            <Field label="Transport"><Input value={draft.transport ?? ''} onChange={(e) => set({ transport: e.target.value })} /></Field>
            <Field label="Ship via"><Input value={draft.ship_via ?? ''} onChange={(e) => set({ ship_via: e.target.value })} /></Field>
            <Field label="Ship to" className="sm:col-span-2">
              <Textarea rows={2} value={draft.ship_to ?? ''} onChange={(e) => set({ ship_to: e.target.value })} placeholder="Leave blank to print the plant above" />
            </Field>
            <Field label="Packing" className="sm:col-span-2">
              <Input value={draft.packing ?? ''} onChange={(e) => set({ packing: e.target.value })} placeholder="e.g. plain boxes, export standard" />
            </Field>
          </div>
        </Card>

        <Card title="Lines">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={TH_CLASS}>
                  <th className="pb-2 pr-2">Material or product</th>
                  <th className="w-20 pb-2 pr-2 text-right">Boxes</th>
                  <th className="w-20 pb-2 pr-2 text-right">Pcs/Box</th>
                  <th className="w-24 pb-2 pr-2 text-right">Qty</th>
                  <th className="w-20 pb-2 pr-2">Unit</th>
                  <th className="w-24 pb-2 pr-2 text-right">Rate</th>
                  <th className="w-20 pb-2 pr-2 text-right">Tax %</th>
                  <th className="w-28 pb-2 pr-2 text-right">Amount</th>
                  <th className="w-8 pb-2" />
                </tr>
              </thead>
              <tbody>
                {draft.items.map((it, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    <td className="py-2 pr-2">
                      <SearchSelect
                        className="w-full"
                        placeholder="Type to search…"
                        value={itemKey(it)}
                        options={buyOptions}
                        onChange={(v) => pickItem(i, v)}
                      />
                    </td>
                    <td className="py-2 pr-2"><Input type="number" min={0} step="any" className="w-full text-right tabular-nums" value={it.packs ?? ''} onChange={(e) => setItem(i, { packs: e.target.value === '' ? null : Number(e.target.value) })} /></td>
                    <td className="py-2 pr-2"><Input type="number" min={0} step="any" className="w-full text-right tabular-nums" value={it.pcs_per_pack ?? ''} onChange={(e) => setItem(i, { pcs_per_pack: e.target.value === '' ? null : Number(e.target.value) })} /></td>
                    <td className="py-2 pr-2"><Input type="number" min={0} step="any" className="w-full text-right tabular-nums" value={it.qty ?? ''} onChange={(e) => setItem(i, { qty: e.target.value === '' ? null : Number(e.target.value) })} /></td>
                    <td className="py-2 pr-2"><Input value={it.unit} onChange={(e) => setItem(i, { unit: e.target.value })} /></td>
                    <td className="py-2 pr-2"><Input type="number" min={0} step="any" className="w-full text-right tabular-nums" value={it.rate || ''} onChange={(e) => setItem(i, { rate: Number(e.target.value) })} /></td>
                    <td className="py-2 pr-2"><Input type="number" min={0} step="any" className="w-full text-right tabular-nums" value={it.tax_pct ?? ''} onChange={(e) => setItem(i, { tax_pct: Number(e.target.value) })} /></td>
                    <td className="py-2 pr-2 text-right tabular-nums">{fmtMoney((it.qty ?? 0) * (it.rate || 0), cur)}</td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        className="text-slate-300 hover:text-red-500"
                        onClick={() => set({ items: draft.items.filter((_, idx) => idx !== i) })}
                      >✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <Button variant="secondary" onClick={() => set({ items: [...draft.items, emptyPoItem()] })}>+ Add line</Button>
            <span className="text-sm text-slate-600">
              Lines <strong className="tabular-nums">{fmtMoney(preview, cur)}</strong>
              {!isNew && existing!.grand_total != null && (
                <> · Document Total <strong className="tabular-nums">{fmtMoney(existing!.grand_total, existing!.currency)}</strong></>
              )}
            </span>
          </div>
        </Card>

        <Card title="Notes">
          <Textarea rows={3} value={draft.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
        </Card>

        <ErrorText error={save.error ?? remove.error} />

        <div className="flex items-center justify-between">
          <div>
            {!isNew && <Button variant="danger" onClick={() => { if (confirm(`Delete ${existing!.number}?`)) remove.mutate(); }}>Delete</Button>}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => navigate('/purchase-orders')}>Back</Button>
            <Button onClick={() => save.mutate(draft)} disabled={save.isPending || !canSave}>
              {save.isPending ? 'Saving…' : isNew ? 'Create Purchase Order' : 'Save Changes'}
            </Button>
          </div>
        </div>

        <HistoryCard entity="purchase-orders" id={id ? Number(id) : undefined} />

        {/* The unsaved-changes dialog. Renders nothing until a navigation is actually blocked. */}
        {prompt}
      </div>
    </div>
  );
}
