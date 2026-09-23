import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { PurchaseOrder, PoItem, Supplier, Material, Location, TaxType, Product } from '../types';
import { Button, Input, Textarea, Select, Field, PageHeader, ErrorText, Card, SettledDocumentType, SearchSelect, FIELD_GRID, TH_CLASS, type SearchOption } from '../components/ui';
import { PdfLink } from '../components/PdfLink';
import CompanySelect, { useCompanies } from '../components/CompanySelect';
import { DocNumber, PaymentTermsInput, PurchaseTermsInput } from '../components/DocFields';
import HistoryCard from '../components/HistoryCard';
import { productTypeLabel, unitOptions } from './Products';
import { PhotoCell } from '../components/LineItemsEditor';
import ColumnsControl, { newColumnConfig, purchaseColumns } from '../components/ColumnsControl';
import { fmtMoney, today } from '../lib/format';
import { PIECES_PER_BILLING_UNIT, piecesOrdered } from '../lib/pieces';
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

const DEFAULT_TAX_PCT = 18;
/**
 * The concessional rate a deemed export is bought at (2026-09-20, the client:
 * *"In tax add Deemed Export (0.1%)"*). Not a fourth stored tax type —
 * `purchase_orders.tax_type` carries a CHECK naming three and SQLite cannot
 * ALTER one — but a preset in the Tax picker: IGST with every line at 0.1%.
 * **Derived on the way back**: the picker reads *Deemed Export* whenever the
 * stored type is IGST and every line is at that rate, so there is no flag
 * that can come to disagree with the lines under it, and the PDF names the
 * concession by the same reading. A line's rate stays editable — the preset
 * writes the figure once and does not police it — and a new line added while
 * the preset is in force starts at 0.1 rather than 18.
 */
export const DEEMED_EXPORT_PCT = 0.1;

export const emptyPoItem = (taxPct = DEFAULT_TAX_PCT): PoItem => ({ material_id: null, product_id: null, description: '', color: '', image: '', qty: null, unit: 'kg', rate: 0, tax_pct: taxPct });

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
  payment_terms: '', notes: '', column_config: newColumnConfig(), items: [emptyPoItem()],
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
  const companies = useCompanies();

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

  /*
   * Bill-to and ship-to, each with its GSTIN, are mandatory (2026-09-20:
   * *"Make Bill To and Ship To mandatory"*) — and on a new order they are
   * written in from the issuing company and the plant, once both are known,
   * so the ordinary order meets the rule without typing: the company's own
   * address and GSTIN bill, the plant receives under the same registration.
   * A default, not a rule — only a blank box is filled, so a typed one is
   * never overwritten. It runs on a saved order too: one raised before the
   * fields existed opened with four blank mandatory boxes and a Save button
   * that would not enable until all were typed (the client's screenshot,
   * 2026-09-20), and the company's own details are what its PDF was already
   * printing in their place.
   */
  useEffect(() => {
    const co = companies.find((c) => c.id === (draft.company_id ?? companies.find((x) => x.is_default)?.id)) ?? companies.find((c) => c.is_default) ?? companies[0];
    const plant = locations.find((l) => l.id === draft.location_id);
    if (!co) return;
    setDraft((d) => {
      const patch: Partial<PoDraft> = {};
      const block = [co.company_name, co.address, [co.city, co.state, co.pincode].filter(Boolean).join(', ')].filter(Boolean).join('\n');
      if (!(d.bill_to ?? '').trim() && block) patch.bill_to = block;
      if (!(d.bill_to_gstin ?? '').trim() && co.gstin) patch.bill_to_gstin = co.gstin;
      // A plant named after the company (the ordinary single-plant setup)
      // is not written twice.
      if (!(d.ship_to ?? '').trim() && plant) {
        const plantName = plant.name.trim().toLowerCase() === String(co.company_name).trim().toLowerCase() ? '' : plant.name;
        patch.ship_to = [co.company_name, plantName, plant.address].filter(Boolean).join('\n');
      }
      if (!(d.ship_to_gstin ?? '').trim() && co.gstin) patch.ship_to_gstin = co.gstin;
      return Object.keys(patch).length ? { ...d, ...patch } : d;
    });
  }, [companies, locations, draft.company_id, draft.location_id]);

  const set = (patch: Partial<PoDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setItem = (i: number, patch: Partial<PoItem>) =>
    setDraft((d) => ({ ...d, items: d.items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) }));
  /**
   * Boxes × pcs/box fills the piece count and, on a piece basis, the billing
   * quantity with it (2026-09-20, the client with two lines typed and Qty
   * blank on both: *"Quantity should be filled automatically"*) — 1,000
   * boxes of 5,000 at `per 1000` is 5,000. The last figure typed drives, the
   * dispatch form's rule: retyping a box count recomputes the quantity, and
   * a quantity typed afterwards stands until the packing is touched again.
   * A weight basis derives nothing — kilos are not a count of boxes.
   */
  const setPacking = (i: number, patch: Partial<PoItem>) => {
    const it = { ...draft.items[i], ...patch };
    const per = PIECES_PER_BILLING_UNIT[it.unit ?? ''];
    if (it.packs != null && it.pcs_per_pack != null) {
      it.total_pcs = it.packs * it.pcs_per_pack;
    } else if (per && 'unit' in patch && it.total_pcs == null && it.qty != null) {
      // Moved onto a piece basis with a bare quantity typed: that figure was
      // typed as a count of something, and pieces is what the box now means.
      it.total_pcs = it.qty;
    }
    if (per && it.total_pcs != null) it.qty = it.total_pcs / per;
    setDraft((d) => ({ ...d, items: d.items.map((x, idx) => (idx === i ? it : x)) }));
  };
  /**
   * The Qty box is pieces on a piece basis (2026-09-20, the client with 19
   * boxes of 5,000 on the line: *"why quantity is showing 95, it should
   * show 95000"*) — the invoice's and the packing list's own rule, `piecesOf`,
   * where Quantity is what is bought and the `per 1000` beside the rate is
   * how it is priced. The billing quantity is derived under it and never
   * typed: `billedQty` on the server reads `total_pcs / per` ahead of a typed
   * `qty` on such a line anyway, so a box holding 95 was a figure the save
   * would have ignored. Typing pieces recomputes the boxes at the line's
   * pcs-per-box, the dispatch form's rule that the last figure typed drives;
   * on a weight basis the box is the kilos, as it always was.
   */
  const qtyShown = (it: PoItem): number | null =>
    (PIECES_PER_BILLING_UNIT[it.unit ?? ''] ? piecesOrdered(it) : it.qty ?? null);
  const setQty = (i: number, value: number | null) => {
    const it = { ...draft.items[i] };
    const per = PIECES_PER_BILLING_UNIT[it.unit ?? ''];
    if (per) {
      it.total_pcs = value;
      it.qty = value == null ? null : value / per;
      if (value != null && it.pcs_per_pack) it.packs = value / it.pcs_per_pack;
    } else {
      it.qty = value;
    }
    setDraft((d) => ({ ...d, items: d.items.map((x, idx) => (idx === i ? it : x)) }));
  };

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
      setItem(i, { material_id: mid, product_id: null, description: m?.name ?? '', color: '', image: '', unit: m?.unit || 'kg' });
    } else {
      const p = products.find((x) => x.id === mid);
      setItem(i, {
        material_id: null, product_id: mid, description: p?.name ?? '', color: p?.color ?? '', unit: p?.unit || 'unit',
        // The catalogue's photo unless one was already put on the line.
        image: draft.items[i]?.image || p?.image || '',
        pcs_per_pack: p?.pcs_per_pack ?? null,
      });
    }
  };

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
    queryClient.invalidateQueries({ queryKey: ['stock'] });
    queryClient.invalidateQueries({ queryKey: ['stock-shortfall'] });
  };

  const partiesStated = ['bill_to', 'bill_to_gstin', 'ship_to', 'ship_to_gstin'].every((f) => String((draft as Record<string, unknown>)[f] ?? '').trim());
  const canSave = !!draft.supplier_id && draft.items.length > 0 && partiesStated;
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
  /*
   * Which optional columns this order draws. Read from the document's own
   * config so the form and the PDF cannot disagree, with the same fallback
   * `ColumnsControl` gives a document saved before the config existed: an
   * order carrying nothing shows everything.
   */
  const hiddenCols = new Set(draft.column_config?.hidden ?? []);
  const show = (key: string) => !hiddenCols.has(key);

  const preview = draft.items.reduce((s, it) => s + (it.qty ?? 0) * (it.rate || 0), 0);
  const cur = draft.currency ?? 'INR';
  const deemed = draft.tax_type === 'igst' && draft.items.length > 0 && draft.items.every((it) => Number(it.tax_pct) === DEEMED_EXPORT_PCT);
  const taxChoice = deemed ? 'deemed_export' : (draft.tax_type ?? 'igst');
  const pickTax = (choice: string) => {
    if (choice === 'deemed_export') {
      set({ tax_type: 'igst', items: draft.items.map((it) => ({ ...it, tax_pct: DEEMED_EXPORT_PCT })) });
      return;
    }
    // Leaving the preset puts the lines it set back on the ordinary rate;
    // a line somebody had typed another figure into is left alone.
    set({ tax_type: choice as TaxType, items: deemed ? draft.items.map((it) => ({ ...it, tax_pct: DEFAULT_TAX_PCT })) : draft.items });
  };

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
              <Select value={taxChoice} onChange={(e) => pickTax(e.target.value)}>
                <option value="igst">IGST (supplier in another state)</option>
                <option value="cgst_sgst">CGST + SGST (supplier in the same state)</option>
                <option value="deemed_export">Deemed Export (IGST 0.1%)</option>
                <option value="none">No tax</option>
              </Select>
            </Field>
            <Field label="Currency">
              <Select value={cur} onChange={(e) => set({ currency: e.target.value })}>
                {['INR', 'USD', 'EUR'].map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            {/* TCS % left the form on 2026-09-20 with Transport and Ship via;
                it alone is shown where a value stands, being money in the
                total that could otherwise be neither seen nor cleared. */}
            {!!existing?.tcs_pct && (
              <Field label="TCS %">
                <Input
                  type="number" min={0} step="any" className="w-full text-right tabular-nums"
                  value={draft.tcs_pct || ''}
                  onChange={(e) => set({ tcs_pct: e.target.value === '' ? 0 : Number(e.target.value) })}
                />
              </Field>
            )}
            {/* The same list the domestic quotation offers (2026-09-20, the
                client: "Add the same payment terms dropdown as domestic
                quotation"); an import takes the export-side list, a
                consignment on a bill of lading being settled the same way
                whichever side of it we are on. Free text still, as there. */}
            <Field label="Payment Terms">
              <PaymentTermsInput isExport={!!draft.is_import} value={draft.payment_terms ?? ''} onChange={(v) => set({ payment_terms: v })} />
            </Field>
            <Field label="Terms">
              <PurchaseTermsInput value={draft.inco_terms ?? ''} onChange={(v) => set({ inco_terms: v })} />
            </Field>
          </div>
        </Card>

        <Card title="Supplier & Shipment">
          {/* Vendor ID, Transport and Ship via left the form on 2026-09-20 at
              the client's word — outright, an order carrying one included
              (the first cut showed them where a value stood, and the client
              asked again with such an order in front of them). The columns
              stay, the draft round-trips them, and the PDF prints what is
              there. TCS % alone is shown where a value stands, being money
              in the total that could otherwise be neither seen nor cleared. */}
          <div className={FIELD_GRID}>
            <Field label="Kind Attn"><Input value={draft.attn ?? ''} onChange={(e) => set({ attn: e.target.value })} placeholder="Who at the supplier" /></Field>
            <Field label="Packing" className="sm:col-span-2 xl:col-span-3">
              <Input value={draft.packing ?? ''} onChange={(e) => set({ packing: e.target.value })} placeholder="e.g. plain boxes, export standard" />
            </Field>
            {/* Bill-to and ship-to with their registrations (2026-09-20, the
                client: "Ship to with GST no and Bill To with GST No is
                required"), each a three-line address beside its GSTIN, the
                pair filling a row so neither party wraps under the other. */}
            <Field label="Bill to *" className="sm:col-span-2 xl:col-span-3">
              <Textarea rows={3} value={draft.bill_to ?? ''} onChange={(e) => set({ bill_to: e.target.value })} placeholder="The party invoiced" />
            </Field>
            <Field label="Bill to GSTIN *">
              <Input value={draft.bill_to_gstin ?? ''} onChange={(e) => set({ bill_to_gstin: e.target.value })} />
            </Field>
            <Field label="Ship to *" className="sm:col-span-2 xl:col-span-3">
              <Textarea rows={3} value={draft.ship_to ?? ''} onChange={(e) => set({ ship_to: e.target.value })} placeholder="Where the goods are delivered" />
            </Field>
            <Field label="Ship to GSTIN *">
              <Input value={draft.ship_to_gstin ?? ''} onChange={(e) => set({ ship_to_gstin: e.target.value })} />
            </Field>
          </div>
        </Card>

        {/*
          The columns this order prints, chosen the way a proforma's are
          (2026-09-23). The tick-list governs **both** this table and the PDF
          from one stored config, which is the whole reason `forceColumns`
          exists on the server: two lists is how the paper and the screen come
          to disagree about the same document.
        */}
        <Card
          title="Lines"
          actions={<ColumnsControl config={draft.column_config ?? {}} onChange={(c) => set({ column_config: c })} columns={purchaseColumns()} />}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={TH_CLASS}>
                  {/* The product column takes what is left after the figures,
                      capped (2026-09-20, the client: "Decrease the width of
                      material") — the figures had been squeezed to 80px boxes
                      beside a picker most of the card wide. */}
                  <th className="w-[28%] min-w-48 pb-2 pr-2">Material or product</th>
                  {/* A photo per line (2026-09-20, the client: "add a column
                      to insert image") — the line editor's own cell, the
                      catalogue's photo on a pick, replaced or cleared here. */}
                  {show('image') && <th className="w-14 pb-2 pr-2">Photo</th>}
                  {/* The colour bought (2026-09-20, the client: "Add Colour
                      column"): the catalogue's on a pick, typed over where
                      the supplier's word differs. */}
                  {show('color') && <th className="w-28 pb-2 pr-2">Colour</th>}
                  {show('packs') && <th className="w-24 pb-2 pr-2 text-right">Boxes</th>}
                  {show('pcs_per_pack') && <th className="w-24 pb-2 pr-2 text-right">Pcs/Box</th>}
                  <th className="w-32 pb-2 pr-2 text-right">Qty</th>
                  <th className="w-28 pb-2 pr-2">Unit</th>
                  <th className="w-28 pb-2 pr-2 text-right">Rate</th>
                  {show('tax') && <th className="w-20 pb-2 pr-2 text-right">Tax %</th>}
                  <th className="w-32 pb-2 pr-2 text-right">Amount</th>
                  <th className="w-8 pb-2" />
                </tr>
              </thead>
              <tbody>
                {draft.items.map((it, i) => (
                  <tr key={i} className="group border-b border-slate-100">
                    <td className="py-2 pr-2">
                      <SearchSelect
                        className="w-full"
                        placeholder="Type to search…"
                        value={itemKey(it)}
                        options={buyOptions}
                        onChange={(v) => pickItem(i, v)}
                      />
                    </td>
                    {show('image') && <td className="py-2 pr-2"><PhotoCell value={it.image ?? ''} onChange={(v) => setItem(i, { image: v })} /></td>}
                    {show('color') && <td className="py-2 pr-2"><Input value={it.color ?? ''} onChange={(e) => setItem(i, { color: e.target.value })} placeholder="e.g. Natural" /></td>}
                    {show('packs') && <td className="py-2 pr-2"><Input type="number" min={0} step="any" className="w-full text-right tabular-nums" value={it.packs ?? ''} onChange={(e) => setPacking(i, { packs: e.target.value === '' ? null : Number(e.target.value) })} /></td>}
                    {show('pcs_per_pack') && <td className="py-2 pr-2"><Input type="number" min={0} step="any" className="w-full text-right tabular-nums" value={it.pcs_per_pack ?? ''} onChange={(e) => setPacking(i, { pcs_per_pack: e.target.value === '' ? null : Number(e.target.value) })} /></td>}
                    <td className="py-2 pr-2"><Input type="number" min={0} step="any" className="w-full text-right tabular-nums" value={qtyShown(it) ?? ''} onChange={(e) => setQty(i, e.target.value === '' ? null : Number(e.target.value))} /></td>
                    {/* The catalogue's units, as the proforma's editor offers
                        them (2026-09-20, the client: "Like in proforma there
                        should be dropdown in unit"); a unit a saved line holds
                        that the list no longer carries stays on it. */}
                    <td className="py-2 pr-2">
                      <Select value={it.unit} onChange={(e) => setPacking(i, { unit: e.target.value })}>
                        {unitOptions(it.unit).map((u) => <option key={u} value={u}>{u}</option>)}
                      </Select>
                    </td>
                    <td className="py-2 pr-2"><Input type="number" min={0} step="any" className="w-full text-right tabular-nums" value={it.rate || ''} onChange={(e) => setItem(i, { rate: Number(e.target.value) })} /></td>
                    {show('tax') && <td className="py-2 pr-2"><Input type="number" min={0} step="any" className="w-full text-right tabular-nums" value={it.tax_pct ?? ''} onChange={(e) => setItem(i, { tax_pct: Number(e.target.value) })} /></td>}
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
            <Button variant="secondary" onClick={() => set({ items: [...draft.items, emptyPoItem(deemed ? DEEMED_EXPORT_PCT : DEFAULT_TAX_PCT)] })}>+ Add line</Button>
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
