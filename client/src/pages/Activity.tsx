import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { PageHeader, Card, Select, Input, EmptyState, Pagination } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { useUrlFilter } from '../lib/useUrlFilter';
import { usePagedList, PAGE_SIZE } from '../lib/usePagedList';
import { describeChange, splitChanges, ACTION_LABEL, type AuditEntry } from '../lib/audit';

/**
 * The whole audit trail. Manager-only, by the route as well as by this page.
 *
 * Read newest first, which is how anybody arrives at it — something looks
 * wrong now, and the question is what happened recently. The filters exist
 * because the other way in is a specific question ("what did X do last
 * Tuesday"), and they are built from the values actually present rather than
 * from a hardcoded list, so an action added later appears without this file
 * being touched.
 */

/** The slug is the API's word for a thing; this is a person's. */
const ENTITY_LABEL: Record<string, string> = {
  quotations: 'Quotation', proformas: 'Proforma', invoices: 'Invoice', orders: 'Order',
  'packing-lists': 'Packing list', customers: 'Customer', products: 'Product',
  enquiries: 'Enquiry', despatches: 'Despatch', 'work-orders': 'Work order',
  'purchase-orders': 'Purchase order', followups: 'Follow-up', payments: 'Payment',
  users: 'User', companies: 'Company', auth: 'Sign-in',
  locations: 'Location', suppliers: 'Supplier', transporters: 'Transporter',
  materials: 'Material', machines: 'Machine', moulds: 'Mould',
};

/** The entities with a page to link back to. The rest are records without one. */
const LINK: Record<string, (id: number) => string> = {
  quotations: (id) => `/quotations/${id}`,
  proformas: (id) => `/proformas/${id}`,
  invoices: (id) => `/invoices/${id}`,
  orders: (id) => `/orders/${id}`,
  'packing-lists': (id) => `/packing-lists/${id}`,
  customers: () => '/customers',
  products: () => '/products',
  enquiries: () => '/enquiries',
  despatches: () => '/despatches',
  'work-orders': () => '/work-orders',
  'purchase-orders': () => '/purchase-orders',
  followups: () => '/followups',
};

interface Facets {
  entities: string[];
  actions: string[];
  users: { id: number; name: string }[];
}

export default function ActivityPage() {
  const [entity, setEntity] = useUrlFilter('entity');
  const [action, setAction] = useUrlFilter('action');
  const [user, setUser] = useUrlFilter('user');
  const [from, setFrom] = useUrlFilter('from');
  const [to, setTo] = useUrlFilter('to');
  const [q, setQ] = useUrlFilter('q');

  const { data: facets } = useQuery({
    queryKey: ['audit-facets'],
    queryFn: () => api.get<Facets>('/api/audit/facets'),
  });

  /**
   * The date pickers speak local time; the log is stamped in UTC. Converted
   * here rather than on the server, which has no way to know what "today"
   * means to whoever is looking — this desk is five and a half hours ahead of
   * the stamps, so an unconverted "today" would begin at half past five in the
   * morning and quietly take the evening before with it.
   */
  const utcBound = (date: string, end: boolean) => {
    if (!date) return '';
    const d = new Date(`${date}T${end ? '23:59:59.999' : '00:00:00.000'}`);
    return Number.isNaN(d.getTime()) ? date : d.toISOString().slice(0, 19).replace('T', ' ');
  };

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({
    entity, action, user, q, from: utcBound(from, false), to: utcBound(to, true),
  })) if (v) params.set(k, v);
  const list = usePagedList<AuditEntry>(
    ['audit', entity, action, user, from, to, q],
    `/api/audit${params.toString() ? `?${params}` : ''}`,
  );

  return (
    <div>
      <PageHeader
        title="Activity"
        subtitle="Who changed what, and when"
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select className="w-44" value={entity} onChange={(e) => setEntity(e.target.value)}>
          <option value="">Everything</option>
          {(facets?.entities ?? []).map((e) => (
            <option key={e} value={e}>{ENTITY_LABEL[e] ?? e}</option>
          ))}
        </Select>
        <Select className="w-56" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">Any action</option>
          {(facets?.actions ?? []).map((a) => (
            <option key={a} value={a}>{ACTION_LABEL[a] ?? a}</option>
          ))}
        </Select>
        <Select className="w-44" value={user} onChange={(e) => setUser(e.target.value)}>
          <option value="">Anyone</option>
          {(facets?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </Select>
        <Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-sm text-slate-400">to</span>
        <Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} />
        <Input
          className="w-56"
          placeholder="Search number or name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <Card className="overflow-x-auto">
        {list.rows.length === 0 ? (
          <EmptyState message="Nothing recorded for that. The trail begins when the app was updated to keep one — anything changed before then is not in it." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-2 pr-3">When</th>
                <th className="pb-2 pr-3">Who</th>
                <th className="pb-2 pr-3">What</th>
                <th className="pb-2 pr-3">Record</th>
                <th className="pb-2">Changes</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((e) => {
                const href = e.entity_id ? LINK[e.entity]?.(e.entity_id) : undefined;
                const { shown, hidden } = splitChanges(e.changes);
                return (
                  <tr key={e.id} className="border-b border-slate-100 align-top last:border-0">
                    <td className="whitespace-nowrap py-2 pr-3 text-slate-500">{fmtDateTime(e.at)}</td>
                    <td className="whitespace-nowrap py-2 pr-3">
                      {/* The name is stored on the entry, so an account since
                          deleted still says who it was. */}
                      {e.user_name || <span className="text-slate-300">—</span>}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 font-medium">
                      {ACTION_LABEL[e.action] ?? e.action}
                    </td>
                    <td className="py-2 pr-3">
                      <span className="text-xs text-slate-400">{ENTITY_LABEL[e.entity] ?? e.entity}</span>{' '}
                      {href
                        ? <Link className="text-brand-700 hover:underline" to={href}>{e.label || `#${e.entity_id}`}</Link>
                        : <span>{e.label || (e.entity_id ? `#${e.entity_id}` : '')}</span>}
                    </td>
                    <td className="py-2">
                      {e.note && <div className="text-xs text-amber-700">{e.note}</div>}
                      {e.changes.length === 0
                        ? <span className="text-slate-300">—</span>
                        : (
                          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                            {shown.map((c, i) => <span key={i}>{describeChange(c)}</span>)}
                            {hidden > 0 && <span className="text-slate-400">and {hidden} more</span>}
                          </div>
                        )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <Pagination
          page={list.page} pages={list.pages} total={list.total} limit={PAGE_SIZE}
          onPage={list.setPage} noun="entries"
        />
        <p className="mt-2 text-xs text-slate-400">
          Entries are never edited or removed, by anyone — there is no route that would.
          Passwords are never recorded; that one changed is.
        </p>
      </Card>
    </div>
  );
}
