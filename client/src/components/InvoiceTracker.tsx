import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { TrackerRow, TrackerShipment, TrackerSummary, Customer } from '../types';
import { Card, Select, Input, Field, Button, Modal, EmptyState, ErrorText, Pagination, DownloadButton, TH_CLASS, CAPTION_CLASS } from '../components/ui';
import { fmtDate, fmtMoney } from '../lib/format';
import { useUrlFilter } from '../lib/useUrlFilter';
import { usePagedList, PAGE_SIZE } from '../lib/usePagedList';
import { useCan } from '../App';

/**
 * The invoice tracker — the Payments page read the way the export desk's own
 * sheet reads (asked for 2026-09-14): one line per commercial invoice, with
 * the sea leg, the advance, the balance, the due date and whether it is
 * settled. The server owns every figure and every rule (`services/
 * invoiceTracker.ts`); this draws them and offers the three things the desk
 * said it revises — ETD, ETA and the documents — plus the due date, which is
 * the one column the tracker adds to the record.
 *
 * Two things to keep. **The sea leg is edited on the trip, not on a copy**:
 * the dialog PATCHes the despatch the challan printed, so the register, the
 * dashboard's *awaiting documents* chip and this page cannot disagree. And
 * **the shipments column is drawn only when the server sent one** — absent
 * for a caller without `dispatch`, decided there rather than by `useCan()`
 * here, the rule every gated section in this app follows.
 */

const DOCS_LABEL: Record<string, string> = { '': 'Not sent', sent: 'Sent', received: 'Received' };
const METHOD_LABEL: Record<string, string> = { '': '', telex: 'Telex', courier: 'Courier' };

function Totals({ summary }: { summary: TrackerSummary }) {
  return (
    <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
      <span className="text-slate-500">
        {summary.invoices} invoice{summary.invoices === 1 ? '' : 's'}
        {summary.pending > 0 && <span className="text-amber-700"> · {summary.pending} pending</span>}
      </span>
      {summary.by_currency.map((c) => (
        <span key={c.currency} className="tabular-nums" title={`Invoiced ${fmtMoney(c.invoiced, c.currency)}`}>
          <span className={`${CAPTION_CLASS} mr-1 text-slate-400`}>balance</span>
          <span className="font-medium text-slate-900">{fmtMoney(c.balance, c.currency)}</span>
        </span>
      ))}
    </div>
  );
}

/** A shipment's references, one line per trip. */
function ShipmentCell({ shipments, render }: { shipments: TrackerShipment[]; render: (s: TrackerShipment) => string }) {
  const lines = shipments.map(render);
  if (!lines.some(Boolean)) return <span className="text-slate-400">—</span>;
  return (
    <div className="space-y-0.5">
      {lines.map((l, i) => <div key={shipments[i].despatch_id}>{l || <span className="text-slate-400">—</span>}</div>)}
    </div>
  );
}

/**
 * Revise the sea leg and the due date. One dialog for the row, with a block
 * per trip: an invoice is nearly always one container, and the rare one
 * billed across two is edited trip by trip rather than through a merged form
 * that would have to invent which trip a single ETA belonged to.
 */
function EditModal({ row, canDispatch, canInvoice, onClose }: {
  row: TrackerRow; canDispatch: boolean; canInvoice: boolean; onClose: () => void;
}) {
  const qc = useQueryClient();
  const [ships, setShips] = useState<TrackerShipment[]>(row.shipments ?? []);
  const [due, setDue] = useState(row.due_on_arrival ? '' : row.due_date);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const setShip = (i: number, patch: Partial<TrackerShipment>) =>
    setShips((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      if (canDispatch) {
        for (const s of ships) {
          await api.patch(`/api/despatches/${s.despatch_id}/sea-leg`, {
            bl_no: s.bl_no, container_no: s.container_no, etd: s.etd, eta: s.eta,
            docs_status: s.docs_status, docs_method: s.docs_method, docs_date: s.docs_date,
          });
        }
      }
      if (canInvoice) await api.patch(`/api/invoices/${row.id}/due-date`, { due_date: due });
      qc.invalidateQueries({ queryKey: ['invoice-tracker'] });
      qc.invalidateQueries({ queryKey: ['despatches'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`${row.number} — revise`} onClose={onClose} wide>
      {canDispatch && ships.map((s, i) => (
        <div key={s.despatch_id} className="mb-4 rounded-lg bg-slate-50 p-3 ring-1 ring-inset ring-slate-200">
          {ships.length > 1 && <div className={`${CAPTION_CLASS} mb-2 text-slate-500`}>Trip {i + 1}</div>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="BL No."><Input value={s.bl_no} onChange={(e) => setShip(i, { bl_no: e.target.value })} /></Field>
            <Field label="Container No."><Input value={s.container_no} onChange={(e) => setShip(i, { container_no: e.target.value })} /></Field>
            <Field label="ETD"><Input type="date" value={s.etd} onChange={(e) => setShip(i, { etd: e.target.value })} /></Field>
            <Field label="ETA"><Input type="date" value={s.eta} onChange={(e) => setShip(i, { eta: e.target.value })} /></Field>
            <Field label="Documents">
              <Select value={s.docs_status} onChange={(e) => setShip(i, { docs_status: e.target.value })}>
                <option value="">Not sent</option>
                <option value="sent">Sent</option>
                <option value="received">Received</option>
              </Select>
            </Field>
            <Field label="Sent by">
              <Select value={s.docs_method} onChange={(e) => setShip(i, { docs_method: e.target.value })}>
                <option value="">—</option>
                <option value="telex">Telex release</option>
                <option value="courier">Courier</option>
              </Select>
            </Field>
            <Field label="Documents date"><Input type="date" value={s.docs_date} onChange={(e) => setShip(i, { docs_date: e.target.value })} /></Field>
          </div>
        </div>
      ))}
      {canDispatch && ships.length === 0 && (
        <p className="mb-4 text-sm text-slate-500">
          No dispatch is linked to this invoice yet, so there is no BL, ETD or ETA to revise. Link the trip on the sales order's Dispatch tab.
        </p>
      )}
      {canInvoice && (
        <Field label="Due date">
          <Input type="date" className="w-48" value={due} onChange={(e) => setDue(e.target.value)} />
          <p className="mt-1 text-xs text-slate-500">Leave blank for <em>due on arrival</em> — the tracker then shows the ETA.</p>
        </Field>
      )}
      {error && <ErrorText error={error} />}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </Modal>
  );
}

export default function InvoiceTracker() {
  const can = useCan();
  const canDispatch = can('dispatch', 'full');
  const canInvoice = can('invoice', 'full');
  const [kind, setKind] = useUrlFilter('export');
  const [status, setStatus] = useUrlFilter('status');
  const [customer, setCustomer] = useUrlFilter('customer_id');
  const [from, setFrom] = useUrlFilter('from');
  const [to, setTo] = useUrlFilter('to');
  const [q, setQ] = useUrlFilter('q');
  const [editing, setEditing] = useState<TrackerRow | null>(null);

  const query = new URLSearchParams();
  if (kind) query.set('export', kind);
  if (status) query.set('status', status);
  if (customer) query.set('customer_id', customer);
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  if (q) query.set('q', q);

  const list = usePagedList<TrackerRow, TrackerSummary>(
    ['invoice-tracker', query.toString()],
    `/api/payments/tracker?${query.toString()}`,
  );
  const rows = list.rows;
  const { data: customers = [] } = useQuery({
    queryKey: ['customers', ''], queryFn: () => api.get<Customer[]>('/api/customers'),
  });
  // Drawn only when the server sent it: absent means the caller may not read it.
  const withSea = rows.some((r) => r.shipments !== undefined);
  const editable = canDispatch || canInvoice;
  const filtered = !!(kind || status || customer || from || to || q);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select className="w-40" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Export and domestic</option>
          <option value="1">Export</option>
          <option value="0">Domestic</option>
        </Select>
        <Select className="w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Pending and completed</option>
          <option value="pending">Pending</option>
          <option value="completed">Completed</option>
        </Select>
        <Select className="w-52" value={customer} onChange={(e) => setCustomer(e.target.value)}>
          <option value="">All customers</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-sm text-slate-400">to</span>
        <Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} />
        <Input className="w-56" placeholder="Search CI, customer, BL or container…" value={q} onChange={(e) => setQ(e.target.value)} />
        <DownloadButton href={`/api/payments/tracker/export${query.toString() ? `?${query}` : ''}`} />
        {list.summary && <Totals summary={list.summary} />}
      </div>

      <Card className="overflow-x-auto">
        {rows.length === 0 ? (
          <EmptyState message={filtered ? 'Nothing matches those filters.' : 'No commercial invoices raised yet.'} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className={TH_CLASS}>
                <th className="pb-2 pr-3">CI No</th>
                <th className="pb-2 pr-3">Customer</th>
                <th className="pb-2 pr-3 text-right">CI Amt</th>
                <th className="pb-2 pr-3">CI Date</th>
                {withSea && <th className="pb-2 pr-3">BL / Container</th>}
                {withSea && <th className="pb-2 pr-3">ETD</th>}
                {withSea && <th className="pb-2 pr-3">ETA</th>}
                {withSea && <th className="pb-2 pr-3">Documents</th>}
                <th className="pb-2 pr-3 text-right">Advance received</th>
                <th className="pb-2 pr-3 text-right">Balance</th>
                <th className="pb-2 pr-3">Due date</th>
                <th className="pb-2 pr-3">Status</th>
                {editable && <th className="pb-2" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 align-top last:border-0 hover:bg-slate-50">
                  <td className="whitespace-nowrap py-2 pr-3">
                    <Link to={`/invoices/${r.id}`} className="text-brand-600 hover:underline">{r.number}</Link>
                    <span className="ml-1 text-xs" title={r.is_export ? 'Export' : 'Domestic'}>{r.is_export ? '🌍' : '🇮🇳'}</span>
                  </td>
                  <td className="py-2 pr-3">
                    <Link to={`/customers/${r.customer_id}`} className="text-brand-600 hover:underline">{r.customer_name}</Link>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums">{fmtMoney(r.grand_total, r.currency)}</td>
                  <td className="whitespace-nowrap py-2 pr-3 text-slate-500">{fmtDate(r.date)}</td>
                  {withSea && (
                    <td className="py-2 pr-3">
                      <ShipmentCell shipments={r.shipments ?? []} render={(s) => [s.bl_no, s.container_no].filter(Boolean).join(' / ')} />
                    </td>
                  )}
                  {withSea && (
                    <td className="whitespace-nowrap py-2 pr-3 text-slate-500">
                      <ShipmentCell shipments={r.shipments ?? []} render={(s) => (s.etd ? fmtDate(s.etd) : '')} />
                    </td>
                  )}
                  {withSea && (
                    <td className="whitespace-nowrap py-2 pr-3 text-slate-500">
                      <ShipmentCell shipments={r.shipments ?? []} render={(s) => (s.eta ? fmtDate(s.eta) : '')} />
                    </td>
                  )}
                  {withSea && (
                    <td className="whitespace-nowrap py-2 pr-3">
                      <ShipmentCell
                        shipments={r.shipments ?? []}
                        render={(s) => [DOCS_LABEL[s.docs_status] ?? s.docs_status, METHOD_LABEL[s.docs_method] ?? s.docs_method,
                          s.docs_date ? fmtDate(s.docs_date) : ''].filter(Boolean).join(' · ')}
                      />
                    </td>
                  )}
                  <td
                    className="whitespace-nowrap py-2 pr-3 text-right tabular-nums"
                    title={r.amount_received !== r.advance_applied
                      ? `Received in all ${fmtMoney(r.amount_received, r.currency)}${r.credited ? `, credited ${fmtMoney(r.credited, r.currency)}` : ''}`
                      : undefined}
                  >
                    {r.advance_applied ? fmtMoney(r.advance_applied, r.currency) : <span className="text-slate-400">—</span>}
                  </td>
                  <td className={`whitespace-nowrap py-2 pr-3 text-right tabular-nums ${r.balance_due > 0 ? 'font-medium text-slate-900' : 'text-slate-400'}`}>
                    {fmtMoney(r.balance_due, r.currency)}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-slate-500">
                    {r.due_date ? fmtDate(r.due_date) : <span className="text-slate-400">—</span>}
                    {r.due_on_arrival && <span className={`ml-1 ${CAPTION_CLASS} text-slate-400`} title="No due date typed; the ETA stands in.">on arrival</span>}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                      r.status === 'completed' ? 'bg-green-50 text-green-700 ring-green-200' : 'bg-amber-50 text-amber-700 ring-amber-200'
                    }`}>
                      {r.status === 'completed' ? 'Completed' : 'Pending'}
                    </span>
                  </td>
                  {editable && (
                    <td className="py-2 text-right">
                      <button type="button" className="text-xs text-brand-600 hover:underline" onClick={() => setEditing(r)}>Revise</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination page={list.page} pages={list.pages} total={list.total} limit={PAGE_SIZE} onPage={list.setPage} noun="invoices" />
      </Card>

      {editing && (
        <EditModal row={editing} canDispatch={canDispatch} canInvoice={canInvoice} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
