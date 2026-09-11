import { Link, useNavigate } from 'react-router-dom';
import type { CreditNote } from '../types';
import { Select, Input, PageHeader, EmptyState, Card, ExportTabs, Pagination, DownloadButton, StatusBadge, TH_CLASS } from '../components/ui';
import { useCompanies } from '../components/CompanySelect';
import { fmtDate, fmtMoney } from '../lib/format';
import { useUrlFilter } from '../lib/useUrlFilter';
import { usePagedList, PAGE_SIZE } from '../lib/usePagedList';

const KIND_LABEL: Record<string, string> = { return: 'Goods returned', adjustment: 'Adjustment' };

/**
 * Every credit note, newest first. There is no "+ New" here on purpose: a
 * credit note is raised against an invoice, from that invoice's page, so the
 * document it credits is never a thing somebody has to pick from a list.
 */
export default function CreditNotesPage() {
  const companies = useCompanies();
  const showCompany = companies.length > 1;
  const navigate = useNavigate();
  const [companyFilter, setCompanyFilter] = useUrlFilter('company');
  const [kindFilter, setKindFilter] = useUrlFilter('kind');
  const [approvalFilter, setApprovalFilter] = useUrlFilter('approval');
  const [exportFilter, setExportFilter] = useUrlFilter('export');
  const [search, setSearch] = useUrlFilter('q');
  const params = new URLSearchParams();
  if (kindFilter) params.set('kind', kindFilter);
  if (approvalFilter) params.set('approval', approvalFilter);
  if (exportFilter) params.set('export', exportFilter);
  if (companyFilter) params.set('company', companyFilter);
  if (search) params.set('q', search);
  const list = usePagedList<CreditNote>(
    ['credit-notes', kindFilter, approvalFilter, exportFilter, companyFilter, search],
    `/api/credit-notes${params.toString() ? `?${params}` : ''}`,
  );
  const rows = list.rows;
  const filtered = !!(search || kindFilter || approvalFilter || exportFilter || companyFilter);

  return (
    <div>
      <PageHeader
        title="Credit Notes"
        subtitle="What a buyer has been credited — goods returned, or a rate settled after the fact"
        actions={<DownloadButton href={`/api/credit-notes/export${params.toString() ? `?${params}` : ''}`} />}
      />
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
        <Select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} className="max-w-45">
          <option value="">Returns and adjustments</option>
          <option value="return">Goods returned</option>
          <option value="adjustment">Adjustments</option>
        </Select>
        <Select value={approvalFilter} onChange={(e) => setApprovalFilter(e.target.value)} className="max-w-45">
          <option value="">Any approval</option>
          <option value="not_submitted">Not submitted</option>
          <option value="pending">Awaiting approval</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </Select>
        <Input
          className="max-w-64"
          placeholder="Search number, invoice or customer…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <Card className="overflow-x-auto">
        {rows.length === 0 ? (
          <EmptyState
            message={filtered
              ? 'Nothing matches those filters.'
              : 'No credit notes yet. Raise one from a commercial invoice when goods come back or a rate is settled down.'}
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className={TH_CLASS}>
                <th className="pb-2 pr-3">Number</th>
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2 pr-3">Customer</th>
                {showCompany && <th className="pb-2 pr-3">Issued By</th>}
                <th className="pb-2 pr-3">Against invoice</th>
                <th className="pb-2 pr-3">Nature</th>
                <th className="pb-2 pr-3 text-right">Credit</th>
                <th className="pb-2 pr-3">Approval</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((n) => (
                <tr key={n.id} className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50" onClick={() => navigate(`/credit-notes/${n.id}`)}>
                  <td className="py-2 pr-3 font-medium text-brand-600"><Link to={`/credit-notes/${n.id}`}>{n.number}</Link></td>
                  <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(n.date)}</td>
                  <td className="py-2 pr-3">{n.customer_name}</td>
                  {showCompany && <td className="py-2 pr-3 text-xs text-slate-500">{n.company_name ?? '—'}</td>}
                  <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                    <Link to={`/invoices/${n.invoice_id}`} className="text-brand-600 hover:underline">{n.invoice_number}</Link>
                  </td>
                  <td className="py-2 pr-3 text-xs text-slate-600">{KIND_LABEL[n.kind] ?? n.kind}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{fmtMoney(n.grand_total, n.currency)}</td>
                  {/* Approval is this document's whole status: unapproved, it credits nothing. */}
                  <td className="py-2 pr-3"><StatusBadge status={n.approval_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination
          page={list.page} pages={list.pages} total={list.total} limit={PAGE_SIZE}
          onPage={list.setPage} noun="credit notes"
        />
      </Card>
    </div>
  );
}
