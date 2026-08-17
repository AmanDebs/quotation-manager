import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Invoice, Customer, LineItem, TaxType, Settings, ColumnConfig, PackingListItem } from '../types';
import { Button, Input, Textarea, Select, Field, PageHeader, ErrorText, Card, StatusBadge } from '../components/ui';
import CompanySelect from '../components/CompanySelect';
import { DocNumber, IncoTermsInput } from '../components/DocFields';
import LineItemsEditor from '../components/LineItemsEditor';
import FollowupButton from '../components/FollowupButton';
import PaymentsCard from '../components/PaymentsCard';
import ApprovalStrip from '../components/ApprovalStrip';
import ColumnsControl, { PACKING_COLUMNS } from '../components/ColumnsControl';
import NotePresetPicker from '../components/NotePresetPicker';
import { fmtQty, today } from '../lib/format';
import { useDefaultNotes } from '../lib/useDefaultNotes';

interface Draft {
  number?: string;
  customer_id: number | '';
  /** Which group entity is selling. Fixed once the document is numbered. */
  company_id?: number;
  pi_id: number | null;
  order_id?: number | null;
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
  packing: PackingDraft;
}

/** The packing list is edited here; the server derives its line items from the invoice's. */
interface PackingDraft {
  number?: string;
  date: string;
  shipping_marks: string;
  remarks: string;
  column_config: ColumnConfig;
  items: PackingListItem[];
}

const emptyPackingItem = (): PackingListItem => ({
  description: '', qty: null, unit: 'unit', packages: '', dimensions: '', gross_weight: 0, net_weight: 0,
});

const emptyDraft = (): Draft => ({
  customer_id: '', pi_id: null, date: today(), currency: 'INR', consignee: '', notify_party: '',
  freight: 0, insurance: 0, shipping_details: '', bank_account: '', inco_terms: '', payment_terms: '',
  is_export: 0, country_of_origin: '', port_of_loading: '', port_of_discharge: '', final_destination: '',
  notify_party_2: '', method_of_despatch: '', lot_no: '', prepared_by: '',
  remarks: '', tax_type: 'igst', column_config: {}, items: [],
  packing: { date: today(), shipping_marks: '', remarks: '', column_config: {}, items: [] },
});

export default function InvoiceFormPage() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isNew = !id;
  const fromProforma = search.get('from_proforma');
  const fromOrder = search.get('from_order');

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
        packing: _pk,
        ...rest
      } = existing;
      setDraft({
        ...(rest as unknown as Draft),
        column_config: existing.column_config ?? {},
        items: existing.items ?? [],
        packing: {
          number: existing.packing?.number,
          date: existing.packing?.date ?? existing.date,
          shipping_marks: existing.packing?.shipping_marks ?? '',
          remarks: existing.packing?.remarks ?? '',
          column_config: existing.packing?.column_config ?? {},
          items: existing.packing?.items ?? [],
        },
      });
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

  // Domestic sales sometimes invoice straight off the order, with no proforma.
  useEffect(() => {
    if (!isNew || fromProforma || !fromOrder || prefilled) return;
    api.get<Partial<Draft> & { items?: LineItem[] }>(`/api/proformas/prefill/from-order/${fromOrder}`).then((p) => {
      const { column_config, ...rest } = p as Record<string, unknown>;
      setDraft((d) => ({
        ...d,
        ...(rest as Partial<Draft>),
        order_id: Number(fromOrder),
        column_config: (column_config as ColumnConfig) ?? {},
        customer_id: (p.customer_id as number) ?? d.customer_id,
      }));
      setPrefilled(true);
    });
  }, [isNew, fromProforma, fromOrder, prefilled]);

  // Arriving from the export/domestic dialog.
  useEffect(() => {
    if (!isNew || fromProforma || fromOrder) return;
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
  }, [isNew, fromProforma, fromOrder, search]);

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

  // The standard clauses, already written in on a new invoice. Above the early
  // returns below: a hook after them runs on some renders and not others, which
  // React treats as a changed hook order and unmounts the whole page for.
  useDefaultNotes(isNew, draft.remarks, (remarks) => setDraft((d) => ({ ...d, remarks })));

  if (loadError) return <ErrorText error={loadError} />;
  if (!isNew && !existing) return <div className="text-slate-400">Loading…</div>;

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setPacking = (patch: Partial<PackingDraft>) =>
    setDraft((d) => ({ ...d, packing: { ...d.packing, ...patch } }));
  // Packing rows follow the invoice's items positionally, so a row may not exist yet.
  const setPackingItem = (i: number, patch: Partial<PackingListItem>) =>
    setDraft((d) => {
      const items = [...d.packing.items];
      while (items.length <= i) items.push(emptyPackingItem());
      items[i] = { ...items[i], ...patch };
      return { ...d, packing: { ...d.packing, items } };
    });
  const totalNet = draft.packing.items.reduce((s, it) => s + (it.net_weight || 0), 0);
  const totalGross = draft.packing.items.reduce((s, it) => s + (it.gross_weight || 0), 0);
  const highVariance = existing?.variance?.filter((v) => Math.abs(v.variance_pct) > 10) ?? [];

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={isNew ? 'New Commercial Invoice' : existing!.number}
        subtitle={isNew ? (fromProforma ? 'Pre-filled from proforma invoice — adjust final quantities and save' : undefined) : existing!.customer_name}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {!isNew && <StatusBadge status={existing!.status} />}
            {!isNew && (
              <>
                <a href={`/api/pdf/invoice/${id}`} target="_blank" rel="noreferrer"><Button variant="secondary">📄 Invoice</Button></a>
                <a href={`/api/pdf/packing-list/${existing!.packing?.id}`} target="_blank" rel="noreferrer">
                  <Button variant="secondary" disabled={!existing!.packing}>📦 Packing List</Button>
                </a>
                <a href={`/api/pdf/invoice-with-packing/${id}`} target="_blank" rel="noreferrer"><Button>📄+📦 Both</Button></a>
                <FollowupButton docType="invoice" docId={Number(id)} customerId={existing!.customer_id} />
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
              <Field label="Invoice Number">
                <DocNumber
                  value={draft.number}
                  title="Assigned from this company's numbering series when the invoice was created"
                />
              </Field>
            )}
            <Field label="Buyer (Customer) *">
              <Select value={draft.customer_id} onChange={(e) => set({ customer_id: e.target.value ? Number(e.target.value) : '' })}>
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
              <IncoTermsInput value={draft.inco_terms} onChange={(v) => set({ inco_terms: v })} />
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

        <Card
          title={`Packing Details${existing?.packing ? ` — ${existing.packing.number}` : ''}`}
          actions={
            <ColumnsControl
              config={draft.packing.column_config}
              onChange={(c) => setPacking({ column_config: c })}
              columns={PACKING_COLUMNS}
            />
          }
        >
          <p className="mb-3 text-sm text-slate-500">
            The packing list is created and kept in sync with this invoice — same items, same shipment. Fill in how the goods are packed.
          </p>
          <div className="mb-3 grid grid-cols-3 gap-3">
            {!isNew && (
              <Field label="Packing List Number">
                <DocNumber
                  value={draft.packing.number}
                  title="Assigned from this company's packing-list series when the invoice was first saved"
                />
              </Field>
            )}
            <Field label="Packing List Date">
              <Input type="date" value={draft.packing.date} onChange={(e) => setPacking({ date: e.target.value })} />
            </Field>
            <Field label="Shipping Marks" className={isNew ? 'col-span-2' : ''}>
              <Input value={draft.packing.shipping_marks} onChange={(e) => setPacking({ shipping_marks: e.target.value })} placeholder="e.g. 1-590/AGLO POLY/NACALA" />
            </Field>
          </div>

          {draft.items.length === 0 ? (
            <p className="py-4 text-center text-sm text-slate-400">Add line items above and their packing rows will appear here.</p>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                    <th className="pb-1 pr-2">Item (from invoice)</th>
                    <th className="pb-1 pr-2 w-28">Packages</th>
                    <th className="pb-1 pr-2 w-32">Dimensions</th>
                    <th className="pb-1 pr-2 w-24">Net Wt (kg)</th>
                    <th className="pb-1 pr-2 w-24">Gross Wt (kg)</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.items.map((it, i) => {
                    const p = draft.packing.items[i] ?? emptyPackingItem();
                    return (
                      <tr key={i} className="border-b border-slate-100 align-top">
                        <td className="py-1.5 pr-2">
                          <div className="text-sm">{it.description || <span className="text-slate-400">(untitled item)</span>}</div>
                          <div className="text-xs text-slate-400">
                            {it.qty != null ? `${fmtQty(it.qty)} ${it.unit}` : 'no qty'}{it.hsn_code ? ` · HSN ${it.hsn_code}` : ''}
                          </div>
                        </td>
                        <td className="py-1.5 pr-2">
                          <Input value={p.packages} onChange={(e) => setPackingItem(i, { packages: e.target.value })} placeholder="e.g. 130 CTN" />
                        </td>
                        <td className="py-1.5 pr-2">
                          <Input value={p.dimensions} onChange={(e) => setPackingItem(i, { dimensions: e.target.value })} placeholder="60x40x40 cm" />
                        </td>
                        <td className="py-1.5 pr-2">
                          <Input type="number" min={0} step="any" value={p.net_weight || ''} onChange={(e) => setPackingItem(i, { net_weight: Number(e.target.value) })} />
                        </td>
                        <td className="py-1.5 pr-2">
                          <Input type="number" min={0} step="any" value={p.gross_weight || ''} onChange={(e) => setPackingItem(i, { gross_weight: Number(e.target.value) })} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="mt-2 text-right text-sm text-slate-600">
                Total Net: <span className="font-semibold tabular-nums">{fmtQty(totalNet)} kg</span>
                {' · '}Total Gross: <span className="font-semibold tabular-nums">{fmtQty(totalGross)} kg</span>
              </div>
            </>
          )}

          <Field label="Packing List Remarks" className="mt-3">
            <Textarea rows={2} value={draft.packing.remarks} onChange={(e) => setPacking({ remarks: e.target.value })} placeholder="e.g. Seaworthy wooden crates, VCI wrapped." />
          </Field>
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
            currencyMismatch={existing!.currency_mismatch}
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
