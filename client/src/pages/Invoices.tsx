import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Invoice } from '../types';
import { Button, Select, Input, PageHeader, EmptyState, Card, ExportTabs, ErrorText, Pagination, DownloadButton, TH_CLASS } from '../components/ui';
import { ColumnFilter, FilteredByStrip } from '../components/ColumnFilter';
import { useColumnFilters, type ColumnFilterSpec } from '../lib/useColumnFilters';
import { useCompanies } from '../components/CompanySelect';
import NewDocumentDialog from '../components/NewDocumentDialog';
import { fmtDate, fmtMoney } from '../lib/format';
import { useUrlFilter } from '../lib/useUrlFilter';
import { usePagedList, PAGE_SIZE } from '../lib/usePagedList';

const STATUSES = ['draft', 'final', 'dispatched', 'paid'];

// Tint the inline picker so the column still reads at a glance, like the badge
// did. The ramp follows the stage: nothing sent yet, issued, gone, settled.
const statusTint: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700 border-slate-300',
  final: 'bg-blue-50 text-blue-700 border-blue-300',
  dispatched: 'bg-amber-50 text-amber-800 border-amber-300',
  paid: 'bg-green-50 text-green-700 border-green-300',
};

const label = (s: string) => s[0].toUpperCase() + s.slice(1);
/** What the Status funnel calls each stored value. */
const STATUS_LABELS: Record<string, string> = Object.fromEntries(STATUSES.map((s) => [s, label(s)]));

/**
 * The header funnels (2026-10-16, the client: *"Add this column wise filter in
 * all reports"*). The quotation list's own spec states the rule.
 *
 * Six of the seven headings; *Issued By* is the company, which the select
 * above the table already narrows and which is drawn only for a group with
 * more than one entity.
 *
 * **Status is one of them here**, where on the quotation and proforma lists it
 * is not: theirs is a tick-box picker carrying a default-shown rule a funnel
 * has no notion of, while this one was a plain single-value select — so the
 * funnel replaces it outright rather than sitting beside it. It keeps the
 * `?status=` key through `param`, so the dashboard's own links still land and
 * the dropdown can clear what they set.
 */
const INVOICE_FILTERS: ColumnFilterSpec[] = [
  { key: 'number', label: 'Number', kind: 'values' },
  { key: 'date', label: 'Date', kind: 'dates' },
  { key: 'customer', label: 'Customer', kind: 'values' },
  { key: 'pi', label: 'Ref. PI', kind: 'values' },
  { key: 'total', label: 'Total', kind: 'numbers' },
  { key: 'status', label: 'Status', kind: 'values', param: 'status', labels: STATUS_LABELS },
];

export default function InvoicesPage() {
  // Only worth a column once the group has more than one entity.
  const companies = useCompanies();
  const showCompany = companies.length > 1;
  const [companyFilter, setCompanyFilter] = useUrlFilter('company');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [exportFilter, setExportFilter] = useUrlFilter('export');
  // Server-side, not a filter over the rows on screen: the list is paged,
  // so searching what has been fetched would only search the current page.
  const [search, setSearch] = useUrlFilter('q');
  const [creating, setCreating] = useState(false);
  const columns = useColumnFilters(INVOICE_FILTERS);

  /** One funnel, drawn inside its heading — see the quotation list's own. */
  const filterFor = (key: string) => {
    const spec = INVOICE_FILTERS.find((c) => c.key === key)!;
    return (
      <ColumnFilter
        column={key}
        kind={spec.kind}
        label={spec.label}
        labels={spec.labels}
        value={columns.get(key)}
        onChange={(v) => columns.set(key, v)}
        query={columns.params.toString()}
        path="/api/invoices/facet"
      />
    );
  };

  const params = new URLSearchParams();
  if (exportFilter) params.set('export', exportFilter);
  if (companyFilter) params.set('company', companyFilter);
  if (search) params.set('q', search);
  // The header funnels, Status among them, carried into the rows, the
  // count and the download alike.
  for (const [k, v] of columns.params) params.set(k, v);
  const list = usePagedList<Invoice>(
    // search rides in the key, so typing returns to page 1 rather than
    // leaving somebody on page 7 of a three-row result.
    ['invoices', exportFilter, companyFilter, search, columns.params.toString()],
    `/api/invoices${params.toString() ? `?${params}` : ''}`,
  );
  const invoices = list.rows;

  // Change status without opening the invoice. The server still owns the
  // approval rule — moving an unapproved invoice to an outgoing status comes
  // back as a 409, which surfaces above the table rather than failing silently.
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      api.post<Invoice>(`/api/invoices/${id}/status`, { status }),
    onSuccess: (inv) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice', String(inv.id)] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['approval-count'] });
    },
  });

  return (
    <div>
      <PageHeader
        title="Commercial Invoices"
        subtitle="“This is the final bill.” Export shipments only — domestic sales are invoiced in Tally."
        actions={
          <div className="flex items-center gap-2">
            <DownloadButton href={`/api/invoices/export${params.toString() ? `?${params}` : ''}`} />
            <Button onClick={() => setCreating(true)}>+ New Invoice</Button>
          </div>
        }
      />
      {creating && <NewDocumentDialog basePath="/invoices" title="New Commercial Invoice" exportOnly onClose={() => setCreating(false)} />}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <ExportTabs value={exportFilter} onChange={setExportFilter} />
        {showCompany && (
          <Select value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)} className="max-w-56">
            <option value="">All companies</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.company_name || `Company ${c.id}`}</option>
            ))}
          </Select>
        )}
        <Input
          className="max-w-64"
          placeholder="Search number or customer…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <ErrorText error={setStatus.error} />
      <FilteredByStrip
        columns={columns.filtered}
        onClear={(key) => columns.set(key, {})}
        onClearAll={columns.clearAll}
      />
      <Card className="overflow-x-auto">
        {invoices.length === 0 ? (
          <EmptyState
            message={
              search || exportFilter || companyFilter || columns.filtered.length
                ? 'Nothing matches those filters.'
                : 'No commercial invoices yet. Create one from a confirmed proforma invoice at dispatch time.'
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className={TH_CLASS}>
                <th className="whitespace-nowrap pb-2 pr-3">
                  <span className="flex items-center gap-0.5">Number{filterFor('number')}</span>
                </th>
                <th className="whitespace-nowrap pb-2 pr-3">
                  <span className="flex items-center gap-0.5">Date{filterFor('date')}</span>
                </th>
                <th className="whitespace-nowrap pb-2 pr-3">
                  <span className="flex items-center gap-0.5">Customer{filterFor('customer')}</span>
                </th>
                {showCompany && <th className="pb-2 pr-3">Issued By</th>}
                <th className="whitespace-nowrap pb-2 pr-3">
                  <span className="flex items-center gap-0.5">Ref. PI{filterFor('pi')}</span>
                </th>
                <th className="whitespace-nowrap pb-2 pr-3 text-right">
                  <span className="flex items-center justify-end gap-0.5">Total{filterFor('total')}</span>
                </th>
                <th className="whitespace-nowrap pb-2 pr-3">
                  <span className="flex items-center gap-0.5">Status{filterFor('status')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50" onClick={() => navigate(`/invoices/${inv.id}`)}>
                  <td className="py-2 pr-3 font-medium text-brand-600"><Link to={`/invoices/${inv.id}`}>{inv.number}</Link></td>
                  <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(inv.date)}</td>
                  <td className="py-2 pr-3">{inv.customer_name}</td>
                  {showCompany && (
                    <td className="py-2 pr-3 text-xs text-slate-500">{inv.company_name ?? "—"}</td>
                  )}
                  <td className="py-2 pr-3">{inv.pi_number || '—'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{fmtMoney(inv.grand_total, inv.currency)}</td>
                  {/* Editable in place — the click must not open the invoice. */}
                  <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                    <select
                      value={inv.status}
                      disabled={setStatus.isPending}
                      onChange={(e) => {
                        setStatus.reset();
                        setStatus.mutate({ id: inv.id, status: e.target.value });
                      }}
                      className={`cursor-pointer rounded-full border px-2 py-0.5 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:opacity-50 ${statusTint[inv.status] ?? 'bg-slate-100 text-slate-600 border-slate-300'}`}
                      title="Change status"
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s} className="bg-white text-slate-800">{label(s)}</option>
                      ))}
                    </select>
                    {inv.approval_status === 'pending' && (
                      <span className="ml-1 text-xs text-amber-700" title="Awaiting manager approval">⏳</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination
          page={list.page} pages={list.pages} total={list.total} limit={PAGE_SIZE}
          onPage={list.setPage} noun="invoices"
        />
      </Card>
    </div>
  );
}
