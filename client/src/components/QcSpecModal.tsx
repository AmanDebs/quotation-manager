import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Product, QcParam, QcKind } from '../types';
import { Button, Input, Select, Modal, ErrorText, EmptyState } from './ui';

/**
 * What to check on this product, and what passes.
 *
 * The recipe's twin: a short list, rewritten whole, in its own dialog rather
 * than as more fields on the catalogue row — "what it is made of" and "what
 * makes it good" are different questions from "what it sells for".
 *
 * Editing this does **not** disturb inspections already recorded. Each result
 * carries its own copy of the tolerance it was judged against, so tightening a
 * spec cannot retroactively fail a batch that met the spec of the day.
 */

const emptyParam = (): QcParam =>
  ({ name: '', kind: 'numeric', unit: '', min_value: null, max_value: null, notes: '' });

/** Blank must persist as null, not 0 — an open-ended tolerance is not "zero". */
const numOrNull = (v: string) => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));

export default function QcSpecModal({ product, onClose }: { product: Product; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [lines, setLines] = useState<QcParam[]>([]);

  const { data: saved, isLoading } = useQuery({
    queryKey: ['qc-params', String(product.id)],
    queryFn: () => api.get<QcParam[]>(`/api/products/${product.id}/qc-params`),
  });

  useEffect(() => { if (saved) setLines(saved.length ? saved : [emptyParam()]); }, [saved]);

  const save = useMutation({
    mutationFn: () => api.put<QcParam[]>(`/api/products/${product.id}/qc-params`, { items: lines }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['qc-params', String(product.id)] });
      // A job's screen shows the live spec beside its checks.
      queryClient.invalidateQueries({ queryKey: ['work-order-details'] });
      onClose();
    },
  });

  const set = (i: number, patch: Partial<QcParam>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  return (
    <Modal title={`Quality checks — ${product.name}`} onClose={onClose} wide>
      {isLoading ? (
        <EmptyState message="Loading…" />
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-2 pr-2">Check</th>
                <th className="w-32 pb-2 pr-2">Type</th>
                <th className="w-20 pb-2 pr-2">Unit</th>
                <th className="w-24 pb-2 pr-2 text-right">Min</th>
                <th className="w-24 pb-2 pr-2 text-right">Max</th>
                <th className="w-8 pb-2" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className="border-b border-slate-100 last:border-0">
                  <td className="py-1.5 pr-2">
                    <Input
                      value={line.name}
                      onChange={(e) => set(i, { name: e.target.value })}
                      placeholder="e.g. Neck diameter"
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <Select
                      value={line.kind}
                      onChange={(e) => {
                        const kind = e.target.value as QcKind;
                        // A pass/fail check has no tolerance to hold, so the
                        // fields are cleared rather than left to be ignored.
                        set(i, kind === 'boolean'
                          ? { kind, min_value: null, max_value: null, unit: '' }
                          : { kind });
                      }}
                    >
                      <option value="numeric">Measurement</option>
                      <option value="boolean">Pass / fail</option>
                    </Select>
                  </td>
                  <td className="py-1.5 pr-2">
                    <Input
                      value={line.unit}
                      onChange={(e) => set(i, { unit: e.target.value })}
                      placeholder="mm"
                      disabled={line.kind === 'boolean'}
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <Input
                      type="number"
                      className="text-right"
                      value={line.min_value ?? ''}
                      onChange={(e) => set(i, { min_value: numOrNull(e.target.value) })}
                      disabled={line.kind === 'boolean'}
                      placeholder="—"
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <Input
                      type="number"
                      className="text-right"
                      value={line.max_value ?? ''}
                      onChange={(e) => set(i, { max_value: numOrNull(e.target.value) })}
                      disabled={line.kind === 'boolean'}
                      placeholder="—"
                    />
                  </td>
                  <td className="py-1.5 text-right">
                    <button
                      onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                      className="px-1 text-slate-400 hover:text-red-600"
                      title="Remove this check"
                    >✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="mt-2 text-xs text-slate-400">
            Leave Min or Max empty for a one-sided tolerance — a wall thickness can have a floor and no
            ceiling. A <b>Pass / fail</b> check is the eye: colour match, flash, short shot.
          </p>

          <div className="mt-3 flex items-center justify-between">
            <Button variant="secondary" onClick={() => setLines((prev) => [...prev, emptyParam()])}>
              + Add check
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
          <ErrorText error={save.error} />
          <p className="mt-2 text-xs text-slate-400">
            Changing this leaves inspections already recorded exactly as they were — each one keeps the
            tolerance it was judged against.
          </p>
        </>
      )}
    </Modal>
  );
}
