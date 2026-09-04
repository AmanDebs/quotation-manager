import { useState, type ChangeEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ImportField, ImportPreview } from '../types';
import { Button, Select, Modal, ErrorText } from './ui';
import { productTypeLabel } from '../pages/Products';

const MAX_MB = 8;

/**
 * Import a product catalogue from a spreadsheet.
 *
 * Nothing is written until the user has seen exactly what will happen to every
 * row, so the flow is: pick a file → confirm the sheet, header row and column
 * mapping → review the create/update/skip breakdown → import.
 */
export default function ProductImportModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [sheet, setSheet] = useState<string | undefined>();
  const [headerRow, setHeaderRow] = useState<number | undefined>();
  const [mapping, setMapping] = useState<Record<string, number> | undefined>();
  const [onDuplicate, setOnDuplicate] = useState<'update' | 'skip'>('update');
  const [done, setDone] = useState<{ created: number; updated: number; skipped: number } | null>(null);
  const [readError, setReadError] = useState('');

  const { data: fields = [] } = useQuery({
    queryKey: ['import-fields'],
    queryFn: () => api.get<ImportField[]>('/api/products/import/fields'),
  });

  const body = () => ({
    file: file?.data, filename: file?.name,
    sheet, header_row: headerRow, mapping, on_duplicate: onDuplicate,
  });

  const preview = useMutation({
    mutationFn: () => api.post<ImportPreview>('/api/products/import/preview', body()),
    onSuccess: (p) => {
      // Adopt whatever the server worked out, so the controls show the truth.
      setSheet(p.sheet);
      setHeaderRow(p.headerRow);
      setMapping(p.mapping);
    },
  });

  const run = useMutation({
    mutationFn: () => api.post<{ created: number; updated: number; skipped: number }>('/api/products/import', body()),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      setDone(r);
    },
  });

  const pickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setReadError('');
    if (f.size > MAX_MB * 1024 * 1024) {
      setReadError(`That file is ${(f.size / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_MB} MB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setFile({ name: f.name, data: String(reader.result) });
      setSheet(undefined); setHeaderRow(undefined); setMapping(undefined); setDone(null);
      preview.reset(); run.reset();
      // Let state settle before the first preview call.
      setTimeout(() => preview.mutate(), 0);
    };
    reader.onerror = () => setReadError('Could not read that file.');
    reader.readAsDataURL(f);
  };

  const p = preview.data;
  const rerun = () => { run.reset(); preview.mutate(); };

  const setColumn = (key: string, value: string) => {
    setMapping({ ...(mapping ?? {}), [key]: Number(value) });
    setTimeout(rerun, 0);
  };

  const actionStyle = { create: 'text-green-700', update: 'text-blue-700', skip: 'text-slate-400' } as const;

  return (
    <Modal title="Import Products from a Spreadsheet" onClose={onClose} wide>
      {done ? (
        <div className="space-y-4">
          <div className="rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-800">
            <div className="mb-1 text-base font-semibold">Import complete</div>
            <div>{done.created} product{done.created === 1 ? '' : 's'} added, {done.updated} updated, {done.skipped} skipped.</div>
          </div>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* 1 — the file */}
          <div>
            <div className="mb-1 text-xs font-medium text-slate-600">1. Choose your file</div>
            <input type="file" accept=".xlsx,.csv,.txt" onChange={pickFile} className="text-sm" />
            <p className="mt-1 text-xs text-slate-400">
              Excel (.xlsx) or CSV, up to {MAX_MB} MB. The old .xls format needs saving as .xlsx first.
            </p>
            {readError && <p className="mt-1 text-sm text-red-600">{readError}</p>}
          </div>

          <ErrorText error={preview.error} />

          {p && (
            <>
              {/* 2 — sheet and header row */}
              <div className="rounded-md border border-slate-200 p-3">
                <div className="mb-2 text-xs font-medium text-slate-600">2. Check we're reading the right rows</div>
                <div className="flex flex-wrap items-end gap-3">
                  {p.sheetNames.length > 1 && (
                    <label className="text-xs text-slate-600">
                      <span className="mb-1 block">Sheet</span>
                      <Select
                        value={sheet ?? p.sheet}
                        className="w-52"
                        onChange={(e) => { setSheet(e.target.value); setHeaderRow(undefined); setMapping(undefined); setTimeout(rerun, 0); }}
                      >
                        {p.sheetNames.map((s) => <option key={s} value={s}>{s}</option>)}
                      </Select>
                    </label>
                  )}
                  <label className="text-xs text-slate-600">
                    <span className="mb-1 block">Headings are on row</span>
                    <Select
                      value={String(p.headerRow)}
                      className="w-24"
                      onChange={(e) => { setHeaderRow(Number(e.target.value)); setMapping(undefined); setTimeout(rerun, 0); }}
                    >
                      {Array.from({ length: 15 }, (_, i) => (
                        <option key={i} value={i}>{i + 1}</option>
                      ))}
                    </Select>
                  </label>
                  <p className="text-xs text-slate-500">
                    Found <span className="font-medium">{p.headers.filter(Boolean).length}</span> columns
                    and <span className="font-medium">{p.summary.total}</span> data rows.
                  </p>
                </div>
              </div>

              {/* 3 — column mapping */}
              <div className="rounded-md border border-slate-200 p-3">
                <div className="mb-2 text-xs font-medium text-slate-600">3. Match your columns to the catalogue</div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {fields.map((f) => (
                    <label key={f.key} className="text-xs text-slate-600">
                      <span className="mb-1 block">
                        {f.label}{f.required && <span className="text-red-500"> *</span>}
                      </span>
                      <Select value={String(p.mapping[f.key] ?? -1)} onChange={(e) => setColumn(f.key, e.target.value)}>
                        <option value="-1">— not in my sheet —</option>
                        {p.headers.map((h, i) => (
                          <option key={i} value={i}>{h}</option>
                        ))}
                      </Select>
                    </label>
                  ))}
                </div>
                {(p.mapping.name === undefined || p.mapping.name < 0) && (
                  <p className="mt-2 text-sm text-red-600">Pick the column that holds the product name.</p>
                )}
              </div>

              {/* 4 — what will happen */}
              <div className="rounded-md border border-slate-200 p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium text-slate-600">4. Review — nothing is saved yet</span>
                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    Products already in the catalogue:
                    <Select
                      value={onDuplicate}
                      className="w-36"
                      onChange={(e) => { setOnDuplicate(e.target.value as 'update' | 'skip'); setTimeout(rerun, 0); }}
                    >
                      <option value="update">Update them</option>
                      <option value="skip">Leave them alone</option>
                    </Select>
                  </label>
                </div>

                <div className="mb-2 flex gap-4 text-sm">
                  <span className="text-green-700">{p.summary.create} to add</span>
                  <span className="text-blue-700">{p.summary.update} to update</span>
                  <span className="text-slate-400">{p.summary.skip} skipped</span>
                </div>

                <div className="max-h-64 overflow-y-auto rounded border border-slate-100">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr className="text-left text-slate-500">
                        <th className="px-2 py-1">Row</th>
                        <th className="px-2 py-1">Action</th>
                        <th className="px-2 py-1">Name</th>
                        <th className="px-2 py-1">Type</th>
                        <th className="px-2 py-1">Colour</th>
                        <th className="px-2 py-1 text-right">Weight</th>
                        <th className="px-2 py-1 text-right">Pcs/Box</th>
                        <th className="px-2 py-1 text-right">20ft</th>
                        <th className="px-2 py-1 text-right">40ft</th>
                        <th className="px-2 py-1 text-right">Price</th>
                        <th className="px-2 py-1">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.rows.map((r, i) => (
                        <tr key={i} className="border-t border-slate-100">
                          <td className="px-2 py-1 text-slate-400">{r.row}</td>
                          <td className={`px-2 py-1 font-medium ${actionStyle[r.action]}`}>
                            {r.action === 'create' ? 'Add' : r.action === 'update' ? 'Update' : 'Skip'}
                          </td>
                          <td className="px-2 py-1">{r.product.name || <span className="text-slate-300">—</span>}</td>
                          <td className="px-2 py-1">{productTypeLabel(r.product.product_type)}</td>
                          <td className="px-2 py-1">{r.product.color || '—'}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{r.product.weight_grams ?? '—'}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{r.product.pcs_per_pack ?? '—'}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{r.product.qty_20ft ?? '—'}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{r.product.qty_40ft ?? '—'}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{r.product.unit_price || '—'}</td>
                          <td className="px-2 py-1 text-slate-400">{r.note ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-xs text-slate-400">
                  A product is matched on name + colour + pcs per box, so the same item at two different box counts
                  stays as two catalogue entries. Product photos are never touched by an import.
                </p>
              </div>
            </>
          )}

          <ErrorText error={run.error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button
              onClick={() => run.mutate()}
              disabled={!p || run.isPending || preview.isPending || p.summary.create + p.summary.update === 0}
            >
              {run.isPending ? 'Importing…' : p ? `Import ${p.summary.create + p.summary.update} products` : 'Import'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
