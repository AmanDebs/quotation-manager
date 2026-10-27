import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { QcCheckRow, QcRegisterSummary, CoaRow, CoaSummary, Customer, Product } from '../types';
import {
  PageHeader, Card, Select, Input, Field, Button, Modal, ErrorText, EmptyState, Pagination,
  DownloadButton, SegmentedTabs, FIELD_GRID, TH_CLASS,
} from '../components/ui';
import { useCan } from '../App';
import { CoaExtraFields } from '../components/CoaExtraFields';
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
 * Correct a certificate — one verb over what used to be four.
 *
 * 2026-10-27, from a review the client approved: a row carried *Edit ·
 * Withdraw · Issue · Discard* beside its PDF, which is four ways to touch one
 * document and three of them only mean anything in a particular state.
 * Somebody correcting a certificate does not think *"withdraw it, edit it,
 * issue it"*; they think *"this says the wrong thing"*.
 *
 * So the row offers **Correct** and this dialog decides what that means:
 *
 * - the **header fields** (date, approver, the buyer's reference, the extra
 *   details) are a plain `PUT`, which the server allows on an issued
 *   certificate — nothing has to be withdrawn to fix a date, and the old
 *   row-button made people withdraw first for no reason;
 * - the **readings** cannot move under an issued certificate (`checkEditError`
 *   refuses it, since everything that lets goods leave reads the number rather
 *   than the reading behind it), so that button **withdraws and opens the job**
 *   in one press, which is the whole of the old three-step path;
 * - a **draft** can be saved as a draft or saved and issued, which is the
 *   ordinary end of a correction and is why *Issue* no longer needs a row of
 *   its own.
 *
 * It acts on the **group**: the route is given one batch and resolves the rest
 * by number, so a certificate covering ten batches is corrected once rather
 * than ten times.
 */
function EditCoa({ row, onClose }: { row: CoaRow; onClose: () => void }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    date: row.coa_date,
    approved_by: row.approved_by,
    buyer_order: row.buyer_order,
    // Opened on what is actually on the certificate: the whole list is sent on
    // save, so a dialog that did not know about these would blank them.
    extra: row.extra ?? [],
  });
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['coa-register'] });
  const save = useMutation({
    mutationFn: () => api.put(`/api/work-orders/batches/${row.batch_id}/coa`, form),
    onSuccess: () => { refresh(); onClose(); },
  });
  /*
   * Save and send it back out, in **one** request: `/coa/issue` takes the same
   * fields under the `batch_ids` contract, so there is no window where the date
   * has moved and the certificate is still a draft.
   */
  const issue = useMutation({
    mutationFn: () => api.post(`/api/work-orders/batches/${row.batch_id}/coa/issue`, form),
    onSuccess: () => { refresh(); onClose(); },
  });
  /*
   * The readings' own way through. On an issued certificate this withdraws
   * first — it has to, or the job refuses the correction — and lands on the
   * batch that prints them; on a draft there is nothing to withdraw.
   */
  const toReadings = useMutation({
    mutationFn: async () => {
      if (!row.draft) await api.post(`/api/work-orders/batches/${row.batch_id}/coa/withdraw`, {});
    },
    onSuccess: () => { refresh(); navigate(`/work-orders/${row.work_order_id}?tab=batches`); },
  });
  const busy = save.isPending || issue.isPending || toReadings.isPending;
  return (
    <Modal title={`Correct ${row.coa_no}`} onClose={onClose}>
      <p className="mb-3 text-xs text-slate-500">
        {row.lots > 1
          ? `Covers ${row.lots} batches — ${row.batch_numbers}. A correction applies to all of them.`
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
      <div className="mt-3 border-t border-slate-100 pt-3">
        <CoaExtraFields rows={form.extra} onChange={(extra) => setForm({ ...form, extra })} />
      </div>
      <p className="mt-3 text-xs text-slate-400">
        {row.draft
          ? 'This one is a draft: it certifies nothing and none of its batches can be dispatched until it '
            + 'is issued again, under this same number.'
          : 'Which batches it covers is not a correction — a certificate over different batches is a '
            + 'different certificate. Discard this one and certify again.'}
      </p>
      <ErrorText error={save.error || issue.error || toReadings.error} />
      <div className="mt-3 flex items-center gap-2">
        {/*
          The readings are the other half of what somebody means by correcting
          a certificate, and they belong to the inspection — its own date, its
          own inspector — so they are changed where that inspection is. What
          used to be a sentence telling somebody to go and withdraw it first is
          now the button doing both.
        */}
        <Button
          variant="ghost"
          disabled={busy}
          title={row.draft
            ? 'Open the job, where readings are corrected on the batch itself'
            : 'Puts it back to a draft and opens the job — readings cannot move under an issued certificate'}
          onClick={() => {
            if (row.draft || confirm(
              `Correct the readings on ${row.coa_no}? It goes back to a draft while you do — nothing is `
              + 'lost, and nothing of it can be dispatched until you issue it again.'
            )) toReadings.mutate();
          }}
        >
          {toReadings.isPending ? 'Opening…' : 'Correct the readings…'}
        </Button>
        <span className="ml-auto" />
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button
          variant={row.draft ? 'secondary' : 'primary'}
          onClick={() => save.mutate()}
          disabled={busy || !form.date}
        >
          {save.isPending ? 'Saving…' : row.draft ? 'Save as draft' : 'Save'}
        </Button>
        {/* The ordinary end of a correction, which is why *Issue* is no longer
            a button on the row. */}
        {!!row.draft && (
          <Button onClick={() => issue.mutate()} disabled={busy || !form.date}>
            {issue.isPending ? 'Issuing…' : 'Save & issue'}
          </Button>
        )}
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
   * **Three acts on a row, not five** (2026-10-27). *Withdraw* and *Issue*
   * moved inside the Correct dialog, where they are the shape of the thing
   * somebody is actually doing rather than two more states to reason about —
   * see `EditCoa`. What is left is the document itself, the one way to change
   * it, and the way out for one that should never have existed: the batches go
   * back to uncertified and the number is **not** re-used.
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
            {' · '}{summary.lots} batch{summary.lots === 1 ? '' : 'es'}
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
          <EmptyState message="No certificates yet. One press of Certify on the To inspect tab inspects a job's output and certifies it." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className={TH_CLASS}>
                <th className="pb-2 pr-3">Certificate</th>
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2 pr-3">Batches</th>
                <th className="pb-2 pr-3">Product</th>
                <th className="pb-2 pr-3">Customer</th>
                <th className="pb-2 pr-3">Work Order</th>
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
                      {r.lots > 1 && <span className="shrink-0 text-xs text-slate-400">({r.lots} batches)</span>}
                    </div>
                  </td>
                  <td className="max-w-[16rem] truncate py-2 pr-3" title={r.products}>{r.products || '—'}</td>
                  <td className="max-w-[14rem] truncate py-2 pr-3" title={r.customer_name}>{r.customer_name}</td>
                  {/*
                    The job rather than the sales order (2026-10-24, the
                    client: *"show work order instead of sales order"*), which
                    is the document this one is issued against: a certificate
                    covers lots, a lot is made on a job, and the order is one
                    step further out. Linked only where there is a single job
                    to link to — a certificate over a split run names both, and
                    a link on one of two numbers would send somebody to half of
                    what the row is about. The order is still a click away,
                    through the job.
                  */}
                  <td className="whitespace-nowrap py-2 pr-3">
                    {r.jobs === 1 ? (
                      <Link to={`/work-orders/${r.work_order_id}`} className="text-brand-600 hover:underline">
                        {r.work_order_numbers}
                      </Link>
                    ) : (
                      // SQLite's DISTINCT concat takes no separator, so the
                      // space is put back here rather than two job numbers
                      // reading as one — and the cell is clipped with the
                      // whole value on hover, the rule the Batches and Product
                      // columns beside it follow: a split run is rare, and
                      // letting its cell set the table's width would widen
                      // every other row for it.
                      <span
                        className="block max-w-[9rem] truncate"
                        title={r.work_order_numbers.split(',').join(', ')}
                      >
                        {r.work_order_numbers.split(',').join(', ')}
                      </span>
                    )}
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
                        <Button
                          variant={r.draft ? 'secondary' : 'ghost'}
                          className="ml-1"
                          title={r.draft
                            ? 'Finish this draft — correct it and issue it again'
                            : 'Change the date, the approver or the readings'}
                          onClick={() => setEditing(r)}
                        >
                          Correct
                        </Button>
                        {/*
                          The way out for a certificate that should never have
                          existed. Drawn on every row rather than only where the
                          server would allow it: whether it has shipped is on
                          the row beside it, and a refusal that names the
                          challan says more than a missing button ever could.
                        */}
                        <Button
                          variant="ghost"
                          className="ml-1"
                          disabled={discard.isPending}
                          title="Clear this certificate — its batches go back to uncertified"
                          onClick={() => {
                            if (confirm(`Discard ${r.coa_no}? ${r.lots > 1 ? `The ${r.lots} batches it covers go` : 'The batch it covers goes'} back to uncertified, and the number is not re-used.`)) {
                              discard.mutate(r.batch_id);
                            }
                          }}
                        >
                          Discard
                        </Button>
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
        <ErrorText error={discard.error} />
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
/**
 * What is made and cannot ship — **and the press that clears it**.
 *
 * 2026-10-27, from a review the client approved. This list has known exactly
 * which lines are held since it was written, and then sent somebody to the
 * job, where the action was three more clicks and a paragraph away. The daily
 * loop is now: open Quality, press *Certify*, type the readings.
 *
 * **The button is drawn where it would work.** `POST /:id/certify` refuses a
 * job whose every shift is already in a batch, so the row offers it only where
 * that job has unlotted output — the `ReadyJob.unlotted` figure exists for
 * this. Where it does not, the hold's own sentence is printed instead, since
 * the next act is then on the job itself (inspect the batch that exists, issue
 * its certificate, or rule on a failed one) and a button that can only produce
 * a refusal is worse than none.
 */
function Pending() {
  const navigate = useNavigate();
  const can = useCan();
  const mayInspect = can('qc', 'full');
  const { data, isPending } = useQuery({
    queryKey: ['qc-pending'],
    queryFn: () => api.get<{ rows: ReadyLine[]; pending: number }>('/api/work-orders/qc-pending'),
  });
  const rows = data?.rows ?? [];
  if (isPending) return <div className="py-8 text-center text-sm text-slate-400">Loading…</div>;
  return (
    <Card className="overflow-x-auto">
      {rows.length === 0 ? (
        <EmptyState message="Nothing is waiting to be inspected. Every line that has been made is either certified or needs no specification." />
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
              {mayInspect && <th className="pb-2" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.order_id}:${r.order_line}`} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                <td className="whitespace-nowrap py-2 pr-3">
                  <Link to={`/orders/${r.order_id}`} className="text-brand-600 hover:underline">{r.order_number}</Link>
                </td>
                <td className="max-w-[12rem] truncate py-2 pr-3" title={r.customer_name}>{r.customer_name}</td>
                <td className="max-w-[16rem] py-2 pr-3">
                  <div className="truncate" title={r.description}>{r.product_name || r.description || '—'}</div>
                  {/*
                    Why it is held, said only where the row has no button: with
                    one it is noise on every line, and without one it is the
                    only thing that says what to do next.
                  */}
                  {mayInspect && r.qc_hold && !r.jobs.some((j) => j.unlotted > 0) && (
                    <div className="text-xs text-amber-700">{r.qc_hold}</div>
                  )}
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
                {/*
                  One press per job with something to sweep. A split run is two
                  jobs and either may be the one to certify, so each gets its
                  own button carrying its number — rare, and the alternative is
                  a button that picks one of them silently.
                */}
                {mayInspect && (
                  <td className="whitespace-nowrap py-2 text-right">
                    {(() => {
                      const ready = r.jobs.filter((j) => j.unlotted > 0);
                      if (!ready.length) {
                        return (
                          <span className="text-xs text-slate-400" title={r.qc_hold ?? undefined}>
                            {r.qc_hold ? 'See the job' : '—'}
                          </span>
                        );
                      }
                      return ready.map((j) => (
                        <Button
                          key={j.id}
                          className="ml-1"
                          title={`Inspect everything ${j.number} has made and not yet certified, and issue the COA`}
                          onClick={() => navigate(`/work-orders/${j.id}/certify`)}
                        >
                          {ready.length > 1 ? `Certify ${j.number}` : 'Certify'}
                        </Button>
                      ));
                    })()}
                  </td>
                )}
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
  /*
   * A blank — or anything unknown — is the **queue** (2026-10-27), which is
   * where the day's work is now that it carries the Certify press. `pending`
   * still lands on it, so every link written before this does too.
   */
  const tab = view === 'coa' || view === 'inspections' ? view : 'pending';
  // Asked whichever tab is open, so the count on the quiet tab is still right
  // — a tab that only counts once you are on it is a tab nobody opens.
  const { data } = useQuery({
    queryKey: ['qc-pending'],
    queryFn: () => api.get<{ rows: ReadyLine[]; pending: number }>('/api/work-orders/qc-pending'),
  });
  const waiting = data?.pending ?? 0;
  const subtitle = tab === 'coa'
    ? 'Every Certificate of Analysis issued, and whether the goods have gone'
    : tab === 'inspections'
      ? 'Every inspection recorded, against the tolerance it was judged by'
      : 'Made and cannot ship until it is inspected and certified';
  return (
    <div>
      {/*
        **Quality, opening on the queue** (2026-10-27, from a review the client
        approved). It was *COA* opening on the register, which reverses their
        own instruction of 2026-10-22 — stated rather than slipped in. The
        reason is that the register is where you *look* and this page is now
        where you *work*: the queue carries the Certify press, so it is the tab
        with something to do and the one that reads 0 when there is not. The
        certificates are one click away and the tab still says so.

        `?view=` is unchanged, so every link already pointing here lands —
        `pending` still opens the queue, and what moved is only which tab a bare
        `/quality` shows.
      */}
      <PageHeader title="Quality" subtitle={subtitle} />
      <div className="mb-3">
        <SegmentedTabs
          value={tab === 'pending' ? '' : tab}
          onChange={setView}
          tabs={[
            { key: '', label: waiting ? `To inspect · ${waiting}` : 'To inspect' },
            { key: 'coa', label: 'Certificates' },
            { key: 'inspections', label: 'History' },
          ]}
        />
      </div>
      {tab === 'coa' ? <Certificates /> : tab === 'inspections' ? <Register /> : <Pending />}
    </div>
  );
}
