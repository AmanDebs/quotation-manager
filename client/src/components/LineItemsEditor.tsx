import { useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { LineItem, Product, TaxType, ColumnConfig } from '../types';
import { Button, Input, Select } from './ui';
import { fmtMoney } from '../lib/format';
import { shrinkImage } from '../lib/image';
import { unitOptions } from '../pages/Products';

/**
 * The photo for one line. Clicking the thumbnail replaces it, ✕ clears it.
 * Photos are downscaled before they are stored — see lib/image.ts for why.
 */
function PhotoCell({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      onChange(await shrinkImage(file));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not use that image');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="relative">
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => pick(e.target.files?.[0])}
      />
      {value ? (
        <>
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="block h-10 w-10 overflow-hidden rounded border border-slate-200 focus:outline-none focus:ring-1 focus:ring-brand-600"
            title="Replace photo"
          >
            <img src={value} alt="" className="h-full w-full object-cover" />
          </button>
          <button
            type="button"
            onClick={() => onChange('')}
            className="absolute -right-1.5 -top-1.5 rounded-full bg-white text-slate-400 opacity-0 shadow-sm hover:text-red-500 focus:opacity-100 group-hover:opacity-100"
            aria-label="Remove photo"
            title="Remove photo"
          >✕</button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={busy}
          className="flex h-10 w-10 items-center justify-center rounded border border-dashed border-slate-300 text-slate-400 hover:border-brand-600 hover:text-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
          title="Add a photo for this line"
          aria-label="Add a photo for this line"
        >
          {busy ? '…' : '+'}
        </button>
      )}
    </div>
  );
}

/**
 * Pieces in one billing unit, mirroring PIECES_PER_BILLING_UNIT in
 * server/src/services/totals.ts. The server is the authority — everything
 * here is a preview of what it will compute on save — but the preview has to
 * agree with it or the subtotal reads zero while the saved document does not.
 */
const PIECES_PER_BILLING_UNIT: Record<string, number> = { 'per 1000': 1000, unit: 1 };

/**
 * Whether a derived "per 1000 pcs" figure says anything the Unit Price does
 * not: it must be piece-based, and priced on some *other* piece basis. Quote a
 * line per 1000 and the derived rate is the unit price back again.
 */
/** Sentinel value for the product select's "this line is a charge" option. */
const CHARGE = 'charge';

const showsPer1000Rate = (unit: string | undefined) => {
  const per = PIECES_PER_BILLING_UNIT[unit ?? ''];
  return per !== undefined && per !== 1000;
};

/**
 * Boxes × pcs/box decides the quantity when the rate is priced per piece.
 * Otherwise the typed Qty stands, and failing that Total Qty is taken at face
 * value in whatever the rate basis is — quotations and proformas have no Qty
 * field, so a kg-priced line has nowhere else to say how much is being sold.
 */
function billedQty(it: LineItem): number | null {
  // A charge bills at quantity 1, so its price is its amount.
  if (it.is_charge) return 1;
  const per = PIECES_PER_BILLING_UNIT[it.unit ?? ''];
  if (per && it.total_pcs != null) return it.total_pcs / per;
  if (it.qty != null) return it.qty;
  return it.total_pcs ?? null;
}

/**
 * Shared line-item grid for quotations, orders, proforma invoices and
 * commercial invoices.
 *
 * The column order mirrors the quotation PDF (`buildQuotationPdf` in
 * server/src/services/pdf.ts), so what you type is laid out the way it prints.
 * Packing is part of that: Aglo prices per 1000 pieces, so pcs/box × boxes =
 * total qty *is* the quotation and those figures belong in the table proper.
 * Only the leftovers — code, supplier and any custom columns — collapse into
 * the quiet second line that opens on demand.
 *
 * Columns hidden via the document's column_config disappear here and on the
 * PDF; `omit` drops one for a document type that never has it at all.
 * Amounts shown are a client-side preview; the server recomputes on save.
 */
export default function LineItemsEditor({
  items, onChange, currency, taxType, showTax, config = {}, omit, forced, share,
}: {
  items: LineItem[];
  onChange: (items: LineItem[]) => void;
  currency: string;
  taxType: TaxType;
  showTax?: boolean;
  config?: ColumnConfig;
  /** Column keys this document type never carries, e.g. `['hsn']` on a quotation. */
  omit?: string[];
  /**
   * Column keys this document type always carries, whatever the config says —
   * see PROFORMA_FORCED in ColumnsControl. Applied last, so a hidden entry
   * inherited from a document that *was* allowed to drop the column cannot
   * take it away here.
   */
  forced?: string[];
  /**
   * Each line's share of the container space this document's goods take up,
   * keyed by line index — the one figure the Container Fitment table gave that
   * this table could not, now that the rest of that table's columns are these
   * columns. Derived, never stored and never printed, so it is a prop rather
   * than an entry in ITEM_COLUMNS: nothing can inherit it, nothing can turn it
   * off by mistake, and `services/pdf.ts` builds from a ColumnSpec list it is
   * not in. Given only by the proforma, which is the form that plans a load.
   *
   * A line absent from the map shows "—": a charge, a line with no boxes yet,
   * or one whose product has no loadability recorded — "nobody has said",
   * which is not the same as none.
   */
  share?: Map<number, number>;
}) {
  const { data: products = [] } = useQuery({ queryKey: ['products', ''], queryFn: () => api.get<Product[]>('/api/products') });
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const hidden = new Set([...(config.hidden ?? []), ...(omit ?? [])]);
  for (const key of forced ?? []) hidden.delete(key);
  const show = (key: string) => !hidden.has(key);
  const customNames = (config.custom ?? []).filter(Boolean);

  const set = (i: number, patch: Partial<LineItem>) =>
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));

  // Boxes × pcs/box auto-fills Total Pcs (still editable afterwards).
  const setPacking = (i: number, patch: Partial<LineItem>) => {
    const it = { ...items[i], ...patch };
    if ((patch.packs !== undefined || patch.pcs_per_pack !== undefined) && it.packs != null && it.pcs_per_pack != null) {
      it.total_pcs = it.packs * it.pcs_per_pack;
    }
    onChange(items.map((x, idx) => (idx === i ? it : x)));
  };

  const toggle = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });

  // Rows are addressed by index, so removing one has to shift every open row
  // above it down — otherwise the wrong line springs open.
  const removeLine = (i: number) => {
    onChange(items.filter((_, idx) => idx !== i));
    setExpanded((prev) => {
      const next = new Set<number>();
      for (const idx of prev) {
        if (idx < i) next.add(idx);
        else if (idx > i) next.add(idx - 1);
      }
      return next;
    });
  };

  const pickProduct = (i: number, productId: string) => {
    // "What kind of line is this?" is the same question as "which product?",
    // so charge lines are the third answer in the same select rather than a
    // checkbox somewhere else on the row.
    if (productId === CHARGE) {
      set(i, {
        product_id: null, is_charge: 1,
        // A charge has no packing, no colour and no loadability. Clearing them
        // matches what the server stores, so the row cannot show figures the
        // saved document does not have.
        packs: null, pcs_per_pack: null, total_pcs: null, qty: null,
        qty_20ft: null, qty_40ft: null, color: '',
      });
      return;
    }
    if (!productId) {
      set(i, { product_id: null, is_charge: 0 });
      return;
    }
    const p = products.find((x) => x.id === Number(productId));
    if (p) {
      set(i, {
        product_id: p.id, is_charge: 0,
        description: p.description ? `${p.name} — ${p.description}` : p.name,
        hsn_code: p.hsn_code,
        unit: p.unit,
        unit_price: p.unit_price,
        color: p.color || items[i].color,
        // The catalogue knows how this product packs and loads; total pcs
        // follows from it. Copied rather than looked up at print time, so
        // editing the catalogue never rewrites a quotation already sent.
        pcs_per_pack: p.pcs_per_pack ?? items[i].pcs_per_pack,
        qty_20ft: p.qty_20ft ?? items[i].qty_20ft,
        qty_40ft: p.qty_40ft ?? items[i].qty_40ft,
        // Reuse the catalogue photo when the line has none of its own, so a
        // photo set once on the product does not have to be uploaded again.
        image: items[i].image || p.image || '',
      });
    }
  };

  const taxVisible = (showTax ?? taxType !== 'none') && show('tax');
  // Turned off for a rate-and-packing price list: the lines still have
  // amounts and the document still has a grand total — the server computes
  // both on save either way — they are simply not shown or printed. Only the
  // quotation offers the toggle; see ColumnsControl.
  const amountVisible = show('amount');
  const lineAmount = (it: LineItem): number | null => {
    const q = billedQty(it);
    return q != null ? q * it.unit_price : null;
  };
  const subtotal = items.reduce((s, it) => s + (lineAmount(it) ?? 0), 0);
  const tax = taxVisible ? items.reduce((s, it) => s + (lineAmount(it) ?? 0) * ((it.tax_pct ?? 0) / 100), 0) : 0;

  // What is left once packing has its own columns: the fields a line rarely
  // carries. When none of them apply the second row holds only the /1000 rate.
  const extrasVisible = show('code') || show('supplier') || customNames.length > 0;
  // Before Amount rather than after it, so it falls inside spanCols below and
  // the second row's colSpan follows it for free; Amount stays the last figure,
  // which is what a money document wants.
  const shareVisible = !!share;
  // Columns between the line number and the amount, for the second row's colSpan.
  // Derived from the same show() calls as the header, so the two cannot drift.
  const spanCols = 3 // Product, Description, Unit — always present
    + (show('image') ? 1 : 0) + (show('hsn') ? 1 : 0) + (show('unit_price') ? 1 : 0)
    + (show('pcs_per_pack') ? 1 : 0) + (show('packs') ? 1 : 0) + (show('total_pcs') ? 1 : 0)
    + (show('qty_20ft') ? 1 : 0) + (show('qty_40ft') ? 1 : 0)
    + (show('qty') ? 1 : 0) + (show('color') ? 1 : 0) + (taxVisible ? 1 : 0)
    + (shareVisible ? 1 : 0);

  /** The leftover fields worth reading at a glance, as one line. */
  const summarise = (it: LineItem): string => {
    const parts: string[] = [];
    const code = (it as { code?: string }).code;
    const supplier = (it as { supplier?: string }).supplier;
    if (show('code') && code) parts.push(code);
    if (show('supplier') && supplier) parts.push(supplier);
    customNames.forEach((name, ci) => {
      const v = it[`custom${ci + 1}` as 'custom1'] as string;
      if (v) parts.push(`${name}: ${v}`);
    });
    return parts.join(' · ');
  };

  /** Stands in for a field a charge line has nothing to put in. */
  const none = <span className="block pt-2 text-xs text-slate-300">—</span>;

  const packField = (label: string, node: ReactNode) => (
    <label className="block">
      <span className="mb-1 block text-[0.6875rem] font-medium uppercase tracking-wide text-slate-400">{label}</span>
      {node}
    </label>
  );

  return (
    <div>
      <div className="overflow-x-auto">
        {/* Twelve columns do not fit a narrow window. Without a floor the
            table squeezed every column to make itself fit — Description worst,
            since it is the only one with no width of its own — so below this
            it scrolls in the wrapper instead, as the other tables do. */}
        <table className="w-full min-w-[1100px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="w-8 pb-2 pr-2 font-medium">#</th>
              {/* w-52 fits ~75% of the catalogue's names; longer ones clip, but
                  the full name sits in Description and in the select's title. */}
              <th className="w-52 pb-2 pr-2 font-medium">Product</th>
              {/* The widest column on purpose: it is the line's own text and
                  it is what prints. It needs a width of its own — with none it
                  measured 85px, narrower than Tax %. */}
              <th className="w-64 min-w-[13rem] pb-2 pr-2 font-medium">Description</th>
              {show('image') && <th className="w-14 pb-2 pr-2 font-medium">Photo</th>}
              {show('hsn') && <th className="w-28 pb-2 pr-2 font-medium">HSN</th>}
              {show('pcs_per_pack') && <th className="w-24 pb-2 pr-2 text-right font-medium">Pcs/Box</th>}
              {show('packs') && <th className="w-20 pb-2 pr-2 text-right font-medium">Boxes</th>}
              {show('qty_20ft') && <th className="w-24 pb-2 pr-2 text-right font-medium">Boxes/20ft</th>}
              {show('qty_40ft') && <th className="w-24 pb-2 pr-2 text-right font-medium">Boxes/40ft</th>}
              {show('total_pcs') && <th className="w-28 pb-2 pr-2 text-right font-medium">Total Qty</th>}
              {show('qty') && <th className="w-24 pb-2 pr-2 text-right font-medium">Qty</th>}
              {show('color') && <th className="w-24 pb-2 pr-2 font-medium">Colour</th>}
              {show('unit_price') && <th className="w-28 pb-2 pr-2 text-right font-medium">Unit Price</th>}
              <th className="w-28 pb-2 pr-2 font-medium">Unit</th>
              {taxVisible && <th className="w-16 pb-2 pr-2 text-right font-medium">Tax %</th>}
              {shareVisible && (
                <th
                  className="w-20 pb-2 pr-2 text-right font-medium"
                  title="Share of the container space these goods take up. Working figure — not printed."
                >
                  Share
                </th>
              )}
              {amountVisible && <th className="w-32 pb-2 pr-2 text-right font-medium">Amount</th>}
              <th className="w-8 pb-2" />
            </tr>
          </thead>

          {items.map((it, i) => {
            const product = products.find((p) => p.id === it.product_id);
            const charge = !!it.is_charge;
            const isOpen = expanded.has(i);
            const summary = summarise(it);
            const amount = lineAmount(it);
            const per1000 = it.total_pcs != null && it.total_pcs > 0 && amount != null && it.unit_price > 0
              && showsPer1000Rate(it.unit)
              ? (amount / it.total_pcs) * 1000
              : null;

            return (
              <tbody key={i} className="group border-b border-slate-100 align-top hover:bg-slate-50/60">
                <tr>
                  <td className="py-2 pr-2 text-xs tabular-nums text-slate-400">{i + 1}</td>
                  <td className="py-2 pr-2">
                    <div className="flex items-center gap-1.5">
                      <Select
                        value={charge ? CHARGE : (it.product_id ?? '')}
                        title={charge ? 'A charge, not goods' : product?.name ?? 'Custom line'}
                        onChange={(e) => pickProduct(i, e.target.value)}
                      >
                        <option value="">— custom —</option>
                        <option value={CHARGE}>— charge (freight, etc.) —</option>
                        {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </Select>
                    </div>
                  </td>
                  <td className="py-2 pr-2">
                    <Input value={it.description} onChange={(e) => set(i, { description: e.target.value })} placeholder="Item description incl. weight spec, e.g. (119 ±2) gms" />
                  </td>
                  {show('image') && (
                    <td className="py-2 pr-2">
                      {charge ? none : <PhotoCell value={it.image ?? ''} onChange={(v) => set(i, { image: v })} />}
                    </td>
                  )}
                  {show('hsn') && (
                    <td className="py-2 pr-2">
                      <Input value={it.hsn_code ?? ''} onChange={(e) => set(i, { hsn_code: e.target.value })} />
                    </td>
                  )}
                  {show('pcs_per_pack') && (
                    <td className="py-2 pr-2">
                      {charge ? none : (
                        <Input
                          type="number" min={0} step="any"
                          value={it.pcs_per_pack ?? ''}
                          placeholder="—"
                          onChange={(e) => setPacking(i, { pcs_per_pack: e.target.value === '' ? null : Number(e.target.value) })}
                        />
                      )}
                    </td>
                  )}
                  {show('packs') && (
                    <td className="py-2 pr-2">
                      {charge ? none : (
                        <Input
                          type="number" min={0} step="any"
                          value={it.packs ?? ''}
                          placeholder="—"
                          onChange={(e) => setPacking(i, { packs: e.target.value === '' ? null : Number(e.target.value) })}
                        />
                      )}
                    </td>
                  )}
                  {show('qty_20ft') && (
                    <td className="py-2 pr-2">
                      {charge ? none : (
                        <Input
                          type="number" min={0} step="any"
                          value={it.qty_20ft ?? ''}
                          placeholder="—"
                          onChange={(e) => set(i, { qty_20ft: e.target.value === '' ? null : Number(e.target.value) })}
                        />
                      )}
                    </td>
                  )}
                  {show('qty_40ft') && (
                    <td className="py-2 pr-2">
                      {charge ? none : (
                        <Input
                          type="number" min={0} step="any"
                          value={it.qty_40ft ?? ''}
                          placeholder="—"
                          onChange={(e) => set(i, { qty_40ft: e.target.value === '' ? null : Number(e.target.value) })}
                        />
                      )}
                    </td>
                  )}
                  {show('total_pcs') && (
                    <td className="py-2 pr-2">
                      {/* Boxes × pcs/box fills this in, but it stays editable —
                          a part-filled last box is normal. */}
                      {charge ? none : (
                        <Input
                          type="number" min={0} step="any"
                          value={it.total_pcs ?? ''}
                          placeholder="—"
                          onChange={(e) => set(i, { total_pcs: e.target.value === '' ? null : Number(e.target.value) })}
                        />
                      )}
                    </td>
                  )}
                  {show('qty') && (
                    <td className="py-2 pr-2">
                      {charge ? none : (
                        <Input
                          type="number" min={0} step="any"
                          value={it.qty ?? ''}
                          placeholder="—"
                          onChange={(e) => set(i, { qty: e.target.value === '' ? null : Number(e.target.value) })}
                        />
                      )}
                    </td>
                  )}
                  {show('color') && (
                    <td className="py-2 pr-2">
                      {charge ? none : (
                        <Input value={it.color ?? ''} onChange={(e) => set(i, { color: e.target.value })} placeholder="Natural" />
                      )}
                    </td>
                  )}
                  {show('unit_price') && (
                    <td className="py-2 pr-2">
                      {/* On a charge line this is the charge itself — there is
                          no quantity for it to be a rate against. */}
                      <Input
                        type="number" min={0} step="any"
                        value={it.unit_price || ''}
                        title={charge ? 'The amount of the charge' : undefined}
                        onChange={(e) => set(i, { unit_price: Number(e.target.value) })}
                      />
                    </td>
                  )}
                  <td className="py-2 pr-2">
                    {charge ? none : (
                      <Select value={it.unit} onChange={(e) => set(i, { unit: e.target.value })}>
                        {unitOptions(it.unit).map((u) => <option key={u} value={u}>{u}</option>)}
                      </Select>
                    )}
                  </td>
                  {taxVisible && (
                    <td className="py-2 pr-2">
                      <Input type="number" min={0} max={100} step="any" value={it.tax_pct ?? ''} onChange={(e) => set(i, { tax_pct: e.target.value === '' ? 0 : Number(e.target.value) })} />
                    </td>
                  )}
                  {shareVisible && (
                    <td className="py-2 pr-2 pt-4 text-right tabular-nums text-slate-500">
                      {share!.has(i) ? `${share!.get(i)!.toFixed(1)}%` : '—'}
                    </td>
                  )}
                  {amountVisible && (
                    <td className="py-2 pr-2 pt-4 text-right font-semibold tabular-nums text-slate-800">
                      {amount != null ? fmtMoney(amount, currency) : <span className="font-normal text-slate-400">price only</span>}
                    </td>
                  )}
                  <td className="py-2 pt-4 text-right">
                    <button
                      className="text-slate-300 opacity-0 transition-opacity hover:text-red-500 focus:opacity-100 focus:outline-none group-hover:opacity-100"
                      onClick={() => removeLine(i)}
                      aria-label={`Remove line ${i + 1}`}
                      title="Remove line"
                    >✕</button>
                  </td>
                </tr>

                {(extrasVisible || per1000 != null) && (
                  <tr>
                    <td />
                    <td colSpan={spanCols} className="pb-2">
                      {extrasVisible && (
                        <button
                          type="button"
                          onClick={() => toggle(i)}
                          aria-expanded={isOpen}
                          aria-controls={`extras-${i}`}
                          className="flex items-center gap-1.5 rounded text-xs text-slate-500 hover:text-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                        >
                          <span className={`inline-block transition-transform ${isOpen ? 'rotate-90' : ''}`}>▸</span>
                          {summary ? (
                            <span>{summary}</span>
                          ) : (
                            <span className="text-slate-400">Add more details</span>
                          )}
                        </button>
                      )}
                    </td>
                    {/* The /1000 rate is the pricing basis, so it shows whether
                        or not the extras are expanded. */}
                    <td className="pb-2 pr-2 text-right text-xs tabular-nums text-slate-400" colSpan={2}>
                      {per1000 != null && <>≈ {fmtMoney(per1000, currency)} /1000 pcs</>}
                    </td>
                  </tr>
                )}

                {extrasVisible && isOpen && (
                  <tr id={`extras-${i}`}>
                    <td />
                    <td colSpan={spanCols + (amountVisible ? 2 : 1)} className="pb-3">
                      <div className="grid grid-cols-2 gap-3 rounded-md border border-slate-200 bg-slate-50/70 p-3 sm:grid-cols-3 lg:grid-cols-6">
                        {show('code') && packField('Code', (
                          <Input value={(it as { code?: string }).code ?? ''} onChange={(e) => set(i, { code: e.target.value } as Partial<LineItem>)} placeholder="48mm" />
                        ))}
                        {show('supplier') && packField('Supplier', (
                          <Input value={(it as { supplier?: string }).supplier ?? ''} onChange={(e) => set(i, { supplier: e.target.value } as Partial<LineItem>)} placeholder="Internal" />
                        ))}
                        {customNames.map((name, ci) => (
                          <div key={ci}>
                            {packField(name, (
                              <Input
                                value={(it[`custom${ci + 1}` as 'custom1'] as string) ?? ''}
                                onChange={(e) => set(i, { [`custom${ci + 1}`]: e.target.value } as Partial<LineItem>)}
                              />
                            ))}
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            );
          })}
        </table>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <Button
          variant="secondary"
          onClick={() => onChange([...items, { description: '', hsn_code: '', qty: null, unit: 'unit', unit_price: 0, tax_pct: 0, color: '', packs: null, pcs_per_pack: null, total_pcs: null, custom1: '', custom2: '', custom3: '' }])}
        >
          + Add Line
        </Button>
        {/*
          "Lines", not "Subtotal" and "Tax".

          These two figures are this table's own arithmetic and cover nothing
          else. Header freight and insurance are added on top and — since Aglo
          charges GST on both — carry tax of their own, so a document with them
          shows a Document Total that these two do not sum to. Called Subtotal
          and Tax they invited exactly that subtraction and looked like a
          rounding error; called Lines they describe what they are, and the
          Document Total beside them stays the one authoritative figure.
        */}
        {amountVisible && (
          <div className="text-sm text-slate-600">
            Lines: <span className="font-semibold tabular-nums">{fmtMoney(subtotal, currency)}</span>
            {taxVisible && <> · Tax on lines: <span className="font-semibold tabular-nums">{fmtMoney(tax, currency)}</span></>}
          </div>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-400">
        {show('qty')
          ? 'Qty × Unit Price is the billed amount (e.g. KGS × price/kg). With a per-piece or per-1000 rate, Boxes × Pcs/Box sets the quantity instead.'
          : 'Boxes × Pcs/Box gives Total Qty, and Total Qty at the Unit Price gives the Amount — so with a per-1000 rate Total Qty is pieces, and with a per-kg rate it is kilos. Leave it empty for a price-only document.'}
        {' '}Pick <em>charge</em> in the Product column for freight, insurance or tooling: it bills at the price you type and is left out of the quantity totals.
      </p>
    </div>
  );
}
