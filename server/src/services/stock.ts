import { db } from '../db/connection.js';
import { round2 } from './totals.js';
import { requirementFor } from './recipe.js';

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
  /** Open jobs whose product has no recipe, so nothing could be worked out. */
  uncosted: { id: number; number: string; description: string }[];
}

/**
 * What the open order book needs against what we have.
 *
 * Requirement counts what is **still to make** on each open job — planned
 * minus produced — because material for pieces already moulded has been
 * consumed, not reserved. Counting the whole plan again would order resin
 * twice for a job that is nearly finished.
 *
 * Jobs whose product has no recipe are listed separately rather than treated
 * as needing nothing. A shortfall report that quietly ignores half the floor
 * is worse than no report.
 */
export function shortfall(locationId?: number | null): Shortfall {
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
    for (const line of lines) {
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
  }

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

  return { rows: rows.sort((a, b) => b.short - a.short || a.material_name.localeCompare(b.material_name)), uncosted };
}
