import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Batch, WorkOrder } from '../types';
import { Button, Input, Select, Field, Modal, ErrorText, EmptyState, TH_CLASS, FIELD_GRID } from './ui';
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
export default function QcCheckModal({ job, batch, certify, onClose, onSaved }: {
  job: WorkOrder;
  /**
   * The lot this check finalises, if it is a final one.
   *
   * Naming a batch is the whole difference between the specification's two QC
   * levels: without it this is an in-process check against the job, with it
   * this is the final check a certificate may be issued on. One prop, because
   * the server draws the same distinction over one column.
   */
  batch?: Batch;
  /**
   * Open a lot, inspect it and certify it in one press (2026-10-21, the
   * client: *"Since our company is small only final COA is required and is
   * issued"*). The lot covers everything the job has made and nobody has
   * lotted, so there is nothing to choose — which is why this is a flag
   * rather than a second dialog: it is the same inspection, with the two
   * fields a certificate needs and no batch to pick.
   */
  certify?: boolean;
  onClose: () => void; onSaved: () => void;
}) {
  const [head, setHead] = useState({ date: today(), shift: '', sample_size: '', inspector: '', notes: '' });
  /*
   * What the certificate needs and the record cannot supply.
   *
   * `batch_number` is blank by default, which the server reads as *take the
   * next one from the series* — but this desk names a lot by its production
   * date rather than by a counter (their own certificate reads
   * *05032026A+B TO 09032026A+B*), and this is the moment somebody knows what
   * to call it. **The lot's date is deliberately not asked**: the server takes
   * it from the last shift booked into the lot, which cannot disagree with the
   * output underneath it, where a typed one could.
   */
  const [coa, setCoa] = useState({ coa_date: today(), approved_by: '', batch_number: '' });
  /*
   * Three facts per parameter since 2026-10-16, where there was one string.
   *
   * `v` is the reading — or the **lowest** piece on a characteristic observed
   * as a range, with `vmax` the highest. `na` is *not applicable*, which is an
   * answer somebody gives rather than a box left alone: Aglo's own preform
   * certificate carries three of them, and a blank could not say it.
   */
  const [values, setValues] = useState<Record<number, { v?: string; vmax?: string; na?: boolean }>>({});
  const row = (id: number) => values[id] ?? {};
  const setRow = (id: number, patch: { v?: string; vmax?: string; na?: boolean }) =>
    setValues((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...patch } }));
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
    mutationFn: () => api.post(`/api/work-orders/${job.id}/${certify ? 'certify' : 'qc-checks'}`, {
      ...head,
      ...(certify ? coa : {}),
      batch_id: batch?.id ?? null,
      sample_size: head.sample_size === '' ? null : Number(head.sample_size),
      results: (full?.qc?.params ?? []).map((p) => {
        const r = row(p.id!);
        return {
          param_id: p.id,
          // Sent as its own fact: the server writes the row and records the
          // answer, where a blank is still dropped as never looked at.
          na: !!r.na,
          // A visual check only counts once a verdict was actually given; "not
          // looked at" and "failed" must not collapse into each other.
          value: r.na ? '' : p.kind === 'boolean' ? (r.v ? r.v === 'pass' : '') : r.v ?? '',
          value_max: r.na || p.kind === 'boolean' || !p.ranged ? '' : r.vmax ?? '',
        };
      }),
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
    <Modal title={certify ? `Certify — ${job.number}` : `Quality — ${job.number}`} onClose={onClose} wide>
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

            {/*
              The two things a certificate needs that an inspection does not.
              Shown only in the one-press shape — on an ordinary check there
              is no certificate to date or to have approved.
            */}
            {certify && (
              <div className="mb-3 rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200">
                <p className="mb-2 text-xs text-slate-500">
                  This opens a lot covering everything this job has made and not yet lotted,
                  records the inspection against it, and issues the certificate. The lot is
                  dated by the last shift in it.
                </p>
                <div className={FIELD_GRID}>
                  <Field label="Batch number">
                    <Input
                      value={coa.batch_number}
                      placeholder="next in the series"
                      onChange={(e) => setCoa({ ...coa, batch_number: e.target.value })}
                    />
                  </Field>
                  <Field label="Certificate date">
                    <Input type="date" value={coa.coa_date} onChange={(e) => setCoa({ ...coa, coa_date: e.target.value })} />
                  </Field>
                  <Field label="Approved by">
                    <Input
                      value={coa.approved_by}
                      onChange={(e) => setCoa({ ...coa, approved_by: e.target.value })}
                      placeholder="Who signs it off"
                    />
                  </Field>
                </div>
              </div>
            )}

            <table className="w-full text-sm">
              <thead>
                <tr className={TH_CLASS}>
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
                      {!!p.ranged && p.kind !== 'boolean' && (
                        <span className="ml-1 text-xs text-slate-400">· both ends</span>
                      )}
                    </td>
                    <td className="py-1.5">
                      <div className="flex items-center gap-1.5">
                        {p.kind === 'boolean' ? (
                          <Select
                            className="w-full"
                            disabled={!!row(p.id!).na}
                            value={row(p.id!).v ?? ''}
                            onChange={(e) => setRow(p.id!, { v: e.target.value })}
                          >
                            <option value="">not checked</option>
                            <option value="pass">pass</option>
                            <option value="fail">fail</option>
                          </Select>
                        ) : (
                          <>
                            <Input
                              type="number"
                              className="w-full"
                              disabled={!!row(p.id!).na}
                              value={row(p.id!).v ?? ''}
                              onChange={(e) => setRow(p.id!, { v: e.target.value })}
                              placeholder={p.ranged ? 'lowest' : p.unit || 'value'}
                            />
                            {/* Observed across the batch: the highest piece
                                beside the lowest, and the verdict is taken on
                                both ends. */}
                            {!!p.ranged && (
                              <>
                                <span className="text-xs text-slate-300">–</span>
                                <Input
                                  type="number"
                                  className="w-full"
                                  disabled={!!row(p.id!).na}
                                  value={row(p.id!).vmax ?? ''}
                                  onChange={(e) => setRow(p.id!, { vmax: e.target.value })}
                                  placeholder="highest"
                                />
                              </>
                            )}
                          </>
                        )}
                        {/* Not applicable: a recorded answer, so it is a tick
                            rather than the absence of one. */}
                        <label
                          className="flex shrink-0 items-center gap-1 text-xs text-slate-500"
                          title="Not applicable to this product — recorded as an answer, and neither a pass nor a failure"
                        >
                          <input
                            type="checkbox"
                            checked={!!row(p.id!).na}
                            onChange={(e) => setRow(p.id!, { na: e.target.checked })}
                          />
                          N/A
                        </label>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-2 flex items-center justify-between gap-3">
              <p className="text-xs text-slate-400">
                Leave a row blank if it was not checked — that is recorded as unmeasured, never as a failure.
                Tick <span className="font-medium">N/A</span> where the characteristic does not apply to this
                product: that is written down and prints on the certificate, and is neither a pass nor a failure.
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
                  <tr className={TH_CLASS}>
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
