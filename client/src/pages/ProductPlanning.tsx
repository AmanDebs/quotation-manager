import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { ProductPlanResponse, ProductPlan, ColourPlan } from '../types';
import { PageHeader, Card, Input, EmptyState, ExportTabs, TH_CLASS, CAPTION_CLASS, BAND_CLASS } from '../components/ui';
import { fmtQty, fmtDate } from '../lib/format';
import { useUrlFilter } from '../lib/useUrlFilter';

/**
 * Product-wise production planning (2026-11-24, the client asking for a
 * planning system on the hierarchy **product → colour → work order →
 * date → line → shift**).
 *
 * This is the top of it, and the first three levels are all that can be drawn
 * without storing anything: a product's demand is the sum of its colours',
 * which is the sum of the work orders under them — because colour lives on the
 * order line and a job is one order line. So the two reconciliation rules this
 * screen is judged by hold **by construction**, and there is no target column
 * anywhere that could come to disagree with the orders behind it.
 *
 * A product row opens to its colours and a colour row to its work orders, the
 * shape *Raw Material Required* already uses — because the live book is
 * hundreds of lines and a flat listing of the lot is not a page anybody can
 * read from the top, while a bare total answers neither half of a question
 * that names a product and a colour.
 *
 * **It narrows with the order book.** The server reads `lineFilters`, so the
 * export/domestic tabs and the search box here mean exactly what they mean on
 * the order book — and a link carrying any of its thirteen column filters
 * (`?f.color=Natural`) lands narrowed, which is how a colour is read on its
 * own without this page needing a control of its own for every column.
 */

/** A figure that is a gap rather than a quantity recedes when it is zero. */
const gap = (n: number) => (n > 0 ? 'text-amber-700' : 'text-slate-300');

/** The rate and where it came from, or the reason there is none. */
function RateCell({ row }: { row: ProductPlan }) {
  if (!row.rate) {
    return (
      <span
        className="text-slate-400"
        title={row.pending > 0
          ? 'No output rate for this product, so the days cannot be worked out. Type one on the product, or plan its jobs by hand.'
          : 'Nothing is pending, so no rate is needed.'}
      >—</span>
    );
  }
  const r = row.rate;
  const measured = r.source === 'measured'
    ? `Measured over ${r.days} day${r.days === 1 ? '' : 's'}, last run ${fmtDate(r.last_run)}`
    : `Typed on the product${r.measured ? `. The shifts booked so far work out at ${fmtQty(r.measured.pcs_per_day)}/day over ${r.measured.days} days` : ''}`;
  return (
    <span title={measured}>
      {fmtQty(r.pcs_per_day)}
      {/* The marker the planner's own queue uses for an override, so a typed
          figure can be told from a measured one down the column. */}
      {r.source === 'stated' && <span className="text-brand-600">*</span>}
    </span>
  );
}

export default function ProductPlanningPage() {
  const [exportFilter, setExportFilter] = useUrlFilter('export');
  const [q, setQ] = useUrlFilter('q');
  const [openProducts, setOpenProducts] = useState<Set<string>>(() => new Set());
  const [openColours, setOpenColours] = useState<Set<string>>(() => new Set());

  const params = new URLSearchParams();
  if (exportFilter) params.set('export', exportFilter);
  if (q) params.set('q', q);

  const { data, isPending } = useQuery<ProductPlanResponse>({
    queryKey: ['product-plan', exportFilter, q],
    queryFn: () => api.get<ProductPlanResponse>(`/api/orders/product-plan?${params.toString()}`),
  });

  const toggle = <T,>(set: Set<T>, put: (s: Set<T>) => void, key: T) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    put(next);
  };

  const rows = data?.rows ?? [];
  const s = data?.summary;
  /* Product row: chevron+item, ordered, planned, made, pending, unplanned,
     rate, days, next due, jobs. */
  const COLS = 10;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Product Planning"
        subtitle="What is wanted, by product and colour, and how long it takes"
      />

      <div className="flex flex-wrap items-center gap-2">
        <ExportTabs value={exportFilter} onChange={setExportFilter} />
        <Input
          className="w-72"
          placeholder="Search product, colour, customer, order no.…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {s && (
        <Card title="The book as it stands">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
            {([
              ['Products', fmtQty(s.products)],
              ['Colours', fmtQty(s.colours)],
              ['Work orders', fmtQty(s.jobs)],
              ['Ordered', fmtQty(s.ordered)],
              ['Made', fmtQty(s.made)],
              ['Pending', fmtQty(s.pending)],
            ] as const).map(([label, value]) => (
              <div key={label}>
                <div className={CAPTION_CLASS}>{label}</div>
                <div className="text-sm font-semibold text-slate-900">{value}</div>
              </div>
            ))}
            <div>
              {/* Demand no job covers. Named rather than hidden: pieces sold
                  and instructed to nobody is what this page exists to find. */}
              <div className={CAPTION_CLASS}>Not instructed</div>
              <div className={`text-sm font-semibold ${s.unplanned > 0 ? 'text-amber-700' : 'text-slate-300'}`}>
                {fmtQty(s.unplanned)}
              </div>
            </div>
          </div>
          {s.no_rate > 0 && (
            <p className="mt-3 text-xs text-amber-700">
              {s.no_rate} product{s.no_rate === 1 ? '' : 's'} with work pending{' '}
              {s.no_rate === 1 ? 'has' : 'have'} no output rate, so the days cannot be worked
              out for {s.no_rate === 1 ? 'it' : 'them'} —{' '}
              <Link to="/products?missing=rate" className="underline">set one on the product</Link>.
            </p>
          )}
        </Card>
      )}

      <Card title="Product → colour → work order">
        {isPending ? (
          <div className="p-6 text-sm text-slate-500">Working it out…</div>
        ) : !rows.length ? (
          <EmptyState message={exportFilter || q
            ? 'Nothing matches those filters.'
            : 'No open sales order line, so there is nothing to plan yet.'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className={TH_CLASS}>
                  <th className="px-3 py-2 text-left">Product</th>
                  <th className="px-3 py-2 text-right">Ordered</th>
                  <th className="px-3 py-2 text-right">Instructed</th>
                  <th className="px-3 py-2 text-right">Made</th>
                  <th className="px-3 py-2 text-right">Pending</th>
                  <th className="px-3 py-2 text-right">Not instr.</th>
                  <th className="px-3 py-2 text-right">Rate/day</th>
                  <th className="px-3 py-2 text-right">Days</th>
                  <th className="px-3 py-2 text-left">Next due</th>
                  <th className="px-3 py-2 text-right">Jobs</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const isOpen = openProducts.has(p.key);
                  return (
                    <Fragment key={p.key}>
                      <tr
                        className={`cursor-pointer border-t border-slate-200 ${BAND_CLASS}`}
                        onClick={() => toggle(openProducts, setOpenProducts, p.key)}
                        title={isOpen ? `Fold ${p.item}` : `Show the ${p.colours.length} colour${p.colours.length === 1 ? '' : 's'} of ${p.item}`}
                      >
                        <td className="px-3 py-2">
                          <span className="mr-1 inline-block w-3 text-slate-400">{isOpen ? '▾' : '▸'}</span>
                          <span className="font-semibold text-slate-900">{p.item}</span>
                          <span className="ml-2 text-slate-400">
                            {p.colours.length} colour{p.colours.length === 1 ? '' : 's'} · {p.orders} order{p.orders === 1 ? '' : 's'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtQty(p.ordered)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtQty(p.planned)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtQty(p.made)}</td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtQty(p.pending)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${gap(p.unplanned)}`}>{fmtQty(p.unplanned)}</td>
                        <td className="px-3 py-2 text-right tabular-nums"><RateCell row={p} /></td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {p.days === null ? <span className="text-slate-300">—</span> : fmtQty(p.days)}
                        </td>
                        <td className="px-3 py-2">{p.next_due ? fmtDate(p.next_due) : <span className="text-slate-300">—</span>}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {p.jobs}
                          {p.jobs > 0 && <span className="text-slate-400"> ({p.dated} dated)</span>}
                        </td>
                      </tr>

                      {isOpen && p.colours.map((c) => (
                        <ColourRows
                          key={`${p.key}|${c.color}`}
                          product={p}
                          colour={c}
                          cols={COLS}
                          open={openColours.has(`${p.key}|${c.color}`)}
                          onToggle={() => toggle(openColours, setOpenColours, `${p.key}|${c.color}`)}
                        />
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-xs text-slate-500">
        <strong>Ordered</strong> is what the customers have asked for, in pieces.{' '}
        <strong>Instructed</strong> is what the work orders tell the floor to make, so{' '}
        <strong>Not instructed</strong> is demand no job covers yet.{' '}
        <strong>Made</strong> counts good pieces and drops a scrapped lot, and{' '}
        <strong>Pending</strong> is what is still owed. A rate marked{' '}
        <span className="text-brand-600">*</span> was typed on the product; the rest are
        measured from the shift book.
      </p>
    </div>
  );
}

/** One colour under a product, and the work orders it is wanted for. */
function ColourRows({ product, colour, cols, open, onToggle }: {
  product: ProductPlan;
  colour: ColourPlan;
  cols: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
        onClick={onToggle}
        title={open ? 'Fold this colour' : `Show the ${colour.jobs} work order${colour.jobs === 1 ? '' : 's'}`}
      >
        <td className="px-3 py-1.5 pl-8">
          <span className="mr-1 inline-block w-3 text-slate-400">{colour.jobs ? (open ? '▾' : '▸') : ''}</span>
          {/* A line stating no colour is an absence, not a fault — the
              em-dash rule this app applies to every blank cell. */}
          {colour.color || <span className="text-slate-400">— no colour stated</span>}
          <span className="ml-2 text-slate-400">{colour.orders} order{colour.orders === 1 ? '' : 's'}</span>
        </td>
        <td className="px-3 py-1.5 text-right tabular-nums">{fmtQty(colour.ordered)}</td>
        <td className="px-3 py-1.5 text-right tabular-nums">{fmtQty(colour.planned)}</td>
        <td className="px-3 py-1.5 text-right tabular-nums">{fmtQty(colour.made)}</td>
        <td className="px-3 py-1.5 text-right tabular-nums">{fmtQty(colour.pending)}</td>
        <td className={`px-3 py-1.5 text-right tabular-nums ${gap(colour.unplanned)}`}>{fmtQty(colour.unplanned)}</td>
        {/* The rate is the product's, so it is not restated per colour — it
            would be the same figure on every row under the one above. */}
        <td className="px-3 py-1.5" />
        <td className="px-3 py-1.5 text-right tabular-nums text-slate-400">
          {product.rate && product.rate.pcs_per_day > 0 && colour.pending > 0
            ? fmtQty(Math.max(1, Math.ceil(colour.pending / product.rate.pcs_per_day)))
            : ''}
        </td>
        <td className="px-3 py-1.5">{colour.next_due ? fmtDate(colour.next_due) : ''}</td>
        <td className="px-3 py-1.5 text-right tabular-nums">
          {colour.jobs}
          {colour.jobs > 0 && <span className="text-slate-400"> ({colour.dated} dated)</span>}
        </td>
      </tr>

      {open && colour.work_orders.length > 0 && (
        <tr className="border-t border-slate-100">
          <td colSpan={cols} className="bg-slate-50/70 px-3 pb-3 pt-1">
            <table className="w-full text-xs">
              <thead>
                <tr className={TH_CLASS}>
                  <th className="px-2 py-1 text-left">Work order</th>
                  <th className="px-2 py-1 text-left">Sales order</th>
                  <th className="px-2 py-1 text-left">Customer</th>
                  <th className="px-2 py-1 text-right">To make</th>
                  <th className="px-2 py-1 text-right">Made</th>
                  <th className="px-2 py-1 text-right">Balance</th>
                  <th className="px-2 py-1 text-left">Status</th>
                  <th className="px-2 py-1 text-left">Start</th>
                  <th className="px-2 py-1 text-left">Finish</th>
                </tr>
              </thead>
              <tbody>
                {colour.work_orders.map((w) => (
                  <tr key={w.id} className="border-t border-slate-100">
                    <td className="px-2 py-1">
                      <Link to={`/work-orders/${w.id}`} className="text-brand-600 hover:underline">{w.number}</Link>
                    </td>
                    <td className="px-2 py-1">
                      <Link to={`/orders/${w.order_id}`} className="text-brand-600 hover:underline">{w.order_number}</Link>
                    </td>
                    <td className="max-w-[14rem] truncate px-2 py-1" title={w.customer_name}>{w.customer_name}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{fmtQty(w.qty_planned)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{fmtQty(w.made)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{fmtQty(w.balance)}</td>
                    <td className="px-2 py-1">{w.status}</td>
                    {/* The dates that stand — revised where set, else planned.
                        Blank is honest: most of the book carries no plan. */}
                    <td className="px-2 py-1">{w.start ? fmtDate(w.start) : <span className="text-slate-300">—</span>}</td>
                    <td className="px-2 py-1">{w.end ? fmtDate(w.end) : <span className="text-slate-300">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
