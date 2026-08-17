import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Quotation, Customer, LineItem, TaxType, ColumnConfig } from '../types';
import { Button, Input, Textarea, Select, Field, PageHeader, ErrorText, Card, StatusBadge } from '../components/ui';
import CompanySelect from '../components/CompanySelect';
import { DocNumber, IncoTermsInput } from '../components/DocFields';
import LineItemsEditor from '../components/LineItemsEditor';
import FollowupButton from '../components/FollowupButton';
import ApprovalStrip from '../components/ApprovalStrip';
import InternalNotes from '../components/InternalNotes';
import ColumnsControl, { quotationColumns, quotationOmit } from '../components/ColumnsControl';
import NotePresetPicker from '../components/NotePresetPicker';
import { fmtMoney, fmtQty, fmtDate, today } from '../lib/format';
import { useDefaultNotes } from '../lib/useDefaultNotes';

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
  customer_id: '', enquiry_id: null, date: today(), currency: 'INR', validity_date: '',
  payment_terms: '', delivery_terms: '', notes: '', freight: 0, insurance: 0,
  inco_terms: '', container_count: '', prepared_by: '', tax_type: 'igst',
  is_export: 0, column_config: {}, items: [],
});

export default function QuotationFormPage() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isNew = !id;

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

  // Arriving from the export/domestic dialog with a chosen customer.
  useEffect(() => {
    if (!isNew) return;
    const type = search.get('type');
    const customer = search.get('customer');
    if (!type && !customer) return;
    const isExport = type === 'export';
    setDraft((d) => ({
      ...d,
      is_export: isExport ? 1 : 0,
      tax_type: isExport ? 'none' : d.tax_type === 'none' ? 'igst' : d.tax_type,
      customer_id: customer ? Number(customer) : d.customer_id,
    }));
  }, [isNew, search]);

  // Once customers load, adopt the chosen customer's currency.
  useEffect(() => {
    if (!isNew || !draft.customer_id || customers.length === 0) return;
    const c = customers.find((x) => x.id === draft.customer_id);
    if (c && draft.currency !== c.currency) setDraft((d) => ({ ...d, currency: c.currency }));
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
            currency: c.currency,
            is_export: c.is_export ?? (c.country.trim().toLowerCase() !== 'india' ? 1 : 0),
            tax_type: (c.country.trim().toLowerCase() !== 'india' ? 'none' : d.tax_type === 'none' ? 'igst' : d.tax_type) as TaxType,
          }
        : {}),
    }));
  };

  const save = useMutation({
    mutationFn: (d: Draft) => (isNew ? api.post<Quotation>('/api/quotations', d) : api.put<Quotation>(`/api/quotations/${id}`, d)),
    onSuccess: (q) => {
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

  const remove = useMutation({
    mutationFn: () => api.del(`/api/quotations/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quotations'] });
      navigate('/quotations');
    },
  });

  // The standard clauses, already written in on a new quotation. Above the
  // early returns below: a hook after them runs on some renders and not others,
  // which React treats as a changed hook order and unmounts the whole page for.
  useDefaultNotes(isNew, draft.notes, (notes) => setDraft((d) => ({ ...d, notes })));

  if (loadError) return <ErrorText error={loadError} />;
  if (!isNew && !existing) return <div className="text-slate-400">Loading…</div>;

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const isSuperseded = !!existing?.superseded_by;
  const readOnly = isSuperseded;

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
                <a href={`/api/pdf/quotation/${id}`} target="_blank" rel="noreferrer">
                  <Button variant="secondary">📄 PDF</Button>
                </a>
                <FollowupButton docType="quotation" docId={Number(id)} customerId={existing!.customer_id} />
                {!readOnly && (
                  <Button variant="secondary" onClick={() => revise.mutate()} disabled={revise.isPending} title="Create a new revision for negotiation">
                    ↻ Revise
                  </Button>
                )}
                {existing!.status === 'accepted' && (
                  <>
                    <Button onClick={() => navigate(`/orders/new?from_quotation=${id}`)}>→ Book Order</Button>
                    <Button variant="secondary" onClick={() => navigate(`/proformas/new?from_quotation=${id}`)}>→ Proforma directly</Button>
                  </>
                )}
              </>
            )}
          </div>
        }
      />

      {isSuperseded && (
        <div className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          This revision has been superseded by a newer one — it is read-only.
        </div>
      )}

      {!isNew && !isSuperseded && (
        <ApprovalStrip
          docType="quotations"
          docId={Number(id)}
          status={existing!.approval_status}
          approvedByName={existing!.approved_by_name}
          approvedAt={existing!.approved_at}
          note={existing!.approval_note}
          queryKey="quotation"
        />
      )}

      {!isNew && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-500">Set status:</span>
          {['draft', 'sent', 'negotiating', 'accepted', 'rejected', 'expired'].map((s) => (
            <button
              key={s}
              disabled={setStatus.isPending || existing!.status === s}
              onClick={() => setStatus.mutate(s)}
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize transition-colors ${
                existing!.status === s ? 'bg-brand-700 text-white' : 'bg-white text-slate-600 border border-slate-300 hover:border-brand-600'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-4">
        <Card
          title="Details"
          actions={
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
          }
        >
          <div className="grid grid-cols-3 gap-3">
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
            <div />
            <Field label="Payment Terms"><Input disabled={readOnly} value={draft.payment_terms} onChange={(e) => set({ payment_terms: e.target.value })} placeholder="e.g. 40% advance, rest against shipping docs" /></Field>
            <Field label="Delivery Timeline"><Input disabled={readOnly} value={draft.delivery_terms} onChange={(e) => set({ delivery_terms: e.target.value })} placeholder="e.g. 4–6 weeks from order" /></Field>
            <Field label="Prepared By"><Input disabled={readOnly} value={draft.prepared_by} onChange={(e) => set({ prepared_by: e.target.value })} placeholder="Who prepared this quote" /></Field>
            <Field label="INCO Terms / Basis">
              <IncoTermsInput
                disabled={readOnly}
                value={draft.inco_terms}
                onChange={(v) => set({ inco_terms: v })}
                placeholder="e.g. CIF Dakar Port, or type your own"
              />
            </Field>
            <Field label="Containers"><Input disabled={readOnly} value={draft.container_count} onChange={(e) => set({ container_count: e.target.value })} placeholder="e.g. 5 X 40ft HQ" /></Field>
            <div />
            <div className="col-span-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-slate-600">Notes (printed on quotation)</span>
                {!readOnly && <NotePresetPicker value={draft.notes} onChange={(v) => set({ notes: v })} />}
              </div>
              <Textarea rows={3} disabled={readOnly} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />
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
              <div className="mt-3 grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 md:max-w-md">
                <Field label={`Indicative Freight (${draft.currency})`}>
                  <Input type="number" min={0} step="any" value={draft.freight || ''} onChange={(e) => set({ freight: Number(e.target.value) })} />
                </Field>
                <Field label={`Insurance (${draft.currency})`}>
                  <Input type="number" min={0} step="any" value={draft.insurance || ''} onChange={(e) => set({ insurance: Number(e.target.value) })} />
                </Field>
              </div>
            </>
          )}
        </Card>

        {/* Saved through its own endpoint, so it needs an id — and it stays
            editable on a superseded revision, unlike everything above. */}
        {!isNew && (
          <Card title="Notes for us">
            <InternalNotes quotationId={Number(id)} value={existing!.internal_notes ?? ''} rows={4} />
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

        <ErrorText error={save.error ?? setStatus.error ?? revise.error ?? remove.error} />

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
      </div>
    </div>
  );
}

/** A superseded revision, laid out in the same sequence as the PDF. */
function ReadOnlyItems({ items, currency }: { items: LineItem[]; currency: string }) {
  const hasPacking = items.some((it) => it.pcs_per_pack != null || it.packs != null || it.total_pcs != null);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
          <th className="pb-1 pr-3">Description</th>
          {hasPacking && <th className="pb-1 pr-3 text-right">Pcs/Box</th>}
          {hasPacking && <th className="pb-1 pr-3 text-right">Boxes</th>}
          {hasPacking && <th className="pb-1 pr-3 text-right">Total Qty</th>}
          <th className="pb-1 pr-3 text-right">Qty</th>
          <th className="pb-1 pr-3 text-right">Unit Price</th>
          <th className="pb-1 pr-3">Unit</th>
          <th className="pb-1 text-right">Amount</th>
        </tr>
      </thead>
      <tbody>
        {items.map((it, i) => (
          <tr key={i} className="border-b border-slate-100 last:border-0">
            <td className="py-1.5 pr-3">{it.description}</td>
            {hasPacking && <td className="py-1.5 pr-3 text-right tabular-nums">{it.pcs_per_pack != null ? fmtQty(it.pcs_per_pack) : '—'}</td>}
            {hasPacking && <td className="py-1.5 pr-3 text-right tabular-nums">{it.packs != null ? fmtQty(it.packs) : '—'}</td>}
            {hasPacking && <td className="py-1.5 pr-3 text-right tabular-nums">{it.total_pcs != null ? fmtQty(it.total_pcs) : '—'}</td>}
            <td className="py-1.5 pr-3 text-right tabular-nums">{it.qty != null ? fmtQty(it.qty) : '—'}</td>
            <td className="py-1.5 pr-3 text-right tabular-nums">{fmtMoney(it.unit_price, currency)}</td>
            <td className="py-1.5 pr-3">{it.unit}</td>
            <td className="py-1.5 text-right tabular-nums">{it.qty != null ? fmtMoney((it.amount ?? it.qty * it.unit_price), currency) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
