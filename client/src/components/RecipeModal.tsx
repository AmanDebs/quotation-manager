import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Material, Product, RecipeLine } from '../types';
import { Button, Input, Select, Modal, ErrorText, EmptyState } from './ui';

/**
 * What one product is made of, per 1000 pieces.
 *
 * Per 1000 because the whole catalogue is quoted that way, and because it keeps
 * the numbers readable: a 119 g preform is 119 kg of resin per 1000 pieces, not
 * 0.119 of something. The preview line does that arithmetic out loud, since the
 * commonest mistake here is entering grams per piece.
 *
 * Having no recipe is the normal starting state — the order desk records
 * material as one word today — so nothing here nags, and everything downstream
 * reads "not costed" rather than zero.
 */
export default function RecipeModal({ product, onClose }: { product: Product; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [lines, setLines] = useState<RecipeLine[]>([]);

  const { data: materials = [] } = useQuery({
    queryKey: ['master', 'materials', false],
    queryFn: () => api.get<Material[]>('/api/materials'),
  });
  const { data: saved, isLoading } = useQuery({
    queryKey: ['recipe', String(product.id)],
    queryFn: () => api.get<RecipeLine[]>(`/api/products/${product.id}/materials`),
  });

  useEffect(() => { if (saved) setLines(saved); }, [saved]);

  const save = useMutation({
    mutationFn: () => api.put<RecipeLine[]>(`/api/products/${product.id}/materials`, { items: lines }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipe', String(product.id)] });
      onClose();
    },
  });

  const set = (i: number, patch: Partial<RecipeLine>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const unitFor = (materialId: number) => materials.find((m) => m.id === materialId)?.unit ?? '';

  return (
    <Modal title={`Recipe — ${product.name}`} onClose={onClose} wide>
      {materials.length === 0 ? (
        <EmptyState message="Add materials under Production Masters first — a recipe needs something to point at." />
      ) : isLoading ? (
        <EmptyState message="Loading…" />
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-2 pr-2">Material</th>
                <th className="w-32 pb-2 pr-2 text-right">Per 1000 pcs</th>
                <th className="w-24 pb-2 pr-2 text-right">Wastage %</th>
                <th className="pb-2 pr-2">For 100,000 pcs</th>
                <th className="w-8 pb-2" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const unit = unitFor(l.material_id);
                const per100k = (l.qty_per_1000 || 0) * 100 * (1 + (l.wastage_pct || 0) / 100);
                return (
                  <tr key={i} className="border-b border-slate-100 align-top">
                    <td className="py-2 pr-2">
                      <Select
                        value={l.material_id || ''}
                        onChange={(e) => set(i, { material_id: Number(e.target.value) })}
                      >
                        <option value="">— choose —</option>
                        {materials.map((m) => (
                          <option key={m.id} value={m.id}>{m.name} ({m.unit})</option>
                        ))}
                      </Select>
                    </td>
                    <td className="py-2 pr-2">
                      <Input
                        type="number" min={0} step="any"
                        value={l.qty_per_1000 || ''}
                        onChange={(e) => set(i, { qty_per_1000: Number(e.target.value) })}
                      />
                    </td>
                    <td className="py-2 pr-2">
                      <Input
                        type="number" min={0} step="any"
                        value={l.wastage_pct || ''}
                        placeholder="0"
                        onChange={(e) => set(i, { wastage_pct: Number(e.target.value) })}
                      />
                    </td>
                    <td className="py-3 pr-2 text-xs tabular-nums text-slate-500">
                      {l.material_id && l.qty_per_1000
                        ? `${per100k.toLocaleString('en-IN', { maximumFractionDigits: 2 })} ${unit}`
                        : '—'}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        className="text-slate-300 hover:text-red-500"
                        onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                        aria-label={`Remove line ${i + 1}`}
                        title="Remove"
                      >✕</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {lines.length === 0 && (
            <p className="py-4 text-center text-sm text-slate-400">
              No recipe yet. Material requirements for this product will read “not costed”.
            </p>
          )}

          <div className="mt-3">
            <Button
              variant="secondary"
              onClick={() => setLines((prev) => [...prev, { material_id: 0, qty_per_1000: 0, wastage_pct: 0 }])}
            >
              + Add material
            </Button>
          </div>

          <p className="mt-3 text-xs text-slate-400">
            Quantities are per <strong>1000 pieces</strong> in the material’s own stock unit — a 119 g
            preform is 119 kg of resin per 1000, not 0.119. Wastage is added on top.
          </p>

          <ErrorText error={save.error} />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save recipe'}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
