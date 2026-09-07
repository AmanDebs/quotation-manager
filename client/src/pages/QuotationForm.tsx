import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Quotation, Customer, LineItem, TaxType, ColumnConfig } from '../types';
import { Button, Input, Textarea, Select, Field, PageHeader, ErrorText, Card, StatusBadge, ReadOnlyFields, labelClass, FIELD_GRID, FIELD_GRID_PLAIN, SettledDocumentType, NOTES_ROWS } from '../components/ui';
import { PdfLink } from '../components/PdfLink';
import CompanySelect from '../components/CompanySelect';
import { DocNumber, IncoTermsInput, PaymentTermsInput, HeaderCharges } from '../components/DocFields';
import LineItemsEditor from '../components/LineItemsEditor';
import FollowupButton from '../components/FollowupButton';
import ApprovalStrip from '../components/ApprovalStrip';
import InternalNotes from '../components/InternalNotes';
import ColumnsControl, { quotationColumns, quotationOmit, newColumnConfig } from '../components/ColumnsControl';
import { fmtMoney, fmtDate, today, addDays, DEFAULT_VALIDITY_DAYS } from '../lib/format';
import { useDefaultNotes } from '../lib/useDefaultNotes';
import { useUser } from '../App';
import { useDefaultOnce } from '../lib/useDefaultOnce';
import { useUnsavedChanges } from '../lib/useUnsavedChanges';
import HistoryCard from '../components/HistoryCard';
import ReadOnlyItems from '../components/ReadOnlyItems';
import { SETTABLE_STATUSES, quotationStatusLabel } from './Quotations';

interface Draft {
  number?: string;
  customer_id: number | '';
  /** Which group entity is selling. Fixed once the document is numbered. */
  company_id?: number;
  enquiry_id: number | null;
  date: string;
  currency: string;
  validity_date: string;
  payment_terms: string;
  delivery_terms: string;
  notes: string;
  freight: number;
  insurance: number;
  inco_terms: string;
  container_count: string;
  prepared_by: string;
  tax_type: TaxType;
  is_export: number;
  column_config: ColumnConfig;
  items: LineItem[];
}

const emptyDraft = (): Draft => ({
  // Offered for a week unless somebody says otherwise. Derived from the
  // draft's own date rather than the clock, so the two cannot disagree
  // across a timezone boundary; it is a default and stays editable.
  customer_id: '', enquiry_id: null, date: today(), currency: 'INR',
  validity_date: addDays(today(), DEFAULT_VALIDITY_DAYS),
  payment_terms: '', delivery_terms: '', notes: '', freight: 0, insurance: 0,
  inco_terms: '', container_count: '', prepared_by: '', tax_type: 'igst',
  is_export: 0, column_config: newColumnConfig(), items: [],
});

export default function QuotationFormPage() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isNew = !id;
  // Who is filling this in — see the prepared-by default below.
  const user = useUser();

  const { data: customers = [] } = useQuery({ queryKey: ['customers', ''], queryFn: () => api.get<Customer[]>('/api/customers') });
  const { data: existing, error: loadError } = useQuery({
    queryKey: ['quotation', id],
    queryFn: () => api.get<Quotation>(`/api/quotations/${id}`),
    enabled: !isNew,
  });

  const [draft, setDraft] = useState<Draft>(emptyDraft());

  useEffect(() => {
    if (existing) {
      setDraft({
        number: existing.number,
        customer_id: existing.customer_id,
        company_id: existing.company_id,
        enquiry_id: existing.enquiry_id,
        date: existing.date,
        currency: existing.currency,
        validity_date: existing.validity_date,
        payment_terms: existing.payment_terms,
        delivery_terms: existing.delivery_terms,
        notes: existing.notes,
        freight: existing.freight ?? 0,
        insurance: existing.insurance ?? 0,
        inco_terms: existing.inco_terms ?? '',
        container_count: existing.container_count ?? '',
        prepared_by: existing.prepared_by ?? '',
        tax_type: existing.tax_type,
        is_export: existing.is_export ?? 0,
        column_config: existing.column_config ?? {},
        items: existing.items ?? [],
      });
    }
  }, [existing]);

  // Arriving from the export/domestic dialog with a chosen customer, or from
  // an enquiry this quotation is going to answer.
  useEffect(() => {
    if (!isNew) return;
    const type = search.get('type');
    const customer = search.get('customer');
    const enquiry = search.get('enquiry');
    if (!type && !customer && !enquiry) return;
    const isExport = type === 'export';
    setDraft((d) => ({
      ...d,
      // `type` is absent when coming from an enquiry, and the customer's own
      // export flag has not been read yet — so leave the draft's value alone
      // rather than forcing it domestic.
      ...(type ? {
        is_export: isExport ? 1 : 0,
        tax_type: isExport ? 'none' : d.tax_type === 'none' ? 'igst' : d.tax_type,
      } : {}),
      customer_id: customer ? Number(customer) : d.customer_id,
      // The server checks this belongs to the same customer and is in scope;
      // it is only carried here so the link is stored when the quotation saves.
      enquiry_id: enquiry ? Number(enquiry) : d.enquiry_id,
    }));
  }, [isNew, search]);

  /**
   * What the customer decides about a new quotation.
   *
   * One copy, because it is applied from two places — picking a customer in
   * the select, and arriving with one already chosen — and the two used to
   * disagree. Arriving from an **enquiry** carries a customer but no `type`,
   * and this effect only ever adopted the currency, so an overseas buyer got a
   * domestic quotation with IGST on it and nothing said so. That mattered more
   * once the Type control stopped being offered on a new document.
   */
  const fromCustomer = (c: Customer) => {
    const isExport = c.is_export ?? (c.country.trim().toLowerCase() !== 'india' ? 1 : 0);
    return {
      currency: c.currency,
      is_export: isExport,
      tax_type: (isExport ? 'none' : 'igst') as TaxType,
    };
  };

  // Once customers load, adopt what the chosen customer decides.
  useEffect(() => {
    if (!isNew || !draft.customer_id || customers.length === 0) return;
    const c = customers.find((x) => x.id === draft.customer_id);
    if (!c) return;
    const want = fromCustomer(c);
    if (draft.currency !== want.currency || draft.is_export !== want.is_export) {
      setDraft((d) => ({ ...d, ...want }));
    }
  }, [isNew, draft.customer_id, customers]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-pick currency and tax type from the selected customer.
  const onCustomerChange = (cid: number | '') => {
    const c = customers.find((x) => x.id === cid);
    setDraft((d) => ({
      ...d,
      customer_id: cid,
      ...(c
        ? {
            // The entity that usually serves them; still changeable below.
            company_id: c.company_id ?? undefined,
            ...fromCustomer(c),
          }
        : {}),
    }));
  };

  const { markSaved, isDirty, prompt } = useUnsavedChanges(draft, {
    // Deferred, so the mutation declared just below is initialised by the
    // time the dialog can call it. Same condition as the page's Save button.
    run: () => save.mutateAsync(draft),
    can: !!draft.customer_id && draft.items.length > 0,
  });

  const save = useMutation({
    mutationFn: (d: Draft) => (isNew ? api.post<Quotation>('/api/quotations', d) : api.put<Quotation>(`/api/quotations/${id}`, d)),
    onSuccess: (q) => {
      markSaved();
      queryClient.invalidateQueries({ queryKey: ['quotations'] });
      queryClient.invalidateQueries({ queryKey: ['quotation', String(q.id)] });
      if (isNew) navigate(`/quotations/${q.id}`, { replace: true });
    },
  });

  const setStatus = useMutation({
    mutationFn: (status: string) => api.post<Quotation>(`/api/quotations/${id}/status`, { status }),
    onSuccess: (q) => {
      queryClient.invalidateQueries({ queryKey: ['quotations'] });
      queryClient.setQueryData(['quotation', String(q.id)], q);
    },
  });

  const revise = useMutation({
    mutationFn: () => api.post<Quotation>(`/api/quotations/${id}/revise`),
    onSuccess: (q) => {
      queryClient.invalidateQueries({ queryKey: ['quotations'] });
      navigate(`/quotations/${q.id}`);
    },
  });

  // A separate offer that starts from this one, under its own number — unlike
  // Revise, which keeps the number and supersedes what is on screen. Offered
  // on a superseded revision too: copying a dead round is a normal way to
  // start a fresh quote, and nothing about the old row changes.
  const duplicate = useMutation({
    mutationFn: () => api.post<Quotation>(`/api/quotations/${id}/duplicate`),
    onSuccess: (q) => {
      queryClient.invalidateQueries({ queryKey: ['quotations'] });
      navigate(`/quotations/${q.id}`);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/api/quotations/${id}`),
    onSuccess: () => {
      // The document is gone; there is nothing left to warn about losing.
      markSaved();
      queryClient.invalidateQueries({ queryKey: ['quotations'] });
      navigate('/quotations');
    },
  });

  // The standard clauses, already written in on a new quotation. Above the
  // early returns below: a hook after them runs on some renders and not others,
  // which React treats as a changed hook order and unmounts the whole page for.
  useDefaultNotes(isNew, draft.notes, (notes) => setDraft((d) => ({ ...d, notes })));
  /*
   * Whoever is signed in prepared it, unless they say otherwise. Filled from
   * the session rather than typed, since the name is already known and getting
   * it wrong is a matter of spelling; it stays editable, because the person at
   * the keyboard is not always the person the customer should reply to.
   */
  useDefaultOnce(isNew, user?.name ?? '', draft.prepared_by, (prepared_by) =>
    setDraft((d) => ({ ...d, prepared_by })));

  if (loadError) return <ErrorText error={loadError} />;
  if (!isNew && !existing) return <div className="text-slate-400">Loading…</div>;

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const isSuperseded = !!existing?.superseded_by;
  // Converted into a proforma. The chain runs one way, so what that proforma
  // was built from cannot move underneath it. Derived on the server from the
  // proforma's own quotation_id, so deleting that proforma unlocks this again.
  const lockedBy = existing?.converted_pi_number ? existing : null;
  const readOnly = isSuperseded || !!lockedBy;
  const gridClass = readOnly ? FIELD_GRID_PLAIN : FIELD_GRID;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={isNew ? 'New Quotation' : `${existing!.number}${existing!.revision ? ` · Rev. ${existing!.revision}` : ''}`}
        subtitle={isNew ? undefined : existing!.customer_name}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {!isNew && <StatusBadge status={existing!.status} />}
            {!isNew && (
              <>
                <PdfLink href={`/api/pdf/quotation/${id}`} isDirty={isDirty}>
                  <Button variant="secondary">📄 PDF</Button>
                </PdfLink>
                <FollowupButton docType="quotation" docId={Number(id)} customerId={existing!.customer_id} />
                {!readOnly && (
                  <Button variant="secondary" onClick={() => revise.mutate()} disabled={revise.isPending} title="Create a new revision for negotiation">
                    ↻ Revise
                  </Button>
                )}
                <Button
                  variant="secondary"
                  onClick={() => duplicate.mutate()}
                  disabled={duplicate.isPending}
                  title="Copy these lines into a new quotation with its own number. The original is left alone."
                >
                  ⧉ Duplicate
                </Button>
                {/* An accepted quotation becomes a proforma, and the order is
                    booked from that. Booking one straight from here was the
                    other way round and is gone; the Orders page still has
                    "+ New Order" for an order that never had a quotation.
                    "Proforma directly" lost its contrast when the order button
                    went, so it says what it does.

                    Replaced by a link once a proforma exists, the shape the
                    proforma's own "Book Order" button already had. Offering it
                    on a quotation the banner below calls converted and
                    read-only invited raising a second proforma against the
                    same quotation, which makes "which document came from this
                    quote" unanswerable. The server refuses it either way —
                    alreadyConvertedError in services/documentChain.ts. */}
                {lockedBy ? (
                  <Link to={`/proformas/${lockedBy.converted_pi_id}`} className="self-center text-xs text-brand-600 hover:underline">
                    Proforma {lockedBy.converted_pi_number}
                  </Link>
                ) : !isSuperseded && existing!.status !== 'rejected' && (
                  /* Gated on `accepted` until that status started meaning "a
                     proforma exists". It is set *by* this button now, so
                     requiring it first would be a door locked from the inside.
                     Rejected is the one status that blocks: a price somebody
                     turned down is not raised as a proforma. A draft is
                     offered because the server settles it — a manager
                     converting one approves it in the same action, and an
                     employee is told to submit it first. */
                  <Button onClick={() => navigate(`/proformas/new?from_quotation=${id}`)}>→ Create Proforma</Button>
                )}
              </>
            )}
          </div>
        }
      />

      {lockedBy && (
        <div className="mb-4 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">
          Converted into proforma{' '}
          <Link to={`/proformas/${lockedBy.converted_pi_id}`} className="font-medium text-brand-600 hover:underline">
            {lockedBy.converted_pi_number}
          </Link>
          , so it is read-only. Delete that proforma if this really has to change,
          or use <strong>Duplicate</strong> to start a fresh quotation from it.
        </div>
      )}

      {isSuperseded && (
        <div className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          This revision has been superseded by a newer one — it is read-only.
        </div>
      )}

      {!isNew && !readOnly && (
        <ApprovalStrip
          docType="quotations"
          docId={Number(id)}
          status={existing!.approval_status}
          approvedByName={existing!.approved_by_name}
          approvedAt={existing!.approved_at}
          note={existing!.approval_note}
          checks={existing!.checks}
          queryKey="quotation"
        />
      )}

      {!isNew && !readOnly && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-500">Set status:</span>
          {SETTABLE_STATUSES.map((s) => (
            <button
              key={s}
              disabled={setStatus.isPending || existing!.status === s}
              onClick={() => setStatus.mutate(s)}
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                existing!.status === s ? 'bg-brand-700 text-white' : 'bg-white text-slate-600 border border-slate-300 hover:border-brand-600'
              }`}
            >
              {quotationStatusLabel(s)}
            </button>
          ))}
          {/* The other two are observations, not decisions, so they are stated
              rather than offered — see SETTABLE_STATUSES in Quotations.tsx. */}
          <span className="text-xs text-slate-400">
            Proforma Generated and Expired set themselves.
          </span>
        </div>
      )}

      <ReadOnlyFields on={readOnly} className="space-y-4">
        <Card
          title="Details"
          actions={
            /*
             * Not offered on a new quotation. The New dialog asks export or
             * domestic before anything else and then lists only that kind of
             * customer, so a second control here answers a question already
             * put — and answering it differently leaves a domestic customer on
             * an export document, which is exactly what the dialog exists to
             * prevent. It stays editable once saved: a quotation draws from
             * one numbering series whatever its type, so nothing can disagree,
             * which is why `exportChangeError` deliberately does not guard it.
             */
            isNew ? (
              <SettledDocumentType isExport={!!draft.is_export} />
            ) : (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-slate-500">Type:</span>
                <Select
                  value={draft.is_export ? 'export' : 'domestic'}
                  disabled={readOnly}
                  onChange={(e) => {
                    const isExport = e.target.value === 'export';
                    set({ is_export: isExport ? 1 : 0, tax_type: isExport ? 'none' : draft.tax_type === 'none' ? 'igst' : draft.tax_type });
                  }}
                  className="w-32"
                >
                  <option value="export">🌍 Export</option>
                  <option value="domestic">🇮🇳 Domestic</option>
                </Select>
              </div>
            )
          }
        >
          <div className={gridClass}>
            {!isNew && (
              <Field label="Quotation Number">
                <DocNumber
                  value={draft.number}
                  title="Assigned from this company's numbering series when the quotation was created"
                />
              </Field>
            )}
            <Field label="Customer *">
              <Select value={draft.customer_id} disabled={readOnly} onChange={(e) => onCustomerChange(e.target.value ? Number(e.target.value) : '')}>
                <option value="">Select customer…</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.country})</option>)}
              </Select>
            </Field>
            <Field label="Issued By">
              <CompanySelect
                value={draft.company_id ?? null}
                locked={!isNew}
                onChange={(id) => set({ company_id: id ?? undefined })}
              />
            </Field>
            <Field label="Date"><Input type="date" disabled={readOnly} value={draft.date} onChange={(e) => set({ date: e.target.value })} /></Field>
            <Field label="Valid Until"><Input type="date" disabled={readOnly} value={draft.validity_date} onChange={(e) => set({ validity_date: e.target.value })} /></Field>
            <Field label="Currency">
              <Select value={draft.currency} disabled={readOnly} onChange={(e) => set({ currency: e.target.value })}>
                <option value="INR">INR</option><option value="USD">USD</option><option value="EUR">EUR</option>
              </Select>
            </Field>
            <Field label="Tax">
              <Select value={draft.tax_type} disabled={readOnly} onChange={(e) => set({ tax_type: e.target.value as TaxType })}>
                <option value="none">No tax (export)</option>
                <option value="cgst_sgst">CGST + SGST (intra-state)</option>
                <option value="igst">IGST (inter-state)</option>
              </Select>
            </Field>
            <Field label="Payment Terms">
              <PaymentTermsInput
                isExport={!!draft.is_export}
                disabled={readOnly}
                value={draft.payment_terms}
                onChange={(v) => set({ payment_terms: v })}
              />
            </Field>
            <Field label="Delivery Timeline"><Input disabled={readOnly} value={draft.delivery_terms} onChange={(e) => set({ delivery_terms: e.target.value })} placeholder="e.g. 4–6 weeks from order" /></Field>
            <Field label="Prepared By"><Input disabled={readOnly} value={draft.prepared_by} onChange={(e) => set({ prepared_by: e.target.value })} placeholder="Who prepared this quote" /></Field>
            <Field label="INCO Terms / Basis">
              <IncoTermsInput
                isExport={!!draft.is_export}
                disabled={readOnly}
                value={draft.inco_terms}
                onChange={(v) => set({ inco_terms: v })}
              />
            </Field>
            {/*
              * Export only — a domestic sale goes on a lorry, not in a box on a
              * ship, and "5 X 40ft HQ" is not a question anybody at this desk
              * answers for one. The proforma and the order already gated it
              * this way; the quotation was the one that did not, which is also
              * why its loadability columns are export-only already.
              *
              * Still shown on a domestic quotation that **already carries a
              * value**, so a figure entered before this can be seen and
              * cleared rather than becoming invisible and unreachable — the
              * rule `HeaderCharges` follows about the freight it replaced. The
              * PDF needs no matching change: it prints the containers only
              * when there is a value, so an empty field was already silent.
              */}
            {(!!draft.is_export || !!draft.container_count) && (
              <Field label="Containers"><Input disabled={readOnly} value={draft.container_count} onChange={(e) => set({ container_count: e.target.value })} placeholder="e.g. 5 X 40ft HQ" /></Field>
            )}
            <div className={`col-span-full ${readOnly ? 'has-[[data-empty]]:hidden' : ''}`}>
              <span className={`mb-1 block ${labelClass(readOnly)}`}>Notes (printed on quotation)</span>
              <Textarea rows={NOTES_ROWS} disabled={readOnly} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />
            </div>
          </div>
        </Card>

        <Card
          title="Line Items"
          actions={!readOnly && <ColumnsControl config={draft.column_config} onChange={(c) => set({ column_config: c })} columns={quotationColumns(!!draft.is_export)} />}
        >
          {readOnly ? (
            <ReadOnlyItems items={draft.items} currency={draft.currency} />
          ) : (
            <>
              <LineItemsEditor items={draft.items} onChange={(items) => set({ items })} currency={draft.currency} taxType={draft.tax_type} config={draft.column_config} omit={quotationOmit(!!draft.is_export)} />
              <HeaderCharges
                freight={draft.freight}
                insurance={draft.insurance}
                currency={draft.currency}
                items={draft.items}
                onChange={(patch) => set(patch)}
              />
            </>
          )}
        </Card>

        {/* Saved through its own endpoint, so it needs an id — and it stays
            editable on a superseded revision, unlike everything above. */}
        {!isNew && (
          <Card title="Notes for us">
            <InternalNotes docType="quotation" docId={Number(id)} value={existing!.internal_notes ?? ""} rows={4} />
          </Card>
        )}

        {!isNew && existing!.revisions && existing!.revisions.length > 1 && (
          <Card title="Revision History (negotiation)">
            <div className="flex flex-wrap gap-3">
              {existing!.revisions.map((r) => (
                <Link
                  key={r.id}
                  to={`/quotations/${r.id}`}
                  className={`rounded-md border px-3 py-2 text-sm ${r.id === Number(id) ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:border-brand-600'}`}
                >
                  <div className="font-medium">Rev. {r.revision}</div>
                  <div className="text-xs text-slate-500">{fmtDate(r.date)} · {fmtMoney(r.grand_total, draft.currency)} · {r.status}</div>
                </Link>
              ))}
            </div>
          </Card>
        )}

        <ErrorText error={save.error ?? setStatus.error ?? revise.error ?? duplicate.error ?? remove.error} />

        {!readOnly && (
          <div className="flex items-center justify-between">
            <div>
              {!isNew && (
                <Button variant="danger" onClick={() => { if (confirm('Delete this quotation?')) remove.mutate(); }}>Delete</Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => navigate('/quotations')}>Back</Button>
              <Button onClick={() => save.mutate(draft)} disabled={save.isPending || !draft.customer_id || draft.items.length === 0}>
                {save.isPending ? 'Saving…' : isNew ? 'Create Quotation' : 'Save Changes'}
              </Button>
            </div>
          </div>
        )}

        <HistoryCard entity="quotations" id={id ? Number(id) : undefined} />

        {/* The unsaved-changes dialog. Renders nothing until a
            navigation is actually blocked. */}
        {prompt}
      </ReadOnlyFields>
    </div>
  );
}

/** A superseded revision, laid out in the same sequence as the PDF. */
