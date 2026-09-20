import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Order, Despatch, Location, Transporter } from '../types';
import { Button, PageHeader, EmptyState, ErrorText } from '../components/ui';
import { DespatchFields, newTrip, editTrip } from '../components/DespatchFields';
import { useUnsavedChanges } from '../lib/useUnsavedChanges';

/**
 * Recording a dispatch, as a page (2026-09-15, at the client's word: *"i want
 * whole new page to record dispatch not a pop up"*).
 *
 * `/despatches/new?order=N` for a new trip on that order, `/despatches/:id/edit`
 * for a saved one. The order is fetched in full — lines, invoices and the lots
 * the picker offers — because neither a register row nor a query string can
 * fill the form. A new trip prefills every line at what is still unsent; an
 * edit merges the saved rows in by position (`newTrip` / `editTrip`, unchanged
 * from the dialog). Being a page it joins the unsaved-changes contract the
 * document forms follow, so leaving mid-edit asks first.
 *
 * Saving returns to the Dispatches register, where the trip now sits.
 */
export default function DespatchFormPage() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: despatch, isPending: loadingDespatch } = useQuery({
    queryKey: ['despatch', String(id)],
    queryFn: () => api.get<Despatch>(`/api/despatches/${id}`),
    enabled: !!id,
  });
  const orderId = id ? despatch?.order_id : Number(search.get('order')) || undefined;

  const { data: order } = useQuery({
    queryKey: ['order', String(orderId)],
    queryFn: () => api.get<Order>(`/api/orders/${orderId}`),
    enabled: !!orderId,
  });
  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });
  const { data: transporters = [] } = useQuery({ queryKey: ['master', 'transporters', false], queryFn: () => api.get<Transporter[]>('/api/transporters') });

  const [draft, setDraft] = useState<Partial<Despatch> | null>(null);
  // Built once the order (and, on an edit, the trip) has arrived.
  if (order && draft === null && (!id || despatch)) {
    setDraft(despatch ? editTrip(order, despatch) : newTrip(order, locations, transporters));
  }

  const save = useMutation({
    mutationFn: (d: Partial<Despatch>) =>
      d.id ? api.put<Despatch>(`/api/despatches/${d.id}`, d) : api.post<Despatch>('/api/despatches', d),
    onSuccess: () => {
      markSaved();
      queryClient.invalidateQueries({ queryKey: ['despatches'] });
      queryClient.invalidateQueries({ queryKey: ['despatch', String(id)] });
      queryClient.invalidateQueries({ queryKey: ['order', String(orderId)] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['order-lines'] });
      queryClient.invalidateQueries({ queryKey: ['order-demand'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      navigate('/despatches');
    },
  });
  const canSave = !!draft && !!draft.date && (draft.items ?? []).some((r) => r.qty != null || r.packs != null);
  const { markSaved, prompt } = useUnsavedChanges(draft, {
    run: () => save.mutateAsync(draft!),
    can: canSave,
  });

  if (!id && !orderId) {
    return (
      <div>
        <PageHeader title="Record a dispatch" />
        <EmptyState message="A dispatch is recorded against a sales order — start from the Dispatches page or a sales order's Record dispatch button." />
        <div className="mt-3"><Link to="/despatches" className="text-brand-600 hover:underline">← Dispatches</Link></div>
      </div>
    );
  }
  if (id && !loadingDespatch && !despatch) {
    return (
      <div>
        <PageHeader title="Edit dispatch" />
        <EmptyState message="That dispatch could not be found." />
        <div className="mt-3"><Link to="/despatches" className="text-brand-600 hover:underline">← Dispatches</Link></div>
      </div>
    );
  }
  if (!order || !draft) {
    return <div className="py-8 text-center text-sm text-slate-400">Loading…</div>;
  }

  /*
   * What this trip itself already has on file, per line, to be excluded from
   * "already sent": `items[i].despatched.qty` sums every despatch on the
   * order including this one, and the server has never counted a trip against
   * itself (`despatchLimitError` takes an `exceptDespatchId`). Read from the
   * saved record, not from the draft being typed into.
   */
  const ownSent = new Map<number, { qty: number; packs: number }>();
  for (const it of despatch?.items ?? []) {
    const prev = ownSent.get(it.order_line) ?? { qty: 0, packs: 0 };
    ownSent.set(it.order_line, { qty: prev.qty + (it.qty ?? 0), packs: prev.packs + (it.packs ?? 0) });
  }

  const buttons = (
    <>
      <Button variant="secondary" onClick={() => navigate(-1)}>Cancel</Button>
      <Button onClick={() => save.mutate(draft)} disabled={save.isPending || !canSave}>
        {save.isPending ? 'Saving…' : 'Save dispatch'}
      </Button>
    </>
  );

  return (
    <div>
      <PageHeader
        title={despatch ? `Edit dispatch${despatch.challan_no ? ` ${despatch.challan_no}` : ''}` : 'Record a dispatch'}
        subtitle={<>
          Sales order <Link to={`/orders/${order.id}`} className="text-brand-600 hover:underline">{order.number}</Link>
          {order.customer_name ? ` · ${order.customer_name}` : ''}
        </>}
        actions={buttons}
      />
      <DespatchFields
        draft={draft}
        items={order.items ?? []}
        orderDate={order.date}
        ownSent={ownSent}
        locations={locations}
        transporters={transporters}
        invoices={order.invoices ?? []}
        isExport={!!order.is_export}
        orderBatches={order.batches ?? []}
        onChange={setDraft}
      />
      <ErrorText error={save.error} />
      <div className="mt-4 flex justify-end gap-2">{buttons}</div>
      {prompt}
    </div>
  );
}
