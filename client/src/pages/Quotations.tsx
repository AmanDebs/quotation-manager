import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Quotation } from '../types';
import { Button, Select, Input, PageHeader, EmptyState, Card, ExportTabs, ErrorText, Pagination, DownloadButton, MultiSelectFilter } from '../components/ui';
import NewDocumentDialog from '../components/NewDocumentDialog';
import InternalNotes from '../components/InternalNotes';
import { useCompanies } from '../components/CompanySelect';
import { fmtDate, fmtMoney } from '../lib/format';
import { useUrlFilter } from '../lib/useUrlFilter';
import { usePagedList, PAGE_SIZE } from '../lib/usePagedList';

const approvalBadge: Record<string, { cls: string; label: string }> = {
  pending: { cls: 'bg-amber-100 text-amber-700', label: 'Awaiting approval' },
  rejected: { cls: 'bg-red-100 text-red-700', label: 'Rejected' },
  not_submitted: { cls: 'bg-slate-100 text-slate-500', label: 'Not submitted' },
};

const STATUSES = ['draft', 'sent', 'negotiating', 'accepted', 'rejected', 'expired'];

// Tint the inline picker so the list still reads at a glance, like the badge did.
const statusTint: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700 border-slate-300',
  sent: 'bg-blue-50 text-blue-700 border-blue-300',
  negotiating: 'bg-amber-50 text-amber-800 border-amber-300',
  accepted: 'bg-green-50 text-green-700 border-green-300',
  rejected: 'bg-red-50 text-red-700 border-red-300',
  expired: 'bg-slate-100 text-slate-500 border-slate-300',
};

export default function QuotationsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // In the URL, so the dashboard can link to one slice of the list and the
  // back button undoes a filter instead of leaving the page.
  const [statusFilter, setStatusFilter] = useUrlFilter('status');
  const [exportFilter, setExportFilter] = useUrlFilter('export');
  // Server-side, not a filter over the rows on screen: the list is paged, so
  // searching what has been fetched would only ever search the current page.
  const [search, setSearch] = useUrlFilter('q');
  const [creating, setCreating] = useState(false);
  // Only worth a column once the group actually has more than one entity.
  const companies = useCompanies();
  const showCompany = companies.length > 1;
  const [companyFilter, setCompanyFilter] = useUrlFilter('company');
  // Which rows have their note panel open. Keyed by quotation id rather than
  // index, so filtering the list cannot open the wrong one.
  const [openNotes, setOpenNotes] = useState<Set<number>>(new Set());

  const toggleNote = (id: number) =>
    setOpenNotes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const params = new URLSearchParams();
  if (statusFilter) params.set('status', statusFilter);
  if (exportFilter) params.set('export', exportFilter);
  if (companyFilter) params.set('company', companyFilter);
  if (search) params.set('q', search);
  const list = usePagedList<Quotation>(
    // search rides in the key, so typing returns to page 1 rather than
    // leaving somebody on page 7 of a four-row result.
    ['quotations', statusFilter, exportFilter, companyFilter, search],
    `/api/quotations${params.toString() ? `?${params}` : ''}`,
  );
  const quotations = list.rows;

  // Change status without leaving the list. The server still enforces the
  // approval rule, so a blocked change surfaces as an error here.
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      api.post<Quotation>(`/api/quotations/${id}/status`, { status }),
    onSuccess: (q) => {
      queryClient.invalidateQueries({ queryKey: ['quotations'] });
      queryClient.invalidateQueries({ queryKey: ['quotation', String(q.id)] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['approval-count'] });
    },
  });

  return (
    <div>
      <PageHeader
        title="Quotations"
        subtitle="“This is our price.”"
        actions={
          <div className="flex items-center gap-2">
            <DownloadButton href={`/api/quotations/export${params.toString() ? `?${params}` : ''}`} />
            <Button onClick={() => setCreating(true)}>+ New Quotation</Button>
          </div>
        }
      />
      {creating && <NewDocumentDialog basePath="/quotations" title="New Quotation" onClose={() => setCreating(false)} />}
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
        <MultiSelectFilter
          options={STATUSES.map((s) => ({ key: s, label: s[0].toUpperCase() + s.slice(1) }))}
          value={statusFilter}
          onChange={setStatusFilter}
          // Names the default rather than sitting blank: the list drops
          // rejected quotations unless asked, and a box saying "All statuses"
          // over a list that is hiding some would be a small lie.
          defaultLabel="Open (rejected hidden)"
          allLabel="All statuses"
        />
        <Input
          className="max-w-64"
          placeholder="Search number or customer…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <ErrorText error={setStatus.error} />
      <Card className="overflow-x-auto">
        {quotations.length === 0 ? (
          <EmptyState
            message={
              search || statusFilter || exportFilter || companyFilter
                ? 'Nothing matches those filters.'
                // Rejected rows are dropped even with no filter set, so an
                // empty table here is not proof the book is empty.
                : 'No open quotations. Rejected ones are hidden — pick “All statuses” to include them.'
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-2 pr-3">Number</th>
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2 pr-3">Customer</th>
                {showCompany && <th className="pb-2 pr-3">Issued By</th>}
                <th className="pb-2 pr-3">Type</th>
                <th className="pb-2 pr-3 text-right">Total</th>
                <th className="pb-2 pr-3">Status</th>
                <th className="pb-2 pr-3">Approval</th>
                <th className="w-8 pb-2" />
              </tr>
            </thead>
            {quotations.map((q) => {
              const noteOpen = openNotes.has(q.id);
              const hasNote = !!q.internal_notes?.trim();
              return (
              <tbody key={q.id} className="border-b border-slate-100 last:border-0">
                <tr className="cursor-pointer hover:bg-slate-50" onClick={() => navigate(`/quotations/${q.id}`)}>
                  <td className="py-2 pr-3 font-medium text-brand-600">
                    <Link to={`/quotations/${q.id}`}>{q.number}{q.revision > 0 && <span className="text-slate-400"> R{q.revision}</span>}</Link>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(q.date)}</td>
                  <td className="py-2 pr-3">{q.customer_name}</td>
                  {showCompany && (
                    <td className="py-2 pr-3 text-xs text-slate-500">{q.company_name ?? "—"}</td>
                  )}
                  <td className="py-2 pr-3 text-xs">{q.is_export ? '🌍 Export' : '🇮🇳 Domestic'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{q.grand_total ? fmtMoney(q.grand_total, q.currency) : '—'}</td>
                  {/* Editable in place — the click must not open the quotation. */}
                  <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                    <select
                      value={q.status}
                      disabled={setStatus.isPending}
                      onChange={(e) => {
                        setStatus.reset();
                        setStatus.mutate({ id: q.id, status: e.target.value });
                      }}
                      className={`cursor-pointer rounded-full border px-2 py-0.5 text-xs font-medium capitalize focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:opacity-50 ${statusTint[q.status] ?? 'bg-slate-100 text-slate-600 border-slate-300'}`}
                      title="Change status"
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s} className="bg-white text-slate-800">
                          {s[0].toUpperCase() + s.slice(1)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-3">
                    {q.approval_status === 'approved' ? (
                      <span className="text-xs text-green-700">✓ Approved</span>
                    ) : (
                      <span className={`rounded-full px-2 py-0.5 text-xs ${approvalBadge[q.approval_status]?.cls ?? ''}`}>
                        {approvalBadge[q.approval_status]?.label ?? q.approval_status}
                      </span>
                    )}
                  </td>
                  {/* Opens the note in place — the click must not open the quotation. */}
                  <td className="py-2 text-right" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => toggleNote(q.id)}
                      aria-expanded={noteOpen}
                      className={`rounded px-1 focus:outline-none focus:ring-1 focus:ring-brand-600 ${
                        hasNote ? 'text-brand-600' : 'text-slate-300 hover:text-slate-500'
                      }`}
                      title={hasNote ? 'Internal note' : 'Add an internal note'}
                      aria-label={hasNote ? `Internal note on ${q.number}` : `Add an internal note to ${q.number}`}
                    >🗒</button>
                  </td>
                </tr>

                {noteOpen && (
                  <tr onClick={(e) => e.stopPropagation()}>
                    <td colSpan={showCompany ? 9 : 8} className="cursor-default px-1 pb-3">
                      <div className="rounded-md border border-slate-200 bg-slate-50/70 p-3">
                        <InternalNotes docType="quotation" docId={q.id} value={q.internal_notes ?? ""} autoFocus />
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
              );
            })}
          </table>
        )}
        <Pagination
          page={list.page} pages={list.pages} total={list.total} limit={PAGE_SIZE}
          onPage={list.setPage} noun="quotations"
        />
      </Card>
    </div>
  );
}
