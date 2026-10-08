import { db } from '../db/connection.js';
import { round2, PIECES_ORDERED_SQL } from './totals.js';
import { LIVE_OK } from './production.js';
import { qcBlockError } from './qc.js';
import { advanceBlockError } from './despatchLimits.js';
import { approvalsForOrders, deskApprovalError } from './dispatchApproval.js';
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
 * **Almost nothing is stored.** No flag, no `notifications` table: a line
 * appears the moment the last gate clears and leaves the moment the goods go,
 * so the queue cannot come to disagree with the record — the shape the Work
 * Orders page's *"N to confirm"* queue already has, and for the same reason.
 *
 * The one exception is the **sales desk's release** (2026-10-08, the hour
 * after this shipped: *"When a product is ready, it should be first be
 * approved by the SPOC of that order, if he approves then it should go to
 * ready to dispatch tab so that logistic person can record dispatch"*), which
 * is an act rather than an observation and lives in `dispatchApproval.ts`. It
 * splits the one queue into two audiences:
 *
 * - **awaiting** — made, and the desk has not released it. The SPOC's queue.
 * - **ready** — released, and nothing else is in the way. Logistics' queue,
 *   and the only thing the sidebar badge counts.
 *
 * A line the desk has not released is still **shown to Logistics, held, with
 * the reason**, the rule a line held by an unpaid advance already follows: the
 * goods are waiting on Sales rather than on the floor, and a queue that simply
 * omitted them would leave them in the yard with nothing on any screen to say
 * why.
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
  /** The live jobs that made it. Never empty: output implies a live job. */
  jobs: ReadyJob[];
  /** All in pieces, by `piecesOrdered`'s one rule. */
  ordered: number;
  made: number;
  sent: number;
  /** Released by the desk and loadable now. */
  ready: number;
  /** Made, and waiting on the desk. A line can carry both at once. */
  awaiting: number;
  /** Cumulative pieces the desk has cleared on this line. */
  approved: number;
  approved_by_name: string;
  approved_at: string;
  /** Whose order it is, from `orders.spoc` — one of the six desk names. */
  spoc: string;
  /** Whether *this* caller may release it; see `deskApprovalError`. */
  may_approve: boolean;
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
 *
 * **And so is a bought-in line** (`made_here = 0`; 2026-10-08, the client:
 * *"leave them out"*). Such a line raises no job and `qcBlockError` skips it,
 * so there is no production record to wait on — it is shippable from the day
 * the order is booked and would sit here permanently until somebody shipped
 * it. That made the queue a list of open order lines rather than a list of
 * things that have just become ready, which is the one thing it is for. **The
 * consequence, stated rather than discovered**: a traded item never appears
 * here, and its trip is recorded from the register or the order book as
 * before. This queue is what the *floor* has finished and not yet shipped.
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
         o.spoc AS spoc,
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
    AND li.made_here = 1
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
 * The queue, and the three counts the badges read.
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
): { rows: ReadyLine[]; ready: number; held: number; awaiting: number } {
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
    spoc: string | null;
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
      const supply = Math.min(made, ordered);
      return { r, ordered, made, sent, supply, outstanding: round2(Math.max(0, supply - sent)) };
    })
    .filter((c) => c.outstanding > 0);

  const orderIds = [...new Set(candidates.map((c) => c.r.order_id))];
  const jobs = jobsByLine(orderIds);
  // What the sales desk has released, asked once for the whole queue.
  const approvals = approvalsForOrders(orderIds);
  // Per order, not per line: the money gate is a fact about the whole order,
  // and asking it once per line would run it five times for one answer.
  const moneyHold = new Map<number, string | null>();
  for (const id of orderIds) moneyHold.set(id, advanceBlockError(id));

  const out: ReadyLine[] = candidates.map((c) => {
    const spoc = String(c.r.spoc ?? '').trim();
    const approval = approvals.get(`${c.r.order_id}:${c.r.line}`);
    const approved = approval?.qty ?? 0;

    /*
     * Three figures over one line, and the arithmetic is what makes the two
     * queues add up rather than overlap.
     *
     * `released` is what the desk has cleared, capped at what the floor has
     * actually made — approving ahead of production releases nothing. `ready`
     * is the part of that still here; `awaiting` is what is made and not
     * released, floored at what has **gone**, so withdrawing an approval after
     * a lorry has left does not put shipped goods back into anybody's queue.
     *
     * A line can carry both at once — twelve lakh released and five made
     * since — which is correct: it is on Logistics' list and back on the
     * desk's.
     */
    const released = Math.min(approved, c.supply);
    const ready = round2(Math.max(0, released - c.sent));
    const awaiting = round2(Math.max(0, c.supply - Math.max(released, c.sent)));

    // The order the save asks them in, so the reason shown is the reason given.
    const blocked = qcBlockError(c.r.order_id, [{ order_line: c.r.line }])
      ?? moneyHold.get(c.r.order_id) ?? null;
    /*
     * What Logistics is told. QC and the advance come first because they are
     * the save's own guards and the sentence is the one the save would give —
     * and because saying *"awaiting Meisha"* over a line that has failed its
     * check would send somebody to chase the wrong person. The release is
     * asked last, and only where nothing at all has been cleared: a line
     * partly released is on the Ready list, where its remainder is the desk's
     * business rather than a reason the lorry cannot go.
     */
    const held = blocked
      ?? (ready === 0 && awaiting > 0
        ? `Made, but not yet released for dispatch${spoc ? ` by ${spoc}` : ''}.`
        : null);

    return {
      order_id: c.r.order_id,
      order_number: c.r.order_number,
      order_date: c.r.order_date,
      customer_name: c.r.customer_name ?? '',
      order_line: c.r.line,
      product_name: c.r.product_name,
      description: c.r.description,
      color: c.r.color,
      jobs: jobs.get(`${c.r.order_id}:${c.r.line}`) ?? [],
      ordered: c.ordered,
      made: c.made,
      sent: c.sent,
      ready,
      awaiting,
      approved,
      approved_by_name: approval?.by_name ?? '',
      approved_at: approval?.at ?? '',
      spoc,
      may_approve: !deskApprovalError(req, spoc),
      held,
    };
  });

  return {
    rows: out,
    // What the badge promises, and so only what can actually be loaded.
    ready: out.filter((r) => r.ready > 0 && !r.held).length,
    held: out.filter((r) => r.held).length,
    awaiting: out.filter((r) => r.awaiting > 0).length,
  };
}
