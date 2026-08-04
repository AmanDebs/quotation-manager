import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { LineItem, Product, TaxType, ColumnConfig } from '../types';
import { Button, Input, Select } from './ui';
import { fmtMoney } from '../lib/format';
import { UNITS } from '../pages/Products';

/**
 * Shared line-item grid for quotations, proforma invoices and commercial invoices.
 * Each item has a billing row (qty × price) and a packaging row (colour, boxes,
 * pcs/box, total pcs, custom columns). Columns hidden via the document's
 * column_config disappear here and on the PDF.
 * Amounts shown are a client-side preview; the server recomputes on save.
 */
export default function LineItemsEditor({
  items, onChange, currency, taxType, showTax, config = {},
}: {
  items: LineItem[];
  onChange: (items: LineItem[]) => void;
  currency: string;
  taxType: TaxType;
  showTax?: boolean;
  config?: ColumnConfig;
}) {
  const { data: products = [] } = useQuery({ queryKey: ['products', ''], queryFn: () => api.get<Product[]>('/api/products') });

  const hidden = new Set(config.hidden ?? []);
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

  const pickProduct = (i: number, productId: string) => {
    if (!productId) {
      set(i, { product_id: null });
      return;
    }
    const p = products.find((x) => x.id === Number(productId));
    if (p) {
      set(i, {
        product_id: p.id,
        description: p.description ? `${p.name} — ${p.description}` : p.name,
        hsn_code: p.hsn_code,
        unit: p.unit,
        unit_price: p.unit_price,
        color: p.color || items[i].color,
      });
    }
  };

  const taxVisible = (showTax ?? taxType !== 'none') && show('tax');
  const subtotal = items.reduce((s, it) => s + (it.qty != null ? it.qty * it.unit_price : 0), 0);
  const tax = taxVisible ? items.reduce((s, it) => s + (it.qty != null ? it.qty * it.unit_price * ((it.tax_pct ?? 0) / 100) : 0), 0) : 0;

  const packagingVisible = show('code') || show('color') || show('supplier') || show('packs') || show('pcs_per_pack') || show('total_pcs') || customNames.length > 0;
  const mainCols = 3 + (show('hsn') ? 1 : 0) + (show('qty') ? 1 : 0) + (show('unit_price') ? 1 : 0) + (taxVisible ? 1 : 0);

  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
            <th className="pb-1 pr-2 w-40">Product</th>
            <th className="pb-1 pr-2">Description</th>
            {show('hsn') && <th className="pb-1 pr-2 w-20">HSN</th>}
            {show('qty') && <th className="pb-1 pr-2 w-20">Qty</th>}
            <th className="pb-1 pr-2 w-24">Unit</th>
            {show('unit_price') && <th className="pb-1 pr-2 w-28">Unit Price</th>}
            {taxVisible && <th className="pb-1 pr-2 w-16">Tax %</th>}
            <th className="pb-1 pr-2 w-28 text-right">Amount</th>
            <th className="pb-1 w-8" />
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => {
            const product = products.find((p) => p.id === it.product_id);
            return (
              <>
                <tr key={`m${i}`} className="align-top">
                  <td className="pt-1.5 pr-2">
                    <div className="flex items-center gap-1.5">
                      {product?.image && <img src={product.image} alt="" className="h-8 w-8 shrink-0 rounded border border-slate-200 object-cover" />}
                      <Select value={it.product_id ?? ''} onChange={(e) => pickProduct(i, e.target.value)}>
                        <option value="">— custom —</option>
                        {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </Select>
                    </div>
                  </td>
                  <td className="pt-1.5 pr-2">
                    <Input value={it.description} onChange={(e) => set(i, { description: e.target.value })} placeholder="Item description incl. weight spec, e.g. (119 ±2) gms" />
                  </td>
                  {show('hsn') && (
                    <td className="pt-1.5 pr-2">
                      <Input value={it.hsn_code ?? ''} onChange={(e) => set(i, { hsn_code: e.target.value })} />
                    </td>
                  )}
                  {show('qty') && (
                    <td className="pt-1.5 pr-2">
                      <Input
                        type="number" min={0} step="any"
                        value={it.qty ?? ''}
                        placeholder="—"
                        onChange={(e) => set(i, { qty: e.target.value === '' ? null : Number(e.target.value) })}
                      />
                    </td>
                  )}
                  <td className="pt-1.5 pr-2">
                    <Select value={it.unit} onChange={(e) => set(i, { unit: e.target.value })}>
                      {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                    </Select>
                  </td>
                  {show('unit_price') && (
                    <td className="pt-1.5 pr-2">
                      <Input type="number" min={0} step="any" value={it.unit_price || ''} onChange={(e) => set(i, { unit_price: Number(e.target.value) })} />
                    </td>
                  )}
                  {taxVisible && (
                    <td className="pt-1.5 pr-2">
                      <Input type="number" min={0} max={100} step="any" value={it.tax_pct ?? ''} onChange={(e) => set(i, { tax_pct: e.target.value === '' ? 0 : Number(e.target.value) })} />
                    </td>
                  )}
                  <td className="pt-1.5 pr-2 text-right tabular-nums">
                    {it.qty != null ? fmtMoney(it.qty * it.unit_price, currency) : <span className="text-slate-400">price only</span>}
                  </td>
                  <td className="pt-1.5 text-right">
                    <button
                      className="text-slate-300 hover:text-red-500"
                      onClick={() => onChange(items.filter((_, idx) => idx !== i))}
                      title="Remove line"
                    >✕</button>
                  </td>
                </tr>
                {packagingVisible && (
                  <tr key={`p${i}`} className="border-b border-slate-100">
                    <td />
                    <td colSpan={mainCols} className="pb-2 pt-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span className="font-medium uppercase tracking-wide text-slate-400">Packaging:</span>
                        {show('code') && (
                          <label className="flex items-center gap-1">Code
                            <Input className="!w-20 !py-1" value={(it as { code?: string }).code ?? ''} onChange={(e) => set(i, { code: e.target.value } as Partial<LineItem>)} placeholder="48mm" />
                          </label>
                        )}
                        {show('color') && (
                          <label className="flex items-center gap-1">Colour
                            <Input className="!w-24 !py-1" value={it.color ?? ''} onChange={(e) => set(i, { color: e.target.value })} placeholder="e.g. Red" />
                          </label>
                        )}
                        {show('supplier') && (
                          <label className="flex items-center gap-1">Supplier
                            <Input className="!w-24 !py-1" value={(it as { supplier?: string }).supplier ?? ''} onChange={(e) => set(i, { supplier: e.target.value } as Partial<LineItem>)} placeholder="Internal" />
                          </label>
                        )}
                        {show('packs') && (
                          <label className="flex items-center gap-1">Boxes/Ctns
                            <Input className="!w-20 !py-1" type="number" min={0} step="any" value={it.packs ?? ''} onChange={(e) => setPacking(i, { packs: e.target.value === '' ? null : Number(e.target.value) })} />
                          </label>
                        )}
                        {show('pcs_per_pack') && (
                          <label className="flex items-center gap-1">Pcs per box
                            <Input className="!w-20 !py-1" type="number" min={0} step="any" value={it.pcs_per_pack ?? ''} onChange={(e) => setPacking(i, { pcs_per_pack: e.target.value === '' ? null : Number(e.target.value) })} />
                          </label>
                        )}
                        {show('total_pcs') && (
                          <label className="flex items-center gap-1">Total Pcs
                            <Input className="!w-24 !py-1" type="number" min={0} step="any" value={it.total_pcs ?? ''} onChange={(e) => set(i, { total_pcs: e.target.value === '' ? null : Number(e.target.value) })} />
                          </label>
                        )}
                        {customNames.map((name, ci) => (
                          <label key={ci} className="flex items-center gap-1">{name}
                            <Input
                              className="!w-28 !py-1"
                              value={(it[`custom${ci + 1}` as 'custom1'] as string) ?? ''}
                              onChange={(e) => set(i, { [`custom${ci + 1}`]: e.target.value } as Partial<LineItem>)}
                            />
                          </label>
                        ))}
                        {it.total_pcs != null && it.qty != null && it.unit_price > 0 && (
                          <span className="text-slate-400">≈ {fmtMoney((it.qty * it.unit_price / it.total_pcs) * 1000, currency)}/1000 pcs</span>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>
      <div className="mt-2 flex items-center justify-between">
        <Button
          variant="secondary"
          onClick={() => onChange([...items, { description: '', hsn_code: '', qty: null, unit: 'unit', unit_price: 0, tax_pct: 0, color: '', packs: null, pcs_per_pack: null, total_pcs: null, custom1: '', custom2: '', custom3: '' }])}
        >
          + Add Line
        </Button>
        <div className="text-sm text-slate-600">
          Subtotal: <span className="font-semibold tabular-nums">{fmtMoney(subtotal, currency)}</span>
          {taxVisible && <> · Tax: <span className="font-semibold tabular-nums">{fmtMoney(tax, currency)}</span></>}
        </div>
      </div>
      <p className="mt-1 text-xs text-slate-400">Qty × Unit Price is the billed amount (e.g. KGS × price/kg). Packaging values print on the documents; the per-1000-pcs rate is derived. Leave Qty empty for a price-only quotation.</p>
    </div>
  );
}
