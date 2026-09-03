import type { LineItem } from '../types';
import { Card } from './ui';
import type { ContainerSize, PlanResult } from '../lib/containerPlan';

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
 *
 * It used to print every line again underneath — Item, Boxes, Pcs/Box, Total
 * Pieces, Boxes per container, Space, Share — and six of those columns were
 * already on screen in the Line Items table above, in the boxes they had been
 * typed into. The one figure only that table could give is **Share**, and it
 * now sits in the items table as a column of its own. What is left here is what
 * this panel alone can say: how many containers, how full, and what is missing.
 *
 * The size is chosen here and owned by the form, because the Share column has
 * to be read against the same container — one plan, one size, as ever.
 */

const fmt = (n: number, dp = 0) =>
  n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });

export default function ContainerFitment({
  items, plan, size, onSize,
}: {
  items: LineItem[];
  /** Computed by the form, which reads the same plan for the Share column. */
  plan: PlanResult;
  size: ContainerSize;
  onSize: (size: ContainerSize) => void;
}) {
  const priced = plan.rows.filter((r) => r.boxes > 0);
  const unknown = plan.rows.filter((r) => r.boxes > 0 && !r.boxesPerContainer);
  const totalBoxes = priced.reduce((s, r) => s + r.boxes, 0);

  // Nothing to fit yet. On a new proforma this sat above the fold as a whole
  // card reporting an absence — the question it answers does not exist until
  // there is something to load. Below the hooks, never above: a return between
  // them changes the hook order and React unmounts the page.
  if (!items.some((it) => !it.is_charge)) return null;

  return (
    <Card
      title="Container Fitment"
      actions={
        <div className="flex items-center gap-1 rounded-md border border-slate-200 p-0.5 text-sm">
          {(['20ft', '40ft'] as ContainerSize[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSize(s)}
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
                are counted in the Boxes total but occupy no space in the container figure, so the real
                requirement is higher. Set boxes per {size} on the product to include {unknown.length === 1 ? 'it' : 'them'}.
              </p>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
