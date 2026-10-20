import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { QcCheckRow, QcRegisterSummary, Customer, Product } from '../types';
import {
  PageHeader, Card, Select, Input, EmptyState, Pagination, DownloadButton,
  SegmentedTabs, TH_CLASS,
} from '../components/ui';
import type { ReadyLine } from '../types';
import { fmtQty } from '../lib/format';
import { fmtDate } from '../lib/format';
import { useUrlFilter } from '../lib/useUrlFilter';
import { usePagedList, PAGE_SIZE } from '../lib/usePagedList';

/**
 * The QC register — every inspection recorded, newest first.
 *
 * The counterpart to the panel on a work order, which answers "how did *this*
 * job do". This answers "what has the quality desk seen", which is the question
 * the desk itself works from and the one nothing could answer before.
 *
 * Two things it deliberately does not do. It does **not** recompute a verdict:
 * `passed` comes from the server, derived from the readings and the tolerance
 * each was judged against, and is **null when nothing was measured** — which is
 * not a pass. And it does not filter on screen: the list is paged, so a filter
 * applied here would only ever filter the page in hand.
 */

const verdictPill = (row: QcCheckRow) => {
  if (row.passed === null) {
    return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500 ring-1 ring-slate-200">not measured</span>;
  }
  return row.passed
    ? <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700 ring-1 ring-green-200">pass</span>
    : (
      <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-red-200">
        fail{row.failed_count > 1 ? ` ×${row.failed_count}` : ''}
      </span>
    );
};

function Register() {
  const [from, setFrom] = useUrlFilter('from');
  const [to, setTo] = useUrlFilter('to');
  const [customer, setCustomer] = useUrlFilter('customer_id');
  const [product, setProduct] = useUrlFilter('product_id');
  const [result, setResult] = useUrlFilter('result');

  const query = new URLSearchParams();
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  if (customer) query.set('customer_id', customer);
  if (product) query.set('product_id', product);
  if (result) query.set('result', result);

  const list = usePagedList<QcCheckRow, QcRegisterSummary>(
    ['qc-register', query.toString()],
    `/api/work-orders/qc-checks?${query.toString()}`
  );
  const rows = list.rows;

  const { data: customers = [] } = useQuery({
    queryKey: ['customers', ''], queryFn: () => api.get<Customer[]>('/api/customers'),
  });
  const { data: products = [] } = useQuery({
    queryKey: ['products', ''], queryFn: () => api.get<Product[]>('/api/products'),
  });

  // Over every inspection matching the filters, never the page on screen.
  const totals = list.summary ?? { checks: rows.length, passed: 0, failed: 0, unmeasured: 0 };
  const filtered = !!(from || to || customer || product || result);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-sm text-slate-400">to</span>
        <Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} />
        <Select className="w-52" value={customer} onChange={(e) => setCustomer(e.target.value)}>
          <option value="">All customers</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select className="w-52" value={product} onChange={(e) => setProduct(e.target.value)}>
          <option value="">All products</option>
          {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Select className="w-40" value={result} onChange={(e) => setResult(e.target.value)}>
          <option value="">Any result</option>
          <option value="fail">Failed</option>
          <option value="pass">Passed</option>
          <option value="unmeasured">Nothing measured</option>
        </Select>
        <span className="ml-auto text-sm text-slate-500">
          {totals.checks} inspection{totals.checks === 1 ? '' : 's'}
          <span className="ml-2 text-green-700">{totals.passed} passed</span>
          <span className={totals.failed ? 'ml-2 font-semibold text-red-600' : 'ml-2 text-slate-400'}>
            {totals.failed} failed
          </span>
          {/* Stated rather than folded into "passed" — a check with no reading
              taken is an absence, and counting it as a pass is the one error
              this whole feature is built to avoid. */}
          {totals.unmeasured > 0 && <span className="ml-2 text-slate-400">{totals.unmeasured} not measured</span>}
        </span>
        <DownloadButton href={`/api/work-orders/qc-checks/export${query.toString() ? `?${query}` : ''}`} />
      </div>

      <Card className="overflow-x-auto">
        {rows.length === 0 ? (
          <EmptyState message={filtered
            ? 'Nothing matches those filters.'
            : 'No inspection has been recorded yet. They are entered from a work order’s QC panel.'} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className={TH_CLASS}>
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2 pr-3">Shift</th>
                <th className="pb-2 pr-3">Job</th>
                <th className="pb-2 pr-3">Product</th>
                <th className="pb-2 pr-3">Customer</th>
                <th className="pb-2 pr-3">Sales Order</th>
                <th className="pb-2 pr-3">Inspector</th>
                <th className="pb-2 pr-3 text-right">Readings</th>
                <th className="pb-2 pr-3">Result</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(r.date)}</td>
                  <td className="py-2 pr-3 text-slate-500">{r.shift || '—'}</td>
                  <td className="py-2 pr-3">
                    <Link to={`/work-orders/${r.work_order_id}`} className="text-brand-600 hover:underline">
                      {r.work_order_number}
                    </Link>
                  </td>
                  <td className="py-2 pr-3">{r.product_name || r.description || '—'}</td>
                  <td className="py-2 pr-3">{r.customer_name}</td>
                  <td className="py-2 pr-3">
                    <Link to={`/orders/${r.order_id}`} className="text-brand-600 hover:underline">{r.order_number}</Link>
                  </td>
                  <td className="py-2 pr-3 text-slate-500">{r.inspector || '—'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                    {/* Readings taken against readings asked for: a spec of six
                        with two filled in is a different thing from a clean
                        sheet, and the pill alone cannot say so. */}
                    {r.measured}/{r.readings}
                  </td>
                  <td className="py-2 pr-3">{verdictPill(r)}</td>
                  <td className="py-2 pr-3">
                    <a
                      href={`/api/pdf/qc-report/${r.work_order_id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-brand-600 hover:underline"
                    >PDF</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination
          page={list.page} pages={list.pages} total={list.total} limit={PAGE_SIZE}
          onPage={list.setPage} noun="inspections"
        />
      </Card>
    </>
  );
}

/**
 * What is waiting on a check (2026-10-20, the client, looking at a Held list
 * full of *"has not passed QC yet"*: *"QC not done should be shown in quality
 * tab as pending"*).
 *
 * The register above answers *what has the quality desk seen*; this answers
 * *what is it holding up*, which until now could only be read off the
 * dispatch queue — a page Quality holds `dispatch: view` on and which is
 * written for somebody loading a lorry rather than somebody taking a
 * measurement.
 *
 * **The same rows the dispatch queue holds, filtered to the ones its QC gate
 * is holding**, so a line leaves this list the moment the check that unblocks
 * it is recorded. Not paged: it is bounded by what is made and unshipped
 * rather than by how long the business has been trading, and it is a queue
 * that is meant to empty.
 */
function Pending() {
  const { data, isPending } = useQuery({
    queryKey: ['qc-pending'],
    queryFn: () => api.get<{ rows: ReadyLine[]; pending: number }>('/api/work-orders/qc-pending'),
  });
  const rows = data?.rows ?? [];
  if (isPending) return <div className="py-8 text-center text-sm text-slate-400">Loading…</div>;
  return (
    <Card className="overflow-x-auto">
      {rows.length === 0 ? (
        <EmptyState message="Nothing is waiting on a check. Every line that has been made either has a passing check or needs none." />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className={TH_CLASS}>
              <th className="pb-2 pr-3">Sales Order</th>
              <th className="pb-2 pr-3">Customer</th>
              <th className="pb-2 pr-3">Item</th>
              <th className="pb-2 pr-3">Colour</th>
              <th className="pb-2 pr-3">Job</th>
              <th className="pb-2 pr-3 text-right">Made</th>
              <th className="pb-2 pr-3 text-right">To ship</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.order_id}:${r.order_line}`} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                <td className="whitespace-nowrap py-2 pr-3">
                  <Link to={`/orders/${r.order_id}`} className="text-brand-600 hover:underline">{r.order_number}</Link>
                </td>
                <td className="max-w-[12rem] truncate py-2 pr-3" title={r.customer_name}>{r.customer_name}</td>
                <td className="max-w-[16rem] truncate py-2 pr-3" title={r.description}>
                  {r.product_name || r.description || '—'}
                </td>
                <td className="whitespace-nowrap py-2 pr-3 text-slate-500">
                  {r.color || <span className="text-slate-300">—</span>}
                </td>
                {/*
                  The answer to "is it connected to the work order": a check is
                  recorded against a job, so the job is the way out of this
                  list. A split run names both, since either may be the one
                  that was measured.
                */}
                <td className="whitespace-nowrap py-2 pr-3">
                  {r.jobs.length === 0 ? <span className="text-slate-300">—</span> : r.jobs.map((j, i) => (
                    <span key={j.id}>
                      {i > 0 && <span className="text-slate-300"> · </span>}
                      <Link to={`/work-orders/${j.id}`} className="text-brand-600 hover:underline">{j.number}</Link>
                    </span>
                  ))}
                </td>
                <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums">{fmtQty(r.made)}</td>
                {/* What is actually held up: made, within what was ordered,
                    and not yet gone. The figure that says whether this row
                    matters today. */}
                <td className="whitespace-nowrap py-2 pr-3 text-right font-medium tabular-nums">
                  {fmtQty(Math.max(0, Math.min(r.made, r.ordered) - r.sent))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/**
 * Two views over one desk: what has been inspected, and what is waiting.
 *
 * Held in the URL like every other view switch in this app, so a filtered or
 * a pending list is a link somebody can send.
 */
export default function QualityPage() {
  const [view, setView] = useUrlFilter('view');
  const pending = view === 'pending';
  // Asked whichever tab is open, so the count on the quiet tab is still right
  // — a tab that only counts once you are on it is a tab nobody opens.
  const { data } = useQuery({
    queryKey: ['qc-pending'],
    queryFn: () => api.get<{ rows: ReadyLine[]; pending: number }>('/api/work-orders/qc-pending'),
  });
  const waiting = data?.pending ?? 0;
  return (
    <div>
      <PageHeader
        title="Quality"
        subtitle={pending
          ? 'Lines that have been made and cannot ship until somebody records a check'
          : 'Every inspection recorded, against the tolerance it was judged by'}
      />
      <div className="mb-3">
        <SegmentedTabs
          value={pending ? 'pending' : 'register'}
          onChange={(v) => setView(v === 'pending' ? 'pending' : '')}
          tabs={[
            { key: 'register', label: 'Register' },
            {
              key: 'pending',
              label: waiting ? `Pending · ${waiting}` : 'Pending',
            },
          ]}
        />
      </div>
      {pending ? <Pending /> : <Register />}
    </div>
  );
}
