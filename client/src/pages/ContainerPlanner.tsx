import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Product } from '../types';
import { Button, Input, Select, Card, PageHeader, EmptyState } from '../components/ui';
import { fmtQty } from '../lib/format';
import {
  planFill, planRequirement, capacityFor,
  type ContainerSize, type Basis, type PlanInput,
} from '../lib/containerPlan';

type Mode = 'fill' | 'requirement';

interface Line { id: number; productId: number | null; value: number }

let nextLineId = 1;
const newLine = (): Line => ({ id: nextLineId++, productId: null, value: 1 });

export default function ContainerPlannerPage() {
  const [mode, setMode] = useState<Mode>('fill');
  const [size, setSize] = useState<ContainerSize>('40ft');
  const [containers, setContainers] = useState(1);
  const [basis, setBasis] = useState<Basis>('boxes');
  const [lines, setLines] = useState<Line[]>([newLine(), newLine()]);

  const { data: products = [] } = useQuery({
    queryKey: ['products', ''],
    queryFn: () => api.get<Product[]>('/api/products'),
  });

  const loadable = useMemo(
    () => products.filter((p) => p.qty_20ft != null || p.qty_40ft != null),
    [products]
  );

  const inputs: PlanInput[] = useMemo(
    () =>
      lines
        .map((l) => {
          const p = products.find((x) => x.id === l.productId);
          if (!p) return null;
          return {
            productId: l.id, // the row, not the product — the same product may appear twice
            name: p.name,
            pcsPerBox: p.pcs_per_pack,
            boxesPerContainer: capacityFor(p, size),
            value: l.value,
          } satisfies PlanInput;
        })
        .filter((x): x is PlanInput => x !== null),
    [lines, products, size]
  );

  const plan = useMemo(
    () => (mode === 'fill' ? planFill(inputs, size, containers, basis) : planRequirement(inputs, size, basis)),
    [inputs, mode, size, containers, basis]
  );

  const setLine = (id: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const totalBoxes = plan.rows.reduce((s, r) => s + r.boxes, 0);
  const totalPieces = plan.rows.reduce((s, r) => s + (r.pieces ?? 0), 0);

  return (
    <div>
      <PageHeader
        title="Container Planner"
        subtitle="Work out the mix of products that fills a container — or how many containers an order needs"
        actions={<Button variant="secondary" onClick={() => setLines([...lines, newLine()])}>+ Add Product</Button>}
      />

      {loadable.length === 0 ? (
        <Card>
          <EmptyState message="No product has boxes-per-container recorded yet." />
          <p className="-mt-6 pb-2 text-center text-sm text-slate-500">
            Add <span className="font-medium">Pcs / Box</span> and <span className="font-medium">Boxes per 20ft / 40ft</span> on{' '}
            <Link to="/products" className="text-brand-600 hover:underline">Products</Link>, or import them from your
            catalogue spreadsheet.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {/* Controls */}
          <Card>
            <div className="flex flex-wrap items-end gap-4">
              <label className="text-xs text-slate-600">
                <span className="mb-1 block font-medium">What do you want to work out?</span>
                <Select value={mode} onChange={(e) => setMode(e.target.value as Mode)} className="w-64">
                  <option value="fill">I have containers — what mix fits?</option>
                  <option value="requirement">I have quantities — how many containers?</option>
                </Select>
              </label>
              <label className="text-xs text-slate-600">
                <span className="mb-1 block font-medium">Container</span>
                <Select value={size} onChange={(e) => setSize(e.target.value as ContainerSize)} className="w-28">
                  <option value="20ft">20 ft</option>
                  <option value="40ft">40 ft</option>
                </Select>
              </label>
              {mode === 'fill' && (
                <label className="text-xs text-slate-600">
                  <span className="mb-1 block font-medium">How many</span>
                  <Input
                    type="number" min={1} step={1} className="w-24"
                    value={containers}
                    onChange={(e) => setContainers(Math.max(1, Number(e.target.value) || 1))}
                  />
                </label>
              )}
              <label className="text-xs text-slate-600">
                <span className="mb-1 block font-medium">{mode === 'fill' ? 'Ratio is in' : 'Quantities are in'}</span>
                <Select value={basis} onChange={(e) => setBasis(e.target.value as Basis)} className="w-28">
                  <option value="boxes">Boxes</option>
                  <option value="pieces">Pieces</option>
                </Select>
              </label>
            </div>
            <p className="mt-3 text-xs text-slate-400">
              A plan covers containers of one size. For a shipment using both a 20ft and a 40ft, plan each separately.
            </p>
          </Card>

          {/* Lines + result */}
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="pb-2 pr-3">Product</th>
                  <th className="pb-2 pr-3 text-right">Pcs / Box</th>
                  <th className="pb-2 pr-3 text-right">Boxes / {size}</th>
                  <th className="pb-2 pr-3 text-right w-28">{mode === 'fill' ? 'Ratio' : `Required (${basis})`}</th>
                  <th className="pb-2 pr-3 text-right">→ Boxes</th>
                  <th className="pb-2 pr-3 text-right">→ Pieces</th>
                  <th className="pb-2 pr-3 text-right">Space</th>
                  <th className="pb-2 w-8" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const p = products.find((x) => x.id === l.productId);
                  const row = plan.rows.find((r) => r.productId === l.id);
                  const capacity = p ? capacityFor(p, size) : null;
                  return (
                    <tr key={l.id} className="border-b border-slate-100 last:border-0">
                      <td className="py-2 pr-3">
                        <Select
                          value={l.productId ?? ''}
                          onChange={(e) => setLine(l.id, { productId: e.target.value ? Number(e.target.value) : null })}
                        >
                          <option value="">— choose a product —</option>
                          {products.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}{x.pcs_per_pack ? ` (${fmtQty(x.pcs_per_pack)}/box)` : ''}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-slate-500">{p?.pcs_per_pack ? fmtQty(p.pcs_per_pack) : '—'}</td>
                      <td className={`py-2 pr-3 text-right tabular-nums ${capacity ? 'text-slate-500' : 'text-red-500'}`}>
                        {capacity ? fmtQty(capacity) : p ? 'not set' : '—'}
                      </td>
                      <td className="py-2 pr-3">
                        <Input
                          type="number" min={0} step="any" className="text-right"
                          value={l.value}
                          onChange={(e) => setLine(l.id, { value: Math.max(0, Number(e.target.value) || 0) })}
                        />
                      </td>
                      <td className="py-2 pr-3 text-right font-semibold tabular-nums">{row ? fmtQty(row.boxes) : '—'}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{row?.pieces != null ? fmtQty(row.pieces) : '—'}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                        {row && row.space > 0 ? `${row.sharePct.toFixed(1)}%` : '—'}
                      </td>
                      <td className="py-2 text-right">
                        <button
                          className="text-slate-300 hover:text-red-500"
                          title="Remove line"
                          onClick={() => setLines((prev) => (prev.length > 1 ? prev.filter((x) => x.id !== l.id) : prev))}
                        >✕</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-200 font-semibold">
                  <td className="pt-2 pr-3" colSpan={4}>Total</td>
                  <td className="pt-2 pr-3 text-right tabular-nums">{fmtQty(totalBoxes)}</td>
                  <td className="pt-2 pr-3 text-right tabular-nums">{totalPieces ? fmtQty(totalPieces) : '—'}</td>
                  <td className="pt-2 pr-3 text-right tabular-nums">{plan.spaceUsed.toFixed(2)} cntr</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </Card>

          {/* Verdict */}
          <Card>
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Containers</div>
                <div className="text-2xl font-bold text-slate-800">
                  {plan.containers} × {size}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Utilisation</div>
                <div className={`text-2xl font-bold ${plan.utilisation >= 98 ? 'text-green-700' : plan.utilisation >= 85 ? 'text-amber-600' : 'text-red-600'}`}>
                  {plan.utilisation.toFixed(1)}%
                </div>
              </div>
              <div className="min-w-48 flex-1">
                <div className="mb-1 text-xs uppercase tracking-wide text-slate-500">Fill</div>
                <div className="h-3 rounded-full bg-slate-100">
                  <div
                    className={`h-3 rounded-full ${plan.utilisation >= 98 ? 'bg-green-600' : plan.utilisation >= 85 ? 'bg-amber-500' : 'bg-red-500'}`}
                    style={{ width: `${Math.min(100, plan.utilisation)}%` }}
                  />
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  {plan.spaceUsed.toFixed(2)} of {plan.containers} container{plan.containers === 1 ? '' : 's'} used
                </div>
              </div>
            </div>

            {plan.leftover && (
              <p className="mt-3 text-sm text-amber-700">
                Room left for about <span className="font-semibold">{fmtQty(plan.leftover.boxes)}</span> more
                boxes of {plan.leftover.name}.
              </p>
            )}
            {plan.utilisation >= 99.9 && plan.containers > 0 && (
              <p className="mt-3 text-sm text-green-700">Containers are full — nothing further fits at this ratio.</p>
            )}
            {plan.issues.length > 0 && (
              <ul className="mt-3 space-y-0.5 text-sm text-red-600">
                {[...new Set(plan.issues)].map((i) => <li key={i}>⚠ {i}</li>)}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
