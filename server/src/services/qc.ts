import { db } from '../db/connection.js';

/**
 * Quality control: what to measure on a product, and whether what came off the
 * machine met it.
 *
 * **Pass and fail are never stored.** A result carries the measurement and the
 * tolerance it was taken against; whether that is a pass is arithmetic, and
 * arithmetic that is written down can disagree with the numbers beside it.
 * Same rule as `stock.ts` for balances and `costing.ts` for value.
 *
 * **The tolerance is copied onto the result** when the check is recorded,
 * rather than read back through the parameter. Tightening a spec next month
 * must not retroactively fail a batch that passed against the spec in force at
 * the time — the same reasoning that stamps `material_moves.rate` at receipt
 * instead of reading it through the purchase order.
 *
 * **A product with no parameters has no opinion**, and says so. `has_spec:
 * false` is not "everything passes", exactly as `hasRecipe: false` is not a
 * material requirement of zero. Most of the catalogue will start this way.
 */

export type QcKind = 'numeric' | 'boolean';

export interface QcParam {
  id: number;
  product_id: number;
  name: string;
  kind: QcKind;
  unit: string;
  min_value: number | null;
  max_value: number | null;
  notes: string;
  sort_order: number;
}

export interface QcResult {
  id: number;
  check_id: number;
  param_id: number | null;
  name: string;
  kind: QcKind;
  unit: string;
  value: number | null;
  min_value: number | null;
  max_value: number | null;
  notes: string;
  sort_order: number;
  /** Derived: true, false, or null when nothing was measured. */
  ok: boolean | null;
}

export interface QcCheck {
  id: number;
  work_order_id: number;
  date: string;
  shift: string;
  sample_size: number | null;
  inspector: string;
  notes: string;
  results: QcResult[];
  /**
   * Derived from the results: false if any measured value is out of tolerance,
   * true if at least one was measured and none failed, null if nothing was.
   * A check with nothing recorded is **not** a pass.
   */
  passed: boolean | null;
  failed_count: number;
}

/** Whether one measurement sits inside the tolerance recorded against it. */
export function resultOk(r: {
  kind: string; value: number | null; min_value: number | null; max_value: number | null;
}): boolean | null {
  if (r.value === null || r.value === undefined) return null;
  // A visual check is its own verdict: 1 is pass, anything else is not.
  if (r.kind === 'boolean') return Number(r.value) === 1;
  // Either end may be open — a wall thickness can have a floor and no ceiling.
  if (r.min_value !== null && r.value < r.min_value) return false;
  if (r.max_value !== null && r.value > r.max_value) return false;
  return true;
}

export function paramsFor(productId: number | null): QcParam[] {
  if (!productId) return [];
  return db.prepare(
    'SELECT * FROM product_qc_params WHERE product_id = ? ORDER BY sort_order, id'
  ).all(productId) as unknown as QcParam[];
}

function decorate(check: Record<string, unknown>, results: QcResult[]): QcCheck {
  const withOk = results.map((r) => ({ ...r, ok: resultOk(r) }));
  const measured = withOk.filter((r) => r.ok !== null);
  const failed = withOk.filter((r) => r.ok === false);
  return {
    ...(check as unknown as Omit<QcCheck, 'results' | 'passed' | 'failed_count'>),
    results: withOk,
    passed: measured.length === 0 ? null : failed.length === 0,
    failed_count: failed.length,
  };
}

/** Every check against one job, oldest first, each with its verdict. */
export function checksForWorkOrder(workOrderId: number): QcCheck[] {
  const checks = db.prepare(
    'SELECT * FROM qc_checks WHERE work_order_id = ? ORDER BY date, id'
  ).all(workOrderId) as Record<string, unknown>[];
  if (!checks.length) return [];
  const results = db.prepare(
    `SELECT * FROM qc_results WHERE check_id IN (${checks.map(() => '?').join(',')})
     ORDER BY sort_order, id`
  ).all(...(checks.map((c) => c.id) as never[])) as unknown as QcResult[];
  const byCheck = new Map<number, QcResult[]>();
  for (const r of results) {
    const list = byCheck.get(r.check_id) ?? [];
    list.push(r);
    byCheck.set(r.check_id, list);
  }
  return checks.map((c) => decorate(c, byCheck.get(Number(c.id)) ?? []));
}

export interface QcSummary {
  /** False when the product has no parameters — no opinion, not a pass. */
  has_spec: boolean;
  checks: number;
  /** Checks where something was measured and nothing failed. */
  passed: number;
  failed: number;
  /** The most recent verdict, which is what the pill on a job shows. */
  last_result: boolean | null;
  last_date: string;
}

export function summaryForWorkOrder(workOrderId: number, productId: number | null): QcSummary {
  const checks = checksForWorkOrder(workOrderId);
  const decided = checks.filter((c) => c.passed !== null);
  const last = decided[decided.length - 1];
  return {
    has_spec: paramsFor(productId).length > 0,
    checks: checks.length,
    passed: decided.filter((c) => c.passed).length,
    failed: decided.filter((c) => !c.passed).length,
    last_result: last ? last.passed : null,
    last_date: last ? last.date : '',
  };
}
