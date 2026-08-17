import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Order, OrderItem, Customer, TaxType, ColumnConfig, WorkOrder } from '../types';
import { Button, Input, Textarea, Select, Field, PageHeader, ErrorText, Card, Tabs } from '../components/ui';
import CompanySelect from '../components/CompanySelect';
import { DocNumber, IncoTermsInput } from '../components/DocFields';
import ProductionTab from '../components/ProductionTab';
import MaterialTab from '../components/MaterialTab';
import DispatchTab from '../components/DispatchTab';
import LineItemsEditor from '../components/LineItemsEditor';
import ColumnsControl from '../components/ColumnsControl';
import NotePresetPicker from '../components/NotePresetPicker';
import FollowupButton from '../components/FollowupButton';
import { ORDER_STATUSES, orderStatusLabel } from './Orders';
import { today } from '../lib/format';
import { useDefaultNotes } from '../lib/useDefaultNotes';

interface Draft {
  number?: string;
  customer_id: number | '';
  /** Which group entity is selling. Fixed once the document is numbered. */
  company_id?: number;
  quotation_id: number | null;
  /**
   * Set only when booking from a proforma. Not a column on the order — the
   * server uses it to point that proforma's `order_id` at the new order.
   */
  pi_id?: number;
  date: string;
  is_export: number;
  order_through: string;
  spoc: string;
  po_number: string;
  po_date: string;
  currency: string;
  tax_type: TaxType;
  payment_terms: string;
  freight: number;
  insurance: number;
  inco_terms: string;
  container_count: string;
  advance_due: number;
  advance_amount: number;
  advance_received_date: string;
  destination: string;
  transport: string;
  freight_terms: string;
  promised_date: string;
  scheduled_date: string;
  revised_date: string;
  actual_production_date: string;
  remarks: string;
  notes: string;
  column_config: ColumnConfig;
  items: OrderItem[];
}

const emptyDraft = (): Draft => ({
  customer_id: '', quotation_id: null, date: today(), is_export: 0,
  order_through: 'Phone', spoc: '', po_number: '', po_date: '',
  currency: 'INR', tax_type: 'igst', payment_terms: '', freight: 0, insurance: 0,
  inco_terms: '', container_count: '', advance_due: 0, advance_amount: 0, advance_received_date: '',
  destination: '', transport: '', freight_terms: '', promised_date: '', scheduled_date: '',
  revised_date: '', actual_production_date: '', remarks: '', notes: '', column_config: {}, items: [],
});

const ORDER_THROUGH = ['Phone', 'Email', 'WhatsApp', 'Meeting', 'Portal', 'Other'];

export default function OrderFormPage() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isNew = !id;
  const fromQuotation = search.get('from_quotation');
  // Booked from a proforma the buyer has confirmed. The prefill returns pi_id,
  // which travels in the payload so the server can link the two.
  const fromProforma = search.get('from_proforma');

  const { data: customers = [] } = useQuery({ queryKey: ['customers', ''], queryFn: () => api.get<Customer[]>('/api/customers') });
  const { data: existing, error: loadError } = useQuery({
    queryKey: ['order', id],
    queryFn: () => api.get<Order>(`/api/orders/${id}`),
    enabled: !isNew,
  });

  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [prefilled, setPrefilled] = useState(false);
  const [tab, setTab] = useState<'details' | 'production' | 'material' | 'dispatch'>('details');

  // Jobs still to finish, shown on the tab so the floor's state is visible
  // without opening it. Loaded here rather than in the tab so the count is
  // there before the tab is ever clicked.
  const { data: jobs = [] } = useQuery({
    queryKey: ['work-orders', String(id)],
    queryFn: () => api.get<WorkOrder[]>(`/api/work-orders?order_id=${id}`),
    enabled: !isNew,
  });
  const openJobs = jobs.filter((w) => !['done', 'cancelled'].includes(w.status)).length;

  useEffect(() => {
    if (existing) {
      const {
        id: _id, number: _n, status: _s, subtotal: _st, tax_total: _tt, grand_total: _gt,
        customer_name: _cn, quotation_number: _qn, created_by_name: _cb,
        dispatched_value: _dv, pending_value: _pv, fully_dispatched: _fd, any_dispatched: _ad,
        proformas: _pf, invoices: _iv,
        ...rest
      } = existing;
      setDraft({
        ...(rest as unknown as Draft),
        number: existing.number,
        column_config: existing.column_config ?? {},
        items: existing.items ?? [],
      });
    }
  }, [existing]);

  useEffect(() => {
    const source = fromQuotation
      ? `from-quotation/${fromQuotation}`
      : fromProforma ? `from-proforma/${fromProforma}` : null;
    if (isNew && source && !prefilled) {
      api.get<Partial<Draft>>(`/api/orders/prefill/${source}`).then((p) => {
        setDraft((d) => ({ ...d, ...p, customer_id: (p.customer_id as number) ?? d.customer_id }));
        setPrefilled(true);
      });
    }
  }, [isNew, fromQuotation, fromProforma, prefilled]);

  const save = useMutation({
    mutationFn: (d: Draft) => (isNew ? api.post<Order>('/api/orders', d) : api.put<Order>(`/api/orders/${id}`, d)),
    onSuccess: (o) => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['order', String(o.id)] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      if (isNew) navigate(`/orders/${o.id}`, { replace: true });
    },
  });

  const setStatus = useMutation({
    mutationFn: (status: string) => api.post<Order>(`/api/orders/${id}/status`, { status }),
    onSuccess: (o) => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.setQueryData(['order', String(o.id)], o);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/api/orders/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      navigate('/orders');
    },
  });

  // The standard clauses, already written in on a new order. Above the early
  // returns below: a hook after them runs on some renders and not others, which
  // React treats as a changed hook order and unmounts the whole page for.
  useDefaultNotes(isNew, draft.notes, (notes) => setDraft((d) => ({ ...d, notes })));

  if (loadError) return <ErrorText error={loadError} />;
  if (!isNew && !existing) return <div className="text-slate-400">Loading…</div>;

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const onCustomerChange = (cid: number | '') => {
    const c = customers.find((x) => x.id === cid);
    setDraft((d) => ({
      ...d,
      customer_id: cid,
      ...(c
        ? {
            currency: c.currency,
            is_export: c.is_export ?? (c.country.trim().toLowerCase() !== 'india' ? 1 : 0),
            tax_type: (c.country.trim().toLowerCase() !== 'india' ? 'none' : d.tax_type === 'none' ? 'igst' : d.tax_type) as TaxType,
          }
        : {}),
    }));
  };

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={isNew ? 'New Order' : existing!.number}
        subtitle={isNew ? (fromQuotation ? 'Booked from quotation — confirm the details' : undefined) : existing!.customer_name}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {!isNew && (
              <>
                <a href={`/api/pdf/order/${id}`} target="_blank" rel="noreferrer"><Button variant="secondary">📄 Order PDF</Button></a>
                <FollowupButton docType="general" docId={Number(id)} customerId={existing!.customer_id} />
                <Button onClick={() => navigate(`/proformas/new?from_order=${id}`)}>→ Proforma Invoice</Button>
                <Button variant="secondary" onClick={() => navigate(`/invoices/new?from_order=${id}`)}>→ Invoice directly</Button>
              </>
            )}
          </div>
        }
      />

      {!isNew && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-500">Status:</span>
          {ORDER_STATUSES.map((s) => (
            <button
              key={s}
              disabled={setStatus.isPending || existing!.status === s}
              onClick={() => setStatus.mutate(s)}
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                existing!.status === s ? 'bg-brand-700 text-white' : 'bg-white text-slate-600 border border-slate-300 hover:border-brand-600'
              }`}
            >
              {orderStatusLabel(s)}
            </button>
          ))}
        </div>
      )}

      {/* Tabs only once the order exists: production has nothing to attach to
          until there are saved lines to raise a job against. */}
      {!isNew && (
        <Tabs
          className="mb-4"
          value={tab}
          onChange={setTab}
          tabs={[
            { key: 'details', label: 'Details' },
            { key: 'production', label: 'Production', badge: openJobs || undefined },
            { key: 'material', label: 'Material' },
            { key: 'dispatch', label: 'Dispatch' },
          ]}
        />
      )}

      {tab === 'production' && !isNew && existing && <ProductionTab order={existing} />}
      {tab === 'material' && !isNew && existing && <MaterialTab order={existing} />}
      {tab === 'dispatch' && !isNew && existing && <DispatchTab order={existing} />}

      <div className={`space-y-4 ${tab === 'details' ? '' : 'hidden'}`}>
        <Card
          title="Order Details"
          actions={
            <Select
              value={draft.is_export ? 'export' : 'domestic'}
              onChange={(e) => {
                const isExport = e.target.value === 'export';
                set({ is_export: isExport ? 1 : 0, tax_type: isExport ? 'none' : draft.tax_type === 'none' ? 'igst' : draft.tax_type });
              }}
              className="w-32"
            >
              <option value="export">🌍 Export</option>
              <option value="domestic">🇮🇳 Domestic</option>
            </Select>
          }
        >
          <div className="grid grid-cols-3 gap-3">
            {!isNew && (
              <Field label="Order Number">
                <DocNumber
                  value={draft.number}
                  title="Assigned from this company's numbering series when the order was created"
                />
              </Field>
            )}
            <Field label="Customer *">
              <Select value={draft.customer_id} onChange={(e) => onCustomerChange(e.target.value ? Number(e.target.value) : '')}>
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
            <Field label="Order Date"><Input type="date" value={draft.date} onChange={(e) => set({ date: e.target.value })} /></Field>
            <Field label="Order Received Via">
              <Select value={draft.order_through} onChange={(e) => set({ order_through: e.target.value })}>
                {ORDER_THROUGH.map((o) => <option key={o}>{o}</option>)}
              </Select>
            </Field>
            <Field label="Handled By (SPOC)"><Input value={draft.spoc} onChange={(e) => set({ spoc: e.target.value })} placeholder="Who took this order" /></Field>
            <Field label="Customer's PO Number"><Input value={draft.po_number} onChange={(e) => set({ po_number: e.target.value })} /></Field>
            <Field label="Customer's PO Date"><Input type="date" value={draft.po_date} onChange={(e) => set({ po_date: e.target.value })} /></Field>
            <Field label="Currency">
              <Select value={draft.currency} onChange={(e) => set({ currency: e.target.value })}>
                <option value="INR">INR</option><option value="USD">USD</option><option value="EUR">EUR</option>
              </Select>
            </Field>
            <Field label="Tax">
              <Select value={draft.tax_type} onChange={(e) => set({ tax_type: e.target.value as TaxType })}>
                <option value="none">No tax (export)</option>
                <option value="cgst_sgst">CGST + SGST</option>
                <option value="igst">IGST</option>
              </Select>
            </Field>
            <Field label="Payment Terms" className="col-span-2">
              <Input value={draft.payment_terms} onChange={(e) => set({ payment_terms: e.target.value })} placeholder="e.g. 30-70, After payment, 100% CAD" />
            </Field>
            {!isNew && existing!.quotation_number && (
              <Field label="From Quotation">
                <Link to={`/quotations/${existing!.quotation_id}`} className="text-sm text-brand-600 hover:underline">{existing!.quotation_number}</Link>
              </Field>
            )}
          </div>

          {/* The advance is part of the payment terms, not a subject of its own —
              three fields did not earn a card between the order and its dates. */}
          <div className="mt-3 grid grid-cols-3 gap-3 border-t border-slate-100 pt-3">
            <Field label={`Advance Due (${draft.currency})`}>
              <Input type="number" min={0} step="any" value={draft.advance_due || ''} onChange={(e) => set({ advance_due: Number(e.target.value) })} />
            </Field>
            <Field label={`Advance Received (${draft.currency})`}>
              <Input type="number" min={0} step="any" value={draft.advance_amount || ''} onChange={(e) => set({ advance_amount: Number(e.target.value) })} />
            </Field>
            <Field label="Date of Credit">
              <Input type="date" value={draft.advance_received_date} onChange={(e) => set({ advance_received_date: e.target.value })} />
            </Field>
          </div>
        </Card>

        <Card title="Production Plan & Delivery">
          <div className="grid grid-cols-4 gap-3">
            <Field label="Promised Despatch"><Input type="date" value={draft.promised_date} onChange={(e) => set({ promised_date: e.target.value })} /></Field>
            <Field label="Originally Scheduled"><Input type="date" value={draft.scheduled_date} onChange={(e) => set({ scheduled_date: e.target.value })} /></Field>
            <Field label="Revised Date"><Input type="date" value={draft.revised_date} onChange={(e) => set({ revised_date: e.target.value })} /></Field>
            <Field label="Actual Production"><Input type="date" value={draft.actual_production_date} onChange={(e) => set({ actual_production_date: e.target.value })} /></Field>
            <Field label="Destination"><Input value={draft.destination} onChange={(e) => set({ destination: e.target.value })} placeholder={draft.is_export ? 'e.g. Nacala, Mozambique' : 'e.g. Hazipur'} /></Field>
            <Field label="Transport"><Input value={draft.transport} onChange={(e) => set({ transport: e.target.value })} placeholder="e.g. Self, Rajkamal Transport, By Sea" /></Field>
            <Field label="Freight Terms"><Input value={draft.freight_terms} onChange={(e) => set({ freight_terms: e.target.value })} placeholder="e.g. Ex-works, To pay" /></Field>
            {!!draft.is_export && (
              <>
                <Field label="INCO Terms">
                  <IncoTermsInput value={draft.inco_terms} onChange={(v) => set({ inco_terms: v })} />
                </Field>
                <Field label="Containers"><Input value={draft.container_count} onChange={(e) => set({ container_count: e.target.value })} placeholder="e.g. 2 X 40ft HQ" /></Field>
              </>
            )}
          </div>
        </Card>

        <Card
          title="Order Items"
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

        {/* The old Dispatch Progress card lived here. It has moved to the
            Dispatch tab, which says the same thing and more — sent as well as
            billed — and keeping a second copy invited the two to disagree. */}

        <Card title="Remarks & Notes" actions={<NotePresetPicker value={draft.notes} onChange={(v) => set({ notes: v })} />}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Remarks (internal)">
              <Textarea rows={3} value={draft.remarks} onChange={(e) => set({ remarks: e.target.value })} />
            </Field>
            <Field label="Notes (printed on the order confirmation)">
              <Textarea rows={3} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />
            </Field>
          </div>
        </Card>

        <ErrorText error={save.error ?? setStatus.error ?? remove.error} />

        <div className="flex items-center justify-between">
          <div>
            {!isNew && <Button variant="danger" onClick={() => { if (confirm('Delete this order?')) remove.mutate(); }}>Delete</Button>}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => navigate('/orders')}>Back</Button>
            <Button onClick={() => save.mutate(draft)} disabled={save.isPending || !draft.customer_id || draft.items.length === 0}>
              {save.isPending ? 'Saving…' : isNew ? 'Create Order' : 'Save Changes'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
