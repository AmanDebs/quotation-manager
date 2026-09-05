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

/**
 * `resultOk` restated in SQL, for a caller that must filter and count in the
 * database rather than over rows already fetched — the QC register, which is
 * paged, so a verdict computed afterwards could only ever judge one page.
 *
 * It lives **here**, next to the function it duplicates, because two copies of
 * a rule in two files is how they come apart; and it is not assumed to agree —
 * `qcRegister.test.ts` runs both over a matrix of kinds, readings and
 * open-ended bounds and asserts they answer identically. Expects the results
 * table aliased `r`.
 */
export const RESULT_FAILED_SQL = `
  r.value IS NOT NULL AND CASE
    WHEN r.kind = 'boolean' THEN r.value <> 1
    ELSE (r.min_value IS NOT NULL AND r.value < r.min_value)
      OR (r.max_value IS NOT NULL AND r.value > r.max_value)
  END`;

/**
 * The specification in force for a product, for a given customer.
 *
 * A customer's rows **replace** the product's default rather than merging with
 * it: dimensions and tolerances genuinely differ between customers for the same
 * part, and a spec assembled out of two rows is one nobody can check by reading
 * it. So there is one list, and `specOwner` says whose.
 *
 * A customer with no rows of their own falls back to the default, which is why
 * nothing on file changed when the column arrived.
 */
export function paramsFor(productId: number | null, customerId?: number | null): QcParam[] {
  if (!productId) return [];
  if (customerId) {
    const own = db.prepare(
      'SELECT * FROM product_qc_params WHERE product_id = ? AND customer_id = ? ORDER BY sort_order, id'
    ).all(productId, customerId) as unknown as QcParam[];
    if (own.length) return own;
  }
  return db.prepare(
    'SELECT * FROM product_qc_params WHERE product_id = ? AND customer_id IS NULL ORDER BY sort_order, id'
  ).all(productId) as unknown as QcParam[];
}

/** Whose specification is being applied — for the screen and the report. */
export function specOwner(productId: number | null, customerId?: number | null): 'customer' | 'default' | 'none' {
  if (!productId) return 'none';
  if (customerId) {
    const own = db.prepare(
      'SELECT COUNT(*) AS c FROM product_qc_params WHERE product_id = ? AND customer_id = ?'
    ).get(productId, customerId) as { c: number };
    if (Number(own.c) > 0) return 'customer';
  }
  const base = db.prepare(
    'SELECT COUNT(*) AS c FROM product_qc_params WHERE product_id = ? AND customer_id IS NULL'
  ).get(productId) as { c: number };
  return Number(base.c) > 0 ? 'default' : 'none';
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

/** Every check against several jobs at once, keyed by work order. */
export function checksForWorkOrders(workOrderIds: number[]): Map<number, QcCheck[]> {
  const out = new Map<number, QcCheck[]>();
  if (!workOrderIds.length) return out;
  const checks = db.prepare(
    `SELECT * FROM qc_checks WHERE work_order_id IN (${workOrderIds.map(() => '?').join(',')})
     ORDER BY date, id`
  ).all(...(workOrderIds as never[])) as Record<string, unknown>[];
  if (!checks.length) return out;
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
  for (const c of checks) {
    const wo = Number(c.work_order_id);
    const list = out.get(wo) ?? [];
    list.push(decorate(c, byCheck.get(Number(c.id)) ?? []));
    out.set(wo, list);
  }
  return out;
}

/** Every check against one job, oldest first, each with its verdict. */
export function checksForWorkOrder(workOrderId: number): QcCheck[] {
  return checksForWorkOrders([workOrderId]).get(workOrderId) ?? [];
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

export function summaryForWorkOrder(workOrderId: number, productId: number | null, customerId?: number | null): QcSummary {
  const checks = checksForWorkOrder(workOrderId);
  const decided = checks.filter((c) => c.passed !== null);
  const last = decided[decided.length - 1];
  return {
    has_spec: paramsFor(productId, customerId).length > 0,
    checks: checks.length,
    passed: decided.filter((c) => c.passed).length,
    failed: decided.filter((c) => !c.passed).length,
    last_result: last ? last.passed : null,
    last_date: last ? last.date : '',
  };
}

/**
 * Nothing ships until it has passed QC.
 *
 * The rule the client asked for on 2026-09-05: *"only after QC it should be
 * available for dispatch"*. Shaped like `linkError` and `lockError` — a
 * function returning the sentence to refuse with, or null — so the route calls
 * it and the rule is testable without an HTTP harness, which this codebase
 * does not have.
 *
 * Three things it has to get right, and each was a way to get it silently
 * wrong.
 *
 * **A product with no specification is never blocked.** `has_spec: false`
 * means nobody has said what to measure, which is not a failure — the rule
 * this module states twice about itself. Blocking those would have stopped
 * every despatch on the day this shipped, since most of the catalogue has no
 * spec recorded.
 *
 * **A check with nothing measured is not a pass.** The verdict is
 * `measured.length === 0 ? null : failed.length === 0`, which is why this asks
 * `decorate` rather than writing the arithmetic again in SQL: a second
 * definition of "passed" would drift from the one on the screen.
 *
 * **The line position counts charge lines.** `work_orders.order_line` is
 * 0-based over *all* order items — `orderLines.ts` numbers first and drops
 * charges afterwards — so an order whose first line is freight has its first
 * goods line at position 1. Numbering after the filter would gate the wrong
 * line and no ordinary fixture would catch it.
 *
 * A spec'd line with **no work order at all** is blocked: not raising a job
 * would otherwise be the way around the gate entirely.
 */
export function qcBlockError(orderId: number, lines: { order_line?: unknown }[]): string | null {
  // Every line of the order, numbered exactly as orderLines.ts numbers them —
  // charge lines included, because they take a position too.
  const items = db.prepare(
    `SELECT ROW_NUMBER() OVER (ORDER BY sort_order, id) - 1 AS pos, product_id, description, is_charge
       FROM order_items WHERE order_id = ?`
  ).all(orderId) as { pos: number; product_id: number | null; description: string; is_charge: number }[];

  // Judged against this customer's own tolerances where they have some.
  const owner = db.prepare('SELECT customer_id FROM orders WHERE id = ?').get(orderId) as
    { customer_id: number } | undefined;

  const wanted = new Set<number>();
  for (const l of lines) {
    const pos = Number(l.order_line);
    if (!Number.isInteger(pos) || pos < 0) return 'Every despatch line must say which order line it is against';
    if (!items.some((it) => Number(it.pos) === pos)) {
      return `Line ${pos + 1} is not on this order — it may have been edited since`;
    }
    wanted.add(pos);
  }
  if (!wanted.size) return null;

  const jobs = db.prepare(
    "SELECT id, order_line FROM work_orders WHERE order_id = ? AND status <> 'cancelled'"
  ).all(orderId) as { id: number; order_line: number }[];
  const checks = checksForWorkOrders(jobs.map((j) => Number(j.id)));

  for (const pos of [...wanted].sort((a, b) => a - b)) {
    const line = items.find((it) => Number(it.pos) === pos)!;
    // A charge is a fee, not goods: there is nothing to inspect.
    if (Number(line.is_charge)) continue;
    if (paramsFor(line.product_id, owner?.customer_id).length === 0) continue;
    const passed = jobs
      .filter((j) => Number(j.order_line) === pos)
      .some((j) => (checks.get(Number(j.id)) ?? []).some((c) => c.passed === true));
    if (!passed) {
      return `${line.description || `Line ${pos + 1}`} has not passed QC yet, so it cannot be despatched. ` +
        'Record a passing quality check against its work order first.';
    }
  }
  return null;
}
