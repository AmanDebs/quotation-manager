import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ProformaOptions } from '../types';
import { Button, Select, ErrorText } from './ui';
import { fmtDate, fmtMoney } from '../lib/format';

/**
 * The proforma this sales order was raised from (2026-11-24, the client
 * looking at a Work Orders list where ten of twelve orders named a sales
 * order rather than a proforma: *"Let me link one by hand"*).
 *
 * The link lives on `proforma_invoices.order_id` and is written by
 * `POST /orders` and nowhere else, so it exists only where somebody pressed
 * **Book Sales Order** on the proforma. An order typed straight in — and the
 * whole imported backlog — has none, and this field used to say in its own
 * comment that there was nothing to edit here.
 *
 * **The options are fetched only when the picker is opened.** Which proformas
 * could be attached is a question nobody asks while reading an order, and
 * asking it on every order page would be a query per view for a control
 * almost nobody presses.
 */
export default function ProformaLink({ orderId, attached, mayEdit, onChanged }: {
  orderId: number;
  /** What `getFull` already carries — no extra request to draw the usual case. */
  attached: { id: number; number: string }[];
  mayEdit: boolean;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<number | ''>('');
  const [error, setError] = useState('');

  const options = useQuery({
    queryKey: ['order', String(orderId), 'proforma-options'],
    queryFn: () => api.get<ProformaOptions>(`/api/orders/${orderId}/proforma-options`),
    enabled: open,
  });

  const done = () => {
    setOpen(false);
    setPick('');
    setError('');
    // The advance, the dispatch walk and the Work Orders grid all read this
    // link, so it is a refetch of the order rather than a patch of one field.
    queryClient.invalidateQueries({ queryKey: ['order', String(orderId)] });
    queryClient.invalidateQueries({ queryKey: ['proformas'] });
    queryClient.invalidateQueries({ queryKey: ['work-orders'] });
    onChanged();
  };

  const attach = useMutation({
    mutationFn: (piId: number) => api.post(`/api/orders/${orderId}/proforma`, { pi_id: piId }),
    onSuccess: done,
    onError: (e: Error) => setError(e.message),
  });
  const detach = useMutation({
    mutationFn: (piId: number) => api.del(`/api/orders/${orderId}/proforma/${piId}`),
    onSuccess: done,
    onError: (e: Error) => setError(e.message),
  });

  const busy = attach.isPending || detach.isPending;

  return (
    <div className="space-y-1">
      <div className="flex min-h-[30px] flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-sm">
        {attached.length > 0 ? (
          <>
            <span className="min-w-0">
              {attached.map((pi, i) => (
                <span key={pi.id}>
                  {i > 0 && ', '}
                  <Link to={`/proformas/${pi.id}`} className="text-brand-600 hover:underline">{pi.number}</Link>
                </span>
              ))}
            </span>
            {mayEdit && (
              <button
                type="button"
                className="ml-auto rounded px-1 text-xs text-slate-400 hover:text-red-600 disabled:opacity-50"
                disabled={busy}
                title="Take this proforma off the order. It goes back to the status it held before the order was booked, and stops being frozen."
                onClick={() => detach.mutate(attached[0].id)}
              >
                Detach
              </button>
            )}
          </>
        ) : (
          <>
            {/* A dash rather than a blank: nothing is attached is an answer. */}
            <span className="text-slate-400">— not attached</span>
            {mayEdit && !open && (
              <button
                type="button"
                className="ml-auto rounded px-1 text-xs text-brand-600 hover:underline"
                onClick={() => setOpen(true)}
              >
                Attach a proforma
              </button>
            )}
          </>
        )}
      </div>

      {open && attached.length === 0 && (
        <div className="space-y-1 rounded-md border border-slate-200 bg-white p-2">
          {options.isLoading && <p className="text-xs text-slate-400">Looking…</p>}
          {options.data && options.data.options.length === 0 && (
            /* A picker that is simply empty reads as a fault; this says which
               question it asked, which is also what to go and fix. */
            <p className="text-xs text-slate-500">
              This customer has no proforma that is free to attach — every one of theirs is
              already on another sales order, or cancelled.
            </p>
          )}
          {options.data && options.data.options.length > 0 && (
            <>
              <Select
                value={pick === '' ? '' : String(pick)}
                onChange={(e) => setPick(e.target.value ? Number(e.target.value) : '')}
              >
                <option value="">— select a proforma —</option>
                {options.data.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.number} · {fmtDate(o.date)} · {fmtMoney(o.grand_total, o.currency)}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-slate-500">
                Attaching marks the proforma <em>Sales Order Generated</em> and freezes its contents,
                exactly as booking the order from it would — and its advance then shows on this order.
                It can be detached again.
              </p>
            </>
          )}
          <div className="flex gap-2 pt-1">
            {/* With nothing to attach there is nothing to press: an Attach
                button over an empty list is a control that can only ever be
                disabled, and the sentence above has already said why. */}
            {(options.data?.options.length ?? 0) > 0 && (
              <Button
                disabled={pick === '' || busy}
                onClick={() => attach.mutate(Number(pick))}
              >
                {attach.isPending ? 'Attaching…' : 'Attach'}
              </Button>
            )}
            <Button variant="ghost" onClick={() => { setOpen(false); setPick(''); setError(''); }}>
              {(options.data?.options.length ?? 0) > 0 ? 'Cancel' : 'Close'}
            </Button>
          </div>
        </div>
      )}
      {error && <ErrorText error={error} />}
    </div>
  );
}
