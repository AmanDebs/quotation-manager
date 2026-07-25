import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Quotation, Customer, LineItem, TaxType } from '../types';
import { Button, Input, Textarea, Select, Field, PageHeader, ErrorText, Card, StatusBadge } from '../components/ui';
import LineItemsEditor from '../components/LineItemsEditor';
import FollowupButton from '../components/FollowupButton';
import { fmtMoney, fmtDate, today } from '../lib/format';

interface Draft {
  number?: string;
  customer_id: number | '';
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
  items: LineItem[];
}

const emptyDraft = (): Draft => ({
  customer_id: '', enquiry_id: null, date: today(), currency: 'INR', validity_date: '',
  payment_terms: '', delivery_terms: '', notes: '', freight: 0, insurance: 0,
  inco_terms: '', container_count: '', prepared_by: '', tax_type: 'igst', items: [],
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
        items: existing.items ?? [],
      });
    }
  }, [existing]);

  // Pre-select customer/enquiry when arriving from an enquiry row.
  useEffect(() => {
    if (isNew) {
      const enquiry = search.get('enquiry');
      const customer = search.get('customer');
      if (enquiry || customer) {
        setDraft((d) => ({
          ...d,
          enquiry_id: enquiry ? Number(enquiry) : null,
          customer_id: customer ? Number(customer) : d.customer_id,
        }));
      }
    }
  }, [isNew, search]);

  // Auto-pick currency and tax type from the selected customer.
  const onCustomerChange = (cid: number | '') => {
    const c = customers.find((x) => x.id === cid);
    setDraft((d) => ({
      ...d,
      customer_id: cid,
      ...(c
        ? {
            currency: c.currency,
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
      queryClient.invalidateQueries({ queryKey: ['enquiries'] });
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

  if (loadError) return <ErrorText error={loadError} />;
  if (!isNew && !existing) return <div className="text-slate-400">Loading…</div>;

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const isSuperseded = !!existing?.superseded_by;
  const readOnly = isSuperseded;

  return (
    <div className="mx-auto max-w-5xl">
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
                  <Button onClick={() => navigate(`/proformas/new?from_quotation=${id}`)}>→ Create Proforma Invoice</Button>
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
        <Card title="Details">
          <div className="grid grid-cols-3 gap-3">
            {!isNew && (
              <Field label="Quotation Number (editable)">
                <Input disabled={readOnly} value={draft.number ?? ''} onChange={(e) => set({ number: e.target.value })} />
              </Field>
            )}
            <Field label="Customer *">
              <Select value={draft.customer_id} disabled={readOnly} onChange={(e) => onCustomerChange(e.target.value ? Number(e.target.value) : '')}>
                <option value="">Select customer…</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.country})</option>)}
              </Select>
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
              <Input disabled={readOnly} value={draft.inco_terms} onChange={(e) => set({ inco_terms: e.target.value })} placeholder="e.g. CIF Dakar Port" />
            </Field>
            <Field label="Containers"><Input disabled={readOnly} value={draft.container_count} onChange={(e) => set({ container_count: e.target.value })} placeholder="e.g. 5 X 40ft HQ" /></Field>
            <div />
            <Field label="Notes (printed on quotation)" className="col-span-3">
              <Textarea rows={2} disabled={readOnly} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />
            </Field>
          </div>
        </Card>

        <Card title="Line Items">
          {readOnly ? (
            <ReadOnlyItems items={draft.items} currency={draft.currency} />
          ) : (
            <>
              <LineItemsEditor items={draft.items} onChange={(items) => set({ items })} currency={draft.currency} taxType={draft.tax_type} />
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

function ReadOnlyItems({ items, currency }: { items: LineItem[]; currency: string }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
          <th className="pb-1 pr-3">Description</th>
          <th className="pb-1 pr-3 text-right">Qty</th>
          <th className="pb-1 pr-3">Unit</th>
          <th className="pb-1 pr-3 text-right">Unit Price</th>
          <th className="pb-1 text-right">Amount</th>
        </tr>
      </thead>
      <tbody>
        {items.map((it, i) => (
          <tr key={i} className="border-b border-slate-100 last:border-0">
            <td className="py-1.5 pr-3">{it.description}</td>
            <td className="py-1.5 pr-3 text-right">{it.qty ?? '—'}</td>
            <td className="py-1.5 pr-3">{it.unit}</td>
            <td className="py-1.5 pr-3 text-right tabular-nums">{fmtMoney(it.unit_price, currency)}</td>
            <td className="py-1.5 text-right tabular-nums">{it.qty != null ? fmtMoney((it.amount ?? it.qty * it.unit_price), currency) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
