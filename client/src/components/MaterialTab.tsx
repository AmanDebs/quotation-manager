import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Order, WorkOrder, StockRow } from '../types';
import { Card, EmptyState, TH_CLASS } from './ui';
import { fmtQty, fmtMoney } from '../lib/format';

/**
 * What this order needs, and whether it is in the store.
 *
 * Requirement comes from the recipes on the open jobs; on hand is the sum of
 * the ledger. A job whose product has no recipe is named rather than counted
 * as needing nothing — that distinction is the whole point, because a
 * shortfall report that silently skips half the floor is worse than none.
 */
export default function MaterialTab({ order }: { order: Order }) {

  const { data: jobs = [] } = useQuery({
    queryKey: ['work-orders', String(order.id)],
    queryFn: () => api.get<WorkOrder[]>(`/api/work-orders?order_id=${order.id}`),
  });
  const { data: stock = [] } = useQuery({
    queryKey: ['stock'],
    queryFn: () => api.get<StockRow[]>('/api/stock'),
  });

  const open = jobs.filter((w) => !['done', 'cancelled'].includes(w.status));

  // Requirement for what is left to make on each open job, added per material.
  // Remaining, not the whole plan: resin for pieces already moulded has been
  // consumed, and counting it again would order it twice.
  const { data: details = [] } = useQuery({
    queryKey: ['work-order-details', String(order.id), open.map((w) => w.id).join()],
    queryFn: () => Promise.all(open.map((w) => api.get<WorkOrder>(`/api/work-orders/${w.id}`))),
    enabled: open.length > 0,
  });

  const need = new Map<number, { name: string; unit: string; qty: number; issued: number }>();
  const uncosted: WorkOrder[] = [];
  for (const w of details) {
    if (!w.material?.has_recipe) { uncosted.push(w); continue; }
    const remaining = Math.max(0, w.qty_planned - (w.progress?.produced ?? 0));
    const share = w.qty_planned > 0 ? remaining / w.qty_planned : 0;
    for (const l of w.material.lines) {
      const seen = need.get(l.material_id);
      const qty = l.qty * share;
      if (seen) { seen.qty += qty; seen.issued += l.issued; }
      else need.set(l.material_id, { name: l.name, unit: l.unit, qty, issued: l.issued });
    }
  }

  const onHandFor = (materialId: number) =>
    stock.filter((s) => s.material_id === materialId).reduce((t, s) => t + s.qty, 0);
  const onOrderFor = (materialId: number) =>
    stock.find((s) => s.material_id === materialId)?.on_order ?? 0;

  // What has actually been consumed against this order so far, at the moving
  // average in force when each issue was made. Deliberately shown beside the
  // order's own value rather than as a margin: the cost is only as complete as
  // the issues behind it, which `jobs_without_issues` says plainly.
  const cost = order.costing;

  return (
    <div className="space-y-4">
      {!!cost && (cost.material_cost > 0 || cost.jobs_issued > 0) && (
        <Card title="Material cost so far">
          <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
            <div>
              <div className="text-xs text-slate-500">Issued to this order</div>
              <div className="text-xl font-bold tabular-nums">{fmtMoney(cost.material_cost, order.currency)}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Order value</div>
              <div className="text-xl font-bold tabular-nums text-slate-500">
                {fmtMoney(Number(order.grand_total) || 0, order.currency)}
              </div>
            </div>
            {Number(order.grand_total) > 0 && cost.jobs_without_issues === 0 && cost.material_cost > 0 && (
              <div>
                <div className="text-xs text-slate-500">Material as a share of value</div>
                <div className="text-xl font-bold tabular-nums">
                  {Math.round((cost.material_cost / Number(order.grand_total)) * 100)}%
                </div>
              </div>
            )}
          </div>
          {cost.jobs_without_issues > 0 && (
            <p className="mt-2 text-xs text-amber-700">
              {cost.jobs_without_issues} job{cost.jobs_without_issues === 1 ? ' has' : 's have'} drawn no
              material yet, so this is the cost of what has been issued — not the finished order.
            </p>
          )}
          <p className="mt-1 text-xs text-slate-400">
            Valued at the moving average when each issue was made, so a later purchase at a different rate
            does not re-price what has already been consumed. Material only — labour and overhead are not
            tracked.
          </p>
        </Card>
      )}

      <Card title="Material for what is still to make">
        {open.length === 0 ? (
          <EmptyState message="No open jobs on this order, so nothing is needed." />
        ) : need.size === 0 && uncosted.length === 0 ? (
          <EmptyState message="Loading…" />
        ) : (
          <>
            {need.size > 0 && (
              <table className="w-full text-sm">
                <thead>
                  <tr className={TH_CLASS}>
                    <th className="pb-2 pr-3">Material</th>
                    <th className="pb-2 pr-3 text-right">Needed</th>
                    <th className="pb-2 pr-3 text-right">Issued</th>
                    <th className="pb-2 pr-3 text-right">In store</th>
                    <th className="pb-2 pr-3 text-right">On order</th>
                    <th className="pb-2 pr-3 text-right">Short</th>
                  </tr>
                </thead>
                <tbody>
                  {[...need].map(([id, n]) => {
                    const have = onHandFor(id);
                    const coming = onOrderFor(id);
                    const short = Math.max(0, n.qty - have - coming);
                    return (
                      <tr key={id} className="border-b border-slate-100 last:border-0">
                        <td className="py-2 pr-3 font-medium">{n.name}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{fmtQty(n.qty)} {n.unit}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-slate-500">{n.issued ? fmtQty(n.issued) : '—'}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{fmtQty(have)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-slate-500">{coming ? fmtQty(coming) : '—'}</td>
                        <td className={`py-2 pr-3 text-right tabular-nums ${short > 0 ? 'font-semibold text-red-600' : 'text-green-700'}`}>
                          {short > 0 ? fmtQty(short) : 'covered'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {uncosted.length > 0 && (
              <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <strong>Not costed:</strong>{' '}
                {uncosted.map((w) => w.number).join(', ')} — the product has no recipe, so nothing above
                accounts for {uncosted.length === 1 ? 'it' : 'them'}. Add one under Products → Recipe.
              </div>
            )}
          </>
        )}
      </Card>

      {/*
        The "Issue material to a job" card was here, one row per open job with
        an Issue button. Issuing is a **job-level** act — `material_moves`
        carries a `work_order_id` — and the job now has a page that does it in
        context, beside what that job needs and what it has already drawn. A
        second door to the same modal, from a list that repeats the Production
        tab's, was the copy worth losing.
      */}
    </div>
  );
}
