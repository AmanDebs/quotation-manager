import { useMemo, useState } from 'react';
import type { LineItem } from '../types';
import { Card } from './ui';
import { fitmentPlan, type ContainerSize } from '../lib/containerPlan';

/**
 * How many containers this proforma's goods actually need.
 *
 * Working information for the person raising the document, not part of it: this
 * never reaches the PDF. The customer's copy states whatever was negotiated in
 * the Container field; this panel is how you find out whether that number is
 * right before you commit to it.
 *
 * The maths is the Container Planner's requirement mode, reused rather than
 * re-derived — capacity is not one number, since a box of preforms and a box of
 * handles occupy different fractions of the same container. One box of line i
 * takes 1/Cᵢ of a container, and the load has to satisfy Σ(boxesᵢ/Cᵢ) ≤ containers.
 *
 * Two rules carried over from the planner, both of which matter here:
 *
 * - **One plan, one container size.** Space is expressed as a fraction of its
 *   own container type, so a figure mixing 20ft and 40ft would mean nothing.
 * - **A line with no loadability recorded is flagged, never dropped.** It
 *   contributes no space, so the container count below it would be an
 *   under-estimate presented as an answer.
 *
 * Charge lines are excluded outright, as everywhere else — freight is not
 * something that goes in a box.
 */

const fmt = (n: number, dp = 0) =>
  n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });

export default function ContainerFitment({
  items, containerCount,
}: {
  items: LineItem[];
  /** The free-text Container field, used only to guess the size to open on. */
  containerCount?: string;
}) {
  // A per-document choice, but not part of the document — it is not printed and
  // not stored, so it lives here rather than costing a column. Opening on
  // whatever the Container field mentions makes the guess right most of the time.
  const [size, setSize] = useState<ContainerSize>(
    /\b20/.test(String(containerCount ?? '')) ? '20ft' : '40ft'
  );

  const plan = useMemo(() => fitmentPlan(items, size), [items, size]);

  const priced = plan.rows.filter((r) => r.boxes > 0);
  const unknown = plan.rows.filter((r) => r.boxes > 0 && !r.boxesPerContainer);
  const totalBoxes = priced.reduce((s, r) => s + r.boxes, 0);

  return (
    <Card
      title="Container Fitment"
      actions={
        <div className="flex items-center gap-1 rounded-md border border-slate-200 p-0.5 text-sm">
          {(['20ft', '40ft'] as ContainerSize[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSize(s)}
              className={`rounded px-2.5 py-1 ${
                size === s ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      }
    >
      <p className="mb-3 text-xs text-slate-500">
        Working figure only — this is not printed on the proforma.
      </p>

      {priced.length === 0 ? (
        <p className="text-sm text-slate-400">
          Add line items with a box count to see how many containers they need.
        </p>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-md bg-slate-50 p-3">
              <div className="text-xs uppercase tracking-wide text-slate-500">Containers</div>
              <div className="text-2xl font-semibold tabular-nums">
                {plan.containers}
                <span className="ml-1 text-sm font-normal text-slate-500">× {size}</span>
              </div>
            </div>
            <div className="rounded-md bg-slate-50 p-3">
              <div className="text-xs uppercase tracking-wide text-slate-500">Space used</div>
              <div className="text-2xl font-semibold tabular-nums">{fmt(plan.spaceUsed, 2)}</div>
            </div>
            <div className="rounded-md bg-slate-50 p-3">
              <div className="text-xs uppercase tracking-wide text-slate-500">Utilisation</div>
              <div
                className={`text-2xl font-semibold tabular-nums ${
                  plan.utilisation >= 90 ? 'text-green-700' : plan.utilisation >= 70 ? 'text-slate-800' : 'text-amber-700'
                }`}
              >
                {fmt(plan.utilisation, 1)}%
              </div>
            </div>
            <div className="rounded-md bg-slate-50 p-3">
              <div className="text-xs uppercase tracking-wide text-slate-500">Boxes</div>
              <div className="text-2xl font-semibold tabular-nums">{fmt(totalBoxes)}</div>
            </div>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="pb-1 pr-3">Item</th>
                <th className="pb-1 pr-3 text-right">Boxes</th>
                <th className="pb-1 pr-3 text-right">Boxes / {size}</th>
                <th className="pb-1 pr-3 text-right">Space</th>
                <th className="pb-1 text-right">Share</th>
              </tr>
            </thead>
            <tbody>
              {priced.map((r) => (
                <tr key={r.productId} className="border-b border-slate-100 last:border-0">
                  <td className="py-1.5 pr-3">
                    {r.name}
                    {!r.boxesPerContainer && (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                        no loadability
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(r.boxes)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-slate-500">
                    {r.boxesPerContainer ? fmt(r.boxesPerContainer) : '—'}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {r.boxesPerContainer ? fmt(r.space, 3) : '—'}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-slate-500">
                    {r.boxesPerContainer ? `${fmt(r.sharePct, 1)}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {plan.leftover && (
            <p className="mt-3 text-sm text-slate-600">
              Room left in the last container for about{' '}
              <span className="font-semibold tabular-nums">{fmt(plan.leftover.boxes)}</span> more boxes
              of {plan.leftover.name}.
            </p>
          )}

          {unknown.length > 0 && (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <div className="font-semibold">
                {unknown.length === 1 ? 'One line has' : `${unknown.length} lines have`} no {size} loadability recorded
              </div>
              <p className="mt-0.5 text-amber-800">
                {unknown.map((r) => r.name).join(', ')} — {unknown.length === 1 ? 'its' : 'their'} boxes
                are counted above but occupy no space in the container figure, so the real requirement is
                higher. Set boxes per {size} on the product to include {unknown.length === 1 ? 'it' : 'them'}.
              </p>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
