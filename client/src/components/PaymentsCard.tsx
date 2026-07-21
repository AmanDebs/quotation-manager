import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Payment } from '../types';
import { Button, Input, Select, Field, Card, ErrorText } from './ui';
import { fmtDate, fmtMoney, today } from '../lib/format';

const METHODS = ['Bank Transfer', 'Letter of Credit', 'Cheque', 'Cash', 'Other'];

/**
 * Record payments against a proforma (advance) or a commercial invoice (balance).
 * The linked document's detail query is invalidated so received/balance figures refresh.
 */
export default function PaymentsCard({
  docType, docId, currency, payments, received, total, balanceDue,
}: {
  docType: 'proforma' | 'invoice';
  docId: number;
  currency: string;
  payments: Payment[];
  received: number;
  total: number;
  balanceDue?: number;
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
  };

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/payments', {
        [docType === 'proforma' ? 'pi_id' : 'invoice_id']: docId,
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
    <Card
      title={docType === 'proforma' ? 'Payments Received (advance)' : 'Payments Received'}
      actions={!adding && <Button variant="secondary" onClick={() => setAdding(true)}>+ Record Payment</Button>}
    >
      {payments.length === 0 && !adding && (
        <p className="text-sm text-slate-400">
          No payments recorded yet.
          {docType === 'proforma' ? ' Record the advance here when it arrives.' : ''}
        </p>
      )}

      {payments.length > 0 && (
        <table className="mb-2 w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
              <th className="pb-1 pr-3">Date</th>
              <th className="pb-1 pr-3">Method</th>
              <th className="pb-1 pr-3">Reference</th>
              <th className="pb-1 pr-3">Source</th>
              <th className="pb-1 pr-3 text-right">Amount</th>
              <th className="pb-1 w-8" />
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id} className="border-b border-slate-100 last:border-0">
                <td className="py-1.5 pr-3 whitespace-nowrap">{fmtDate(p.date)}</td>
                <td className="py-1.5 pr-3">{p.method || '—'}</td>
                <td className="py-1.5 pr-3">{p.reference || '—'}</td>
                <td className="py-1.5 pr-3 text-xs text-slate-500">{p.pi_id ? 'Advance (PI)' : 'Invoice'}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{fmtMoney(p.amount, p.currency)}</td>
                <td className="py-1.5 text-right">
                  <button
                    className="text-slate-300 hover:text-red-500"
                    title="Delete payment"
                    onClick={() => { if (confirm('Delete this payment record?')) remove.mutate(p.id); }}
                  >✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {adding && (
        <div className="mb-2 rounded-md border border-slate-200 bg-slate-50 p-3">
          <div className="grid grid-cols-4 gap-3">
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

      <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-slate-100 pt-2 text-sm">
        <span>Document Total: <span className="font-semibold tabular-nums">{fmtMoney(total, currency)}</span></span>
        <span>Received: <span className="font-semibold tabular-nums text-green-700">{fmtMoney(received, currency)}</span></span>
        <span>Balance: <span className={`font-semibold tabular-nums ${outstanding > 0 ? 'text-red-600' : 'text-green-700'}`}>{fmtMoney(outstanding, currency)}</span></span>
      </div>
    </Card>
  );
}
