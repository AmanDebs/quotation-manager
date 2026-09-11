import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type {
  Batch, Location, Machine, Mould, Process, WorkOrder, WorkOrderStatus,
} from '../types';
import {
  Button, Card, EmptyState, ErrorText, Field, Input, PageHeader, Select, Tabs, Textarea,
  CAPTION_CLASS, TH_CLASS,
} from '../components/ui';
import { LogOutput } from '../components/LogOutputModal';
import { IssueModal } from '../components/IssueMaterialModal';
import QcCheckModal from '../components/QcCheckModal';
import BatchDispositionModal from '../components/BatchDispositionModal';
import OpenBatchModal from '../components/OpenBatchModal';
import { PdfLink } from '../components/PdfLink';
import { useUnsavedChanges } from '../lib/useUnsavedChanges';
import { useCan } from '../App';
import { fmtDate, fmtMoney, fmtQty } from '../lib/format';
import { offeredWorkOrderStatuses, workOrderStatusLabel, workOrderStatusStyle } from './WorkOrders';

/**
 * One job, on a page of its own.
 *
 * The factory side was built hanging off the sales order, which is right for
 * the questions an order asks — how far along is this order, what has left the
 * plant — but it left a work order with nowhere to be opened: `/work-orders`
 * listed them and `GET /work-orders/:id` answered in full, and nothing put the
 * two together. So a job's own output, the material drawn against it and the
 * inspections on it could only be reached through the order that happens to
 * contain it, three clicks away and mixed in with its siblings.
 *
 * **Production, material and quality are job-level facts** — `production_
 * entries`, `material_moves` and `qc_checks` all carry a `work_order_id`. That
 * is what makes this page the right home for them.
 *
 * **Despatch deliberately is not here.** `despatches.order_id` is NOT NULL and
 * there is no `work_order_id` on that table: a lorry leaves against an *order*,
 * carrying lines from several jobs at once, which is how the desk's own sheet
 * records it. A Dispatch tab here would need a link that does not exist and
 * would describe the goods moving in a way they do not.
 *
 * Everything on it is the server's own answer from one `GET /work-orders/:id`
 * — progress, material required against issued, the QC spec in force and its
 * checks — so nothing is re-derived here and this page cannot disagree with the
 * order's Production tab about the same job.
 */

type Tab = 'details' | 'production' | 'batches' | 'material' | 'quality';

/** The job's own fields, minus the order line — which is fixed once it exists. */
interface Draft {
  description: string;
  qty_planned: number;
  location_id: number | null;
  machine_id: number | null;
  mould_id: number | null;
  process_id: number | null;
  planned_start: string;
  planned_end: string;
  notes: string;
}



export default function WorkOrderDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const can = useCan();
  const [tab, setTab] = useState<Tab>('details');
  const [logging, setLogging] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [openingBatch, setOpeningBatch] = useState(false);
  // The lot a final check is being recorded against, if any.
  const [finalising, setFinalising] = useState<Batch | null>(null);
  // The lot being ruled on, and which way — see BatchDispositionModal.
  const [deciding, setDeciding] = useState<{ batch: Batch; disposition: 'rework' | 'scrapped' } | null>(null);

  const { data: job, error: loadError } = useQuery({
    queryKey: ['work-order', id],
    queryFn: () => api.get<WorkOrder>(`/api/work-orders/${id}`),
  });

  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (!job) return;
    setDraft({
      description: job.description ?? '',
      qty_planned: job.qty_planned ?? 0,
      location_id: job.location_id, machine_id: job.machine_id,
      mould_id: job.mould_id, process_id: job.process_id,
      planned_start: job.planned_start ?? '', planned_end: job.planned_end ?? '',
      notes: job.notes ?? '',
    });
  }, [job]);

  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });
  const { data: machines = [] } = useQuery({ queryKey: ['master', 'machines', false], queryFn: () => api.get<Machine[]>('/api/machines') });
  const { data: moulds = [] } = useQuery({ queryKey: ['master', 'moulds', false], queryFn: () => api.get<Mould[]>('/api/moulds') });
  const { data: processes = [] } = useQuery({ queryKey: ['master', 'processes', false], queryFn: () => api.get<Process[]>('/api/processes') });

  // Anything recorded here moves the order's own status and its progress
  // figures, so both are invalidated alongside the job itself.
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['work-order', id] });
    queryClient.invalidateQueries({ queryKey: ['work-orders'] });
    if (job) queryClient.invalidateQueries({ queryKey: ['order', String(job.order_id)] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  /*
   * The same contract every document form has, and it is what a PDF link on
   * this page needs: `PdfLink` takes `isDirty` as a **required** prop precisely
   * so a page with an editable form cannot quietly open a document built from
   * the saved version. This page has one — description, quantity, machine,
   * dates — so it has to answer the question.
   *
   * It closes a second gap while it is here: leaving with the Details form
   * edited used to lose them without a word.
   */
  const { markSaved, pdf, prompt } = useUnsavedChanges(draft, {
    run: () => save.mutateAsync(draft!),
    can: !!draft && draft.qty_planned > 0,
  });

  const save = useMutation({
    mutationFn: (d: Draft) => api.put<WorkOrder>(`/api/work-orders/${id}`, d),
    onSuccess: () => { markSaved(); refresh(); },
  });
  const setStatus = useMutation({
    mutationFn: (status: WorkOrderStatus) => api.post(`/api/work-orders/${id}/status`, { status }),
    onSuccess: refresh,
  });
  /*
   * Issuing the certificate is a **Quality** act, and the button is only drawn
   * for a lot whose final check passed — but the refusal is the server's:
   * `coaBlockError` owns why one may not be issued, and a disabled button that
   * merely hides the reason teaches nobody anything, so its sentence is shown.
   */
  const issueCoa = useMutation({
    mutationFn: (batchId: number) => api.post(`/api/work-orders/batches/${batchId}/coa`, {}),
    onSuccess: refresh,
  });
  /*
   * What to do with a lot that failed. The note is asked for on the way, and
   * only for a decision being *made* — withdrawing one asks nothing, because
   * there is nothing to explain about undoing a mistake.
   */
  const decide = useMutation({
    mutationFn: ({ batchId, disposition, note }: { batchId: number; disposition: string; note: string }) =>
      api.post(`/api/work-orders/batches/${batchId}/disposition`, { disposition, note }),
    onSuccess: () => { refresh(); setDeciding(null); },
  });
  /*
   * Pull the product's current recipe onto this job.
   *
   * The escape from what would otherwise be a trap: the job is costed against
   * the recipe it was raised on, which is the point — but a recipe entered
   * wrongly would then be stuck on it, and a job with output cannot be deleted
   * and re-raised. Deliberately a press rather than something a recipe edit
   * does by itself, which would be the drift this exists to stop.
   */
  const reSnapshot = useMutation({
    mutationFn: () => api.post(`/api/work-orders/${id}/recipe-snapshot`, {}),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/work-orders/${id}`),
    // The job is gone; there is nothing left to warn about losing.
    onSuccess: () => { markSaved(); refresh(); navigate('/work-orders'); },
  });

  if (loadError) return <ErrorText error={loadError} />;
  if (!job || !draft) return <div className="text-slate-400">Loading…</div>;

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d!, ...patch }));
  const mayEdit = can('work_order', 'full');
  const progress = job.progress;
  const pct = job.qty_planned > 0 ? Math.round(((progress?.produced ?? 0) / job.qty_planned) * 100) : 0;
  // Whether anything has actually left the store for this job, which decides
  // what a material cost of zero is allowed to claim.
  const issued = (job.material?.lines ?? []).reduce((n, l) => n + l.issued, 0);

  return (
    <div>
      <PageHeader
        title={job.number}
        subtitle={
          <>
            {job.description || job.product_name || 'Job'} · {job.customer_name} ·{' '}
            <Link to={`/orders/${job.order_id}`} className="text-brand-600 hover:underline">
              {job.order_number}
            </Link>{' '}
            line {job.order_line + 1}
          </>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {can('qc') && (
              <PdfLink href={`/api/pdf/qc-report/${job.id}`} guard={pdf} title="Every inspection on this job, with the tolerance each reading was judged against">
                📄 QC Report
              </PdfLink>
            )}
            {can('output', 'full') && <Button variant="secondary" onClick={() => setLogging(true)}>Log output</Button>}
            {can('qc', 'full') && <Button variant="secondary" onClick={() => setInspecting(true)}>Record QC check</Button>}
          </div>
        }
      />

      {/* The floor's own vocabulary, set by hand — unlike the order's status,
          which follows the facts. A job is released and paused by a person. */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-sm">
        <span className="mr-1 text-slate-500">Status:</span>
        {offeredWorkOrderStatuses(job.status).map((s) => (
          <button
            key={s}
            disabled={!mayEdit || setStatus.isPending}
            onClick={() => setStatus.mutate(s)}
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 transition-colors ${
              job.status === s ? workOrderStatusStyle[s] : 'bg-white text-slate-500 ring-slate-200 hover:ring-slate-300'
            } ${mayEdit ? '' : 'cursor-default'}`}
          >
            {workOrderStatusLabel(s)}
          </button>
        ))}
      </div>

      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'details', label: 'Details' },
          { key: 'production', label: 'Production', badge: job.entries?.length || undefined },
          { key: 'batches', label: 'Batches', badge: job.batches?.length || undefined },
          { key: 'material', label: 'Material' },
          { key: 'quality', label: 'Quality', badge: job.qc?.checks.length || undefined },
        ]}
      />

      {tab === 'details' && (
        <>
          <Card title="Job">
            {/* The order line is not editable here, and deliberately: which line
                a job is against is what keys its progress to the order, and the
                order's own Production tab is where a job is raised against one. */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Description" className="sm:col-span-2">
                <Input disabled={!mayEdit} value={draft.description} onChange={(e) => set({ description: e.target.value })} />
              </Field>
              <Field label="Pieces to make">
                <Input
                  type="number" min={0} step="any" disabled={!mayEdit}
                  className="w-full text-right tabular-nums"
                  value={draft.qty_planned || ''}
                  onChange={(e) => set({ qty_planned: Number(e.target.value) })}
                />
              </Field>
              <Field label="Product">
                <div className="px-0.5 py-1.5 text-sm text-slate-700">{job.product_name || '—'}</div>
              </Field>
              <Field label="Plant">
                <Select disabled={!mayEdit} value={draft.location_id ?? ''} onChange={(e) => set({ location_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— none —</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </Select>
              </Field>
              <Field label="Machine">
                <Select disabled={!mayEdit} value={draft.machine_id ?? ''} onChange={(e) => set({ machine_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— none —</option>
                  {machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </Select>
              </Field>
              <Field label="Mould">
                <Select disabled={!mayEdit} value={draft.mould_id ?? ''} onChange={(e) => set({ mould_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— none —</option>
                  {moulds.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </Select>
              </Field>
              <Field label="Process">
                <Select disabled={!mayEdit} value={draft.process_id ?? ''} onChange={(e) => set({ process_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— none —</option>
                  {processes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              </Field>
              <Field label="Planned start">
                <Input type="date" disabled={!mayEdit} value={draft.planned_start} onChange={(e) => set({ planned_start: e.target.value })} />
              </Field>
              <Field label="Planned finish">
                <Input type="date" disabled={!mayEdit} value={draft.planned_end} onChange={(e) => set({ planned_end: e.target.value })} />
              </Field>
              <Field label="Notes" className="sm:col-span-2 lg:col-span-4">
                <Textarea rows={2} disabled={!mayEdit} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />
              </Field>
            </div>
          </Card>

          <ErrorText error={save.error ?? setStatus.error ?? remove.error} />

          {mayEdit && (
            <div className="mt-3 flex items-center justify-between">
              <Button
                variant="danger"
                onClick={() => { if (confirm(`Delete ${job.number}? Its output and issued material go with it.`)) remove.mutate(); }}
              >
                Delete
              </Button>
              <Button onClick={() => save.mutate(draft)} disabled={save.isPending || !(draft.qty_planned > 0)}>
                {save.isPending ? 'Saving…' : 'Save Changes'}
              </Button>
            </div>
          )}
        </>
      )}

      {tab === 'production' && (
        <Card title="Output">
          <div className="mb-3 flex flex-wrap items-center gap-5 text-sm">
            <div>
              <div className={CAPTION_CLASS}>Planned</div>
              <div className="tabular-nums">{fmtQty(job.qty_planned)}</div>
            </div>
            <div>
              <div className={CAPTION_CLASS}>Made</div>
              <div className="tabular-nums">{fmtQty(progress?.produced ?? 0)}</div>
            </div>
            <div>
              <div className={CAPTION_CLASS}>Left</div>
              <div className="tabular-nums">{fmtQty(progress?.balance ?? job.qty_planned)}</div>
            </div>
            <div>
              <div className={CAPTION_CLASS}>Rejected</div>
              <div className="tabular-nums">{fmtQty(progress?.rejected ?? 0)}</div>
            </div>
            {/* Null, not zero, when nothing has been made — a rate of 0% reads
                as "no rejects", which is a different claim from "not started". */}
            <div>
              <div className={CAPTION_CLASS}>Reject rate</div>
              <div className="tabular-nums">
                {progress?.reject_pct != null ? `${progress.reject_pct}%` : '—'}
              </div>
            </div>
          </div>

          <div className="mb-4 h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-brand-600" style={{ width: `${Math.min(100, pct)}%` }} />
          </div>

          {(job.entries ?? []).length === 0 ? (
            <EmptyState message="Nothing booked yet. Shift output recorded against this job shows here, and the figures above are sums over it." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={TH_CLASS}>
                    <th className="pb-2 pr-3">Date</th>
                    <th className="pb-2 pr-3">Shift</th>
                    <th className="pb-2 pr-3">Operator</th>
                    <th className="pb-2 pr-3 text-right">Good</th>
                    <th className="pb-2 pr-3 text-right">Rejected</th>
                    <th className="pb-2 pr-3">Notes</th>
                    <th className="pb-2 pr-3">Booked by</th>
                  </tr>
                </thead>
                <tbody>
                  {(job.entries ?? []).map((e) => (
                    <tr key={e.id} className="border-b border-slate-100 last:border-0">
                      <td className="py-2 pr-3">{fmtDate(e.date)}</td>
                      <td className="py-2 pr-3">{e.shift || '—'}</td>
                      <td className="py-2 pr-3">{e.operator || '—'}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{fmtQty(e.qty_ok)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{e.qty_reject ? fmtQty(e.qty_reject) : '—'}</td>
                      <td className="py-2 pr-3 text-xs text-slate-500">{e.notes || ''}</td>
                      <td className="py-2 pr-3 text-xs text-slate-400">{e.created_by_name || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'batches' && (
        <Card
          title="Batches"
          actions={can('output', 'full')
            ? <Button variant="secondary" onClick={() => setOpeningBatch(true)}>Open a batch</Button>
            : undefined}
        >
          {/*
            The lot is where the two halves of this page meet: Production opens
            it and books shifts into it, Quality finalises it and issues the
            certificate. Neither team can do the other's part, which is what a
            certificate is for.
          */}
          <p className="mb-3 text-xs text-slate-500">
            A batch is what an invoice line traces back to. Its quantity is the output booked
            into it, and it is cleared by a <em>final</em> check — one recorded against the batch
            itself, rather than the shift-wise checks on the Quality tab.
          </p>

          {(job.batches ?? []).length === 0 ? (
            <EmptyState message="No batches on this job. Output booked without one still counts towards the job — a batch is how a lot is identified and certified, not how it is counted." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={TH_CLASS}>
                    <th className="pb-2 pr-3">Batch</th>
                    <th className="pb-2 pr-3">Started</th>
                    <th className="pb-2 pr-3 text-right">Made</th>
                    <th className="pb-2 pr-3 text-right">Rejected</th>
                    <th className="pb-2 pr-3">Final check</th>
                    <th className="pb-2 pr-3">Certificate</th>
                    <th className="pb-2 pr-3">Outcome</th>
                    <th className="pb-2 pr-3">Dispatched</th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody>
                  {(job.batches ?? []).map((b) => (
                    <tr key={b.id} className="border-b border-slate-100 last:border-0">
                      <td className="py-2 pr-3 font-medium">{b.number}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(b.date)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{fmtQty(b.made)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {b.rejected ? fmtQty(b.rejected) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="py-2 pr-3">
                        {/* Not inspected is neither a pass nor a failure, and says so. */}
                        {b.qc === 'passed' ? <span className="text-green-700">Passed</span>
                          : b.qc === 'failed' ? <span className="text-rose-700">Failed</span>
                            : <span className="text-slate-400">Not inspected</span>}
                      </td>
                      <td className="py-2 pr-3">
                        {b.cleared
                          ? <span className="text-slate-700">{b.coa_no} <span className="text-xs text-slate-400">{fmtDate(b.coa_date)}</span></span>
                          : <span className="text-slate-300">—</span>}
                      </td>
                      {/*
                        What was decided about a lot that failed. A lot nobody
                        has ruled on says so in amber rather than sitting blank
                        — a failed lot with an empty cell beside it is exactly
                        the row that goes unnoticed for a month, which is the
                        whole reason the loop is worth recording.
                      */}
                      <td className="py-2 pr-3 text-xs">
                        {b.disposition ? (
                          <>
                            <span className={b.scrapped ? 'text-rose-700' : 'text-slate-700'}>
                              {b.scrapped ? 'Scrapped' : 'Rework'}
                            </span>
                            {b.disposition_date && <span className="text-slate-400"> · {fmtDate(b.disposition_date)}</span>}
                            {b.disposition_note && <div className="text-slate-400">{b.disposition_note}</div>}
                          </>
                        ) : b.held ? (
                          <span className="text-amber-700">Awaiting a decision</span>
                        ) : <span className="text-slate-300">—</span>}
                      </td>
                      {/*
                        Where this lot went — the traceability chain read
                        backwards, which is the direction a recall reads it.
                        Nothing recorded is **not** the same as "still here":
                        naming lots on a trip is optional, so this says only
                        that nobody has named it on one.
                      */}
                      <td className="py-2 pr-3 text-xs">
                        {b.trips?.length ? b.trips.map((t) => (
                          <div key={t.despatch_id} className="whitespace-nowrap">
                            <span className="text-slate-700">{t.reference || fmtDate(t.date)}</span>
                            {t.destination && <span className="text-slate-400"> · {t.destination}</span>}
                          </div>
                        )) : <span className="text-slate-300">—</span>}
                        {/* ...and came back. Approved is what counts; a drafted
                            return is said to be one, since it is why scrap is
                            still refused. */}
                        {b.returns?.map((r) => (
                          <div key={r.credit_note_id} className={`whitespace-nowrap ${r.approval_status === 'approved' ? 'text-amber-700' : 'text-slate-400'}`}>
                            ↩ returned on <Link to={`/credit-notes/${r.credit_note_id}`} className="hover:underline">{r.number}</Link>
                            {r.approval_status !== 'approved' && ' (not yet approved)'}
                          </div>
                        ))}
                      </td>
                      <td className="whitespace-nowrap py-2 text-right">
                        {b.cleared ? (
                          <PdfLink href={`/api/pdf/coa/${b.id}`} guard={pdf} title="Certificate of Analysis">
                            📄 COA
                          </PdfLink>
                        ) : can('qc', 'full') ? (
                          <>
                            <Button variant="ghost" onClick={() => setFinalising(b)}>Final check</Button>
                            {/*
                              Rework and scrap are offered on a lot that has
                              actually failed — they are what a failed check
                              initiates, and offering them beside a passing one
                              would invite condemning good goods by misclick.
                              A decision already made offers only its undo.
                            */}
                            {b.disposition ? (
                              <Button
                                variant="ghost"
                                className="ml-1"
                                disabled={decide.isPending}
                                title="Withdraw this decision"
                                onClick={() => decide.mutate({ batchId: b.id, disposition: '', note: '' })}
                              >
                                Withdraw
                              </Button>
                            ) : b.qc === 'failed' ? (
                              <>
                                <Button variant="ghost" className="ml-1" disabled={decide.isPending}
                                  onClick={() => { decide.reset(); setDeciding({ batch: b, disposition: 'rework' }); }}>Rework</Button>
                                <Button variant="danger" className="ml-1 border-0" disabled={decide.isPending}
                                  onClick={() => { decide.reset(); setDeciding({ batch: b, disposition: 'scrapped' }); }}>Scrap</Button>
                              </>
                            ) : (
                              <Button
                                variant="secondary"
                                className="ml-1"
                                disabled={b.qc !== 'passed' || issueCoa.isPending}
                                title={b.qc === 'passed'
                                  ? 'Issue the Certificate of Analysis for this batch'
                                  : 'A batch is certified on a passing final check'}
                                onClick={() => issueCoa.mutate(b.id)}
                              >
                                Issue COA
                              </Button>
                            )}
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ErrorText error={issueCoa.error || decide.error} />
        </Card>
      )}

      {tab === 'material' && (
        <Card
          title="Material"
          actions={can('material', 'full') ? <Button variant="secondary" onClick={() => setIssuing(true)}>Issue material</Button> : undefined}
        >
          {/*
            `has_recipe: false` means nobody has said what this product eats —
            unanswerable, not a requirement of nothing. Saying "0 kg required"
            would make a job that has never been costed look fully covered.
          */}
          {/*
            Which recipe these figures came from. Only worth saying when the
            two have actually parted: a job costed against a stamped recipe
            that still matches the product's has nothing to explain, and a
            line of reassurance on every screen is how people stop reading
            the ones that matter.
          */}
          {job.material?.recipe_differs && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
              <span>
                Costed against the recipe as it stood when this job was raised. The product’s recipe has
                changed since.
              </span>
              {can('work_order', 'full') && (
                <Button variant="secondary" disabled={reSnapshot.isPending} onClick={() => reSnapshot.mutate()}>
                  {reSnapshot.isPending ? 'Updating…' : 'Use the current recipe'}
                </Button>
              )}
            </div>
          )}
          <ErrorText error={reSnapshot.error} />
          {!job.material?.has_recipe ? (
            <EmptyState message="Not costed — this product has no recipe, so how much material the job needs is unknown, not nil. Add one on the product to see required against issued." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={TH_CLASS}>
                    <th className="pb-2 pr-3">Material</th>
                    <th className="pb-2 pr-3 text-right">Required</th>
                    <th className="pb-2 pr-3 text-right">Issued</th>
                    <th className="pb-2 pr-3 text-right">Still to issue</th>
                  </tr>
                </thead>
                <tbody>
                  {job.material.lines.map((l) => {
                    const left = Math.max(0, l.qty - l.issued);
                    return (
                      <tr key={l.material_id} className="border-b border-slate-100 last:border-0">
                        <td className="py-2 pr-3">{l.name}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{fmtQty(l.qty)} {l.unit}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{fmtQty(l.issued)} {l.unit}</td>
                        <td className={`py-2 pr-3 text-right tabular-nums ${left > 0 ? 'text-amber-700' : 'text-slate-400'}`}>
                          {left > 0 ? `${fmtQty(left)} ${l.unit}` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Issued but never in the recipe. It still left the store, so it has
              to be visible rather than dropped for not matching the plan. */}
          {!!job.material?.extra?.length && (
            <p className="mt-3 text-xs text-amber-700">
              {job.material.extra.length} material{job.material.extra.length === 1 ? ' was' : 's were'} issued
              that the recipe does not mention.
            </p>
          )}

          {/*
            Zero is two different facts and the sentence has to say which.
            `costing.ts` keeps unpriced stock out of the average's base rather
            than valuing it at nothing, so material drawn from a receipt with no
            rate recorded costs 0 here — which is not the same as nothing having
            been issued, and reading it as such is how a job looks free.
          */}
          <p className="mt-3 text-xs text-slate-500">
            {issued > 0 ? (
              <>
                Material issued to this job has cost{' '}
                <strong className="tabular-nums">{fmtMoney(job.material_cost ?? 0, 'INR')}</strong>, at the
                moving average in force when each issue was made.
                {!job.material_cost && ' Zero because the stock it came out of has no rate recorded — record one on the receipt to value it.'}
              </>
            ) : (
              'Nothing has been issued to this job yet.'
            )}
          </p>
        </Card>
      )}

      {tab === 'quality' && (
        <Card
          title="Quality"
          actions={
            <div className="flex items-center gap-2">
              {/* Beside the checks it prints, which is where somebody looking
                  at them thinks to ask for it — the header carries it too, for
                  the same reason every document form carries its own. */}
              <PdfLink href={`/api/pdf/qc-report/${job.id}`} guard={pdf} title="Grouped by date and shift, each reading beside the tolerance it was judged against">
                📄 QC Report
              </PdfLink>
              {can('qc', 'full') && <Button variant="secondary" onClick={() => setInspecting(true)}>Record check</Button>}
            </div>
          }
        >
          {/*
            Whose specification applies is part of the answer, not a detail: the
            same part is measured to different tolerances for different buyers,
            and `none` is no opinion at all rather than everything passing.
          */}
          <p className="mb-3 text-xs text-slate-500">
            {job.qc?.spec_owner === 'customer'
              ? `Measured against ${job.customer_name}'s own specification.`
              : job.qc?.spec_owner === 'default'
                ? 'Measured against the product’s default specification.'
                : 'No specification recorded for this product — nothing here has an opinion, which is not the same as passing.'}
          </p>

          {(job.qc?.checks ?? []).length === 0 ? (
            <EmptyState message="No checks recorded. An inspection stores the reading and the tolerance it was judged against, so tightening the spec later cannot fail a batch that met the spec of the day." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={TH_CLASS}>
                    <th className="pb-2 pr-3">Date</th>
                    <th className="pb-2 pr-3">Shift</th>
                    <th className="pb-2 pr-3">Inspector</th>
                    <th className="pb-2 pr-3 text-right">Sample</th>
                    <th className="pb-2 pr-3">Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {(job.qc?.checks ?? []).map((c) => (
                    <tr key={c.id} className="border-b border-slate-100 last:border-0">
                      <td className="py-2 pr-3">{fmtDate(c.date)}</td>
                      <td className="py-2 pr-3">{c.shift || '—'}</td>
                      <td className="py-2 pr-3">{c.inspector || '—'}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{c.sample_size || '—'}</td>
                      <td className="py-2 pr-3">
                        {/* Nothing measured is not a pass, and is not a failure
                            either — the distinction services/qc.ts insists on. */}
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${
                          c.passed == null
                            ? 'bg-slate-50 text-slate-500 ring-slate-200'
                            : c.passed
                              ? 'bg-green-50 text-green-700 ring-green-200'
                              : 'bg-red-50 text-red-700 ring-red-200'
                        }`}>
                          {c.passed == null ? 'Not measured' : c.passed ? 'Pass' : 'Fail'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Renders nothing until a navigation is actually blocked. */}
      {prompt}
      {logging && <LogOutput job={job} onClose={() => setLogging(false)} onSaved={refresh} />}
      {openingBatch && <OpenBatchModal job={job} onClose={() => setOpeningBatch(false)} onSaved={refresh} />}
      {deciding && (
        <BatchDispositionModal
          batch={deciding.batch}
          disposition={deciding.disposition}
          saving={decide.isPending}
          error={decide.error}
          onClose={() => setDeciding(null)}
          onSave={(note) => decide.mutate({ batchId: deciding.batch.id, disposition: deciding.disposition, note })}
        />
      )}

      {finalising && (
        <QcCheckModal job={job} batch={finalising} onClose={() => setFinalising(null)} onSaved={refresh} />
      )}
      {issuing && <IssueModal job={job} onClose={() => setIssuing(false)} onSaved={refresh} />}
      {inspecting && <QcCheckModal job={job} onClose={() => setInspecting(false)} onSaved={refresh} />}
    </div>
  );
}
