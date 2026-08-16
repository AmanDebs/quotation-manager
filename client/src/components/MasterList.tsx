import { useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Button, Input, Textarea, Select, Field, Card, EmptyState, ErrorText, Modal } from './ui';

/**
 * One production master — locations, suppliers, transporters, materials,
 * machines, moulds. Six lists that differ only in their columns, so they are
 * described in `pages/Masters.tsx` and rendered here rather than written six
 * times, mirroring how the server describes them in `routes/masters.ts`.
 *
 * Retiring (`active = 0`) is the normal way to take a row out of use; delete is
 * for mistakes and 409s when anything references the row.
 */

export interface MasterField<T> {
  key: keyof T & string;
  label: string;
  type?: 'text' | 'number' | 'textarea' | 'select';
  options?: { value: string | number; label: string }[];
  placeholder?: string;
  /** Span both columns of the modal grid. */
  wide?: boolean;
}

export interface MasterColumn<T> {
  key: string;
  label: string;
  align?: 'right';
  render: (row: T) => ReactNode;
}

export interface MasterSpec<T> {
  path: string;
  title: string;
  /** Singular, for buttons and the modal title. */
  singular: string;
  blurb?: string;
  columns: MasterColumn<T>[];
  fields: MasterField<T>[];
  empty: Record<string, unknown>;
}

interface Row { id: number; name: string; active: number }

export default function MasterList<T extends Row>({ spec, canEdit }: { spec: MasterSpec<T>; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [showRetired, setShowRetired] = useState(false);
  const [editing, setEditing] = useState<Partial<T> | null>(null);

  const key = ['master', spec.path, showRetired] as const;
  const { data: rows = [] } = useQuery({
    queryKey: key,
    queryFn: () => api.get<T[]>(`/api/${spec.path}${showRetired ? '?all=1' : ''}`),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['master', spec.path] });

  const save = useMutation({
    mutationFn: (row: Partial<T>) =>
      row.id ? api.put<T>(`/api/${spec.path}/${row.id}`, row) : api.post<T>(`/api/${spec.path}`, row),
    onSuccess: () => { invalidate(); setEditing(null); },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/${spec.path}/${id}`),
    onSuccess: invalidate,
  });

  const set = (patch: Partial<T>) => setEditing((prev) => (prev ? { ...prev, ...patch } : prev));

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="text-sm text-slate-500">
            {rows.length} {rows.length === 1 ? spec.singular.toLowerCase() : spec.title.toLowerCase()}
          </span>
          {spec.blurb && <p className="mt-0.5 text-xs text-slate-400">{spec.blurb}</p>}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
            Show retired
          </label>
          {canEdit && (
            <Button onClick={() => { save.reset(); remove.reset(); setEditing({ ...spec.empty } as Partial<T>); }}>
              + New {spec.singular}
            </Button>
          )}
        </div>
      </div>

      <ErrorText error={remove.error} />

      <Card className="overflow-x-auto">
        {rows.length === 0 ? (
          <EmptyState message={`No ${spec.title.toLowerCase()} yet.`} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                {spec.columns.map((c) => (
                  <th key={c.key} className={`pb-2 pr-3 ${c.align === 'right' ? 'text-right' : ''}`}>{c.label}</th>
                ))}
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={`border-b border-slate-100 last:border-0 hover:bg-slate-50 ${row.active ? '' : 'text-slate-400'}`}>
                  {spec.columns.map((c) => (
                    <td key={c.key} className={`py-2 pr-3 ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}>
                      {c.render(row)}
                      {c.key === 'name' && !row.active && <span className="ml-2 text-xs">(retired)</span>}
                    </td>
                  ))}
                  <td className="whitespace-nowrap py-2 text-right">
                    {canEdit ? (
                      <>
                        <Button variant="ghost" onClick={() => { save.reset(); remove.reset(); setEditing(row); }}>Edit</Button>
                        <Button
                          variant="danger"
                          className="ml-1 border-0"
                          onClick={() => { if (confirm(`Delete ${spec.singular.toLowerCase()} "${row.name}"?`)) remove.mutate(row.id); }}
                        >
                          Delete
                        </Button>
                      </>
                    ) : (
                      <span className="text-xs text-slate-300" title="Ask your manager to change this list">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {editing && (
        <Modal
          title={editing.id ? `Edit ${editing.name}` : `New ${spec.singular}`}
          onClose={() => setEditing(null)}
        >
          <div className="grid grid-cols-2 gap-3">
            {spec.fields.map((f) => (
              <Field key={f.key} label={f.label} className={f.wide ? 'col-span-2' : ''}>
                {f.type === 'textarea' ? (
                  <Textarea
                    rows={2}
                    value={String(editing[f.key] ?? '')}
                    onChange={(e) => set({ [f.key]: e.target.value } as Partial<T>)}
                    placeholder={f.placeholder}
                  />
                ) : f.type === 'select' ? (
                  <Select
                    value={String(editing[f.key] ?? '')}
                    onChange={(e) => set({ [f.key]: e.target.value === '' ? null : e.target.value } as Partial<T>)}
                  >
                    <option value="">— none —</option>
                    {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                ) : f.type === 'number' ? (
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    value={editing[f.key] == null ? '' : String(editing[f.key])}
                    // Blank must stay blank: an unrecorded cavity count is not zero.
                    onChange={(e) => set({ [f.key]: e.target.value === '' ? null : Number(e.target.value) } as Partial<T>)}
                    placeholder={f.placeholder}
                  />
                ) : (
                  <Input
                    value={String(editing[f.key] ?? '')}
                    onChange={(e) => set({ [f.key]: e.target.value } as Partial<T>)}
                    placeholder={f.placeholder}
                  />
                )}
              </Field>
            ))}
            <label className="col-span-2 flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={editing.active === undefined ? true : !!editing.active}
                onChange={(e) => set({ active: e.target.checked ? 1 : 0 } as Partial<T>)}
              />
              In use — untick to retire it without losing the history
            </label>
          </div>
          <ErrorText error={save.error} />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={() => save.mutate(editing)} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
