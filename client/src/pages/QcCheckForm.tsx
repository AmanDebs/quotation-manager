import { Fragment, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { CoaExtra, CoaField, CoaHeaderConfig, QcCheck, WorkOrder } from '../types';
import {
  Button, Input, Select, Field, Card, PageHeader, ErrorText, EmptyState, TH_CLASS, FIELD_GRID,
} from '../components/ui';
import { CoaExtraFields } from '../components/CoaExtraFields';
import { CoaHeaderFields } from '../components/CoaHeaderFields';
import { PdfLink } from '../components/PdfLink';
import { useUnsavedChanges } from '../lib/useUnsavedChanges';
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
/**
 * One row's answer.
 *
 * `v`/`vmax` are the reading, or its two ends. `mode` says which of the three
 * shapes was used — a range across the batch, a single figure (an average, or
 * one taken once), or **complied**, which is a pass with no number behind it.
 * `said` is the words written in place of the default wording, which is what
 * Aglo's own fitment block carries (*Ok*, *No leakage found*).
 */
/**
 * The three blocks the certificate prints, in the order their paper has them,
 * with the unsectioned remainder last.
 *
 * The labels are the certificate's own (`QC_SECTION_LABEL` on the server), and
 * they are repeated here rather than fetched because the page only ever *draws*
 * them — the server decides which block a result belongs in, from the section
 * copied onto the result itself.
 */
const SECTIONS: { key: string; label: string; adj: string }[] = [
  { key: 'visual', label: 'Visual Checks', adj: 'visual' },
  { key: 'dimensional', label: 'Dimensional Checks', adj: 'dimensional' },
  { key: 'fitment', label: 'Fitment Check', adj: 'fitment' },
  { key: '', label: 'Other Checks', adj: '' },
];

/**
 * A check nobody specified, added to one inspection (2026-10-22, the client:
 * *"divide the checks into sections … and also give option to add a custom
 * check in that section"*).
 *
 * It is **not an edit to the product's specification** — that is the Products
 * page, and a parameter added there applies to every batch from then on. This
 * is one certificate's own row: an ad-hoc dimension, a one-off visual, a test
 * a particular buyer asked for. It carries everything a result needs to read
 * back, which is why the server stores it with no `param_id` and nothing
 * downstream has to know it was custom.
 *
 * Its `id` is **negative**, so it shares the answer map with the specified
 * checks without ever colliding with a real parameter id.
 */
type CustomCheck = {
  id: number; name: string; section: string; kind: string;
  unit: string; min: string; max: string;
};

type Answer = {
  v?: string; vmax?: string; na?: boolean;
  mode?: 'range' | 'value' | 'complied';
  said?: string;
};

export default function QcCheckFormPage({ certify }: {
  /**
   * Open a lot, inspect it and certify it in one press (2026-10-21, the
   * client: *"Since our company is small only final COA is required and is
   * issued"*). The lot covers everything the job has made and nobody has
   * lotted, so there is nothing to choose — which is why this is a flag
   * rather than a second screen: it is the same inspection, with the two
   * fields a certificate needs and no batch to pick.
   *
   * It comes from the **route** (`/work-orders/:id/certify`) rather than from
   * a prop somebody passes, so the address bar says which of the two acts is
   * being performed.
   */
  certify?: boolean;
}) {
  const { id, checkId } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  /*
   * The lot this check finalises, if it is a final one — `?batch=N`.
   *
   * Naming a batch is the whole difference between the specification's two QC
   * levels: without it this is an in-process check against the job, with it
   * this is the final check a certificate may be issued on. The server draws
   * the same distinction over one nullable column.
   */
  const batchId = Number(params.get('batch')) || null;
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
  const [coa, setCoa] = useState({
    coa_date: today(),
    approved_by: '',
    batch_number: '',
    // Whatever this customer asks to see on the page — see `CoaExtraFields`.
    // Empty on every certificate that asks for nothing extra, which the server
    // reads as nothing to print.
    extra: [] as CoaExtra[],
  });
  /*
   * Which header cells the certificate prints, and what was typed over the
   * record on the ones that allow it — see `CoaHeaderFields`.
   *
   * **`null` until somebody ticks or types**, which is what makes an
   * untouched panel send nothing at all: the server then writes the header it
   * has always written, which is what every certificate on file carries.
   */
  const [header, setHeader] = useState<CoaHeaderConfig | null>(null);
  /*
   * Three facts per parameter since 2026-10-16, where there was one string.
   *
   * `v` is the reading — or the **lowest** piece on a characteristic observed
   * as a range, with `vmax` the highest. `na` is *not applicable*, which is an
   * answer somebody gives rather than a box left alone: Aglo's own preform
   * certificate carries three of them, and a blank could not say it.
   */
  const [values, setValues] = useState<Record<number, Answer>>({});
  const row = (id: number) => values[id] ?? {};
  const setRow = (id: number, patch: Answer) =>
    setValues((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...patch } }));
  /**
   * How a measured characteristic was answered.
   *
   * Explicit rather than inferred from which boxes are filled, because a
   * blank *highest* cannot tell a deliberate average from a forgotten one —
   * and the server's guard, which refuses a half-filled range, is worth
   * keeping. It defaults to what the specification promises, so a row nobody
   * touches behaves exactly as it did.
   */
  const modeOf = (p: { id?: number; ranged?: number }) =>
    row(p.id!).mode ?? (p.ranged ? 'range' : 'value');
  const queryClient = useQueryClient();

  const { data: full, isLoading } = useQuery({
    queryKey: ['work-order', String(id)],
    queryFn: () => api.get<WorkOrder>(`/api/work-orders/${id}`),
  });
  const job = full;
  /*
   * What the certificate's header will say — the same list `buildCoaPdf`
   * draws from, so this page cannot promise a cell the document does not
   * print. Asked only in the one-press shape, an ordinary inspection having
   * no certificate to preview.
   */
  const { data: headerData, isLoading: headerLoading } = useQuery({
    queryKey: ['coa-header', 'wo', String(id)],
    queryFn: () => api.get<{ fields: CoaField[] }>(`/api/work-orders/${id}/coa-header`),
    enabled: !!certify,
  });
  /*
   * The two cells that exist only once the press is made, shown as what it is
   * about to write rather than as an em-dash: the batch takes the number
   * typed above, and the certificate its date — its own number is drawn from
   * the series at the moment it is issued, which the hint says.
   *
   * Merged here rather than asked of the server per keystroke.
   */
  const headerFields = headerData?.fields?.map((f) => {
    if (f.key === 'batch') {
      // The number typed above, or what the press will do with a blank — an
      // em-dash here would read as a certificate with no batch on it, which
      // is the one thing it cannot be.
      const v = coa.batch_number.trim() || '(next in the series)';
      return { ...f, derived: v, value: v };
    }
    if (f.key === 'certificate') {
      const v = `(drawn at issue)   ${coa.coa_date ? fmtDate(coa.coa_date) : ''}`.trim();
      return { ...f, derived: v, value: v };
    }
    return f;
  });
  /*
   * **The inspection being corrected**, where that is what this is —
   * `/work-orders/:id/qc/:checkId` (2026-10-24, the client, with a draft
   * certificate in front of them: *"i want to change the results of the
   * tests"*). It is the same page and the same rules: a correction is this
   * list of readings written again, so a second screen for it would be two
   * forms that could come to disagree about what an answer means.
   */
  const editing: QcCheck | undefined = checkId
    ? (full?.qc?.checks ?? []).find((c) => c.id === Number(checkId))
    : undefined;
  // The lot in play: the one being inspected, or — on a correction — the one
  // the stored check already names, which nothing here may change.
  const batch = (full?.batches ?? []).find((b) => b.id === (editing ? editing.batch_id : batchId));

  const after = () => {
    queryClient.invalidateQueries({ queryKey: ['work-order', String(id)] });
  };
  const payload = () => ({
    ...head,
    ...(certify ? coa : {}),
    ...(certify && header ? { header } : {}),
    batch_id: batch?.id ?? null,
    sample_size: head.sample_size === '' ? null : Number(head.sample_size),
    results: [
      ...(full?.qc?.params ?? []).map((p) => ({ ...p, custom: false, name: p.name, unit: p.unit, min: '', max: '' })),
      // A custom row with no name is a blank line somebody opened and did
      // not fill in, which the server refuses — so it is dropped here
      // rather than sent to produce a refusal about itself.
      ...custom.filter((c) => c.name.trim()).map((c) => ({ ...c, custom: true, ranged: 0 })),
    ].map((p) => {
      const r = row(p.id!);
      const mode = p.kind === 'boolean' ? 'value' : modeOf(p);
      const complied = !r.na && mode === 'complied';
      return {
        // Null for a custom check: it points at no parameter and carries
        // its own description instead.
        param_id: p.custom ? null : p.id,
        name: p.name,
        kind: p.kind,
        section: p.section ?? '',
        unit: p.unit ?? '',
        min_value: p.custom ? ((p as CustomCheck).min === '' ? null : Number((p as CustomCheck).min)) : null,
        max_value: p.custom ? ((p as CustomCheck).max === '' ? null : Number((p as CustomCheck).max)) : null,
        // Sent as its own fact: the server writes the row and records the
        // answer, where a blank is still dropped as never looked at.
        na: !!r.na,
        // Conforms, with no figure — a pass the inspector asserts rather
        // than one a reading decides.
        complied,
        mode,
        // The words, where words were written; blank leaves the default.
        observation: (r.said ?? '').trim(),
        // A visual check only counts once a verdict was actually given; "not
        // looked at" and "failed" must not collapse into each other.
        value: r.na || complied ? '' : p.kind === 'boolean' ? (r.v ? r.v === 'pass' : '') : r.v ?? '',
        value_max: r.na || complied || p.kind === 'boolean' || mode !== 'range' ? '' : r.vmax ?? '',
      };
    }),
  });
  const add = useMutation({
    /*
     * A correction is a PUT on the check itself rather than a fresh POST: the
     * reading moves and the inspection stays the one that happened, on its own
     * date, by whoever took it. Recording it again would date every other
     * reading on it to today.
     */
    mutationFn: () => (editing
      ? api.put(`/api/work-orders/qc-checks/${editing.id}`, payload())
      : api.post(`/api/work-orders/${id}/${certify ? 'certify' : 'qc-checks'}`, payload())),
    /*
     * **Back to the job, not back to a blank form.** The dialog this replaced
     * stayed open and cleared itself, which is right for a thing floating over
     * the page you came from; a page that silently emptied after Save would
     * read as one that had lost the reading. The job's own Quality tab is
     * where the inspection now is — or the Batches tab, where a lot just
     * certified needs looking at.
     */
    onSuccess: () => {
      setValues({});
      markSaved();
      after();
      navigate(`/work-orders/${id}?tab=${certify || batch ? 'batches' : 'quality'}`);
    },
  });
  const removeCheck = useMutation({
    mutationFn: (checkId: number) => api.del(`/api/work-orders/qc-checks/${checkId}`),
    onSuccess: after,
  });

  /*
   * The same contract every form page in this app has, and the reason this is
   * worth being a page at all: a dialog cannot be navigated away from, so it
   * never had to answer the question. A page can — and a half-typed inspection
   * is exactly the thing somebody would be annoyed to lose to a stray click on
   * the sidebar.
   *
   * The readings are what counts as dirty; the header fields carry defaults
   * and are not a change by themselves.
   */
  const { markSaved, pdf, prompt } = useUnsavedChanges(values, {
    run: () => add.mutateAsync(),
    can: Object.keys(values).length > 0,
    message: editing
      ? 'These corrections to the inspection have not been saved yet.'
      : 'This inspection has not been recorded yet.',
  });

  /*
   * Custom checks, and the blocks everything is drawn in.
   *
   * `sectioned` follows the **specification**, not the custom rows: a product
   * nobody has sectioned draws the one flat list it always did, and the add
   * button under it has no block to name — the same fallback the certificate
   * takes, so the page and the document agree about what this product's
   * checks look like.
   */
  const [custom, setCustom] = useState<CustomCheck[]>([]);
  const [nextCustom, setNextCustom] = useState(-1);
  const addCustom = (section: string) => {
    setCustom((prev) => [...prev, {
      id: nextCustom, name: '', section, kind: 'boolean', unit: '', min: '', max: '',
    }]);
    setNextCustom((n) => n - 1);
  };
  const patchCustom = (id: number, patch: Partial<CustomCheck>) =>
    setCustom((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const dropCustom = (id: number) => {
    setCustom((prev) => prev.filter((c) => c.id !== id));
    setValues((prev) => { const next = { ...prev }; delete next[id]; return next; });
  };

  /*
   * Fill the form in from the inspection being corrected.
   *
   * An effect rather than an initial state, because the job arrives after the
   * first render — the rule `useDefaultOnce` states about every other default
   * read off something fetched. It runs **once per check** (`filled` latches
   * on the id), so a figure typed over is never overwritten by a refetch, and
   * switching to a different check still fills in.
   *
   * A result that points at **no parameter** comes back as a custom row,
   * carrying the name, section, unit and tolerance that were copied onto it —
   * which covers both a check added on the spot and a parameter since deleted
   * from the specification, and is what `qc_results.param_id` being nullable
   * is for. Negative ids keep those rows out of the way of real parameter
   * ids, exactly as a freshly added one does.
   */
  const [filled, setFilled] = useState(0);
  useEffect(() => {
    if (!editing || filled === editing.id) return;
    setFilled(editing.id);
    setHead({
      date: editing.date,
      shift: editing.shift ?? '',
      sample_size: editing.sample_size === null ? '' : String(editing.sample_size),
      inspector: editing.inspector ?? '',
      notes: editing.notes ?? '',
    });
    const answers: Record<number, Answer> = {};
    const added: CustomCheck[] = [];
    let next = -1;
    for (const r of editing.results) {
      const key = r.param_id ?? next--;
      if (r.param_id === null) {
        added.push({
          id: key,
          name: r.name,
          section: r.section ?? '',
          kind: r.kind,
          unit: r.unit ?? '',
          min: r.min_value === null ? '' : String(r.min_value),
          max: r.max_value === null ? '' : String(r.max_value),
        });
      }
      answers[key] = {
        na: !!r.na,
        // Which of the three answers this row was given. N/A rides beside it
        // rather than being a fourth mode, exactly as the form sends it.
        mode: r.complied ? 'complied' : r.ranged ? 'range' : 'value',
        said: r.observation ?? '',
        v: r.na || r.complied || r.value === null
          ? ''
          : r.kind === 'boolean' ? (r.value === 1 ? 'pass' : 'fail') : String(r.value),
        vmax: r.value_max === null || r.value_max === undefined ? '' : String(r.value_max),
      };
    }
    setValues(answers);
    setCustom(added);
    setNextCustom(next);
  }, [editing, filled]);

  const specParams = full?.qc?.params ?? [];
  const checks = full?.qc?.checks ?? [];
  /*
   * Whether an inspection's readings can still be corrected — the client's
   * half of `checkEditError`, so the page does not draw a button that only
   * ever produces a refusal. The server is what refuses; this only decides
   * what is offered. An in-process check names no lot and is always free.
   */
  const correctable = (c: QcCheck) =>
    c.batch_id === null || !(full?.batches ?? []).find((b) => b.id === c.batch_id)?.cleared;
  const sectioned = specParams.some((p) => !!p.section);
  /** What each block draws: its specified checks, then the ones added to it. */
  const blocks = (sectioned ? SECTIONS : [{ key: '', label: 'Checks', adj: '' }])
    .map((b) => ({
      ...b,
      checks: [
        ...specParams
          .filter((p) => (sectioned ? (p.section ?? '') === b.key : true))
          .map((p) => ({ ...p, custom: false as const, min: '', max: '' })),
        ...custom.filter((c) => (sectioned ? c.section === b.key : true))
          .map((c) => ({
            ...c, custom: true as const, ranged: 0,
            min_value: c.min === '' ? null : Number(c.min),
            max_value: c.max === '' ? null : Number(c.max),
          })),
      ],
    }))
    // A block with nothing specified and nothing added is not drawn — a
    // heading over an empty list is a heading people stop reading.
    .filter((b) => b.checks.length > 0 || b.key !== '');
  const summary = full?.qc?.summary;
  const specOwner = full?.qc?.spec_owner;

  /**
   * Whether a row has actually been answered, by the server's own reading of
   * one: a reading, both ends of a range, *Complied*, or N/A. A boolean row
   * carrying only wording is **not** an answer — the words replace what the
   * certificate prints and never the verdict — and half a range is refused,
   * so the count a person reads before pressing Record is the count the save
   * will agree with.
   */
  const answered = (p: { id?: number; kind: string; ranged?: number }) => {
    const r = row(p.id!);
    if (r.na) return true;
    if (p.kind === 'boolean') return !!r.v;
    const m = modeOf(p);
    if (m === 'complied') return true;
    if (m === 'range') return !!r.v && !!r.vmax;
    return !!r.v;
  };

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

  if (isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (!job) return <p className="text-sm text-slate-500">Work order not found.</p>;

  const title = certify
    ? `Certify — ${job.number}`
    : editing
      ? `Correct inspection — ${batch ? batch.number : job.number}`
      : batch ? `Final check — ${batch.number}` : `Quality check — ${job.number}`;

  /*
   * Every row of this page, so the bar at the foot can say how many of them
   * have been answered — the one question somebody has after nineteen rows,
   * and one no amount of scrolling back answers reliably.
   */
  const allChecks = blocks.flatMap((b) => b.checks);
  const done = allChecks.filter(answered).length;

  return (
    /*
     * Capped like every other form in this app (2026-10-31, the client:
     * *"Make it more user friendly"*). Uncapped it ran the full 1432 of the
     * card, which on their own nineteen-row preform specification put **658px
     * under *Characteristic* for a 281px name** and squeezed the three
     * controls that are actually typed into to 364 — 585px of white sitting
     * between a question and its answer, nineteen times down the page. This
     * is a form rather than a book, and `max-w-7xl` is what the five document
     * forms already use.
     */
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={title}
        subtitle={
          <>
            {job.product_name || job.description}
            {job.customer_name ? ` · ${job.customer_name}` : ''}
            {job.order_number ? <> · <Link to={`/orders/${job.order_id}`} className="hover:underline">{job.order_number}</Link></> : null}
          </>
        }
        actions={
          <Button variant="secondary" onClick={() => navigate(`/work-orders/${id}`)}>Back to job</Button>
        }
      />
      <Card title={certify ? 'Inspection and certificate' : editing ? 'Correct the readings' : 'Inspection'}>
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
                ? <>Inspected against <b>{full?.customer_name}</b>&rsquo;s own specification.</>
                : <>Inspected against the product&rsquo;s default specification.</>}
            </span>
            <PdfLink href={`/api/pdf/qc-report/${job.id}`} guard={pdf} title="Quality report">
              Quality report (PDF)
            </PdfLink>
          </div>

          {/*
            What a correction is, said before the readings rather than left to
            be worked out from the title: the inspection keeps its own date and
            inspector, because that is when it happened and who took it.
            Where a draft certificate prints these readings, it says so and
            names the step left to do — issuing it again is what puts the
            corrected document out, and nothing here does that.
          */}
          {editing && (
            <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Correcting the inspection of <b>{fmtDate(editing.date)}</b>
              {editing.shift ? ` · ${editing.shift}` : ''}
              {editing.inspector ? ` · ${editing.inspector}` : ''}. It keeps that date and inspector — this is a
              figure being put right, not a second inspection.
              {batch?.coa_draft && (
                <> Certificate <b>{batch.coa_no}</b> is a draft and prints these readings, so issue it again
                  from the COA page once they are right.</>
              )}
            </p>
          )}

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
                  This opens a batch covering everything this job has made and not yet
                  certified, records the inspection against it, and issues the certificate. The
                  batch is dated by the last shift in it.
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
                {/*
                  Every cell of the header, with a tick on each — the whole of
                  what the certificate says about itself. The buyer's own
                  reference lives in there rather than beside the three boxes
                  above: it is a header cell like the rest, and two controls
                  over one fact is how the two come to disagree.
                */}
                <div className="mt-3 border-t border-slate-200 pt-3">
                  <CoaHeaderFields
                    fields={headerFields}
                    config={header}
                    loading={headerLoading}
                    onChange={setHeader}
                  />
                </div>
                <div className="mt-3 border-t border-slate-200 pt-3">
                  <CoaExtraFields rows={coa.extra} onChange={(extra) => setCoa({ ...coa, extra })} />
                </div>
              </div>
            )}

            {/*
              Fixed widths rather than content-sized, so the slack is shared
              out rather than dumped on the name column and a long
              characteristic wraps instead of pushing the answer further
              right. The three add to 100%: the name takes what it needs, the
              tolerance is short on almost every row, and what is left goes to
              the cells somebody types into.
            */}
            <table className="w-full table-fixed text-sm">
              <thead>
                <tr className={TH_CLASS}>
                  <th className="w-[40%] pb-1 pr-2">Characteristic</th>
                  <th className="w-[18%] pb-1 pr-2">Should be</th>
                  <th className="pb-1">Measured</th>
                </tr>
              </thead>
              <tbody>
                {blocks.map((b) => (
                  <Fragment key={b.key}>
                    {/*
                      A heading per block, drawn only where the specification
                      says which block a characteristic belongs in — the same
                      fallback the certificate takes, so a product nobody has
                      sectioned is the one flat list it always was.
                    */}
                    {sectioned && (
                      <tr>
                        <td colSpan={3} className="pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-brand-700">
                          {b.label}
                        </td>
                      </tr>
                    )}
                    {b.checks.map((p) => (
                  <tr key={p.id} className="border-b border-slate-100 last:border-0">
                    {/*
                      A specified check states its name and its tolerance; a
                      custom one is typed here, which is the only part of the
                      row that differs. Everything to the right of it — the
                      three answers, the wording and N/A — is the same control
                      for both, because a check nobody specified is still a
                      check and is judged by the same rule.
                    */}
                    <td className="py-1.5 pr-2">
                      {p.custom ? (
                        <div className="flex items-center gap-1">
                          <Input
                            className="w-full"
                            value={p.name}
                            onChange={(e) => patchCustom(p.id, { name: e.target.value })}
                            placeholder="What was checked"
                          />
                          <button
                            type="button"
                            onClick={() => dropCustom(p.id)}
                            className="shrink-0 px-1 text-slate-300 hover:text-red-500"
                            title="Remove this check"
                          >✕</button>
                        </div>
                      ) : p.name}
                    </td>
                    <td className="py-1.5 pr-2 text-slate-500">
                      {p.custom ? (
                        /*
                          A custom check states its own kind and tolerance,
                          which is four controls in a cell sized for the words
                          *50 – 51 gm*. It wraps onto a second line rather
                          than running under the answer beside it — a row
                          somebody is composing may be two lines tall, where
                          the nineteen being read may not.
                        */
                        <div className="flex flex-wrap items-center gap-1">
                          <Select
                            className="w-28 shrink-0"
                            value={p.kind}
                            onChange={(e) => patchCustom(p.id, { kind: e.target.value })}
                          >
                            <option value="boolean">pass / fail</option>
                            <option value="numeric">measurement</option>
                          </Select>
                          {/* A tolerance is optional on a custom check, and
                              one left open is judged on the end it has — the
                              rule `resultOk` already applies to a specified
                              parameter with a one-sided window. */}
                          {p.kind === 'numeric' && (
                            <>
                              <Input
                                type="number" className="w-16 shrink-0" value={p.min ?? ''}
                                onChange={(e) => patchCustom(p.id, { min: e.target.value })}
                                placeholder="min"
                              />
                              <Input
                                type="number" className="w-16 shrink-0" value={p.max ?? ''}
                                onChange={(e) => patchCustom(p.id, { max: e.target.value })}
                                placeholder="max"
                              />
                              <Input
                                className="w-16 shrink-0" value={p.unit}
                                onChange={(e) => patchCustom(p.id, { unit: e.target.value })}
                                placeholder="unit"
                              />
                            </>
                          )}
                        </div>
                      ) : (
                        <>
                          {p.kind === 'boolean' ? 'pass' : tolerance(p)}
                          {p.kind !== 'boolean' && modeOf(p) === 'range' && (
                            <span className="ml-1 text-xs text-slate-400">· both ends</span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="py-1.5">
                      <div className="flex items-center gap-1.5">
                        {p.kind === 'boolean' ? (
                          <>
                            {/*
                              Two buttons rather than a dropdown. On this
                              desk's own specification eleven of nineteen rows
                              are pass/fail, so a select cost two clicks and a
                              read apiece — and nineteen boxes all reading *not
                              checked* say nothing a glance can use. Pressed,
                              the answer is a colour down the column; pressing
                              it again clears it, which is how a mis-click is
                              undone without a third control.
                            */}
                            <div className="flex shrink-0 gap-1">
                              {(['pass', 'fail'] as const).map((v) => (
                                <button
                                  key={v}
                                  type="button"
                                  disabled={!!row(p.id!).na}
                                  onClick={() => setRow(p.id!, { v: row(p.id!).v === v ? '' : v })}
                                  className={`w-16 rounded-md border px-2 py-1 text-xs font-medium capitalize transition-colors disabled:opacity-40 ${
                                    row(p.id!).v === v
                                      ? v === 'pass'
                                        ? 'border-green-500 bg-green-50 text-green-700'
                                        : 'border-red-500 bg-red-50 text-red-700'
                                      : 'border-slate-200 text-slate-400 hover:border-slate-300 hover:text-slate-600'
                                  }`}
                                >
                                  {v}
                                </button>
                              ))}
                            </div>
                            {/*
                              The words, where words are what gets written.
                              Aglo's own fitment block reads *Ok* and *No
                              leakage found* rather than Pass, Pass — so this
                              replaces the **wording** on the certificate and
                              never the verdict, which the select beside it
                              still decides. Blank prints what it always did.
                            */}
                            <Input
                              className="w-44 shrink-0"
                              disabled={!!row(p.id!).na}
                              value={row(p.id!).said ?? ''}
                              onChange={(e) => setRow(p.id!, { said: e.target.value })}
                              placeholder={row(p.id!).v === 'fail' ? 'Fail' : 'Pass'}
                              title="What the certificate should say — leave blank for Pass or Fail"
                            />
                          </>
                        ) : (
                          <>
                            {/*
                              Which of the three answers this is. A
                              specification can only say what is *usually*
                              given, so the choice sits on the reading: a run
                              measured piece by piece carries a range, one
                              averaged carries a figure, and one checked with
                              a gauge rather than measured carries Complied.
                            */}
                            <Select
                              className="w-40 shrink-0"
                              disabled={!!row(p.id!).na}
                              value={modeOf(p)}
                              onChange={(e) => setRow(p.id!, { mode: e.target.value as Answer['mode'] })}
                            >
                              <option value="range">lowest–highest</option>
                              <option value="value">single value</option>
                              <option value="complied">complied</option>
                            </Select>
                            {modeOf(p) === 'complied' ? (
                              <Input
                                className="w-44 shrink-0"
                                disabled={!!row(p.id!).na}
                                value={row(p.id!).said ?? ''}
                                onChange={(e) => setRow(p.id!, { said: e.target.value })}
                                placeholder="Complied"
                                title="What the certificate should say — leave blank for Complied"
                              />
                            ) : (
                              <>
                                <Input
                                  type="number"
                                  className={`shrink-0 ${modeOf(p) === 'range' ? 'w-28' : 'w-36'}`}
                                  disabled={!!row(p.id!).na}
                                  value={row(p.id!).v ?? ''}
                                  onChange={(e) => setRow(p.id!, { v: e.target.value })}
                                  placeholder={modeOf(p) === 'range' ? 'lowest' : p.unit || 'value'}
                                />
                                {/* Observed across the batch: the highest piece
                                    beside the lowest, and the verdict is taken on
                                    both ends. */}
                                {modeOf(p) === 'range' && (
                                  <>
                                    <span className="text-xs text-slate-300">–</span>
                                    <Input
                                      type="number"
                                      className="w-28 shrink-0"
                                      disabled={!!row(p.id!).na}
                                      value={row(p.id!).vmax ?? ''}
                                      onChange={(e) => setRow(p.id!, { vmax: e.target.value })}
                                      placeholder="highest"
                                    />
                                  </>
                                )}
                              </>
                            )}
                          </>
                        )}
                        {/* Not applicable: a recorded answer, so it is a tick
                            rather than the absence of one. */}
                        <label
                          className="ml-auto flex shrink-0 items-center gap-1 text-xs text-slate-500"
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
                    {/*
                      A check nobody specified, added to this block. It is one
                      inspection's own row rather than an edit to the product's
                      specification: `qc_results.param_id` is nullable, so the
                      result simply points at no parameter and carries its own
                      name, kind, section and tolerance — which is why nothing
                      downstream has to be told about it.
                    */}
                    <tr>
                      <td colSpan={3} className="py-1.5">
                        <button
                          type="button"
                          onClick={() => addCustom(b.key)}
                          className="text-xs font-medium text-brand-700 hover:underline"
                        >
                          + Add a{b.adj ? ` ${b.adj}` : ''} check
                        </button>
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>

            <p className="mt-2 text-xs text-slate-400">
              A row left blank was not checked — recorded as unmeasured, never as a failure.
              <span className="font-medium"> Complied</span> is a pass with no figure behind it;
              <span className="font-medium"> N/A</span> says the characteristic does not apply here. Anything
              typed beside an answer is what the certificate prints in place of the usual word.
            </p>
          </div>

          {/*
            The Record button, where it can be pressed from.
            Nineteen rows is 1,461px of page against a 1,000px window, so the
            one button this form has was one somebody had to scroll to find
            — and nothing said whether a row had been missed on the way down.
            The bar answers both, in the shape the planning grid's own sticky
            bar already has.
          */}
          <div className="sticky bottom-4 z-20 mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
            <span className="text-sm font-medium text-slate-700">
              <span className="tabular-nums">{done}</span> of{' '}
              <span className="tabular-nums">{allChecks.length}</span> answered
            </span>
            {done < allChecks.length && (
              <span className="text-xs text-slate-400">
                {allChecks.length - done} not checked — that is recorded as unmeasured
              </span>
            )}
            <ErrorText error={add.error} />
            <Button
              className="ml-auto shrink-0 whitespace-nowrap"
              onClick={() => add.mutate()}
              disabled={add.isPending}
            >
              {add.isPending ? 'Saving…' : editing ? 'Save corrections' : 'Record inspection'}
            </Button>
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
                  {[...checks].reverse().filter((c) => c.id !== editing?.id).map((c) => (
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
                      <td className="whitespace-nowrap py-1.5 text-right">
                        {/*
                          Correct a figure rather than record the whole
                          inspection again, which on a long specification is
                          the difference between one box and nineteen.
                        */}
                        {correctable(c) && (
                          <button
                            onClick={() => navigate(`/work-orders/${id}/qc/${c.id}`)}
                            className="px-1 text-xs text-slate-400 hover:text-brand-700"
                            title="Correct these readings"
                          >Edit</button>
                        )}
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
      </Card>
      {prompt}
    </div>
  );
}
