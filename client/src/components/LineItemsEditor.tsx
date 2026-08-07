import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { LineItem, Product, TaxType, ColumnConfig } from '../types';
import { Button, Input, Select } from './ui';
import { fmtMoney, fmtQty } from '../lib/format';
import { UNITS } from '../pages/Products';

/**
 * Shared line-item grid for quotations, orders, proforma invoices and
 * commercial invoices.
 *
 * A line has two kinds of information and they are not equally important. The
 * billing figures (qty × price = amount) are read on every glance and get the
 * table proper. The packaging detail (code, colour, boxes, pcs/box) is entered
 * once — often filled from the catalogue — and then only referred to, so it
 * collapses to a single summary line that opens on demand.
 *
 * Columns hidden via the document's column_config disappear here and on the PDF.
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
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

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
        // The catalogue knows how this product packs; total pcs follows from it.
        pcs_per_pack: p.pcs_per_pack ?? items[i].pcs_per_pack,
      });
    }
  };

  const taxVisible = (showTax ?? taxType !== 'none') && show('tax');
  const subtotal = items.reduce((s, it) => s + (it.qty != null ? it.qty * it.unit_price : 0), 0);
  const tax = taxVisible ? items.reduce((s, it) => s + (it.qty != null ? it.qty * it.unit_price * ((it.tax_pct ?? 0) / 100) : 0), 0) : 0;

  const packagingVisible = show('code') || show('color') || show('supplier') || show('packs') || show('pcs_per_pack') || show('total_pcs') || customNames.length > 0;
  // Columns between the line number and the amount, for the packaging row's colSpan.
  const spanCols = 2 + (show('hsn') ? 1 : 0) + (show('qty') ? 1 : 0) + 1 + (show('unit_price') ? 1 : 0) + (taxVisible ? 1 : 0);

  /** The packaging values worth reading at a glance, as one line. */
  const summarise = (it: LineItem): string => {
    const parts: string[] = [];
    const code = (it as { code?: string }).code;
    const supplier = (it as { supplier?: string }).supplier;
    if (show('code') && code) parts.push(code);
    if (show('color') && it.color) parts.push(it.color);
    if (show('supplier') && supplier) parts.push(supplier);
    if (show('packs') && it.packs != null && show('pcs_per_pack') && it.pcs_per_pack != null) {
      parts.push(`${fmtQty(it.packs)} boxes × ${fmtQty(it.pcs_per_pack)}${it.total_pcs != null ? ` = ${fmtQty(it.total_pcs)} pcs` : ''}`);
    } else if (show('packs') && it.packs != null) {
      parts.push(`${fmtQty(it.packs)} boxes`);
    } else if (show('total_pcs') && it.total_pcs != null) {
      parts.push(`${fmtQty(it.total_pcs)} pcs`);
    }
    customNames.forEach((name, ci) => {
      const v = it[`custom${ci + 1}` as 'custom1'] as string;
      if (v) parts.push(`${name}: ${v}`);
    });
    return parts.join(' · ');
  };

  const packField = (label: string, node: ReactNode) => (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</span>
      {node}
    </label>
  );

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="w-8 pb-2 pr-2 font-medium">#</th>
              {/* w-52 fits ~75% of the catalogue's names; longer ones clip, but
                  the full name sits in Description and in the select's title. */}
              <th className="w-52 pb-2 pr-2 font-medium">Product</th>
              <th className="pb-2 pr-2 font-medium">Description</th>
              {show('hsn') && <th className="w-28 pb-2 pr-2 font-medium">HSN</th>}
              {show('qty') && <th className="w-24 pb-2 pr-2 text-right font-medium">Qty</th>}
              <th className="w-32 pb-2 pr-2 font-medium">Unit</th>
              {show('unit_price') && <th className="w-28 pb-2 pr-2 text-right font-medium">Unit Price</th>}
              {taxVisible && <th className="w-20 pb-2 pr-2 text-right font-medium">Tax %</th>}
              <th className="w-36 pb-2 pr-2 text-right font-medium">Amount</th>
              <th className="w-8 pb-2" />
            </tr>
          </thead>

          {items.map((it, i) => {
            const product = products.find((p) => p.id === it.product_id);
            const isOpen = expanded.has(i);
            const summary = summarise(it);
            const per1000 = it.total_pcs != null && it.total_pcs > 0 && it.qty != null && it.unit_price > 0
              ? (it.qty * it.unit_price / it.total_pcs) * 1000
              : null;

            return (
              <tbody key={i} className="group border-b border-slate-100 align-top hover:bg-slate-50/60">
                <tr>
                  <td className="py-2 pr-2 text-xs tabular-nums text-slate-400">{i + 1}</td>
                  <td className="py-2 pr-2">
                    <div className="flex items-center gap-1.5">
                      {product?.image && <img src={product.image} alt="" className="h-8 w-8 shrink-0 rounded border border-slate-200 object-cover" />}
                      <Select
                        value={it.product_id ?? ''}
                        title={product?.name ?? 'Custom line'}
                        onChange={(e) => pickProduct(i, e.target.value)}
                      >
                        <option value="">— custom —</option>
                        {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </Select>
                    </div>
                  </td>
                  <td className="py-2 pr-2">
                    <Input value={it.description} onChange={(e) => set(i, { description: e.target.value })} placeholder="Item description incl. weight spec, e.g. (119 ±2) gms" />
                  </td>
                  {show('hsn') && (
                    <td className="py-2 pr-2">
                      <Input value={it.hsn_code ?? ''} onChange={(e) => set(i, { hsn_code: e.target.value })} />
                    </td>
                  )}
                  {show('qty') && (
                    <td className="py-2 pr-2">
                      <Input
                        type="number" min={0} step="any"
                        value={it.qty ?? ''}
                        placeholder="—"
                        onChange={(e) => set(i, { qty: e.target.value === '' ? null : Number(e.target.value) })}
                      />
                    </td>
                  )}
                  <td className="py-2 pr-2">
                    <Select value={it.unit} onChange={(e) => set(i, { unit: e.target.value })}>
                      {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                    </Select>
                  </td>
                  {show('unit_price') && (
                    <td className="py-2 pr-2">
                      <Input type="number" min={0} step="any" value={it.unit_price || ''} onChange={(e) => set(i, { unit_price: Number(e.target.value) })} />
                    </td>
                  )}
                  {taxVisible && (
                    <td className="py-2 pr-2">
                      <Input type="number" min={0} max={100} step="any" value={it.tax_pct ?? ''} onChange={(e) => set(i, { tax_pct: e.target.value === '' ? 0 : Number(e.target.value) })} />
                    </td>
                  )}
                  <td className="py-2 pr-2 pt-4 text-right font-semibold tabular-nums text-slate-800">
                    {it.qty != null ? fmtMoney(it.qty * it.unit_price, currency) : <span className="font-normal text-slate-400">price only</span>}
                  </td>
                  <td className="py-2 pt-4 text-right">
                    <button
                      className="text-slate-300 opacity-0 transition-opacity hover:text-red-500 focus:opacity-100 focus:outline-none group-hover:opacity-100"
                      onClick={() => removeLine(i)}
                      aria-label={`Remove line ${i + 1}`}
                      title="Remove line"
                    >✕</button>
                  </td>
                </tr>

                {packagingVisible && (
                  <tr>
                    <td />
                    <td colSpan={spanCols} className="pb-2">
                      <button
                        type="button"
                        onClick={() => toggle(i)}
                        aria-expanded={isOpen}
                        aria-controls={`packing-${i}`}
                        className="flex items-center gap-1.5 rounded text-xs text-slate-500 hover:text-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                      >
                        <span className={`inline-block transition-transform ${isOpen ? 'rotate-90' : ''}`}>▸</span>
                        {summary ? (
                          <span>{summary}</span>
                        ) : (
                          <span className="text-slate-400">Add packaging details</span>
                        )}
                      </button>
                    </td>
                    <td className="pb-2 pr-2 text-right text-xs tabular-nums text-slate-400" colSpan={2}>
                      {per1000 != null && <>≈ {fmtMoney(per1000, currency)} /1000 pcs</>}
                    </td>
                  </tr>
                )}

                {packagingVisible && isOpen && (
                  <tr id={`packing-${i}`}>
                    <td />
                    <td colSpan={spanCols + 2} className="pb-3">
                      <div className="grid grid-cols-2 gap-3 rounded-md border border-slate-200 bg-slate-50/70 p-3 sm:grid-cols-3 lg:grid-cols-6">
                        {show('code') && packField('Code', (
                          <Input value={(it as { code?: string }).code ?? ''} onChange={(e) => set(i, { code: e.target.value } as Partial<LineItem>)} placeholder="48mm" />
                        ))}
                        {show('color') && packField('Colour', (
                          <Input value={it.color ?? ''} onChange={(e) => set(i, { color: e.target.value })} placeholder="Red" />
                        ))}
                        {show('supplier') && packField('Supplier', (
                          <Input value={(it as { supplier?: string }).supplier ?? ''} onChange={(e) => set(i, { supplier: e.target.value } as Partial<LineItem>)} placeholder="Internal" />
                        ))}
                        {show('packs') && packField('Boxes', (
                          <Input type="number" min={0} step="any" value={it.packs ?? ''} onChange={(e) => setPacking(i, { packs: e.target.value === '' ? null : Number(e.target.value) })} />
                        ))}
                        {show('pcs_per_pack') && packField('Pcs per box', (
                          <Input type="number" min={0} step="any" value={it.pcs_per_pack ?? ''} onChange={(e) => setPacking(i, { pcs_per_pack: e.target.value === '' ? null : Number(e.target.value) })} />
                        ))}
                        {show('total_pcs') && packField('Total pcs', (
                          <Input type="number" min={0} step="any" value={it.total_pcs ?? ''} onChange={(e) => set(i, { total_pcs: e.target.value === '' ? null : Number(e.target.value) })} />
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
        <div className="text-sm text-slate-600">
          Subtotal: <span className="font-semibold tabular-nums">{fmtMoney(subtotal, currency)}</span>
          {taxVisible && <> · Tax: <span className="font-semibold tabular-nums">{fmtMoney(tax, currency)}</span></>}
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-400">
        Qty × Unit Price is the billed amount (e.g. KGS × price/kg). Leave Qty empty for a price-only quotation.
      </p>
    </div>
  );
}
