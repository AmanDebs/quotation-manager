import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Proforma, Customer, LineItem, TaxType, Settings, ColumnConfig } from '../types';
import { Button, Input, Textarea, Select, Field, PageHeader, ErrorText, Card, StatusBadge, SettledDocumentType } from '../components/ui';
import CompanySelect from '../components/CompanySelect';
import { DocNumber, IncoTermsInput, HeaderCharges } from '../components/DocFields';
import LineItemsEditor from '../components/LineItemsEditor';
import ReadOnlyItems from '../components/ReadOnlyItems';
import ContainerFitment from '../components/ContainerFitment';
import FollowupButton from '../components/FollowupButton';
import InternalNotes from '../components/InternalNotes';
import PaymentsCard from '../components/PaymentsCard';
import ApprovalStrip from '../components/ApprovalStrip';
import ColumnsControl, { proformaColumns, proformaOmit, newColumnConfig, hasColumnPrefs, PROFORMA_FORCED } from '../components/ColumnsControl';
import NotePresetPicker from '../components/NotePresetPicker';
import { today } from '../lib/format';
import { useDefaultNotes } from '../lib/useDefaultNotes';
import { useUnsavedChanges } from '../lib/useUnsavedChanges';
import HistoryCard from '../components/HistoryCard';
import { SETTABLE_STATUSES, proformaStatusLabel } from './Proformas';

interface Draft {
  number?: string;
  customer_id: number | '';
  /** Which group entity is selling. Fixed once the document is numbered. */
  company_id?: number;
  quotation_id: number | null;
  date: string;
  currency: string;
  consignee: string;
  notify_party: string;
  freight: number;
  insurance: number;
  lead_time: string;
  bank_account: string;
  inco_terms: string;
  payment_terms: string;
  delivery_terms: string;
  validity_date: string;
  is_export: number;
  country_of_origin: string;
  port_of_loading: string;
  port_of_discharge: string;
  final_destination: string;
  container_count: string;
  partial_shipment: string;
  po_number: string;
  po_date: string;
  notify_party_2: string;
  method_of_despatch: string;
  quantity_tolerance: string;
  hs_code: string;
  prepared_by: string;
  remarks: string;
  tax_type: TaxType;
  column_config: ColumnConfig;
  items: LineItem[];
}

const emptyDraft = (): Draft => ({
  customer_id: '', quotation_id: null, date: today(), currency: 'INR', consignee: '', notify_party: '',
  freight: 0, insurance: 0, lead_time: '', bank_account: '', inco_terms: '', payment_terms: '',
  delivery_terms: '', validity_date: '', is_export: 0, country_of_origin: '', port_of_loading: '',
  port_of_discharge: '', final_destination: '', container_count: '', partial_shipment: 'Not Allowed',
  po_number: '', po_date: '', notify_party_2: '', method_of_despatch: '', quantity_tolerance: '',
  hs_code: '', prepared_by: '', remarks: '', tax_type: 'igst', column_config: newColumnConfig(), items: [],
});

export default function ProformaFormPage() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isNew = !id;
  const fromQuotation = search.get('from_quotation');
  const fromOrder = search.get('from_order');

  const { data: customers = [] } = useQuery({ queryKey: ['customers', ''], queryFn: () => api.get<Customer[]>('/api/customers') });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/api/settings') });
  const { data: existing, error: loadError } = useQuery({
    queryKey: ['proforma', id],
    queryFn: () => api.get<Proforma>(`/api/proformas/${id}`),
    enabled: !isNew,
  });

  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [prefilled, setPrefilled] = useState(false);

  useEffect(() => {
    if (existing) {
      const {
        id: _id, number: _n, status: _s, subtotal: _st, tax_total: _tt, grand_total: _gt,
        customer_name: _cn, quotation_number: _qn, payments: _p, amount_received: _ar,
        approval_status: _as, approved_at: _aa, approval_note: _an, approved_by_name: _ab, created_by_name: _cb,
        ...rest
      } = existing;
      setDraft({ ...(rest as unknown as Draft), column_config: existing.column_config ?? {}, items: existing.items ?? [] });
    }
  }, [existing]);

  useEffect(() => {
    if (!isNew || prefilled) return;
    const source = fromOrder
      ? `/api/proformas/prefill/from-order/${fromOrder}`
      : fromQuotation
        ? `/api/proformas/prefill/from-quotation/${fromQuotation}`
        : null;
    if (!source) return;
    api.get<Partial<Draft>>(source).then((p) => {
      setDraft((d) => ({
        ...d, ...p,
        customer_id: (p.customer_id as number) ?? d.customer_id,
        // Carry the source's columns forward only when it actually has some. A
        // document saved before these defaults existed carries a blank config,
        // and spreading that over the draft would quietly undo them.
        column_config: hasColumnPrefs(p.column_config) ? p.column_config : d.column_config,
      }));
      setPrefilled(true);
    });
  }, [isNew, fromQuotation, fromOrder, prefilled]);

  // Arriving from the export/domestic dialog.
  useEffect(() => {
    if (!isNew || fromQuotation || fromOrder) return;
    const type = search.get('type');
    const customer = search.get('customer');
    if (!type && !customer) return;
    const isExport = type === 'export';
    setDraft((d) => ({
      ...d,
      is_export: isExport ? 1 : 0,
      tax_type: isExport ? 'none' : d.tax_type === 'none' ? 'igst' : d.tax_type,
      country_of_origin: isExport ? 'India' : d.country_of_origin,
      quantity_tolerance: isExport && !d.quantity_tolerance ? '(±) 10% in value and quantity' : d.quantity_tolerance,
      customer_id: customer ? Number(customer) : d.customer_id,
    }));
  }, [isNew, fromQuotation, fromOrder, search]);

  // Adopt the chosen customer's details once customers load.
  useEffect(() => {
    if (!isNew || !draft.customer_id || customers.length === 0 || prefilled) return;
    const c = customers.find((x) => x.id === draft.customer_id);
    if (c && draft.currency !== c.currency) {
      setDraft((d) => ({ ...d, currency: c.currency, consignee: c.consignee, notify_party: c.notify_party, notify_party_2: c.notify_party_2 }));
    }
  }, [isNew, draft.customer_id, customers, prefilled]); // eslint-disable-line react-hooks/exhaustive-deps

  const { markSaved } = useUnsavedChanges(draft);

  const save = useMutation({
    mutationFn: (d: Draft) => (isNew ? api.post<Proforma>('/api/proformas', d) : api.put<Proforma>(`/api/proformas/${id}`, d)),
    onSuccess: (p) => {
      markSaved();
      queryClient.invalidateQueries({ queryKey: ['proformas'] });
      queryClient.invalidateQueries({ queryKey: ['proforma', String(p.id)] });
      if (isNew) navigate(`/proformas/${p.id}`, { replace: true });
    },
  });

  const setStatus = useMutation({
    mutationFn: (status: string) => api.post<Proforma>(`/api/proformas/${id}/status`, { status }),
    onSuccess: (p) => {
      queryClient.invalidateQueries({ queryKey: ['proformas'] });
      queryClient.setQueryData(['proforma', String(p.id)], p);
    },
  });

  // A fresh proforma that starts from this one, under its own number. The
  // order link is deliberately not carried — see the endpoint's own note.
  const duplicate = useMutation({
    mutationFn: () => api.post<Proforma>(`/api/proformas/${id}/duplicate`),
    onSuccess: (p) => {
      queryClient.invalidateQueries({ queryKey: ['proformas'] });
      navigate(`/proformas/${p.id}`);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/api/proformas/${id}`),
    onSuccess: () => {
      // The document is gone; there is nothing left to warn about losing.
      markSaved();
      queryClient.invalidateQueries({ queryKey: ['proformas'] });
      navigate('/proformas');
    },
  });

  // The standard clauses, already written in on a new proforma. Above the early
  // returns below: a hook after them runs on some renders and not others, which
  // React treats as a changed hook order and unmounts the whole page for.
  useDefaultNotes(isNew, draft.remarks, (remarks) => setDraft((d) => ({ ...d, remarks })));

  if (loadError) return <ErrorText error={loadError} />;
  if (!isNew && !existing) return <div className="text-slate-400">Loading…</div>;

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  // An order has been booked from this proforma, so its figures are what that
  // order was built from and the chain runs one way. Derived from order_id --
  // the same column dispatchProgress() walks -- so deleting the order unlocks
  // this again. Payments and internal notes deliberately stay editable: an
  // advance is banked against the proforma *after* the order exists, which is
  // the normal case and the whole point of an advance.
  const lockedByOrder = !!existing?.order_id;
  const readOnly = lockedByOrder;

  const onCustomerChange = (cid: number | '') => {
    const c = customers.find((x) => x.id === cid);
    if (c) {
      const isExport = c.country.trim().toLowerCase() !== 'india';
      set({
        customer_id: cid, currency: c.currency, consignee: c.consignee, notify_party: c.notify_party,
        notify_party_2: c.notify_party_2,
        is_export: isExport ? 1 : 0, tax_type: isExport ? 'none' : draft.tax_type === 'none' ? 'igst' : draft.tax_type,
        country_of_origin: isExport ? 'India' : draft.country_of_origin,
        quantity_tolerance: isExport && !draft.quantity_tolerance ? '(±) 10% in value and quantity' : draft.quantity_tolerance,
      });
    } else {
      set({ customer_id: cid });
    }
  };

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={isNew ? 'New Proforma Invoice' : existing!.number}
        subtitle={isNew ? (fromQuotation ? 'Pre-filled from quotation — review and save' : undefined) : existing!.customer_name}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {!isNew && <StatusBadge status={existing!.status} />}
            {!isNew && (
              <>
                <a href={`/api/pdf/proforma/${id}`} target="_blank" rel="noreferrer"><Button variant="secondary">📄 PDF</Button></a>
                <FollowupButton docType="proforma" docId={Number(id)} customerId={existing!.customer_id} />
                <Button
                  variant="secondary"
                  onClick={() => duplicate.mutate()}
                  disabled={duplicate.isPending}
                  title="Copy these lines into a new proforma with its own number. The original, its order link and its payments are left alone."
                >
                  ⧉ Duplicate
                </Button>
                {/* Book the order the buyer has confirmed against this
                    proforma. Hidden once one exists — the proforma carries the
                    link, and re-pointing it would orphan the first order's
                    dispatch figures. */}
                {existing!.order_id ? (
                  <Link to={`/orders/${existing!.order_id}`} className="self-center text-xs text-brand-600 hover:underline">
                    Order {existing!.order_number ?? existing!.order_id}
                  </Link>
                ) : ['sent', 'order_confirmed', 'advance_received', 'in_production'].includes(existing!.status) && (
                  <Button variant="secondary" onClick={() => navigate(`/orders/new?from_proforma=${id}`)}>→ Book Order</Button>
                )}
                {/* No route to a commercial invoice from here. The chain runs
                    proforma → order → invoice, and the order is the document
                    that knows what was actually made and shipped; billing
                    straight from the proforma skipped it and let one shipment
                    be billed twice. Book the order above, then raise the
                    invoice from it. */}
              </>
            )}
          </div>
        }
      />

      {lockedByOrder && (
        <div className="mb-4 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">
          Order{' '}
          <Link to={`/orders/${existing!.order_id}`} className="font-medium text-brand-600 hover:underline">
            {existing!.order_number ?? existing!.order_id}
          </Link>{' '}
          was booked from this proforma, so its figures are read-only. Delete that
          order if this really has to change, or use <strong>Duplicate</strong> to
          start a fresh proforma from it. Payments and internal notes stay open —
          an advance is banked against this document after the order exists.
        </div>
      )}

      {!isNew && !lockedByOrder && (
        <ApprovalStrip
          docType="proformas"
          docId={Number(id)}
          status={existing!.approval_status}
          approvedByName={existing!.approved_by_name}
          approvedAt={existing!.approved_at}
          note={existing!.approval_note}
          queryKey="proforma"
        />
      )}

      {/* Hidden once the order is booked, like the quotation's. The banner
          above already says why and links to the order. */}
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
              {proformaStatusLabel(s)}
            </button>
          ))}
          {/* The other two are observations, not decisions — see
              SETTABLE_STATUSES in Proformas.tsx. */}
          <span className="text-xs text-slate-400">
            Sales Order Generated and Expired set themselves.
          </span>
        </div>
      )}

      <div className="space-y-4">
        <Card title="Details">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {!isNew && (
              <Field label="PI Number">
                <DocNumber
                  value={draft.number}
                  title="Assigned from this company's numbering series when the proforma was created"
                />
              </Field>
            )}
            <Field label="Buyer (Customer) *">
              <Select disabled={readOnly} value={draft.customer_id} onChange={(e) => onCustomerChange(e.target.value ? Number(e.target.value) : '')}>
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
            <Field label="Date"><Input disabled={readOnly} type="date" value={draft.date} onChange={(e) => set({ date: e.target.value })} /></Field>
            <Field label="Valid Until"><Input disabled={readOnly} type="date" value={draft.validity_date} onChange={(e) => set({ validity_date: e.target.value })} /></Field>
            <Field label="Currency (at customer's option)">
              <Select disabled={readOnly} value={draft.currency} onChange={(e) => set({ currency: e.target.value })}>
                <option value="INR">INR</option><option value="USD">USD</option><option value="EUR">EUR</option>
              </Select>
            </Field>
            <Field label="Tax">
              <Select disabled={readOnly} value={draft.tax_type} onChange={(e) => set({ tax_type: e.target.value as TaxType })}>
                <option value="none">No tax (export)</option>
                <option value="cgst_sgst">CGST + SGST (intra-state)</option>
                <option value="igst">IGST (inter-state)</option>
              </Select>
            </Field>
            <Field label="Production Lead Time"><Input disabled={readOnly} value={draft.lead_time} onChange={(e) => set({ lead_time: e.target.value })} placeholder="e.g. 4 weeks from advance" /></Field>
            <Field label="Payment Terms"><Input disabled={readOnly} value={draft.payment_terms} onChange={(e) => set({ payment_terms: e.target.value })} /></Field>
            <Field label="Delivery Terms"><Input disabled={readOnly} value={draft.delivery_terms} onChange={(e) => set({ delivery_terms: e.target.value })} /></Field>
            <Field label="INCO Terms">
              <IncoTermsInput disabled={readOnly} value={draft.inco_terms} onChange={(v) => set({ inco_terms: v })} />
            </Field>
            <Field label="Method of Despatch">
              <Select disabled={readOnly} value={draft.method_of_despatch} onChange={(e) => set({ method_of_despatch: e.target.value })}>
                <option value="">— select —</option>
                <option>By Sea</option>
                <option>By Air</option>
                <option>By Road</option>
              </Select>
            </Field>
            <Field label="Quantity Tolerance">
              <Input disabled={readOnly} value={draft.quantity_tolerance} onChange={(e) => set({ quantity_tolerance: e.target.value })} placeholder="e.g. (±) 10% in value and quantity" />
            </Field>
            <Field label="HS Code (header)">
              <Input disabled={readOnly} value={draft.hs_code} onChange={(e) => set({ hs_code: e.target.value })} placeholder="e.g. 3923" />
            </Field>
            <Field label="Prepared By">
              <Input disabled={readOnly} value={draft.prepared_by} onChange={(e) => set({ prepared_by: e.target.value })} />
            </Field>
            <Field label="Bank Account (printed on PI)" className="col-span-3">
              <Select disabled={readOnly}
                value={draft.bank_account}
                onChange={(e) => set({ bank_account: e.target.value })}
              >
                <option value="">— select bank account —</option>
                {(settings?.bank_accounts ?? []).map((b, i) => (
                  <option key={i} value={b.details}>{b.label || `Account ${i + 1}`}</option>
                ))}
                {draft.bank_account && !(settings?.bank_accounts ?? []).some((b) => b.details === draft.bank_account) && (
                  <option value={draft.bank_account}>(current value)</option>
                )}
              </Select>
              {(settings?.bank_accounts ?? []).length === 0 && (
                <p className="mt-1 text-xs text-amber-600">No bank accounts configured — add them in Settings.</p>
              )}
            </Field>
          </div>
        </Card>

        <Card title="Buyer's Purchase Order">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="PO Number"><Input disabled={readOnly} value={draft.po_number} onChange={(e) => set({ po_number: e.target.value })} placeholder="Customer's PO reference" /></Field>
            <Field label="PO Date"><Input disabled={readOnly} type="date" value={draft.po_date} onChange={(e) => set({ po_date: e.target.value })} /></Field>
          </div>
          <p className="mt-2 text-xs text-slate-400">Printed on the PI as “Buyer PO”. Set status to “order confirmed” once the PO is received.</p>
        </Card>

        <Card title="Consignee & Notify Parties">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Consignee (if different from buyer)">
              <Textarea disabled={readOnly} rows={3} value={draft.consignee} onChange={(e) => set({ consignee: e.target.value })} />
            </Field>
            <Field label="Notify Party 1">
              <Textarea disabled={readOnly} rows={3} value={draft.notify_party} onChange={(e) => set({ notify_party: e.target.value })} />
            </Field>
            <Field label="Notify Party 2">
              <Textarea disabled={readOnly} rows={3} value={draft.notify_party_2} onChange={(e) => set({ notify_party_2: e.target.value })} />
            </Field>
          </div>
        </Card>

        <Card title="Export Details">
          {/* Editable only before the first save. After that the number has
              been issued from one series or the other and the flag can no
              longer move to match it — the server refuses the change too. */}
          <div className="mb-3">
            {isNew ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!draft.is_export}
                  onChange={(e) => {
                    const isExport = e.target.checked;
                    set({ is_export: isExport ? 1 : 0, tax_type: isExport ? 'none' : draft.tax_type === 'none' ? 'igst' : draft.tax_type });
                  }}
                />
                This is an export order
              </label>
            ) : (
              <SettledDocumentType isExport={!!draft.is_export} number={draft.number} />
            )}
          </div>
          {!!draft.is_export && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Country of Origin"><Input disabled={readOnly} value={draft.country_of_origin} onChange={(e) => set({ country_of_origin: e.target.value })} /></Field>
              <Field label="Port of Loading"><Input disabled={readOnly} value={draft.port_of_loading} onChange={(e) => set({ port_of_loading: e.target.value })} placeholder="e.g. Nhava Sheva" /></Field>
              <Field label="Port of Discharge"><Input disabled={readOnly} value={draft.port_of_discharge} onChange={(e) => set({ port_of_discharge: e.target.value })} /></Field>
              <Field label="Final Destination"><Input disabled={readOnly} value={draft.final_destination} onChange={(e) => set({ final_destination: e.target.value })} /></Field>
              <Field label="Number of Containers"><Input disabled={readOnly} value={draft.container_count} onChange={(e) => set({ container_count: e.target.value })} placeholder="e.g. 2 x 40ft HC" /></Field>
              <Field label="Partial Shipment">
                <Select disabled={readOnly} value={draft.partial_shipment} onChange={(e) => set({ partial_shipment: e.target.value })}>
                  <option>Allowed</option>
                  <option>Not Allowed</option>
                </Select>
              </Field>
            </div>
          )}
        </Card>

        <Card
          title="Line Items"
          actions={<ColumnsControl config={draft.column_config} onChange={(c) => set({ column_config: c })} columns={proformaColumns(!!draft.is_export)} />}
        >
          {readOnly ? (
            <ReadOnlyItems items={draft.items} currency={draft.currency} />
          ) : (
            <LineItemsEditor items={draft.items} onChange={(items) => set({ items })} currency={draft.currency} taxType={draft.tax_type} config={draft.column_config} omit={proformaOmit(!!draft.is_export)} forced={PROFORMA_FORCED} />
          )}
          <HeaderCharges
            freight={draft.freight}
            insurance={draft.insurance}
            currency={draft.currency}
            items={draft.items}
            onChange={(patch) => set(patch)}
          />
        </Card>

        {/* Working information, deliberately not on the PDF: it answers
            "does the Container field above say the right thing?" */}
        <ContainerFitment items={draft.items} containerCount={draft.container_count} />

        {/* Saved through its own endpoint, so it needs an id — and so saving a
            note cannot reset an approved proforma the way the form's Save does. */}
        {!isNew && (
          <Card title="Notes for us">
            <InternalNotes docType="proforma" docId={Number(id)} value={existing!.internal_notes ?? ''} rows={4} />
          </Card>
        )}

        <Card title="Remarks" actions={<NotePresetPicker value={draft.remarks} onChange={(v) => set({ remarks: v })} />}>
          <Textarea disabled={readOnly} rows={3} value={draft.remarks} onChange={(e) => set({ remarks: e.target.value })} placeholder="Any other conditions specific to this customer…" />
        </Card>

        {!isNew && (
          <PaymentsCard
            docType="proforma"
            docId={Number(id)}
            currency={existing!.currency}
            payments={existing!.payments ?? []}
            received={existing!.amount_received ?? 0}
            total={existing!.grand_total}
          />
        )}

        <ErrorText error={save.error ?? setStatus.error ?? duplicate.error ?? remove.error} />

        <div className="flex items-center justify-between">
          <div>
            {!isNew && <Button variant="danger" onClick={() => { if (confirm('Delete this proforma invoice?')) remove.mutate(); }}>Delete</Button>}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => navigate('/proformas')}>Back</Button>
            {!readOnly && (
              <Button onClick={() => save.mutate(draft)} disabled={save.isPending || !draft.customer_id || draft.items.length === 0}>
                {save.isPending ? 'Saving…' : isNew ? 'Create Proforma Invoice' : 'Save Changes'}
              </Button>
            )}
          </div>
        </div>

        <HistoryCard entity="proformas" id={id ? Number(id) : undefined} />
      </div>
    </div>
  );
}
