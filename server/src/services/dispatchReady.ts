import { db } from '../db/connection.js';
import { round2, PIECES_ORDERED_SQL } from './totals.js';
import { LIVE_OK } from './production.js';
import { qcBlockError } from './qc.js';
import { advanceBlockError } from './despatchLimits.js';
import { scopeClause } from '../middleware/scope.js';
import type { AuthedRequest } from '../middleware/auth.js';

/**
 * What can be loaded onto a lorry now — the queue Logistics is notified by.
 *
 * Asked for 2026-10-08: *"when a product is made and is ready for dispatch,
 * the logistics person should get a notification … and it should be connected
 * to work order also."* Production books a shift, the job moves itself to
 * `done`, and until this nothing told Logistics — who could not even open the
 * Work Orders list, holding `work_order: none` on it.
 *
 * **Nothing here is a second opinion about whether goods may ship.** "Ready"
 * is four facts and `POST /despatches` already checks all four, so this asks
 * those same guards rather than restating them — `qcBlockError` and
 * `advanceBlockError`, in the order the save runs them, so the sentence this
 * shows is the sentence the save would give. A queue with its own rule is how
 * a badge comes to promise what the API refuses, which this codebase records
 * as the worst way round for a guard to be wrong.
 *
 * **Nothing is stored.** No flag, no `notifications` table: a line appears the
 * moment the last gate clears and leaves the moment the goods go, so the queue
 * cannot come to disagree with the record — the shape the Work Orders page's
 * *"N to confirm"* queue already has, and for the same reason.
 */

/** A live job on the line, named so the queue can link to it. */
export interface ReadyJob {
  id: number;
  number: string;
  status: string;
}

export interface ReadyLine {
  order_id: number;
  order_number: string;
  order_date: string;
  customer_name: string;
  order_line: number;
  product_name: string | null;
  description: string;
  color: string;
  /** Bought in rather than made here: no job, nothing produced to wait on. */
  bought_in: boolean;
  jobs: ReadyJob[];
  /** All in pieces, by `piecesOrdered`'s one rule. */
  ordered: number;
  made: number;
  sent: number;
  ready: number;
  /** The guard's own sentence, or null when the lorry may actually leave. */
  held: string | null;
}

/**
 * Every goods line of an open order, with what has been made against it and
 * what has gone — **one statement, not one per order**.
 *
 * `work_orders.order_line` and `despatch_items.order_line` are the same
 * position the whole chain is keyed on, so both fold in as grouped sub-selects
 * exactly as `orderLines.ts` does it. `LIVE_OK` rather than a raw sum of
 * `qty_ok`, so a **scrapped lot is not ready to ship** — condemned output stops
 * counting as made, which is the whole point of that expression.
 *
 * Charge lines are excluded outright, as everywhere else. Cancelled and
 * completed orders are skipped: there is nothing left to load against either.
 */
const CANDIDATE_SQL = `
  WITH li AS (
    SELECT oi.order_id,
           ROW_NUMBER() OVER (PARTITION BY oi.order_id ORDER BY oi.sort_order, oi.id) - 1 AS line,
           oi.product_id, oi.description, oi.color, oi.is_charge,
           COALESCE(p.made_here, 1) AS made_here,
           p.name AS product_name,
           ${PIECES_ORDERED_SQL('oi')} AS ordered
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
  )
  SELECT o.id AS order_id, o.number AS order_number, o.date AS order_date,
         c.name AS customer_name,
         li.line, li.product_id, li.product_name, li.description, li.color, li.made_here,
         li.ordered,
         COALESCE((
           SELECT SUM(${LIVE_OK('e')}) FROM production_entries e
           JOIN work_orders w ON w.id = e.work_order_id
           WHERE w.order_id = o.id AND w.order_line = li.line AND w.status <> 'cancelled'
         ), 0) AS made,
         COALESCE((
           SELECT SUM(di.qty) FROM despatch_items di
           JOIN despatches d ON d.id = di.despatch_id
           WHERE d.order_id = o.id AND di.order_line = li.line
         ), 0) AS sent
  FROM li
  JOIN orders o ON o.id = li.order_id
  LEFT JOIN customers c ON c.id = o.customer_id
  WHERE li.is_charge = 0
    AND o.status NOT IN ('cancelled', 'completed')`;

/** The live jobs on a line, for the half of this the client asked to be linked. */
function jobsByLine(orderIds: number[]): Map<string, ReadyJob[]> {
  const out = new Map<string, ReadyJob[]>();
  if (!orderIds.length) return out;
  const rows = db.prepare(
    `SELECT id, number, status, order_id, order_line FROM work_orders
     WHERE order_id IN (${orderIds.map(() => '?').join(',')}) AND status <> 'cancelled'
     ORDER BY order_line, id`
  ).all(...orderIds) as
    { id: number; number: string; status: string; order_id: number; order_line: number }[];
  for (const r of rows) {
    const key = `${r.order_id}:${r.order_line}`;
    const list = out.get(key) ?? [];
    list.push({ id: r.id, number: r.number, status: r.status });
    out.set(key, list);
  }
  return out;
}

/**
 * The queue, and the two counts the badge reads.
 *
 * Scoped through `scopeClause` like every other read here. It binds on nobody
 * today — Logistics is unscoped and holds the only `dispatch: full` cell
 * besides the super admin's — and is written anyway for the reason
 * `exportOnlyInvoice` is kept: the rule lives where the answer is decided, so
 * giving Sales that cell later narrows this with it.
 */
export function readyLines(
  req: AuthedRequest,
  opts: { companyId?: number } = {},
): { rows: ReadyLine[]; ready: number; held: number } {
  const scope = scopeClause(req, 'o.customer_id');
  // The dashboard narrows every figure to one selling entity; the queue's own
  // page asks about the whole group. Each company's rows partition the
  // unfiltered whole, the invariant the rest of that page is held to.
  const company = opts.companyId ? ' AND o.company_id = ?' : '';
  const rows = db.prepare(
    `${CANDIDATE_SQL}${scope.sql ? ` AND (${scope.sql})` : ''}${company}
     ORDER BY o.date DESC, o.id DESC, li.line`
  ).all(...scope.params, ...(opts.companyId ? [opts.companyId] : [])) as {
    order_id: number; order_number: string; order_date: string; customer_name: string | null;
    line: number; product_id: number | null; product_name: string | null;
    description: string; color: string; made_here: number;
    ordered: number; made: number; sent: number;
  }[];

  /*
   * What is ready is what has been made and not yet sent, **capped at what was
   * ordered**: an over-run is a fact about the floor, not an instruction to
   * ship more than the buyer asked for. The dispatch form's own ±10% ceiling
   * is a tolerance for what somebody types, not a target.
   */
  const candidates = rows
    .map((r) => {
      const ordered = round2(Number(r.ordered) || 0);
      const made = round2(Number(r.made) || 0);
      const sent = round2(Number(r.sent) || 0);
      /*
       * A bought-in line raises no job and `qcBlockError` skips it, so there
       * is no production record to wait on — it is shippable from the day the
       * order is booked. Counting it as "made" is the only honest reading;
       * the row says *bought in* so nobody reads it as the floor's work.
       */
      const boughtIn = !Number(r.made_here);
      const supply = boughtIn ? ordered : Math.min(made, ordered);
      return { r, ordered, made, sent, boughtIn, ready: round2(Math.max(0, supply - sent)) };
    })
    .filter((c) => c.ready > 0);

  const orderIds = [...new Set(candidates.map((c) => c.r.order_id))];
  const jobs = jobsByLine(orderIds);
  // Per order, not per line: the money gate is a fact about the whole order,
  // and asking it once per line would run it five times for one answer.
  const moneyHold = new Map<number, string | null>();
  for (const id of orderIds) moneyHold.set(id, advanceBlockError(id));

  const out: ReadyLine[] = candidates.map((c) => {
    // The order the save asks them in, so the reason shown is the reason given.
    const held = qcBlockError(c.r.order_id, [{ order_line: c.r.line }]) ?? moneyHold.get(c.r.order_id) ?? null;
    return {
      order_id: c.r.order_id,
      order_number: c.r.order_number,
      order_date: c.r.order_date,
      customer_name: c.r.customer_name ?? '',
      order_line: c.r.line,
      product_name: c.r.product_name,
      description: c.r.description,
      color: c.r.color,
      bought_in: c.boughtIn,
      jobs: jobs.get(`${c.r.order_id}:${c.r.line}`) ?? [],
      ordered: c.ordered,
      made: c.made,
      sent: c.sent,
      ready: c.ready,
      held,
    };
  });

  return {
    rows: out,
    ready: out.filter((r) => !r.held).length,
    held: out.filter((r) => r.held).length,
  };
}
