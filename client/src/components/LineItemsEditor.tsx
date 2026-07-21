import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { LineItem, Product, TaxType } from '../types';
import { Button, Input, Select } from './ui';
import { fmtMoney } from '../lib/format';
import { UNITS } from '../pages/Products';

/**
 * Shared line-item grid for quotations, proforma invoices and commercial invoices.
 * Amounts shown here are a client-side preview; the server recomputes on save.
 */
export default function LineItemsEditor({
  items, onChange, currency, taxType, showTax,
}: {
  items: LineItem[];
  onChange: (items: LineItem[]) => void;
  currency: string;
  taxType: TaxType;
  showTax?: boolean;
}) {
  const { data: products = [] } = useQuery({ queryKey: ['products', ''], queryFn: () => api.get<Product[]>('/api/products') });

  const set = (i: number, patch: Partial<LineItem>) =>
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));

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
      });
    }
  };

  const taxVisible = showTax ?? taxType !== 'none';
  const subtotal = items.reduce((s, it) => s + (it.qty != null ? it.qty * it.unit_price : 0), 0);
  const tax = taxVisible ? items.reduce((s, it) => s + (it.qty != null ? it.qty * it.unit_price * ((it.tax_pct ?? 0) / 100) : 0), 0) : 0;

  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
            <th className="pb-1 pr-2 w-40">Product</th>
            <th className="pb-1 pr-2">Description</th>
            <th className="pb-1 pr-2 w-20">HSN</th>
            <th className="pb-1 pr-2 w-20">Qty</th>
            <th className="pb-1 pr-2 w-24">Unit</th>
            <th className="pb-1 pr-2 w-28">Unit Price</th>
            {taxVisible && <th className="pb-1 pr-2 w-16">Tax %</th>}
            <th className="pb-1 pr-2 w-28 text-right">Amount</th>
            <th className="pb-1 w-8" />
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i} className="border-b border-slate-100 align-top">
              <td className="py-1.5 pr-2">
                <Select value={it.product_id ?? ''} onChange={(e) => pickProduct(i, e.target.value)}>
                  <option value="">— custom —</option>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              </td>
              <td className="py-1.5 pr-2">
                <Input value={it.description} onChange={(e) => set(i, { description: e.target.value })} placeholder="Item description" />
              </td>
              <td className="py-1.5 pr-2">
                <Input value={it.hsn_code ?? ''} onChange={(e) => set(i, { hsn_code: e.target.value })} />
              </td>
              <td className="py-1.5 pr-2">
                <Input
                  type="number" min={0} step="any"
                  value={it.qty ?? ''}
                  placeholder="—"
                  onChange={(e) => set(i, { qty: e.target.value === '' ? null : Number(e.target.value) })}
                />
              </td>
              <td className="py-1.5 pr-2">
                <Select value={it.unit} onChange={(e) => set(i, { unit: e.target.value })}>
                  {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                </Select>
              </td>
              <td className="py-1.5 pr-2">
                <Input type="number" min={0} step="any" value={it.unit_price || ''} onChange={(e) => set(i, { unit_price: Number(e.target.value) })} />
              </td>
              {taxVisible && (
                <td className="py-1.5 pr-2">
                  <Input type="number" min={0} max={100} step="any" value={it.tax_pct ?? ''} onChange={(e) => set(i, { tax_pct: e.target.value === '' ? 0 : Number(e.target.value) })} />
                </td>
              )}
              <td className="py-1.5 pr-2 text-right tabular-nums">
                {it.qty != null ? fmtMoney(it.qty * it.unit_price, currency) : <span className="text-slate-400">price only</span>}
              </td>
              <td className="py-1.5 text-right">
                <button
                  className="text-slate-300 hover:text-red-500"
                  onClick={() => onChange(items.filter((_, idx) => idx !== i))}
                  title="Remove line"
                >✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex items-center justify-between">
        <Button
          variant="secondary"
          onClick={() => onChange([...items, { description: '', hsn_code: '', qty: null, unit: 'unit', unit_price: 0, tax_pct: 0 }])}
        >
          + Add Line
        </Button>
        <div className="text-sm text-slate-600">
          Subtotal: <span className="font-semibold tabular-nums">{fmtMoney(subtotal, currency)}</span>
          {taxVisible && <> · Tax: <span className="font-semibold tabular-nums">{fmtMoney(tax, currency)}</span></>}
        </div>
      </div>
      <p className="mt-1 text-xs text-slate-400">Leave Qty empty when the customer hasn't shared quantities — the document then shows unit prices only.</p>
    </div>
  );
}
