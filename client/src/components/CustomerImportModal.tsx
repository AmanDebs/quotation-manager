import { useState, type ChangeEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ImportField, CustomerImportPreview } from '../types';
import { Button, Select, Modal, ErrorText } from './ui';

const MAX_MB = 8;

/** The spreadsheet's own column name, since a sheet may repeat a heading. */
function colLabel(i: number): string {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
}

/**
 * Import the customer book from a spreadsheet.
 *
 * The product import's flow over a sheet that is one row per customer — or,
 * just as usefully, **one column of names**, which is what the order book's
 * Party Name column is and what the order import is waiting on.
 *
 * The one control worth reading is the near-match answer: a second spelling of
 * a buyer already on file is the risk this screen exists to manage, so those
 * rows are listed in amber, left alone by default, and added only on request.
 */
export default function CustomerImportModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [sheet, setSheet] = useState<string | undefined>();
  const [headerRow, setHeaderRow] = useState<number | undefined>();
  const [mapping, setMapping] = useState<Record<string, number> | undefined>();
  const [onDuplicate, setOnDuplicate] = useState<'update' | 'skip'>('skip');
  const [nearMatch, setNearMatch] = useState<'same' | 'new'>('same');
  const [done, setDone] = useState<{ created: number; updated: number; skipped: number } | null>(null);
  const [readError, setReadError] = useState('');

  const { data: fields = [] } = useQuery({
    queryKey: ['customer-import-fields'],
    queryFn: () => api.get<ImportField[]>('/api/customers/import/fields'),
  });

  const body = () => ({
    file: file?.data, filename: file?.name,
    sheet, header_row: headerRow, mapping,
    on_duplicate: onDuplicate, near_match: nearMatch,
  });

  const preview = useMutation({
    mutationFn: () => api.post<CustomerImportPreview>('/api/customers/import/preview', body()),
    onSuccess: (p) => { setSheet(p.sheet); setHeaderRow(p.headerRow); setMapping(p.mapping); },
  });

  const run = useMutation({
    mutationFn: () => api.post<{ created: number; updated: number; skipped: number }>('/api/customers/import', body()),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
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
    <Modal title="Import Customers from a Spreadsheet" onClose={onClose} wide>
      {done ? (
        <div className="space-y-4">
          <div className="rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-800">
            <div className="mb-1 text-base font-semibold">Import complete</div>
            <div>{done.created} customer{done.created === 1 ? '' : 's'} added, {done.updated} updated, {done.skipped} skipped.</div>
          </div>
          <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <div className="mb-1 text-xs font-medium text-slate-600">1. Choose your file</div>
            <input type="file" accept=".xlsx,.csv,.txt" onChange={pickFile} className="text-sm" />
            <p className="mt-1 text-xs text-slate-400">
              Excel (.xlsx) or CSV, up to {MAX_MB} MB. A column of names is enough — the rest fills in later,
              and a name repeated down the sheet is imported once.
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
                      className="w-32"
                      onChange={(e) => { setHeaderRow(Number(e.target.value)); setMapping(undefined); setTimeout(rerun, 0); }}
                    >
                      {/* A sheet with no heading at all is ordinary here: a column
                          of names pasted out of another book has none. */}
                      <option value="-1">no headings</option>
                      {Array.from({ length: 15 }, (_, i) => <option key={i} value={i}>{i + 1}</option>)}
                    </Select>
                  </label>
                  <p className="text-xs text-slate-500">
                    Found <span className="font-medium">{p.headers.filter(Boolean).length}</span> columns
                    and <span className="font-medium">{p.summary.total}</span> rows.
                  </p>
                </div>
              </div>

              {/* 3 — column mapping */}
              <div className="rounded-md border border-slate-200 p-3">
                <div className="mb-2 text-xs font-medium text-slate-600">3. Match your columns</div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {fields.map((f) => (
                    <label key={f.key} className="text-xs text-slate-600">
                      <span className="mb-1 block">{f.label}{f.required && <span className="text-red-500"> *</span>}</span>
                      <Select value={String(p.mapping[f.key] ?? -1)} onChange={(e) => setColumn(f.key, e.target.value)}>
                        <option value="-1">— not in my sheet —</option>
                        {p.headers.map((h, i) => <option key={i} value={i}>{colLabel(i)} · {h}</option>)}
                      </Select>
                    </label>
                  ))}
                </div>
                {(p.mapping.name === undefined || p.mapping.name < 0) && (
                  <p className="mt-2 text-sm text-red-600">Pick the column that holds the customer name.</p>
                )}
              </div>

              {/* 4 — what will happen */}
              <div className="rounded-md border border-slate-200 p-3">
                <div className="mb-2 text-xs font-medium text-slate-600">4. Review — nothing is saved yet</div>
                <div className="mb-3 flex flex-wrap items-end gap-3">
                  <label className="text-xs text-slate-600">
                    <span className="mb-1 block">Names already on file</span>
                    <Select
                      value={onDuplicate}
                      className="w-48"
                      onChange={(e) => { setOnDuplicate(e.target.value as 'update' | 'skip'); setTimeout(rerun, 0); }}
                    >
                      <option value="skip">Leave them alone</option>
                      <option value="update">Update from the sheet</option>
                    </Select>
                  </label>
                  <label className="text-xs text-slate-600">
                    <span className="mb-1 block">A name that nearly matches one</span>
                    <Select
                      value={nearMatch}
                      className="w-56"
                      onChange={(e) => { setNearMatch(e.target.value as 'same' | 'new'); setTimeout(rerun, 0); }}
                    >
                      <option value="same">Is the same customer</option>
                      <option value="new">Is a different customer</option>
                    </Select>
                  </label>
                </div>

                <div className="mb-2 flex flex-wrap gap-4 text-sm">
                  <span className="text-green-700">{p.summary.create} to add</span>
                  <span className="text-blue-700">{p.summary.update} to update</span>
                  <span className="text-slate-400">{p.summary.skip} skipped</span>
                  {p.summary.near > 0 && (
                    <span className="text-amber-700">{p.summary.near} read like a customer already on file</span>
                  )}
                </div>

                <div className="max-h-64 overflow-y-auto rounded border border-slate-100">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr className="text-left text-slate-500">
                        <th className="px-2 py-1">Row</th>
                        <th className="px-2 py-1">Action</th>
                        <th className="px-2 py-1">Name</th>
                        <th className="px-2 py-1">City</th>
                        <th className="px-2 py-1">Country</th>
                        <th className="px-2 py-1">GSTIN</th>
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
                          <td className="px-2 py-1">
                            {r.customer.name || <span className="text-slate-300">—</span>}
                            {r.customer.is_export === 1 && <span className="ml-1 text-slate-400">🌍</span>}
                          </td>
                          <td className="px-2 py-1">{r.customer.city || '—'}</td>
                          <td className="px-2 py-1">{r.customer.country || '—'}</td>
                          <td className="px-2 py-1">{r.customer.gstin || '—'}</td>
                          <td className={`px-2 py-1 ${r.nearName ? 'text-amber-700' : 'text-slate-400'}`}>{r.note ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-xs text-slate-400">
                  An update writes only the columns your sheet carries, so a list of names cannot blank an address
                  already on file. A name that nearly matches one is never renamed — every document and payment
                  hangs off that record.
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
              {run.isPending ? 'Importing…'
                : p ? `Import ${p.summary.create + p.summary.update} customer${p.summary.create + p.summary.update === 1 ? '' : 's'}`
                : 'Import'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
