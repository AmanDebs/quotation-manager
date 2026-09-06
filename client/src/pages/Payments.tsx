import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { PaymentRow, PaymentRegisterSummary, Customer } from '../types';
import { PageHeader, Card, Select, Input, EmptyState, Pagination, DownloadButton, TH_CLASS, CAPTION_CLASS } from '../components/ui';
import { fmtDate, fmtMoney } from '../lib/format';
import { useUrlFilter } from '../lib/useUrlFilter';
import { usePagedList, PAGE_SIZE } from '../lib/usePagedList';

/**
 * Money in, as a register.
 *
 * Payments could only ever be seen on the one document they were banked
 * against, so "what came in this week" and "which of these is credited to
 * nothing" had no answer outside the dashboard's Cash Collected bar.
 *
 * Two things it deliberately is not. It is **not an allocation report** —
 * where an advance ends up is `services/receivables.ts`'s question, answered
 * on the invoice and on the customer's page; this says what arrived, from
 * whom, and against which document. And it does **not filter on screen**: the
 * list is paged, so a filter applied here would only ever filter the page in
 * hand.
 */

/** The figures over the table. One per currency, because money is never summed across them. */
function Totals({ summary }: { summary: PaymentRegisterSummary }) {
  return (
    <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
      <span className="text-slate-500">
        {summary.payments} payment{summary.payments === 1 ? '' : 's'}
      </span>
      {summary.by_currency.map((c) => (
        <span key={c.currency} className="tabular-nums font-medium text-slate-900">
          {fmtMoney(c.amount, c.currency)}
        </span>
      ))}
      {summary.mismatched > 0 && (
        <span className="text-amber-700">{summary.mismatched} credited to nothing</span>
      )}
    </div>
  );
}

export default function PaymentsPage() {
  const [from, setFrom] = useUrlFilter('from');
  const [to, setTo] = useUrlFilter('to');
  const [customer, setCustomer] = useUrlFilter('customer_id');
  const [against, setAgainst] = useUrlFilter('against');
  const [method, setMethod] = useUrlFilter('method');
  const [mismatched, setMismatched] = useUrlFilter('mismatched');
  const [q, setQ] = useUrlFilter('q');

  const query = new URLSearchParams();
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  if (customer) query.set('customer_id', customer);
  if (against) query.set('against', against);
  if (method) query.set('method', method);
  if (mismatched) query.set('mismatched', mismatched);
  if (q) query.set('q', q);

  const list = usePagedList<PaymentRow, PaymentRegisterSummary>(
    ['payments', query.toString()],
    `/api/payments?${query.toString()}`,
  );
  const rows = list.rows;

  const { data: customers = [] } = useQuery({
    queryKey: ['customers', ''], queryFn: () => api.get<Customer[]>('/api/customers'),
  });
  // Whatever has actually been used, so the filter cannot offer a method that
  // would return nothing.
  const { data: methods = [] } = useQuery({
    queryKey: ['payment-methods'], queryFn: () => api.get<string[]>('/api/payments/methods'),
  });

  const filtered = !!(from || to || customer || against || method || mismatched || q);

  return (
    <div>
      <PageHeader
        title="Payments"
        subtitle="Every payment banked, and what it was banked against"
        // The same query the table is reading, so the download and the screen
        // cannot disagree; the server ignores `page`/`limit` and sends the lot.
        actions={<DownloadButton href={`/api/payments/export${query.toString() ? `?${query}` : ''}`} />}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-sm text-slate-400">to</span>
        <Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} />
        <Select className="w-52" value={customer} onChange={(e) => setCustomer(e.target.value)}>
          <option value="">All customers</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        {/* An advance is banked against a proforma and a settlement against an
            invoice: different things to look at, so they can be asked for
            separately. */}
        <Select className="w-44" value={against} onChange={(e) => setAgainst(e.target.value)}>
          <option value="">Advances and settlements</option>
          <option value="proforma">Advances only</option>
          <option value="invoice">Against invoices</option>
        </Select>
        {methods.length > 0 && (
          <Select className="w-40" value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="">Any method</option>
            {methods.map((m) => <option key={m} value={m}>{m}</option>)}
          </Select>
        )}
        <Input
          className="w-56"
          placeholder="Search reference, customer or document…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={mismatched === '1'}
            onChange={(e) => setMismatched(e.target.checked ? '1' : '')}
          />
          Credited to nothing
        </label>
        {list.summary && <Totals summary={list.summary} />}
      </div>

      <Card className="overflow-x-auto">
        {rows.length === 0 ? (
          <EmptyState message={filtered
            ? 'Nothing matches those filters.'
            : 'No payments recorded yet. They are entered on a proforma or an invoice.'} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className={TH_CLASS}>
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2 pr-3">Customer</th>
                <th className="pb-2 pr-3">Against</th>
                <th className="pb-2 pr-3">Method / reference</th>
                <th className="pb-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="py-2 pr-3 text-slate-500">{fmtDate(p.date)}</td>
                  <td className="py-2 pr-3">
                    {p.customer_id
                      ? <Link to={`/customers/${p.customer_id}`} className="text-brand-600 hover:underline">{p.customer_name}</Link>
                      : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="py-2 pr-3">
                    {p.against_number ? (
                      <Link
                        to={p.against_type === 'invoice' ? `/invoices/${p.invoice_id}` : `/proformas/${p.pi_id}`}
                        className="text-brand-600 hover:underline"
                      >
                        {p.against_number}
                      </Link>
                    ) : <span className="text-slate-400">—</span>}
                    <span className={`ml-1 ${CAPTION_CLASS} text-slate-400`}>
                      {p.against_type === 'proforma' ? 'advance' : ''}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-slate-500">
                    {[p.method, p.reference].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {fmtMoney(p.amount, p.currency)}
                    {/* The whole reason this page has a filter for it: money in
                        a currency its document is not billed in is allocated to
                        nothing, and used to be visible one document at a time. */}
                    {p.mismatched === 1 && (
                      <span
                        className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700 ring-1 ring-amber-200"
                        title={`This document is billed in ${p.doc_currency}, so the payment is credited to nothing.`}
                      >
                        not {p.doc_currency}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination
          page={list.page} pages={list.pages} total={list.total} limit={PAGE_SIZE}
          onPage={list.setPage} noun="payments"
        />
      </Card>
    </div>
  );
}
