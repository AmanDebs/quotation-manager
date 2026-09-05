import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Customer, CustomerSummary, CustomerDocRow } from '../types';
import { useCan } from '../App';
import {
  Button, Card, PageHeader, EmptyState, StatusBadge, CAPTION_CLASS, TH_CLASS,
} from '../components/ui';
import CustomerDialog from '../components/CustomerDialog';
import { fmtMoney, fmtDate } from '../lib/format';

/**
 * One customer, on one screen.
 *
 * Every document in this app hangs off `customer_id` and there was no way to
 * ask the obvious question about one — what have we quoted them, what have
 * they ordered, what do they owe — without opening five lists and filtering
 * each by hand.
 *
 * **What is shown is decided by the server**, not here. `customerSummary`
 * assembles only the sections the caller's team may read, so a missing key
 * means "not yours to see" and this file simply renders what it was handed.
 * The alternative — asking `useCan()` for each section — would be a second
 * copy of the access table living on the client, and a copy is a policy that
 * drifts.
 */

/** A figure over its caption, the dashboard's money tile without the delta. */
function Stat({ label, value, tone = '' }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div>
      <div className={CAPTION_CLASS}>{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${tone || 'text-slate-900'}`}>{value}</div>
    </div>
  );
}

/**
 * A card holding the head of a list.
 *
 * `total` rather than `rows.length` in the heading, and a closing line when the
 * two differ: six rows out of forty is a sample, and a card that does not say
 * so reads as the whole file.
 */
function ListCard({ title, total, shown, empty, children }: {
  title: string; total: number; shown: number; empty: string; children: ReactNode;
}) {
  return (
    <Card title={total > 0 ? `${title} (${total})` : title}>
      {total === 0 ? <EmptyState message={empty} /> : (
        <>
          <div className="overflow-x-auto">{children}</div>
          {total > shown && (
            <p className="mt-2 text-xs text-slate-400">
              Showing the {shown} most recent of {total}.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/** The four columns every money document shares, so five cards do not spell them out five times. */
function DocRows({ rows, path, extra }: {
  rows: CustomerDocRow[];
  path: string;
  extra?: (row: CustomerDocRow) => ReactNode;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className={TH_CLASS}>
          <th className="pb-2 pr-3">Number</th>
          <th className="pb-2 pr-3">Date</th>
          <th className="pb-2 pr-3">Status</th>
          <th className="pb-2 pr-3 text-right">Total</th>
          {extra && <th className="pb-2 text-right">&nbsp;</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
            <td className="py-1.5 pr-3">
              <Link to={`${path}/${r.id}`} className="text-brand-600 hover:underline">{r.number || `#${r.id}`}</Link>
              {r.superseded && <span className="ml-1 text-xs text-slate-400">superseded</span>}
              {r.po_number ? <span className="ml-1 text-xs text-slate-400">PO {r.po_number}</span> : null}
            </td>
            <td className="py-1.5 pr-3 text-slate-500">{fmtDate(r.date)}</td>
            <td className="py-1.5 pr-3"><StatusBadge status={r.status} /></td>
            <td className="py-1.5 pr-3 text-right tabular-nums">{fmtMoney(r.grand_total, r.currency)}</td>
            {extra && <td className="py-1.5 text-right tabular-nums">{extra(r)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function CustomerDetailPage() {
  const { id } = useParams();
  const can = useCan();
  const [editing, setEditing] = useState(false);

  const { data: customer, isLoading, error } = useQuery({
    queryKey: ['customer', String(id)],
    queryFn: () => api.get<Customer>(`/api/customers/${id}`),
  });
  const { data: summary } = useQuery({
    queryKey: ['customer', String(id), 'summary'],
    queryFn: () => api.get<CustomerSummary>(`/api/customers/${id}/summary`),
  });

  if (isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (error || !customer) {
    return (
      <div>
        <PageHeader title="Customer" />
        <EmptyState message="That customer does not exist, or is not yours to see." />
      </div>
    );
  }

  const money = summary?.money;
  const contact = [customer.contact_person, customer.email, customer.phone].filter(Boolean).join(' · ');
  const where = [customer.city, customer.country].filter(Boolean).join(', ');

  return (
    <div>
      <PageHeader
        title={customer.name}
        subtitle={[customer.is_export ? '🌍 Export' : '🇮🇳 Domestic', where, customer.currency]
          .filter(Boolean).join(' · ')}
        actions={
          <div className="flex gap-2">
            <Link to="/customers"><Button variant="secondary">← All customers</Button></Link>
            {can('customer', 'full') && <Button onClick={() => setEditing(true)}>Edit</Button>}
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Details">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            {[
              ['Contact', contact],
              ['Address', [customer.address, where].filter(Boolean).join(', ')],
              ['GSTIN', customer.gstin],
              ['Owner', customer.owner_name],
              ['Consignee', customer.consignee],
              ['Notes', customer.notes],
              // An empty field is dropped rather than printed as a label over a
              // dash — the rule `ReadOnlyFields` follows on the document forms.
            ].filter(([, v]) => !!v).map(([label, value]) => (
              <div key={label as string}>
                <dt className={CAPTION_CLASS}>{label}</dt>
                <dd className="mt-0.5 whitespace-pre-wrap text-sm text-slate-900">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>

        {money && (
          <Card title="Money">
            {money.rows.length === 0 ? (
              <EmptyState message="Nothing invoiced yet." />
            ) : (
              <div className="space-y-4">
                {/* One block per currency. They are never added together — a
                    €10,000 balance is not ₹10,000, and there is no rate stored
                    anywhere to make one out of the other. */}
                {/*
                  * All five figures, always. Dropping the ones that are zero
                  * was tried and read worse: the row reflowed from four
                  * columns to five depending on the data, so one customer's
                  * Overdue sat under Invoiced and the next customer's sat
                  * beside it. A zero here is a fact — nothing overdue, no
                  * advance held — and a figure that says so should look like
                  * a figure, muted rather than missing.
                  */}
                {money.rows.map((r) => (
                  <div key={r.currency} className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                    <Stat label={`Invoiced ${r.currency}`} value={fmtMoney(r.invoiced, r.currency)} />
                    <Stat label="Received" value={fmtMoney(r.received, r.currency)} />
                    <Stat
                      label="Outstanding"
                      value={fmtMoney(r.outstanding, r.currency)}
                      tone={r.outstanding > 0.005 ? 'text-slate-900' : 'text-slate-400'}
                    />
                    <Stat
                      label="Advance held"
                      value={fmtMoney(r.advance_held, r.currency)}
                      tone={r.advance_held > 0.005 ? 'text-emerald-700' : 'text-slate-400'}
                    />
                    <Stat
                      label="Overdue"
                      value={r.overdue}
                      tone={r.overdue > 0 ? 'text-rose-700' : 'text-slate-400'}
                    />
                  </div>
                ))}
              </div>
            )}
            {money.currency_mismatch.length > 0 && (
              /* Money credited to nothing, surfaced rather than dropped — the
                 usual cause is a document whose currency was changed after the
                 payment was recorded. */
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
                {money.currency_mismatch.map((m) => fmtMoney(m.amount, m.currency)).join(', ')} was
                received in a currency the document it sits against is not billed in, so it is
                credited to nothing above. Correct the payment or the document to have it counted.
              </p>
            )}
          </Card>
        )}

        {summary?.enquiries && (
          <ListCard title="Enquiries" total={summary.enquiries.total} shown={summary.enquiries.rows.length}
            empty="No enquiries recorded.">
            <table className="w-full text-sm">
              <thead>
                <tr className={TH_CLASS}>
                  <th className="pb-2 pr-3">Date</th>
                  <th className="pb-2 pr-3">Status</th>
                  <th className="pb-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {summary.enquiries.rows.map((e) => (
                  <tr key={e.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-1.5 pr-3 text-slate-500">{fmtDate(e.date)}</td>
                    <td className="py-1.5 pr-3"><StatusBadge status={e.status} /></td>
                    <td className="py-1.5 text-slate-600">{e.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ListCard>
        )}

        {summary?.quotations && (
          <ListCard title="Quotations" total={summary.quotations.total} shown={summary.quotations.rows.length}
            empty="Nothing quoted yet.">
            <DocRows rows={summary.quotations.rows} path="/quotations" />
          </ListCard>
        )}

        {summary?.proformas && (
          <ListCard title="Proforma Invoices" total={summary.proformas.total} shown={summary.proformas.rows.length}
            empty="No proformas raised.">
            <DocRows rows={summary.proformas.rows} path="/proformas" />
          </ListCard>
        )}

        {summary?.orders && (
          <ListCard title="Orders" total={summary.orders.total} shown={summary.orders.rows.length}
            empty="No orders booked.">
            <DocRows rows={summary.orders.rows} path="/orders" />
          </ListCard>
        )}

        {summary?.invoices && (
          <ListCard title="Commercial Invoices" total={summary.invoices.total} shown={summary.invoices.rows.length}
            empty="Nothing billed yet.">
            <DocRows
              rows={summary.invoices.rows}
              path="/invoices"
              // The balance beside the total, since "what is still owed on this
              // one" is the reason to open an invoice from here.
              extra={(r) => (r.balance_due && r.balance_due > 0.005
                ? <span className="text-rose-700">{fmtMoney(r.balance_due, r.currency)} due</span>
                : <span className="text-emerald-700">settled</span>)}
            />
          </ListCard>
        )}

        {summary?.payments && (
          <ListCard title="Payments" total={summary.payments.total} shown={summary.payments.rows.length}
            empty="Nothing received yet.">
            <table className="w-full text-sm">
              <thead>
                <tr className={TH_CLASS}>
                  <th className="pb-2 pr-3">Date</th>
                  <th className="pb-2 pr-3">Against</th>
                  <th className="pb-2 pr-3">Method</th>
                  <th className="pb-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {summary.payments.rows.map((p) => (
                  <tr key={p.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-1.5 pr-3 text-slate-500">{fmtDate(p.date)}</td>
                    <td className="py-1.5 pr-3">{p.against || '—'}</td>
                    <td className="py-1.5 pr-3 text-slate-500">
                      {[p.method, p.reference].filter(Boolean).join(' · ') || '—'}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{fmtMoney(p.amount, p.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ListCard>
        )}

        {summary?.followups && (
          <ListCard title="Follow-ups" total={summary.followups.total} shown={summary.followups.rows.length}
            empty="No chases recorded.">
            <table className="w-full text-sm">
              <thead>
                <tr className={TH_CLASS}>
                  <th className="pb-2 pr-3">Due</th>
                  <th className="pb-2 pr-3">Note</th>
                  <th className="pb-2">State</th>
                </tr>
              </thead>
              <tbody>
                {summary.followups.rows.map((f) => (
                  <tr key={f.id} className="border-b border-slate-100 last:border-0">
                    <td className={`py-1.5 pr-3 ${f.overdue ? 'text-rose-700' : 'text-slate-500'}`}>{fmtDate(f.due_date)}</td>
                    <td className="py-1.5 pr-3 text-slate-600">{f.note || '—'}</td>
                    <td className="py-1.5">
                      <StatusBadge status={f.done ? 'done' : f.overdue ? 'overdue' : 'open'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ListCard>
        )}

        {summary?.qc && summary.qc.products.length > 0 && (
          <Card title="Their own QC tolerances">
            {/* A customer's rows replace the product default rather than
                merging with it, so this is the whole list of parts measured
                differently for them — see `product_qc_params.customer_id`. */}
            {/* Its own scroller, like every other table here: a long product
                name must widen this card, not the whole document. */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={TH_CLASS}>
                    <th className="pb-2 pr-3">Product</th>
                    <th className="pb-2 text-right">Parameters</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.qc.products.map((p) => (
                    <tr key={p.product_id} className="border-b border-slate-100 last:border-0">
                      <td className="py-1.5 pr-3">{p.product_name}</td>
                      <td className="py-1.5 text-right tabular-nums">{p.params}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>

      {editing && <CustomerDialog initial={customer} onClose={() => setEditing(false)} />}
    </div>
  );
}
