import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Payment } from '../types';
import { Button, Input, Select, Field, Card, ErrorText, ReadOnlyFields, TH_CLASS } from './ui';
import { fmtDate, fmtMoney, today } from '../lib/format';

const METHODS = ['Bank Transfer', 'Letter of Credit', 'Cheque', 'Cash', 'Other'];

/**
 * Record payments against a proforma (advance), a sales order (an advance where
 * there is no proforma) or a commercial invoice (balance). The linked
 * document's detail query is invalidated so received/balance figures refresh.
 *
 * The sales order is the third caller rather than a second card, because two
 * copies of a money form is how the two come to ask different things. It banks
 * against the **proforma** wherever the order has one — the order page passes
 * `docType="proforma"` with that id and names itself in `alsoInvalidate` — so
 * the proforma's own document goes on stating the advance it took in.
 */
export default function PaymentsCard({
  docType, docId, currency, payments, received, total, balanceDue, advanceApplied, credited, currencyMismatch,
  title, emptyHint, alsoInvalidate,
}: {
  docType: 'proforma' | 'invoice' | 'order';
  docId: number;
  currency: string;
  payments: Payment[];
  received: number;
  total: number;
  balanceDue?: number;
  /**
   * How much of `received` came from the advance on the source proforma rather
   * than from a payment on this document. Invoice only — on a proforma every
   * payment *is* the advance, so the split would say nothing.
   */
  advanceApplied?: number;
  /**
   * What approved credit notes have taken off the bill. Shown as its own
   * figure, never folded into Received: a credit is not money that arrived.
   */
  credited?: number;
  /** Money against this document in another currency, credited to nothing. */
  currencyMismatch?: { currency: string; amount: number }[];
  /** Overrides the card's heading, where the caller's own word for it is better. */
  title?: string;
  /** A sentence under the empty state, for a card whose money goes elsewhere. */
  emptyHint?: string;
  /**
   * Further query keys to refresh. The order page records into its proforma's
   * pool, so the page holding the figure is not the document being posted to.
   */
  alsoInvalidate?: readonly (readonly unknown[])[];
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState(METHODS[0]);
  const [reference, setReference] = useState('');

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: [docType, String(docId)] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    queryClient.invalidateQueries({ queryKey: ['payments'] });
    for (const key of alsoInvalidate ?? []) queryClient.invalidateQueries({ queryKey: key as unknown[] });
  };

  const LINK = { proforma: 'pi_id', invoice: 'invoice_id', order: 'order_id' } as const;

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/payments', {
        [LINK[docType]]: docId,
        date, amount: Number(amount), method, reference,
      }),
    onSuccess: () => {
      invalidate();
      setAdding(false);
      setAmount('');
      setReference('');
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/payments/${id}`),
    onSuccess: invalidate,
  });

  const outstanding = balanceDue ?? Math.max(0, Math.round((total - received) * 100) / 100);

  return (
    // Money keeps arriving after the document is frozen — an advance is banked
    // against a proforma *after* its order is booked, which is the whole point
    // of an advance. This card is on the list lockError() deliberately leaves
    // alone, so its fields stay fields.
    <ReadOnlyFields on={false}>
    <Card
      title={title ?? (docType === 'invoice' ? 'Payments Received' : 'Payments Received (advance)')}
      actions={!adding && (
        <Button variant="secondary" onClick={() => setAdding(true)}>
          {docType === 'invoice' ? '+ Record Payment' : '+ Record Advance'}
        </Button>
      )}
    >
      {payments.length === 0 && !adding && (
        <p className="text-sm text-slate-400">
          No payments recorded yet.
          {docType !== 'invoice' ? ' Record the advance here when it arrives.' : ''}
          {emptyHint ? ` ${emptyHint}` : ''}
        </p>
      )}

      {payments.length > 0 && (
        <table className="mb-2 w-full text-sm">
          <thead>
            <tr className={TH_CLASS}>
              <th className="pb-1 pr-3">Date</th>
              <th className="pb-1 pr-3">Method</th>
              <th className="pb-1 pr-3">Reference</th>
              <th className="pb-1 pr-3">Source</th>
              <th className="pb-1 pr-3 text-right">Amount</th>
              <th className="pb-1 w-8" />
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => {
              // On an invoice, an advance recorded on the proforma may be split
              // across several shipments — show the slice credited here, and
              // send the user to the proforma to change the payment itself.
              const isSharedAdvance = docType === 'invoice' && !p.invoice_id && !!p.pi_id;
              const applied = p.applied_amount ?? p.amount;
              const partly = isSharedAdvance && applied !== p.amount;
              return (
                <tr key={p.id} className="border-b border-slate-100 last:border-0">
                  <td className="py-1.5 pr-3 whitespace-nowrap">{fmtDate(p.date)}</td>
                  <td className="py-1.5 pr-3">{p.method || '—'}</td>
                  <td className="py-1.5 pr-3">{p.reference || '—'}</td>
                  <td className="py-1.5 pr-3 text-xs text-slate-500">
                    {p.pi_id ? 'Advance (PI)' : p.order_id ? 'Advance (SO)' : 'Invoice'}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {fmtMoney(applied, p.currency)}
                    {partly && (
                      <div className="text-xs font-normal text-slate-400">
                        of {fmtMoney(p.amount, p.currency)} advance
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 text-right">
                    {isSharedAdvance ? (
                      <span className="text-slate-300" title="Recorded on the proforma invoice — edit it there">–</span>
                    ) : (
                      <button
                        className="text-slate-300 hover:text-red-500"
                        title="Delete payment"
                        onClick={() => { if (confirm('Delete this payment record?')) remove.mutate(p.id); }}
                      >✕</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {adding && (
        <div className="mb-2 rounded-md border border-slate-200 bg-slate-50 p-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label={`Amount (${currency})`}>
              <Input type="number" min={0} step="any" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
            </Field>
            <Field label="Method">
              <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                {METHODS.map((m) => <option key={m}>{m}</option>)}
              </Select>
            </Field>
            <Field label="Reference (UTR / cheque no.)">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
          </div>
          <ErrorText error={create.error} />
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending || !Number(amount)}>Save Payment</Button>
          </div>
        </div>
      )}

      {/* Money in another currency cannot be added to this document's total, and
          converting it would invent a rate. Shown so it can be corrected rather
          than quietly ignored — normally the document's currency was changed
          after the payment was recorded. */}
      {!!currencyMismatch?.length && (
        <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="font-semibold">Not counted: payment in another currency</div>
          <p className="mt-0.5 text-amber-800">
            {currencyMismatch.map((m) => `${fmtMoney(m.amount, m.currency)}`).join(', ')}
            {' '}is recorded against this document, which is billed in {currency}. It is not
            included in Received. Correct the document's currency, or re-record the payment.
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-slate-100 pt-2 text-sm">
        <span>Document Total: <span className="font-semibold tabular-nums">{fmtMoney(total, currency)}</span></span>
        <span>Received: <span className="font-semibold tabular-nums text-green-700">{fmtMoney(received, currency)}</span></span>
        {/* The advance is credited to this invoice by `receivables.ts` and is
            named here for the same reason the PDF names it: a total that
            silently includes money banked against another document reads as a
            payment nobody can find. */}
        {!!advanceApplied && advanceApplied > 0 && (
          <span className="text-slate-500">
            of which advance: <span className="font-semibold tabular-nums">{fmtMoney(advanceApplied, currency)}</span>
          </span>
        )}
        {!!credited && credited > 0 && (
          <span>Credited: <span className="font-semibold tabular-nums text-amber-700">−{fmtMoney(credited, currency)}</span></span>
        )}
        <span>Balance: <span className={`font-semibold tabular-nums ${outstanding > 0 ? 'text-red-600' : 'text-green-700'}`}>{fmtMoney(outstanding, currency)}</span></span>
      </div>
    </Card>
    </ReadOnlyFields>
  );
}
