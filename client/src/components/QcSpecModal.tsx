import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Customer, Product, QcParam, QcKind, QcSpecResponse } from '../types';
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
 *
 * **A customer may have their own**, asked for on 2026-09-05: the same part is
 * genuinely measured to different tolerances for different buyers. The picker
 * chooses whose list is being edited, and a customer's rows **replace** the
 * default rather than merging with it — one list on screen, one list on the
 * report, and it says whose. A customer with none falls back to the default,
 * so nothing changes for anybody until somebody writes an override.
 */

const emptyParam = (): QcParam =>
  ({ name: '', kind: 'numeric', unit: '', min_value: null, max_value: null, notes: '' });

/** Blank must persist as null, not 0 — an open-ended tolerance is not "zero". */
const numOrNull = (v: string) => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));

export default function QcSpecModal({ product, onClose }: { product: Product; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [lines, setLines] = useState<QcParam[]>([]);
  // Empty string is the product's default spec, which is what NULL means in
  // the column — not "no customer chosen yet".
  const [customerId, setCustomerId] = useState('');

  const { data: customers = [] } = useQuery({
    queryKey: ['customers', ''],
    queryFn: () => api.get<Customer[]>('/api/customers'),
  });

  const { data: saved, isLoading } = useQuery({
    queryKey: ['qc-params', String(product.id), customerId],
    queryFn: () => api.get<QcSpecResponse>(
      `/api/products/${product.id}/qc-params${customerId ? `?customer_id=${customerId}` : ''}`
    ),
  });

  /*
   * What is shown when a customer has no override is the **default**, so the
   * dialog opens on the spec actually in force and saving it makes that
   * customer's own copy — which is how an override is written in the first
   * place. `owner` is what tells the two apart on screen.
   */
  useEffect(() => {
    if (saved) setLines(saved.items.length ? saved.items : [emptyParam()]);
  }, [saved]);

  const save = useMutation({
    mutationFn: () => api.put<QcSpecResponse>(`/api/products/${product.id}/qc-params`, {
      items: lines,
      customer_id: customerId ? Number(customerId) : null,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['qc-params', String(product.id)] });
      // A job's screen shows the live spec beside its checks.
      queryClient.invalidateQueries({ queryKey: ['work-order-details'] });
      onClose();
    },
  });

  const inherited = !!customerId && saved?.owner === 'default';

  const set = (i: number, patch: Partial<QcParam>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  return (
    <Modal title={`Quality checks — ${product.name}`} onClose={onClose} wide>
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-slate-200">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Specification for</span>
        <Select
          className="w-64"
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
        >
          <option value="">Every customer (the default)</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        {inherited && (
          <span className="text-xs text-slate-500">
            No specification of their own — showing the default. Saving makes this their own copy.
          </span>
        )}
        {customerId && saved?.owner === 'customer' && (
          <span className="text-xs text-slate-500">
            Their own. Removing every row puts them back on the default.
          </span>
        )}
      </div>

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
