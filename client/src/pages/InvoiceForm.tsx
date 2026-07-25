import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Invoice, Customer, LineItem, TaxType, Settings, ColumnConfig } from '../types';
import { Button, Input, Textarea, Select, Field, PageHeader, ErrorText, Card, StatusBadge } from '../components/ui';
import LineItemsEditor from '../components/LineItemsEditor';
import FollowupButton from '../components/FollowupButton';
import PaymentsCard from '../components/PaymentsCard';
import ApprovalStrip from '../components/ApprovalStrip';
import ColumnsControl from '../components/ColumnsControl';
import NotePresetPicker from '../components/NotePresetPicker';
import { today } from '../lib/format';

interface Draft {
  number?: string;
  customer_id: number | '';
  pi_id: number | null;
  date: string;
  currency: string;
  consignee: string;
  notify_party: string;
  freight: number;
  insurance: number;
  shipping_details: string;
  bank_account: string;
  inco_terms: string;
  payment_terms: string;
  is_export: number;
  country_of_origin: string;
  port_of_loading: string;
  port_of_discharge: string;
  final_destination: string;
  notify_party_2: string;
  method_of_despatch: string;
  lot_no: string;
  prepared_by: string;
  remarks: string;
  tax_type: TaxType;
  column_config: ColumnConfig;
  items: LineItem[];
}

const emptyDraft = (): Draft => ({
  customer_id: '', pi_id: null, date: today(), currency: 'INR', consignee: '', notify_party: '',
  freight: 0, insurance: 0, shipping_details: '', bank_account: '', inco_terms: '', payment_terms: '',
  is_export: 0, country_of_origin: '', port_of_loading: '', port_of_discharge: '', final_destination: '',
  notify_party_2: '', method_of_despatch: '', lot_no: '', prepared_by: '',
  remarks: '', tax_type: 'igst', column_config: {}, items: [],
});

export default function InvoiceFormPage() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isNew = !id;
  const fromProforma = search.get('from_proforma');

  const { data: customers = [] } = useQuery({ queryKey: ['customers', ''], queryFn: () => api.get<Customer[]>('/api/customers') });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/api/settings') });
  const { data: existing, error: loadError } = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => api.get<Invoice>(`/api/invoices/${id}`),
    enabled: !isNew,
  });

  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [prefilled, setPrefilled] = useState(false);

  useEffect(() => {
    if (existing) {
      const {
        id: _id, number: _n, status: _s, subtotal: _st, tax_total: _tt, grand_total: _gt,
        customer_name: _cn, pi_number: _pn, variance: _v, payments: _p, amount_received: _ar, balance_due: _bd,
        approval_status: _as, approved_at: _aa, approval_note: _an, approved_by_name: _ab, created_by_name: _cb,
        ...rest
      } = existing;
      setDraft({ ...(rest as unknown as Draft), column_config: existing.column_config ?? {}, items: existing.items ?? [] });
    }
  }, [existing]);

  useEffect(() => {
    if (isNew && fromProforma && !prefilled) {
      api.get<Partial<Draft>>(`/api/invoices/prefill/from-proforma/${fromProforma}`).then((p) => {
        setDraft((d) => ({ ...d, ...p, customer_id: (p.customer_id as number) ?? d.customer_id }));
        setPrefilled(true);
      });
    }
  }, [isNew, fromProforma, prefilled]);

  // Arriving from the export/domestic dialog.
  useEffect(() => {
    if (!isNew || fromProforma) return;
    const type = search.get('type');
    const customer = search.get('customer');
    if (!type && !customer) return;
    const isExport = type === 'export';
    setDraft((d) => ({
      ...d,
      is_export: isExport ? 1 : 0,
      tax_type: isExport ? 'none' : d.tax_type === 'none' ? 'igst' : d.tax_type,
      country_of_origin: isExport ? 'India' : d.country_of_origin,
      customer_id: customer ? Number(customer) : d.customer_id,
    }));
  }, [isNew, fromProforma, search]);

  useEffect(() => {
    if (!isNew || !draft.customer_id || customers.length === 0 || prefilled) return;
    const c = customers.find((x) => x.id === draft.customer_id);
    if (c && draft.currency !== c.currency) {
      setDraft((d) => ({ ...d, currency: c.currency, consignee: c.consignee, notify_party: c.notify_party, notify_party_2: c.notify_party_2 }));
    }
  }, [isNew, draft.customer_id, customers, prefilled]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: (d: Draft) => (isNew ? api.post<Invoice>('/api/invoices', d) : api.put<Invoice>(`/api/invoices/${id}`, d)),
    onSuccess: (inv) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice', String(inv.id)] });
      if (isNew) navigate(`/invoices/${inv.id}`, { replace: true });
    },
  });

  const setStatus = useMutation({
    mutationFn: (status: string) => api.post<Invoice>(`/api/invoices/${id}/status`, { status }),
    onSuccess: (inv) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.setQueryData(['invoice', String(inv.id)], inv);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/api/invoices/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      navigate('/invoices');
    },
  });

  if (loadError) return <ErrorText error={loadError} />;
  if (!isNew && !existing) return <div className="text-slate-400">Loading…</div>;

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const highVariance = existing?.variance?.filter((v) => Math.abs(v.variance_pct) > 10) ?? [];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={isNew ? 'New Commercial Invoice' : existing!.number}
        subtitle={isNew ? (fromProforma ? 'Pre-filled from proforma invoice — adjust final quantities and save' : undefined) : existing!.customer_name}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {!isNew && <StatusBadge status={existing!.status} />}
            {!isNew && (
              <>
                <a href={`/api/pdf/invoice/${id}`} target="_blank" rel="noreferrer"><Button variant="secondary">📄 PDF</Button></a>
                <FollowupButton docType="invoice" docId={Number(id)} customerId={existing!.customer_id} />
                <Button onClick={() => navigate(`/packing-lists/new?from_invoice=${id}`)}>→ Create Packing List</Button>
              </>
            )}
          </div>
        }
      />

      {!isNew && (
        <ApprovalStrip
          docType="invoices"
          docId={Number(id)}
          status={existing!.approval_status}
          approvedByName={existing!.approved_by_name}
          approvedAt={existing!.approved_at}
          note={existing!.approval_note}
          queryKey="invoice"
        />
      )}

      {!isNew && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-500">Set status:</span>
          {['draft', 'final', 'dispatched', 'paid'].map((s) => (
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

      {existing?.variance && existing.variance.length > 0 && (
        <div className={`mb-4 rounded-md px-3 py-2 text-sm ${highVariance.length ? 'bg-red-50 text-red-800' : 'bg-blue-50 text-blue-800'}`}>
          <span className="font-medium">Quantity variance vs {existing.pi_number}:</span>{' '}
          {existing.variance.map((v) => `${v.description}: ${v.pi_qty} → ${v.invoice_qty} (${v.variance_pct > 0 ? '+' : ''}${v.variance_pct}%)`).join(' · ')}
          {highVariance.length > 0 && <div className="mt-1 font-medium">⚠ Exceeds the usual 10% variance clause — please review.</div>}
        </div>
      )}

      <div className="space-y-4">
        <Card title="Details">
          <div className="grid grid-cols-3 gap-3">
            {!isNew && (
              <Field label="Invoice Number (editable)">
                <Input value={draft.number ?? ''} onChange={(e) => set({ number: e.target.value })} />
              </Field>
            )}
            <Field label="Buyer (Customer) *">
              <Select value={draft.customer_id} onChange={(e) => set({ customer_id: e.target.value ? Number(e.target.value) : '' })}>
                <option value="">Select customer…</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.country})</option>)}
              </Select>
            </Field>
            <Field label="Invoice Date"><Input type="date" value={draft.date} onChange={(e) => set({ date: e.target.value })} /></Field>
            <Field label="Currency">
              <Select value={draft.currency} onChange={(e) => set({ currency: e.target.value })}>
                <option value="INR">INR</option><option value="USD">USD</option><option value="EUR">EUR</option>
              </Select>
            </Field>
            <Field label="Tax">
              <Select value={draft.tax_type} onChange={(e) => set({ tax_type: e.target.value as TaxType })}>
                <option value="none">No tax (export)</option>
                <option value="cgst_sgst">CGST + SGST (intra-state)</option>
                <option value="igst">IGST (inter-state)</option>
              </Select>
            </Field>
            <Field label="INCO Terms">
              <Select value={draft.inco_terms} onChange={(e) => set({ inco_terms: e.target.value })}>
                {['', 'EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'].map((t) => <option key={t} value={t}>{t || '— select —'}</option>)}
              </Select>
            </Field>
            <Field label="Payment Terms"><Input value={draft.payment_terms} onChange={(e) => set({ payment_terms: e.target.value })} /></Field>
            <Field label="Method of Despatch">
              <Select value={draft.method_of_despatch} onChange={(e) => set({ method_of_despatch: e.target.value })}>
                <option value="">— select —</option>
                <option>By Sea</option>
                <option>By Air</option>
                <option>By Road</option>
              </Select>
            </Field>
            <Field label="Lot No."><Input value={draft.lot_no} onChange={(e) => set({ lot_no: e.target.value })} placeholder="e.g. 90/2025" /></Field>
            <Field label="Prepared By"><Input value={draft.prepared_by} onChange={(e) => set({ prepared_by: e.target.value })} /></Field>
            <Field label="Shipping Details" className="col-span-2">
              <Input value={draft.shipping_details} onChange={(e) => set({ shipping_details: e.target.value })} placeholder="Vessel/flight, BL number, shipping line…" />
            </Field>
            <Field label="Bank Account" className="col-span-3">
              <Select value={draft.bank_account} onChange={(e) => set({ bank_account: e.target.value })}>
                <option value="">— select bank account —</option>
                {(settings?.bank_accounts ?? []).map((b, i) => (
                  <option key={i} value={b.details}>{b.label || `Account ${i + 1}`}</option>
                ))}
                {draft.bank_account && !(settings?.bank_accounts ?? []).some((b) => b.details === draft.bank_account) && (
                  <option value={draft.bank_account}>(current value)</option>
                )}
              </Select>
            </Field>
          </div>
        </Card>

        <Card title="Consignee & Notify Parties">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Consignee">
              <Textarea rows={3} value={draft.consignee} onChange={(e) => set({ consignee: e.target.value })} />
            </Field>
            <Field label="Notify Party 1">
              <Textarea rows={3} value={draft.notify_party} onChange={(e) => set({ notify_party: e.target.value })} />
            </Field>
            <Field label="Notify Party 2">
              <Textarea rows={3} value={draft.notify_party_2} onChange={(e) => set({ notify_party_2: e.target.value })} />
            </Field>
          </div>
        </Card>

        <Card title="Export Details">
          <label className="mb-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!draft.is_export}
              onChange={(e) => {
                const isExport = e.target.checked;
                set({ is_export: isExport ? 1 : 0, tax_type: isExport ? 'none' : draft.tax_type === 'none' ? 'igst' : draft.tax_type });
              }}
            />
            This is an export shipment
          </label>
          {!!draft.is_export && (
            <div className="grid grid-cols-4 gap-3">
              <Field label="Country of Origin"><Input value={draft.country_of_origin} onChange={(e) => set({ country_of_origin: e.target.value })} /></Field>
              <Field label="Port of Loading"><Input value={draft.port_of_loading} onChange={(e) => set({ port_of_loading: e.target.value })} /></Field>
              <Field label="Port of Discharge"><Input value={draft.port_of_discharge} onChange={(e) => set({ port_of_discharge: e.target.value })} /></Field>
              <Field label="Final Destination"><Input value={draft.final_destination} onChange={(e) => set({ final_destination: e.target.value })} /></Field>
            </div>
          )}
        </Card>

        <Card
          title="Line Items (final dispatch quantities)"
          actions={<ColumnsControl config={draft.column_config} onChange={(c) => set({ column_config: c })} />}
        >
          <LineItemsEditor items={draft.items} onChange={(items) => set({ items })} currency={draft.currency} taxType={draft.tax_type} config={draft.column_config} />
          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 md:max-w-md">
            <Field label={`Freight (${draft.currency})`}>
              <Input type="number" min={0} step="any" value={draft.freight || ''} onChange={(e) => set({ freight: Number(e.target.value) })} />
            </Field>
            <Field label={`Insurance (${draft.currency})`}>
              <Input type="number" min={0} step="any" value={draft.insurance || ''} onChange={(e) => set({ insurance: Number(e.target.value) })} />
            </Field>
          </div>
        </Card>

        <Card title="Remarks / Disclaimers" actions={<NotePresetPicker value={draft.remarks} onChange={(v) => set({ remarks: v })} />}>
          <Textarea rows={3} value={draft.remarks} onChange={(e) => set({ remarks: e.target.value })} />
        </Card>

        {!isNew && (
          <PaymentsCard
            docType="invoice"
            docId={Number(id)}
            currency={existing!.currency}
            payments={existing!.payments ?? []}
            received={existing!.amount_received ?? 0}
            total={existing!.grand_total}
            balanceDue={existing!.balance_due}
          />
        )}

        <ErrorText error={save.error ?? setStatus.error ?? remove.error} />

        <div className="flex items-center justify-between">
          <div>
            {!isNew && <Button variant="danger" onClick={() => { if (confirm('Delete this invoice?')) remove.mutate(); }}>Delete</Button>}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => navigate('/invoices')}>Back</Button>
            <Button onClick={() => save.mutate(draft)} disabled={save.isPending || !draft.customer_id || draft.items.length === 0}>
              {save.isPending ? 'Saving…' : isNew ? 'Create Invoice' : 'Save Changes'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
