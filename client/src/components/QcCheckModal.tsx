import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { WorkOrder } from '../types';
import { Button, Input, Select, Field, Modal, ErrorText, EmptyState } from './ui';
import { fmtDate, today } from '../lib/format';

/**
 * Inspect a job against its product's specification, and read what earlier
 * inspections found.
 *
 * A row left blank was **not measured**. It is not stored, and it is not a
 * failure — which is why a check with nothing filled in is refused rather than
 * saved as a pass. Silence is not a verdict, the same distinction the material
 * side draws with `has_recipe`.
 *
 * Pass and fail are never sent from here or stored anywhere: the server keeps
 * the reading and the tolerance it was taken against, and derives the rest.
 */
export default function QcCheckModal({ job, onClose, onSaved }: {
  job: WorkOrder; onClose: () => void; onSaved: () => void;
}) {
  const [head, setHead] = useState({ date: today(), shift: '', sample_size: '', inspector: '', notes: '' });
  const [values, setValues] = useState<Record<number, string>>({});
  const queryClient = useQueryClient();

  const { data: full } = useQuery({
    queryKey: ['work-order', String(job.id)],
    queryFn: () => api.get<WorkOrder>(`/api/work-orders/${job.id}`),
  });

  const after = () => {
    queryClient.invalidateQueries({ queryKey: ['work-order', String(job.id)] });
    onSaved();
  };
  const add = useMutation({
    mutationFn: () => api.post(`/api/work-orders/${job.id}/qc-checks`, {
      ...head,
      sample_size: head.sample_size === '' ? null : Number(head.sample_size),
      results: (full?.qc?.params ?? []).map((p) => ({
        param_id: p.id,
        // A visual check only counts once a verdict was actually given; "not
        // looked at" and "failed" must not collapse into each other.
        value: p.kind === 'boolean'
          ? (values[p.id!] ? values[p.id!] === 'pass' : '')
          : values[p.id!] ?? '',
      })),
    }),
    onSuccess: () => { setValues({}); after(); },
  });
  const removeCheck = useMutation({
    mutationFn: (checkId: number) => api.del(`/api/work-orders/qc-checks/${checkId}`),
    onSuccess: after,
  });

  const params = full?.qc?.params ?? [];
  const checks = full?.qc?.checks ?? [];
  const summary = full?.qc?.summary;
  const specOwner = full?.qc?.spec_owner;

  const tolerance = (p: { min_value: number | null; max_value: number | null; unit: string }) => {
    if (p.min_value === null && p.max_value === null) return '—';
    const unit = p.unit ? ` ${p.unit}` : '';
    if (p.min_value === null) return `up to ${p.max_value}${unit}`;
    if (p.max_value === null) return `${p.min_value}${unit} and above`;
    return `${p.min_value} – ${p.max_value}${unit}`;
  };

  const verdict = (ok: boolean | null) =>
    ok === null
      ? <span className="text-slate-300">—</span>
      : ok
        ? <span className="font-semibold text-green-700">pass</span>
        : <span className="font-semibold text-red-600">fail</span>;

  return (
    <Modal title={`Quality — ${job.number}`} onClose={onClose} wide>
      {summary && !summary.has_spec ? (
        <EmptyState message="No quality checks are defined for this product. Set them under Products → QC, then come back." />
      ) : (
        <>
          {/*
            * Whose tolerances this job is being judged against. It is on screen
            * rather than assumed because the same part is genuinely measured to
            * different tolerances for different buyers — reading a figure
            * without knowing which spec it was judged by is how a batch gets
            * passed against somebody else's.
            */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-slate-500">
              {specOwner === 'customer'
                ? <>Measured against <b>{full?.customer_name}</b>&rsquo;s own specification.</>
                : <>Measured against the product&rsquo;s standard specification.</>}
            </span>
            <a
              href={`/api/pdf/qc-report/${job.id}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium text-brand-700 hover:underline"
            >Quality report (PDF)</a>
          </div>

          {!!summary && summary.checks > 0 && (
            <div className="mb-3 flex flex-wrap gap-4 text-sm">
              <span>Inspections <strong className="tabular-nums">{summary.checks}</strong></span>
              <span className="text-green-700">Passed <strong className="tabular-nums">{summary.passed}</strong></span>
              <span className={summary.failed ? 'text-red-600' : 'text-slate-400'}>
                Failed <strong className="tabular-nums">{summary.failed}</strong>
              </span>
              <span>Last {verdict(summary.last_result)}</span>
            </div>
          )}

          <div className="rounded-lg border border-slate-200 p-3">
            <div className="mb-2 grid grid-cols-2 gap-2 md:grid-cols-4">
              <Field label="Date">
                <Input type="date" value={head.date} onChange={(e) => setHead({ ...head, date: e.target.value })} />
              </Field>
              <Field label="Shift">
                <Input value={head.shift} onChange={(e) => setHead({ ...head, shift: e.target.value })} placeholder="A" />
              </Field>
              <Field label="Pieces checked">
                <Input
                  type="number"
                  value={head.sample_size}
                  onChange={(e) => setHead({ ...head, sample_size: e.target.value })}
                  placeholder="5"
                />
              </Field>
              <Field label="Inspector">
                <Input value={head.inspector} onChange={(e) => setHead({ ...head, inspector: e.target.value })} />
              </Field>
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="pb-1 pr-2">Check</th>
                  <th className="pb-1 pr-2">Should be</th>
                  <th className="w-40 pb-1">Measured</th>
                </tr>
              </thead>
              <tbody>
                {params.map((p) => (
                  <tr key={p.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-1.5 pr-2">{p.name}</td>
                    <td className="py-1.5 pr-2 text-slate-500">
                      {p.kind === 'boolean' ? 'pass' : tolerance(p)}
                    </td>
                    <td className="py-1.5">
                      {p.kind === 'boolean' ? (
                        <Select
                          value={values[p.id!] ?? ''}
                          onChange={(e) => setValues({ ...values, [p.id!]: e.target.value })}
                        >
                          <option value="">not checked</option>
                          <option value="pass">pass</option>
                          <option value="fail">fail</option>
                        </Select>
                      ) : (
                        <Input
                          type="number"
                          value={values[p.id!] ?? ''}
                          onChange={(e) => setValues({ ...values, [p.id!]: e.target.value })}
                          placeholder={p.unit || 'value'}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-2 flex items-center justify-between gap-3">
              <p className="text-xs text-slate-400">
                Leave a row blank if it was not checked — that is recorded as unmeasured, never as a failure.
              </p>
              <Button onClick={() => add.mutate()} disabled={add.isPending}>
                {add.isPending ? 'Saving…' : 'Record inspection'}
              </Button>
            </div>
            <ErrorText error={add.error} />
          </div>

          {checks.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Previous inspections</div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                    <th className="pb-1 pr-2">Date</th>
                    <th className="pb-1 pr-2">Shift</th>
                    <th className="pb-1 pr-2">Result</th>
                    <th className="pb-1 pr-2">Readings</th>
                    <th className="pb-1" />
                  </tr>
                </thead>
                <tbody>
                  {[...checks].reverse().map((c) => (
                    <tr key={c.id} className="border-b border-slate-100 align-top last:border-0">
                      <td className="whitespace-nowrap py-1.5 pr-2">{fmtDate(c.date)}</td>
                      <td className="py-1.5 pr-2 text-slate-500">{c.shift || '—'}</td>
                      <td className="py-1.5 pr-2">
                        {verdict(c.passed)}
                        {c.failed_count > 0 && (
                          <span className="ml-1 text-xs text-red-600">({c.failed_count})</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-2">
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                          {c.results.map((r) => (
                            <span key={r.id} className={r.ok === false ? 'text-red-600' : 'text-slate-500'}>
                              {r.name}{' '}
                              <b>
                                {r.kind === 'boolean' ? (r.value === 1 ? 'pass' : 'fail') : r.value}
                                {r.kind === 'numeric' && r.unit ? ` ${r.unit}` : ''}
                              </b>
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="py-1.5 text-right">
                        <button
                          onClick={() => { if (confirm('Delete this inspection?')) removeCheck.mutate(c.id); }}
                          className="px-1 text-slate-400 hover:text-red-600"
                          title="Delete"
                        >✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-slate-400">
                Each reading keeps the tolerance it was judged against, so changing the specification later
                does not re-judge what has already been inspected.
              </p>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
