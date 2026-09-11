import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useCan, useUser } from '../App';
import type { CreditNote, CreditKind, LineItem, ColumnConfig, TaxType, ReturnableBatch, Location } from '../types';
import { Button, Input, Textarea, Select, Field, PageHeader, ErrorText, Card, SettledDocumentType, FIELD_GRID, TH_CLASS } from '../components/ui';
import { PdfLink } from '../components/PdfLink';
import { DocNumber } from '../components/DocFields';
import LineItemsEditor from '../components/LineItemsEditor';
import ApprovalStrip from '../components/ApprovalStrip';
import ColumnsControl, { newColumnConfig, invoiceColumns, INVOICE_OMIT, INVOICE_FORCED } from '../components/ColumnsControl';
import { fmtDate, fmtMoney, fmtQty, today } from '../lib/format';
import { useDefaultOnce } from '../lib/useDefaultOnce';
import { useUnsavedChanges } from '../lib/useUnsavedChanges';
import HistoryCard from '../components/HistoryCard';

/**
 * The credit note: the invoice being partly taken back.
 *
 * Everything that identifies the document — customer, currency, tax type,
 * export flag, company — comes from the invoice it credits and is stated here
 * rather than asked, because the server copies it from that invoice on every
 * save and ignores anything sent. What the form actually asks is narrow: why,
 * which lines, how much of each, and whether the goods came back.
 */

interface Draft {
  number?: string;
  invoice_id: number | null;
  date: string;
  kind: CreditKind;
  reason: string;
  notes: string;
  prepared_by: string;
  /* Read-only, from the invoice. Held on the draft so the editor and the
   * badge can read them; the server overwrites them with the invoice's own. */
  currency: string;
  tax_type: TaxType;
  is_export: number;
  column_config: ColumnConfig;
  items: LineItem[];
  /** Which lots came back. Sent whole; `[]` clears. */
  batch_ids: number[];
  /** Where the goods arrived — the finished-goods ledger's plant for a return. */
  location_id: number | null;
}

const emptyDraft = (): Draft => ({
  invoice_id: null, date: today(), kind: 'return', reason: '', notes: '', prepared_by: '',
  currency: 'INR', tax_type: 'igst', is_export: 0, column_config: newColumnConfig(), items: [], batch_ids: [], location_id: null,
});

const KIND_LABEL: Record<CreditKind, string> = { return: 'Goods returned', adjustment: 'Adjustment (money only)' };

export default function CreditNoteFormPage() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const can = useCan();
  const user = useUser();
  const isNew = !id;
  const fromInvoice = search.get('from_invoice');

  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });
  const { data: existing, error: loadError } = useQuery({
    queryKey: ['credit-note', id],
    queryFn: () => api.get<CreditNote>(`/api/credit-notes/${id}`),
    enabled: !isNew,
  });

  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [prefilled, setPrefilled] = useState(false);
  // The invoice's lines on a *new* note, with what is still open on each —
  // a saved one carries them as `invoice_lines`.
  const [lines, setLines] = useState<CreditNote['invoice_lines']>();
  const [invoiceNumber, setInvoiceNumber] = useState('');
  // The lots that could have come back, on a new note; a saved one carries its own.
  const [orderBatches, setOrderBatches] = useState<ReturnableBatch[] | undefined>();

  useEffect(() => {
    if (existing) {
      setDraft({
        number: existing.number, invoice_id: existing.invoice_id, date: existing.date, kind: existing.kind,
        reason: existing.reason, notes: existing.notes, prepared_by: existing.prepared_by,
        currency: existing.currency, tax_type: existing.tax_type, is_export: existing.is_export,
        column_config: existing.column_config ?? {}, items: existing.items ?? [],
        batch_ids: (existing.batches ?? []).map((b) => b.id),
        location_id: existing.location_id ?? null,
      });
    }
  }, [existing]);

  /*
   * The one way in. A credit note is raised from an invoice, and the prefill
   * brings that invoice's lines across at **what is still open to credit**
   * rather than at what was billed — a second partial return is ordinary, and
   * prefilling the whole line would offer a figure the save then refuses.
   */
  useEffect(() => {
    if (!isNew || !fromInvoice || prefilled) return;
    api.get<Partial<Draft> & {
      items: LineItem[]; invoice_number: string; invoice_lines: CreditNote['invoice_lines']; order_batches?: ReturnableBatch[];
    }>(`/api/credit-notes/prefill/from-invoice/${fromInvoice}`).then((p) => {
      const { invoice_number, invoice_lines, order_batches, ...rest } = p;
      setDraft((d) => ({ ...d, ...rest, invoice_id: Number(fromInvoice), items: p.items ?? [] }));
      setInvoiceNumber(invoice_number);
      setLines(invoice_lines);
      setOrderBatches(order_batches);
      setPrefilled(true);
    });
  }, [isNew, fromInvoice, prefilled]);

  const { markSaved, pdf, prompt } = useUnsavedChanges(draft, {
    run: () => save.mutateAsync(draft),
    can: !!draft.invoice_id && draft.items.length > 0,
  });

  const save = useMutation({
    mutationFn: (d: Draft) => (isNew ? api.post<CreditNote>('/api/credit-notes', d) : api.put<CreditNote>(`/api/credit-notes/${id}`, d)),
    onSuccess: (n) => {
      markSaved();
      queryClient.invalidateQueries({ queryKey: ['credit-notes'] });
      queryClient.invalidateQueries({ queryKey: ['credit-note', String(n.id)] });
      // The invoice's balance and the order behind it both moved.
      queryClient.invalidateQueries({ queryKey: ['invoice', String(n.invoice_id)] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      if (isNew) navigate(`/credit-notes/${n.id}`, { replace: true });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/api/credit-notes/${id}`),
    onSuccess: () => {
      markSaved();
      queryClient.invalidateQueries({ queryKey: ['credit-notes'] });
      queryClient.invalidateQueries({ queryKey: ['invoice', String(existing?.invoice_id)] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      navigate('/credit-notes');
    },
  });

  useDefaultOnce(isNew, user?.name ?? '', draft.prepared_by, (prepared_by) =>
    setDraft((d) => ({ ...d, prepared_by })));

  if (loadError) return <ErrorText error={loadError} />;
  if (!isNew && !existing) return <div className="text-slate-400">Loading…</div>;
  if (isNew && !fromInvoice) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="New Credit Note" />
        <Card>
          <p className="text-sm text-slate-600">
            A credit note is raised against a commercial invoice — open the invoice and use <b>↩ Credit Note</b> there.
          </p>
          <div className="mt-3"><Link to="/invoices"><Button variant="secondary">Commercial Invoices</Button></Link></div>
        </Card>
      </div>
    );
  }

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const canEdit = can('invoice', 'full');
  const openLines = existing?.invoice_lines ?? lines;
  const invoiceRef = existing?.invoice_number ?? invoiceNumber;
  const lots = existing?.order_batches ?? orderBatches ?? [];

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={isNew ? 'New Credit Note' : existing!.number}
        subtitle={isNew
          ? `Against invoice ${invoiceRef} — cut the lines down to what is being credited`
          : `${existing!.customer_name} · against invoice ${existing!.invoice_number}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {!isNew && (
              <>
                <PdfLink href={`/api/pdf/credit-note/${id}`} guard={pdf}><Button variant="secondary">📄 Credit Note</Button></PdfLink>
                <Link to={`/invoices/${existing!.invoice_id}`}><Button variant="secondary">Open invoice</Button></Link>
              </>
            )}
          </div>
        }
      />

      {!isNew && (
        <ApprovalStrip
          docType="credit-notes"
          docId={Number(id)}
          status={existing!.approval_status}
          approvedByName={existing!.approved_by_name}
          approvedAt={existing!.approved_at}
          note={existing!.approval_note}
          checks={existing!.checks}
          queryKey="credit-note"
        />
      )}

      {/*
        * Why approval matters more here than on any other document: until
        * this is approved it credits nothing — the invoice goes on showing
        * the full balance and the order goes on counting the goods as sent.
        */}
      {!isNew && existing!.approval_status !== 'approved' && (
        <div className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
          Not yet approved, so it credits nothing: invoice {existing!.invoice_number} still shows its full balance
          {existing!.kind === 'return' ? ' and the order still counts these goods as dispatched' : ''}. Submit it for approval when it is right.
        </div>
      )}

      <div className="space-y-4">
        <Card title="Details">
          <div className={FIELD_GRID}>
            {!isNew && <Field label="Credit Note Number"><DocNumber value={draft.number} title="Numbered from the invoice's own series" /></Field>}
            <Field label="Against Invoice">
              <DocNumber value={invoiceRef} title="Fixed once the credit note is numbered" />
            </Field>
            <Field label="Date"><Input type="date" value={draft.date} onChange={(e) => set({ date: e.target.value })} /></Field>
            <Field label="Nature">
              <Select value={draft.kind} onChange={(e) => set({ kind: e.target.value as CreditKind })}>
                {(Object.keys(KIND_LABEL) as CreditKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </Select>
            </Field>
            <Field label="Type"><SettledDocumentType isExport={!!draft.is_export} number={draft.number} /></Field>
            <Field label="Currency"><DocNumber value={draft.currency} title="The invoice's currency" /></Field>
            <Field label="Prepared By"><Input value={draft.prepared_by} onChange={(e) => set({ prepared_by: e.target.value })} /></Field>
            {/* Where the goods came back to, so the finished-goods ledger can
                place them. Only a return has a plant; an adjustment moves nothing. */}
            {draft.kind === 'return' && (
              <Field label="Returned to plant">
                <Select value={draft.location_id ?? ''} onChange={(e) => set({ location_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">Plant not recorded</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </Select>
              </Field>
            )}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {draft.kind === 'return'
              ? 'Goods returned: the quantities come off what the sales order line counts as dispatched, so a line credited in full is open again.'
              : 'Adjustment: money only — a rate settled down, a short shipment, a discount. Nothing physical moved, so the sales order is untouched.'}
          </p>
          <Field label="Reason for credit" className="mt-3">
            <Textarea rows={2} value={draft.reason} onChange={(e) => set({ reason: e.target.value })} placeholder="e.g. 20 boxes damaged in transit, rejected at goods inward" />
          </Field>
        </Card>

        <Card
          title="Lines credited"
          actions={<ColumnsControl config={draft.column_config} onChange={(column_config) => set({ column_config })} columns={invoiceColumns()} />}
        >
          <LineItemsEditor
            items={draft.items}
            onChange={(items) => set({ items })}
            currency={draft.currency}
            taxType={draft.tax_type}
            showTax={draft.tax_type !== 'none'}
            config={draft.column_config}
            omit={INVOICE_OMIT}
            forced={INVOICE_FORCED}
          />
          {/*
            * What the invoice billed on each line and how much is still open,
            * so the figure above can be checked against it. The server refuses
            * the same limits; this explains them rather than copying them.
            */}
          {openLines && openLines.length > 0 && draft.kind === 'return' && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={TH_CLASS}>
                    <th className="pb-1 pr-3">#</th>
                    <th className="pb-1 pr-3">Invoice line</th>
                    <th className="pb-1 pr-3 text-right">Billed</th>
                    <th className="pb-1 pr-3 text-right">Already credited</th>
                    <th className="pb-1 pr-3 text-right">Still open</th>
                  </tr>
                </thead>
                <tbody>
                  {openLines.map((l, i) => (
                    <tr key={i} className="border-b border-slate-100 last:border-0 text-slate-600">
                      <td className="py-1 pr-3">{i + 1}</td>
                      <td className="py-1 pr-3">{l.description}{l.is_charge ? <span className="ml-1 text-xs text-slate-400">(charge)</span> : ''}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{l.is_charge || l.qty == null ? '—' : `${fmtQty(l.qty)} ${l.unit}`}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{l.is_charge ? '—' : fmtQty(l.already_credited)}</td>
                      <td className="py-1 pr-3 text-right tabular-nums font-medium">
                        {l.is_charge || l.qty == null ? '—' : fmtQty(Math.max(0, l.qty - l.already_credited))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/*
          * Which identified lots came back — `despatch_batches` read the
          * other way, and the fact that lets the floor scrap a lot that has
          * been to the customer. Absent unless the order has lots and this
          * is a return: an adjustment moves no goods, and the server refuses
          * a lot named on one. A lot named on this note stays ticked here
          * whether or not it can be re-offered.
          */}
        {draft.kind === 'return' && lots.length > 0 && (
          <Card title="Lots returned">
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {lots.map((b) => {
                const on = draft.batch_ids.includes(b.id);
                return (
                  <label
                    key={b.id}
                    className={`flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-sm ring-1 hover:bg-slate-50 ${
                      on ? 'bg-brand-50 ring-brand-200' : 'ring-slate-200'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={on}
                      onChange={(e) => set({
                        batch_ids: e.target.checked ? [...draft.batch_ids, b.id] : draft.batch_ids.filter((x) => x !== b.id),
                      })}
                    />
                    <span className="min-w-0">
                      <span className="font-medium">{b.number}</span>
                      <span className="ml-1 text-slate-500">{b.product_name || `Line ${b.order_line + 1}`}</span>
                      <span className="block text-xs text-slate-500">
                        {b.trips.length
                          ? `Dispatched on ${b.trips.map((t) => t.reference || fmtDate(t.date)).join(', ')}`
                          : 'Not named on any dispatch'}
                        {b.coa_no ? ` · ${b.coa_no}` : ''}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Once this credit note is approved, a lot named here can be scrapped or reworked on its job.
            </p>
          </Card>
        )}

        <Card title="Notes">
          <Textarea rows={2} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Printed on the credit note, e.g. Replacement to follow on the next consignment." />
        </Card>

        {!isNew && (
          <div className="text-sm text-slate-500">
            Credit: <span className="font-semibold tabular-nums text-slate-800">{fmtMoney(existing!.grand_total, existing!.currency)}</span>
            {' '}against invoice {existing!.invoice_number} of{' '}
            <span className="tabular-nums">{fmtMoney(existing!.invoice_total ?? 0, existing!.currency)}</span>
            {existing!.invoice_date ? ` dated ${fmtDate(existing!.invoice_date)}` : ''}.
          </div>
        )}

        <ErrorText error={save.error ?? remove.error} />

        <div className="flex items-center justify-between">
          <div>
            {!isNew && canEdit && (
              <Button variant="danger" onClick={() => { if (confirm('Delete this credit note?')) remove.mutate(); }}>Delete</Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => navigate('/credit-notes')}>Back</Button>
            {canEdit && (
              <Button onClick={() => save.mutate(draft)} disabled={save.isPending || !draft.invoice_id || draft.items.length === 0}>
                {save.isPending ? 'Saving…' : isNew ? 'Create Credit Note' : 'Save Changes'}
              </Button>
            )}
          </div>
        </div>

        <HistoryCard entity="credit-notes" id={id ? Number(id) : undefined} />
        {prompt}
      </div>
    </div>
  );
}
