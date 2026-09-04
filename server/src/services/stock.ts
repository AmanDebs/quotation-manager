import { db } from '../db/connection.js';
import { round2 } from './totals.js';
import { requirementFor } from './recipe.js';
// The only place allowed to answer how far along an order line is, so the
// order-book basis asks it rather than walking the same tables again.
import { orderLines } from './orderLines.js';

/**
 * How much material there is, and how much is short.
 *
 * The only place allowed to answer either — the rule `services/receivables.ts`
 * follows for credit and `dispatchProgress()` for shipments. On-hand is the
 * signed sum of `material_moves`; there is no stock column anywhere, so a
 * figure cannot drift from the movements that produced it, and every kilo is
 * traceable to a receipt, an issue or an adjustment.
 *
 * Stock is held **per location**. Aglo despatches from two plants, and
 * "we have 5 tonnes" is not useful when it is all at the wrong one, so
 * nothing here pools locations unless it is asked to.
 */

export interface OnHandRow {
  material_id: number;
  location_id: number;
  material_name: string;
  unit: string;
  category: string;
  location_name: string;
  qty: number;
}

/** On hand for one material, at one location or across all of them. */
export function onHand(materialId: number, locationId?: number | null): number {
  const row = locationId
    ? db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM material_moves WHERE material_id = ? AND location_id = ?')
      .get(materialId, locationId) as { q: number }
    : db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM material_moves WHERE material_id = ?')
      .get(materialId) as { q: number };
  return round2(row.q);
}

/** Every material/location pair that has ever moved, with its balance. */
export function onHandAll(locationId?: number | null): OnHandRow[] {
  const rows = db.prepare(
    `SELECT mm.material_id, mm.location_id, m.name AS material_name, m.unit, m.category,
            l.name AS location_name, SUM(mm.qty) AS qty
     FROM material_moves mm
     JOIN materials m ON m.id = mm.material_id
     JOIN locations l ON l.id = mm.location_id
     ${locationId ? 'WHERE mm.location_id = ?' : ''}
     GROUP BY mm.material_id, mm.location_id
     ORDER BY m.category, m.name, l.name`
  ).all(...(locationId ? [locationId] : []) as never[]) as unknown as OnHandRow[];
  return rows.map((r) => ({ ...r, qty: round2(r.qty) }));
}

/**
 * Still to arrive on open purchase orders: ordered minus received.
 *
 * Received is a sum of the receipt moves carrying that PO, so a part delivery
 * needs nothing keyed anywhere else. Cancelled orders bring nothing.
 */
export function onOrder(materialId?: number): Map<number, number> {
  const rows = db.prepare(
    `SELECT i.material_id,
            SUM(COALESCE(i.qty, 0)) AS ordered,
            COALESCE((SELECT SUM(mm.qty) FROM material_moves mm
                      WHERE mm.po_id = i.po_id AND mm.material_id = i.material_id
                        AND mm.source = 'po_receipt'), 0) AS received
     FROM po_items i
     JOIN purchase_orders p ON p.id = i.po_id
     WHERE p.status NOT IN ('cancelled','received') AND i.material_id IS NOT NULL
       ${materialId ? 'AND i.material_id = ?' : ''}
     GROUP BY i.material_id, i.po_id`
  ).all(...(materialId ? [materialId] : []) as never[]) as { material_id: number; ordered: number; received: number }[];

  const out = new Map<number, number>();
  for (const r of rows) {
    // A delivery over the ordered quantity does not make the next PO smaller.
    const pending = Math.max(0, r.ordered - r.received);
    out.set(r.material_id, round2((out.get(r.material_id) ?? 0) + pending));
  }
  return out;
}

/**
 * What has been received against one purchase order, **per line**.
 *
 * The question used to be answered by grouping the ledger on `material_id`,
 * which was wrong in two directions at once: two lines of the same material
 * each reported the whole delivered quantity, and a line naming no material
 * reported nothing for ever. `po_receipts` records the line a delivery was
 * against, so the answer is per line and a product line has progress at all.
 *
 * The key is the line's **position**, because saving a purchase order deletes
 * and reinserts its lines — see the note on the table in schema.sql.
 */
export function receivedByLine(poId: number): Map<number, number> {
  const rows = db.prepare(
    'SELECT po_line, SUM(qty) AS q FROM po_receipts WHERE po_id = ? GROUP BY po_line'
  ).all(poId) as { po_line: number; q: number }[];
  return new Map(rows.map((r) => [Number(r.po_line), round2(r.q)]));
}

/**
 * What has been received against one purchase order, per material.
 *
 * Still read from the ledger, and still the right source for the stock-side
 * question `onOrder` asks — a material line writes both records in one
 * transaction, so the two can only agree.
 */
export function receivedByPo(poId: number): Map<number, number> {
  const rows = db.prepare(
    `SELECT material_id, SUM(qty) AS q FROM material_moves
     WHERE po_id = ? AND source = 'po_receipt' GROUP BY material_id`
  ).all(poId) as { material_id: number; q: number }[];
  return new Map(rows.map((r) => [r.material_id, round2(r.q)]));
}

export interface ShortfallRow {
  material_id: number;
  material_name: string;
  unit: string;
  category: string;
  /** Needed by every open work order, wastage included. */
  required: number;
  on_hand: number;
  on_order: number;
  /** required − on_hand − on_order, floored at zero. */
  short: number;
}

export interface Shortfall {
  rows: ShortfallRow[];
  /** Jobs or order lines whose product has no recipe, so nothing could be worked out. */
  uncosted: { id: number; number: string; description: string }[];
  basis: ShortfallBasis;
}

/**
 * Which question is being asked.
 *
 * `jobs` is what the floor has been told to make and has not yet made.
 * `orders` is what the customers have actually ordered and not yet been made —
 * which is the same figure one step earlier, before anybody has raised a work
 * order, and is what the buyer needs to commit to resin ahead of the plan.
 *
 * They are alternatives, never added: `orders` already contains `jobs`, since
 * a planned-but-unmade piece is also an ordered-but-unmade one.
 */
export type ShortfallBasis = 'jobs' | 'orders';

/**
 * What is still to be made needs against what we have.
 *
 * Requirement counts what is **still to make** — made subtracted from what was
 * asked for — because material for pieces already moulded has been consumed,
 * not reserved. Counting the whole figure again would order resin twice for
 * something nearly finished.
 *
 * On the `orders` basis the question is asked one step earlier, of the order
 * book rather than of the jobs raised from it: ordered minus produced, over
 * the goods lines of orders that are still open. Charge lines never appear —
 * `orderLines` drops them at the source, the way `goodsOnly()` does — and the
 * quantities come from that service rather than from a second walk of the same
 * tables, because it is the only place allowed to answer how far along a line
 * is.
 *
 * Whatever the basis, anything whose product has no recipe is listed
 * separately rather than treated as needing nothing. A shortfall report that
 * quietly ignores half the floor is worse than no report.
 */
/*
 * The default stays , which is what every existing caller means: the
 * dashboard's "materials short" chip has counted open work orders since it was
 * written, and changing what a figure counts without changing its words is how
 * a number quietly stops meaning what its reader thinks. The buying screen asks
 * for  explicitly and says on screen which question it answered.
 */
/*
 * The default stays `jobs`, which is what every caller written before this
 * meant: the dashboard's "materials short" chip has counted open work orders
 * since it was written, and changing what a figure counts without changing its
 * words is how a number quietly stops meaning what its reader thinks. The
 * buying screen asks for `orders` explicitly, and says which it answered.
 */
export function shortfall(locationId?: number | null, basis: ShortfallBasis = 'jobs'): Shortfall {
  return basis === 'orders' ? fromOrderBook(locationId) : fromJobs(locationId);
}

function fromJobs(locationId?: number | null): Shortfall {
  const jobs = db.prepare(
    `SELECT w.id, w.number, w.description, w.product_id, w.qty_planned,
            COALESCE((SELECT SUM(e.qty_ok) FROM production_entries e WHERE e.work_order_id = w.id), 0) AS made
     FROM work_orders w
     WHERE w.status NOT IN ('done','cancelled')
       ${locationId ? 'AND w.location_id = ?' : ''}`
  ).all(...(locationId ? [locationId] : []) as never[]) as
    { id: number; number: string; description: string; product_id: number | null; qty_planned: number; made: number }[];

  const required = new Map<number, ShortfallRow>();
  const uncosted: Shortfall['uncosted'] = [];

  for (const job of jobs) {
    const remaining = Math.max(0, job.qty_planned - job.made);
    const { hasRecipe, lines } = requirementFor(job.product_id, remaining);
    if (!hasRecipe) {
      uncosted.push({ id: job.id, number: job.number, description: job.description });
      continue;
    }
    for (const line of lines) addRequirement(required, line);
  }

  return finish(required, uncosted, locationId, 'jobs');
}

/**
 * The same arithmetic, asked of the order book.
 *
 * `ordered − made` per line, which is exactly `planned − produced` plus the
 * part nobody has raised a job for yet. A line with nothing left to make
 * contributes nothing rather than a negative.
 */
function fromOrderBook(locationId?: number | null): Shortfall {
  const lines = orderLines({ openOnly: true });
  const required = new Map<number, ShortfallRow>();
  const uncosted: Shortfall['uncosted'] = [];

  for (const line of lines) {
    const remaining = Math.max(0, Number(line.ordered) - Number(line.made));
    if (remaining <= 0) continue;
    const { hasRecipe, lines: needs } = requirementFor(line.product_id, remaining);
    if (!hasRecipe) {
      uncosted.push({
        id: line.order_id,
        number: line.order_number,
        description: line.description,
      });
      continue;
    }
    for (const need of needs) addRequirement(required, need);
  }
  return finish(required, uncosted, locationId, 'orders');
}

/** One material's need, folded into the running total. */
function addRequirement(
  required: Map<number, ShortfallRow>,
  line: { material_id: number; name: string; unit: string; category: string; qty: number }
) {
  const seen = required.get(line.material_id);
  if (seen) seen.required = round2(seen.required + line.qty);
  else required.set(line.material_id, {
    material_id: line.material_id,
    material_name: line.name,
    unit: line.unit,
    category: line.category,
    required: line.qty,
    on_hand: 0,
    on_order: 0,
    short: 0,
  });
}

/** What we have, taken off what is needed — shared by both bases. */
function finish(
  required: Map<number, ShortfallRow>,
  uncosted: Shortfall['uncosted'],
  locationId: number | null | undefined,
  basis: ShortfallBasis
): Shortfall {
  const pending = onOrder();
  const rows = [...required.values()].map((r) => {
    const have = onHand(r.material_id, locationId ?? undefined);
    // Material on order is group-wide: a delivery can be redirected, and
    // narrowing it by plant would raise a purchase order that is already placed.
    const coming = pending.get(r.material_id) ?? 0;
    return {
      ...r,
      on_hand: have,
      on_order: coming,
      short: round2(Math.max(0, r.required - have - coming)),
    };
  });

  return {
    rows: rows.sort((a, b) => b.short - a.short || a.material_name.localeCompare(b.material_name)),
    uncosted,
    basis,
  };
}
