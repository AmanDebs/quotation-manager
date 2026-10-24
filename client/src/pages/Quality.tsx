import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { QcCheckRow, QcRegisterSummary, CoaRow, CoaSummary, Customer, Product } from '../types';
import {
  PageHeader, Card, Select, Input, Field, Button, Modal, ErrorText, EmptyState, Pagination,
  DownloadButton, SegmentedTabs, FIELD_GRID, TH_CLASS,
} from '../components/ui';
import { useCan } from '../App';
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

/**
 * Correct a certificate's date or its approver.
 *
 * **The two fields the issue dialog asked for**, which are the only two on a
 * certificate that are not derived — the number comes from the company's own
 * series and the lots are what it certifies, so neither is a correction, and
 * the server refuses both by not reading them.
 *
 * It acts on the **group**: the route is given one lot and resolves the rest
 * by number, so a certificate covering ten lots is corrected once rather than
 * ten times.
 */
function EditCoa({ row, onClose }: { row: CoaRow; onClose: () => void }) {
  const [form, setForm] = useState({
    date: row.coa_date, approved_by: row.approved_by, buyer_order: row.buyer_order,
  });
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: () => api.put(`/api/work-orders/batches/${row.batch_id}/coa`, form),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['coa-register'] });
      onClose();
    },
  });
  return (
    <Modal title={`Certificate ${row.coa_no}`} onClose={onClose}>
      <p className="mb-3 text-xs text-slate-500">
        {row.lots > 1
          ? `Covers ${row.lots} lots — ${row.batch_numbers}. A correction applies to all of them.`
          : `Covers batch ${row.batch_numbers}.`}
      </p>
      <div className={FIELD_GRID}>
        <Field label="Certificate date">
          <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        </Field>
        <Field label="Approved by">
          <Input
            value={form.approved_by}
            onChange={(e) => setForm({ ...form, approved_by: e.target.value })}
            placeholder="Who signs it off"
          />
        </Field>
        {/*
          The buyer's own reference, never ours. Blank is a real answer: the
          document falls back to the proforma behind the order and then to the
          customer's PO, and never to the sales order, which means nothing to
          whoever reads the certificate.
        */}
        <Field label="Buyer's order">
          <Input
            value={form.buyer_order}
            onChange={(e) => setForm({ ...form, buyer_order: e.target.value })}
            placeholder="PI or PO number"
          />
        </Field>
      </div>
      <p className="mt-3 text-xs text-slate-400">
        {row.draft
          ? 'This certificate has been withdrawn, so it is a draft: it certifies nothing and no lot of it '
            + 'can be dispatched until it is issued again, under this same number.'
          : 'The number and the lots it covers are not corrections — a certificate over different lots is a '
            + 'different certificate. Withdraw this one and issue another.'}
      </p>
      <ErrorText error={save.error} />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending || !form.date}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * Every Certificate of Analysis issued — what the desk tracks COAs from
 * (2026-10-22, the client: *"instead of Quality, make it COA tab and track
 * COA"*).
 *
 * **One row per certificate, not per lot.** A number may be written to
 * several lots in one act — Aglo's own cap COA covers five days of two shifts
 * — so a register keyed on the lot would list that consignment ten times
 * under one number, which is the opposite of what a certificate register is
 * for. The lots it covers are a column.
 *
 * It filters on the **server**, like the inspection register beside it: the
 * list is paged, so a filter applied here would only ever filter the page in
 * hand.
 */
function Certificates() {
  const [from, setFrom] = useUrlFilter('from');
  const [to, setTo] = useUrlFilter('to');
  const [customer, setCustomer] = useUrlFilter('customer_id');
  const [shipped, setShipped] = useUrlFilter('shipped');
  // Issued or withdrawn-and-kept — what somebody opening the register to
  // finish a draft is looking for.
  const [state, setState] = useUrlFilter('state');

  const query = new URLSearchParams();
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  if (customer) query.set('customer_id', customer);
  if (shipped) query.set('shipped', shipped);
  if (state) query.set('state', state);

  const list = usePagedList<CoaRow, CoaSummary>(
    ['coa-register', query.toString()],
    `/api/work-orders/coa?${query.toString()}`
  );
  const rows = list.rows;
  const summary = list.summary;
  const { data: customers = [] } = useQuery({
    queryKey: ['customers', ''],
    queryFn: () => api.get<Customer[]>('/api/customers'),
  });
  const can = useCan();
  const mayEdit = can('qc', 'full');
  const [editing, setEditing] = useState<CoaRow | null>(null);
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['coa-register'] });
  /*
   * Withdraw it — to a **draft**, which keeps the number, the date, the
   * approver and the lots and says only that it has not gone out. The server
   * refuses once the number is on a challan or a credit note, so this is only
   * ever a certificate that has gone nowhere.
   */
  const withdraw = useMutation({
    mutationFn: (batchId: number) => api.post(`/api/work-orders/batches/${batchId}/coa/withdraw`, {}),
    onSuccess: refresh,
  });
  /* The same certificate going back out, under its own number. */
  const issue = useMutation({
    mutationFn: (batchId: number) => api.post(`/api/work-orders/batches/${batchId}/coa/issue`, {}),
    onSuccess: refresh,
  });
  /*
   * And the way out for a certificate that should never have existed: the
   * lots go back to uncertified and the number is not re-used. What
   * withdrawing used to do, kept as its own act now that withdrawing drafts.
   */
  const discard = useMutation({
    mutationFn: (batchId: number) => api.del(`/api/work-orders/batches/${batchId}/coa`),
    onSuccess: refresh,
  });

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-xs text-slate-400">to</span>
        <Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} />
        <Select className="w-56" value={customer} onChange={(e) => setCustomer(e.target.value)}>
          <option value="">All customers</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        {/*
          The one thing about a certificate that changes after it is issued,
          and the reason somebody opens this list: has it gone out yet.
        */}
        <Select className="w-44" value={shipped} onChange={(e) => setShipped(e.target.value)}>
          <option value="">Dispatched or not</option>
          <option value="1">Dispatched</option>
          <option value="0">Not yet dispatched</option>
        </Select>
        <Select className="w-40" value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">Issued or draft</option>
          <option value="issued">Issued</option>
          <option value="draft">Draft</option>
        </Select>
        {summary && (
          <span className="ml-auto text-sm text-slate-500">
            {summary.certificates} certificate{summary.certificates === 1 ? '' : 's'}
            {' · '}{summary.lots} lot{summary.lots === 1 ? '' : 's'}
            {' · '}<span className="tabular-nums">{fmtQty(summary.qty)}</span> pcs
            {!!summary.shipped && <span className="text-slate-400">{' · '}{summary.shipped} dispatched</span>}
            {/* Amber, not grey: a draft is a certificate waiting on somebody,
                which is the one row on this register with something to do. */}
            {!!summary.drafts && <span className="text-amber-700">{' · '}{summary.drafts} draft{summary.drafts === 1 ? '' : 's'}</span>}
          </span>
        )}
        <DownloadButton href={`/api/work-orders/coa/export?${query.toString()}`} />
      </div>

      <Card className="overflow-x-auto">
        {list.isPending ? (
          <div className="py-8 text-center text-sm text-slate-400">Loading…</div>
        ) : rows.length === 0 ? (
          <EmptyState message="No certificates yet. A COA is issued from a job's Batches tab, or in one press with Certify (COA)." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className={TH_CLASS}>
                <th className="pb-2 pr-3">Certificate</th>
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2 pr-3">Batches</th>
                <th className="pb-2 pr-3">Product</th>
                <th className="pb-2 pr-3">Customer</th>
                <th className="pb-2 pr-3">Sales Order</th>
                <th className="pb-2 pr-3 text-right">Certified</th>
                <th className="pb-2 pr-3">Approved by</th>
                <th className="pb-2 pr-3">Dispatched</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.coa_no}:${r.batch_id}`} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="whitespace-nowrap py-2 pr-3 font-medium">
                    {r.coa_no}
                    {/* Said on the row rather than inferred from a missing
                        button: a draft looks exactly like a certificate from
                        every other cell, and it is the difference between
                        goods that may ship and goods that may not. */}
                    {!!r.draft && (
                      <span
                        className="ml-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-normal text-amber-700 ring-1 ring-amber-200"
                        title="Withdrawn and kept — it certifies nothing until it is issued again"
                      >draft</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3">{fmtDate(r.coa_date)}</td>
                  {/* The lots it covers. More than one is the ordinary shape
                      of their own paperwork, so the count is said out loud
                      rather than left to be counted off a long cell. */}
                  <td className="py-2 pr-3">
                    {/* The count sits outside the clip, or on a ten-lot
                        certificate — the shape their own paperwork has — the
                        truncation eats the one part of the cell that is
                        readable at a glance. */}
                    <div className="flex items-center gap-1">
                      <span className="max-w-[12rem] truncate" title={r.batch_numbers}>{r.batch_numbers}</span>
                      {r.lots > 1 && <span className="shrink-0 text-xs text-slate-400">({r.lots} lots)</span>}
                    </div>
                  </td>
                  <td className="max-w-[16rem] truncate py-2 pr-3" title={r.products}>{r.products || '—'}</td>
                  <td className="max-w-[14rem] truncate py-2 pr-3" title={r.customer_name}>{r.customer_name}</td>
                  <td className="whitespace-nowrap py-2 pr-3">
                    <Link to={`/orders/${r.order_id}`} className="text-brand-600 hover:underline">{r.order_number}</Link>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums">{fmtQty(r.qty)}</td>
                  <td className="max-w-[10rem] truncate py-2 pr-3 text-slate-500" title={r.approved_by}>
                    {r.approved_by || <span className="text-slate-300">—</span>}
                  </td>
                  {/* An absence, not a fault: a certificate is issued *before*
                      dispatch, so "not yet" is the ordinary state of a fresh
                      one rather than something to chase. */}
                  <td className="whitespace-nowrap py-2 pr-3">
                    {r.shipped
                      ? <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700 ring-1 ring-green-200">dispatched</span>
                      : <span className="text-xs text-slate-400">not yet</span>}
                  </td>
                  <td className="whitespace-nowrap py-2 text-right">
                    <a
                      href={`/api/pdf/coa/${r.batch_id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-medium text-brand-700 hover:underline"
                    >PDF</a>
                    {/*
                      Drawn on every certificate rather than only the ones the
                      server would allow: whether it has shipped is on the row
                      beside them, and a refusal that names the challan says
                      more than a missing button ever could — the rule the
                      order's own lot picker follows.
                    */}
                    {mayEdit && (
                      <>
                        <Button variant="ghost" className="ml-1" onClick={() => setEditing(r)}>Edit</Button>
                        {/*
                          A draft's two ways on, and they are different acts.
                          **Issue** is this certificate going back out under
                          its own number — the ordinary end of a correction.
                          **Discard** is for one that should never have
                          existed, and does what withdrawing used to: the lots
                          go back to uncertified and the number is spent.
                        */}
                        {r.draft ? (
                          <>
                            <Button
                              variant="secondary"
                              className="ml-1"
                              disabled={issue.isPending}
                              title="Issue this certificate again, under the same number"
                              onClick={() => issue.mutate(r.batch_id)}
                            >
                              Issue
                            </Button>
                            <Button
                              variant="ghost"
                              className="ml-1"
                              disabled={discard.isPending}
                              title="Clear this certificate — the lots go back to uncertified"
                              onClick={() => {
                                if (confirm(`Discard ${r.coa_no}? ${r.lots > 1 ? `The ${r.lots} lots it covers go` : 'The lot it covers goes'} back to uncertified, and the number is not re-used.`)) {
                                  discard.mutate(r.batch_id);
                                }
                              }}
                            >
                              Discard
                            </Button>
                          </>
                        ) : (
                          <Button
                            variant="ghost"
                            className="ml-1"
                            disabled={withdraw.isPending}
                            title="Put it back to draft — nothing is lost, and it certifies nothing until issued again"
                            onClick={() => {
                              if (confirm(`Withdraw ${r.coa_no}? It becomes a draft — the number, the date and ${r.lots > 1 ? `the ${r.lots} lots it covers stay` : 'the lot it covers stays'} — and nothing of it can be dispatched until you issue it again.`)) {
                                withdraw.mutate(r.batch_id);
                              }
                            }}
                          >
                            Withdraw
                          </Button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination
          page={list.page} pages={list.pages} total={list.total} limit={PAGE_SIZE}
          onPage={list.setPage} noun="certificates"
        />
        <ErrorText error={withdraw.error ?? issue.error ?? discard.error} />
      </Card>
      {editing && <EditCoa row={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

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
 * Three views over one desk: the certificates issued, what is waiting for
 * one, and the inspections behind them.
 *
 * **It opens on the certificates** (2026-10-22, the client: *"instead of
 * Quality, make it COA tab and track COA"*). The inspection register stays —
 * it is the record the certificates are issued on, and a page that tracked
 * the document while hiding the readings behind it would answer half the
 * question — but it is no longer what the page is *about*, which is why the
 * page and its sidebar entry now read **COA**.
 *
 * `?view=` holds which, like every other view switch in this app, so a
 * filtered list is a link somebody can send. **Blank is the certificates**,
 * so a bookmark saved against the old default lands on a list rather than on
 * nothing; `?view=pending` is unchanged and still what the old Pending tab
 * and the dashboard's own links point at.
 */
export default function QualityPage() {
  const [view, setView] = useUrlFilter('view');
  const tab = view === 'pending' || view === 'inspections' ? view : 'coa';
  // Asked whichever tab is open, so the count on the quiet tab is still right
  // — a tab that only counts once you are on it is a tab nobody opens.
  const { data } = useQuery({
    queryKey: ['qc-pending'],
    queryFn: () => api.get<{ rows: ReadyLine[]; pending: number }>('/api/work-orders/qc-pending'),
  });
  const waiting = data?.pending ?? 0;
  const subtitle = tab === 'pending'
    ? 'Lines that have been made and cannot ship until somebody records a check'
    : tab === 'inspections'
      ? 'Every inspection recorded, against the tolerance it was judged by'
      : 'Every Certificate of Analysis issued, and whether the goods have gone';
  return (
    <div>
      <PageHeader title="COA" subtitle={subtitle} />
      <div className="mb-3">
        <SegmentedTabs
          value={tab}
          onChange={(v) => setView(v === 'coa' ? '' : v)}
          tabs={[
            { key: 'coa', label: 'Certificates' },
            { key: 'pending', label: waiting ? `Pending · ${waiting}` : 'Pending' },
            { key: 'inspections', label: 'Inspections' },
          ]}
        />
      </div>
      {tab === 'pending' ? <Pending /> : tab === 'inspections' ? <Register /> : <Certificates />}
    </div>
  );
}
