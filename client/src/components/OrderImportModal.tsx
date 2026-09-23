import { useState, type ChangeEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ImportField, OrderImportPreview } from '../types';
import { Button, Select, Modal, ErrorText, CAPTION_CLASS } from './ui';
import { fmtDate, fmtMoney } from '../lib/format';

const MAX_MB = 8;

/**
 * Load a backlog of sales orders from a spreadsheet.
 *
 * The product import's flow — pick a file → confirm the sheet, header row and
 * columns → review → import — over a sheet that is **one row per order line
 * with the order number repeating**, which is how both of this desk's own
 * books are kept. The review is therefore grouped by order rather than listed
 * by row, since an order is what gets written.
 *
 * Nothing is saved until the last button, and what it writes is what this
 * shows: the server re-parses the same file through the same function.
 */
export default function OrderImportModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [sheet, setSheet] = useState<string | undefined>();
  const [headerRow, setHeaderRow] = useState<number | undefined>();
  const [mapping, setMapping] = useState<Record<string, number> | undefined>();
  const [basis, setBasis] = useState<'pieces' | 'billing'>('pieces');
  const [done, setDone] = useState<{ created: number; lines: number; skipped: number } | null>(null);
  const [readError, setReadError] = useState('');

  const { data: fields = [] } = useQuery({
    queryKey: ['order-import-fields'],
    queryFn: () => api.get<ImportField[]>('/api/orders/import/fields'),
  });

  const body = () => ({
    file: file?.data, filename: file?.name,
    sheet, header_row: headerRow, mapping, quantity_basis: basis,
  });

  const preview = useMutation({
    mutationFn: () => api.post<OrderImportPreview>('/api/orders/import/preview', body()),
    onSuccess: (p) => {
      // Adopt whatever the server worked out, so the controls show the truth.
      setSheet(p.sheet);
      setHeaderRow(p.headerRow);
      setMapping(p.mapping);
    },
  });

  const run = useMutation({
    mutationFn: () => api.post<{ created: number; lines: number; skipped: number }>('/api/orders/import', body()),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['order-lines'] });
      queryClient.invalidateQueries({ queryKey: ['order-demand'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
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

  const orderFields = fields.filter((f) => f.scope !== 'line');
  const lineFields = fields.filter((f) => f.scope === 'line');

  const columnPicker = (f: ImportField) => (
    <label key={f.key} className="text-xs text-slate-600">
      <span className="mb-1 block">{f.label}{f.required && <span className="text-red-500"> *</span>}</span>
      <Select value={String(p?.mapping[f.key] ?? -1)} onChange={(e) => setColumn(f.key, e.target.value)}>
        <option value="-1">— not in my sheet —</option>
        {p?.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
      </Select>
    </label>
  );

  return (
    <Modal title="Import Sales Orders from a Spreadsheet" onClose={onClose} wide>
      {done ? (
        <div className="space-y-4">
          <div className="rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-800">
            <div className="mb-1 text-base font-semibold">Import complete</div>
            <div>
              {done.created} sales order{done.created === 1 ? '' : 's'} booked over {done.lines} line
              {done.lines === 1 ? '' : 's'}, {done.skipped} skipped.
            </div>
            <div className="mt-2 text-green-700">
              Work orders have been raised against every goods line, as they are on any booking.
              Numbering is untouched — set the counters in Settings → Numbering so new documents
              carry on from your own book.
            </div>
          </div>
          <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <div className="mb-1 text-xs font-medium text-slate-600">1. Choose your file</div>
            <input type="file" accept=".xlsx,.csv,.txt" onChange={pickFile} className="text-sm" />
            <p className="mt-1 text-xs text-slate-400">
              Excel (.xlsx) or CSV, up to {MAX_MB} MB — one row per order line, with the order number
              repeating (or stated once and left blank below it). Dates are read day first.
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
                      {Array.from({ length: 15 }, (_, i) => <option key={i} value={i}>{i + 1}</option>)}
                    </Select>
                  </label>
                  <p className="text-xs text-slate-500">
                    Found <span className="font-medium">{p.headers.filter(Boolean).length}</span> columns
                    and <span className="font-medium">{p.summary.rows}</span> line rows.
                  </p>
                </div>
              </div>

              {/* 3 — column mapping */}
              <div className="rounded-md border border-slate-200 p-3">
                <div className="mb-2 text-xs font-medium text-slate-600">3. Match your columns</div>
                <div className={CAPTION_CLASS}>The order</div>
                <div className="mb-3 mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">{orderFields.map(columnPicker)}</div>
                <div className={CAPTION_CLASS}>Each line</div>
                <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">{lineFields.map(columnPicker)}</div>
                {(p.mapping.number === undefined || p.mapping.number < 0) && (
                  <p className="mt-2 text-sm text-red-600">Pick the column that holds the order number — it is what groups the rows into orders.</p>
                )}
              </div>

              {/* 4 — what will happen */}
              <div className="rounded-md border border-slate-200 p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium text-slate-600">4. Review — nothing is saved yet</span>
                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    The Quantity column holds
                    <Select
                      value={basis}
                      className="w-56"
                      onChange={(e) => { setBasis(e.target.value as 'pieces' | 'billing'); setTimeout(rerun, 0); }}
                    >
                      <option value="pieces">pieces (priced per 1000)</option>
                      <option value="billing">the billing quantity as typed</option>
                    </Select>
                  </label>
                </div>

                <div className="mb-2 flex gap-4 text-sm">
                  <span className="text-green-700">{p.summary.create} order{p.summary.create === 1 ? '' : 's'} to book</span>
                  <span className="text-slate-500">{p.summary.lines} lines</span>
                  <span className="text-slate-400">{p.summary.skip} skipped</span>
                </div>

                <div className="max-h-72 overflow-y-auto rounded border border-slate-100">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr className={`text-left ${CAPTION_CLASS}`}>
                        <th className="px-2 py-1">Order</th>
                        <th className="px-2 py-1">Date</th>
                        <th className="px-2 py-1">Customer</th>
                        <th className="px-2 py-1">Item</th>
                        <th className="px-2 py-1 text-right">Qty</th>
                        <th className="px-2 py-1 text-right">Rate</th>
                        <th className="px-2 py-1">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.orders.map((o, oi) => {
                        const skip = o.action === 'skip';
                        const tint = skip ? 'text-slate-400' : '';
                        return (
                          <tr key={oi} className="border-t border-slate-200 align-top">
                            <td className={`whitespace-nowrap px-2 py-1 font-medium ${skip ? 'text-slate-400' : 'text-slate-800'}`}>
                              {o.number || <span className="text-red-500">no number</span>}
                              {!skip && <div className="font-normal text-slate-400">{fmtMoney(o.total, o.currency)}</div>}
                            </td>
                            <td className={`whitespace-nowrap px-2 py-1 ${tint}`}>{o.date ? fmtDate(o.date) : '—'}</td>
                            <td className={`px-2 py-1 ${tint}`}>
                              {o.customer_name || o.customer_text || '—'}
                              {o.customer_name && o.customer_name !== o.customer_text && (
                                <div className="text-slate-400">matched from “{o.customer_text}”</div>
                              )}
                            </td>
                            <td className={`px-2 py-1 ${tint}`}>
                              {o.lines.map((l, li) => (
                                <div key={li} className={l.product_id ? '' : 'text-amber-700'}>
                                  {l.description}{l.color ? ` · ${l.color}` : ''}
                                </div>
                              ))}
                              {o.dropped.map((d, di) => (
                                <div key={`d${di}`} className="text-slate-400">row {d.row}: {d.note}</div>
                              ))}
                            </td>
                            <td className={`px-2 py-1 text-right tabular-nums ${tint}`}>
                              {o.lines.map((l, li) => (
                                <div key={li}>{(l.total_pcs ?? l.qty ?? 0).toLocaleString('en-IN')}</div>
                              ))}
                            </td>
                            <td className={`px-2 py-1 text-right tabular-nums ${tint}`}>
                              {o.lines.map((l, li) => <div key={li}>{l.unit_price || '—'}</div>)}
                            </td>
                            <td className="px-2 py-1">
                              {o.note && <div className={skip ? 'text-red-600' : 'text-slate-400'}>{o.note}</div>}
                              {o.lines.filter((l) => l.note).map((l, li) => (
                                <div key={li} className="text-amber-700">{l.note}</div>
                              ))}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-xs text-slate-400">
                  Customers are matched by name and never created — an order whose customer is not on file is
                  skipped, so add them first. An item that is not in the catalogue is booked as a custom line.
                  An order number already on file is left exactly as it is, so running this twice is safe.
                </p>
              </div>
            </>
          )}

          <ErrorText error={run.error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button
              onClick={() => run.mutate()}
              disabled={!p || run.isPending || preview.isPending || p.summary.create === 0}
            >
              {run.isPending ? 'Importing…' : p ? `Book ${p.summary.create} sales orders` : 'Import'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
