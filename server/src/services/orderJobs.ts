import { db } from '../db/connection.js';
import { nextNumber } from './numbering.js';
import { resolveCompanyId } from './companies.js';
import { snapshotRecipe } from './recipe.js';
import { piecesOrdered } from './totals.js';

/**
 * The sales order owns its work orders (2026-09-11, at the client's word).
 *
 * Until now a job was a Production act — **+ Job** or the bulk raise on the
 * order's Production tab — and the reasons that was left manual are recorded
 * on `POST /work-orders/bulk`. The client asked for the step to go: an order,
 * once booked, *is* the instruction to make it, and asking somebody to press
 * a button that only ever accepts the figure the app already worked out is a
 * step with no decision in it. So the tab is gone and this runs instead.
 *
 * **The invoice's packing list is the precedent**, not an MRP. `syncPackingList`
 * creates the list on first save and keeps its lines in step with the
 * invoice's, inside the invoice's own transaction, under whoever saved the
 * invoice — nobody needs `packing_list: full` for a packing list to exist. A
 * job raised here is the same thing: the system raising it the way it numbers
 * the document, which is what dissolves the access-matrix objection (Sales
 * confirms the order and holds `work_order: view`) — Sales is not raising a
 * job any more than they are raising a packing list.
 *
 * **Deliberately timid where the floor has acted.** One job per goods line,
 * planned at what the line orders; but once a job has output booked against
 * it, or somebody has raised a second one on the line, or moved it off
 * `planned`, the line is the floor's and this leaves it alone — a job with a
 * shift against it is a day's production, not a figure to be restated from a
 * sales edit. What it *does* keep in step is the unstarted case: a line's
 * quantity corrected before anything was made moves the one planned job to
 * match, and a line that disappears cancels its unstarted job.
 *
 * **Bought-in goods raise nothing.** `products.made_here = 0` marks a line
 * that is traded rather than made — the same treatment as a charge line here
 * and in `qcBlockError`, there being no job to raise and nothing to inspect.
 * A product flipped to bought-in after booking has its untouched job
 * withdrawn on the next save, and one flipped back gets a job again.
 */

export interface OrderRef { id: number; customer_id: number; company_id: number }

/** The product on an order line, by the position rule the whole chain uses. */
export function productOfLine(orderId: number, pos: number): number | null {
  const row = db.prepare(
    `SELECT product_id FROM (
       SELECT product_id, ROW_NUMBER() OVER (ORDER BY sort_order, id) - 1 AS p
         FROM order_items WHERE order_id = ?
     ) WHERE p = ?`
  ).get(orderId, pos) as { product_id: number | null } | undefined;
  return row?.product_id ?? null;
}

const STATUSES = ['planned', 'released', 'running', 'paused', 'done', 'cancelled'];
const numOrNull = (v: unknown) =>
  v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);

/**
 * Write one job. Every job is created here — the order's own sync below, and
 * `POST /work-orders` for the second job a split run sometimes wants — so a
 * job starts the same way whoever raised it. The caller owns the transaction.
 */
export function insertJob(order: OrderRef, body: Record<string, unknown>, userId: number | null): number {
  // Numbered by the company that sold the order, so one series covers
  // everything that entity makes.
  const companyId = resolveCompanyId(order.company_id, order.customer_id);
  const number = String(body.number ?? '').trim() || nextNumber('work_order', { companyId });
  const line = Number(body.order_line) || 0;
  const productId = numOrNull(body.product_id) ?? productOfLine(order.id, line);
  const info = db.prepare(
    `INSERT INTO work_orders (number, company_id, order_id, order_line, product_id, description, qty_planned,
                              location_id, machine_id, mould_id, process_id, planned_start, planned_end,
                              revised_start, revised_end, notes,
                              status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    number, companyId, order.id, line, productId,
    String(body.description ?? ''),
    Number(body.qty_planned) || 0,
    numOrNull(body.location_id), numOrNull(body.machine_id), numOrNull(body.mould_id), numOrNull(body.process_id),
    String(body.planned_start ?? ''), String(body.planned_end ?? ''),
    String(body.revised_start ?? ''), String(body.revised_end ?? ''), String(body.notes ?? ''),
    STATUSES.includes(String(body.status)) ? String(body.status) : 'planned',
    userId
  );
  const id = Number(info.lastInsertRowid);
  // Stamped in the caller's transaction, so a job and the figures it is costed
  // against are written together or not at all — see `snapshotRecipe`.
  snapshotRecipe(id, productId);
  return id;
}

/** What a line asks to be made, in pieces — `piecesOrdered`'s rule, which converts a per-1000 quantity. */
const target = (it: { total_pcs: number | null; qty: number | null; unit: string }) => piecesOrdered(it);

export interface JobSync { raised: number[]; adjusted: number[]; cancelled: number[] }

/**
 * Bring an order's jobs into line with its goods lines. Idempotent: a second
 * call with nothing changed does nothing, which is what lets it run on every
 * save rather than only the first.
 */
export function syncOrderJobs(orderId: number, userId: number | null, opts: { raise?: boolean } = {}): JobSync {
  const mayRaise = opts.raise !== false;
  const order = db.prepare('SELECT id, customer_id, company_id, status FROM orders WHERE id = ?')
    .get(orderId) as (OrderRef & { status: string }) | undefined;
  const out: JobSync = { raised: [], adjusted: [], cancelled: [] };
  if (!order) return out;

  // Positions count charge lines — the chain's index rule — so the position
  // is taken over every line and charges are skipped afterwards.
  const lines = (db.prepare(
    `SELECT oi.product_id, oi.description, oi.qty, oi.unit, oi.total_pcs, oi.is_charge,
            COALESCE(p.made_here, 1) AS made_here
       FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ? ORDER BY oi.sort_order, oi.id`
  ).all(orderId) as { product_id: number | null; description: string; qty: number | null; unit: string; total_pcs: number | null; is_charge: number; made_here: number }[])
    .map((it, line) => ({ ...it, line }));

  const jobs = db.prepare(
    `SELECT w.id, w.order_line, w.status, w.qty_planned,
            (SELECT COUNT(*) FROM production_entries e WHERE e.work_order_id = w.id) AS entries,
            (SELECT COUNT(*) FROM material_moves m WHERE m.work_order_id = w.id) AS issues
       FROM work_orders w WHERE w.order_id = ? AND w.status <> 'cancelled'
      ORDER BY w.order_line, w.id`
  ).all(orderId) as { id: number; order_line: number; status: string; qty_planned: number; entries: number; issues: number }[];
  const byLine = new Map<number, typeof jobs>();
  for (const j of jobs) byLine.set(j.order_line, [...(byLine.get(j.order_line) ?? []), j]);

  /** Nothing has happened to it yet: still planned, no shift, no material. */
  const untouched = (j: { status: string; entries: number; issues: number }) =>
    j.status === 'planned' && j.entries === 0 && j.issues === 0;

  // A cancelled order raises nothing and cancels what has not started.
  const live = order.status !== 'cancelled';

  for (const it of lines) {
    const mine = byLine.get(it.line) ?? [];
    if (it.is_charge || !it.made_here || target(it) <= 0 || !live) {
      // Nothing to make on this line: an unstarted job against it is withdrawn.
      for (const j of mine) if (untouched(j)) { cancel(j.id); out.cancelled.push(j.id); }
      continue;
    }
    if (!mine.length) {
      if (!mayRaise) continue;
      out.raised.push(insertJob(order, {
        order_line: it.line, product_id: it.product_id, description: it.description, qty_planned: target(it),
      }, userId));
      continue;
    }
    // Exactly one job, nothing done on it, figure differs: the line was
    // corrected before the floor touched it, so the plan follows. Anything
    // else is the floor's own arrangement and is left alone.
    if (mine.length === 1 && untouched(mine[0]) && Number(mine[0].qty_planned) !== target(it)) {
      db.prepare('UPDATE work_orders SET qty_planned = ?, description = ? WHERE id = ?')
        .run(target(it), it.description, mine[0].id);
      out.adjusted.push(mine[0].id);
    }
  }
  // Jobs on positions the order no longer has.
  for (const j of jobs) {
    if (j.order_line >= lines.length && untouched(j)) { cancel(j.id); out.cancelled.push(j.id); }
  }
  return out;
}

/** dd-mm-yyyy, the way every date this app prints reads. */
const day = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return d ? `${d}-${m}-${y}` : iso;
};

/**
 * The original plan is recorded once and then does not change (2026-09-29, the
 * client: *"Original planned start and end date cannot be edited after
 * input."*).
 *
 * `planned_start`/`planned_end` and `revised_start`/`revised_end` are two
 * facts, not one field with a spare — what was promised, and what is now
 * expected — and the whole value of the pair is that the **slip** is visible.
 * Overwriting the original loses it silently: the row goes on looking like a
 * job that was always going to run on that date, which is the one thing the
 * second column exists to prevent. So the first date typed is the record, and
 * every date after it is a revision.
 *
 * The fifth guard of this shape — after `lockError`, `qcBlockError`,
 * `incompleteError` and `renameError` — a function returning the sentence to
 * refuse with, so the rule is testable without the HTTP harness this codebase
 * does not have, and so the screen can explain it rather than keep a copy of
 * it.
 *
 * **Per field, not per job.** A job given a start and no finish has not
 * recorded its original finish yet, so the first finish typed is still an
 * input rather than a revision — reading the pair as one would leave that
 * column permanently blank with a revision beside it and nothing to measure it
 * against.
 *
 * Three things it deliberately does not refuse. A **blank** column is the
 * input this is about, which is every job the order raises. **Saying the same
 * date again** is not a change, so an ordinary save that sends the whole row
 * back — which `PUT /work-orders/:id` does — is never refused. And the
 * **revised** pair is not guarded at all: a plan that moves twice is ordinary,
 * and that is the column this points people at.
 */
export function plannedDateError(
  job: { number: string; planned_start?: string | null; planned_end?: string | null },
  patch: Record<string, unknown>,
): string | null {
  for (const [field, word] of [['planned_start', 'start'], ['planned_end', 'finish']] as const) {
    if (!(field in patch)) continue;
    const was = String(job[field] ?? '').trim();
    if (!was) continue;
    if (String(patch[field] ?? '').trim() === was) continue;
    return `The original planned ${word} for ${job.number} was recorded as ${day(was)} and does not change — it is what a revision is measured against. Set the revised ${word} instead.`;
  }
  return null;
}

/**
 * The one-off for the book as it stands: every open order with **no** job at
 * all gets its jobs. Runs on boot, and is idempotent by construction — an
 * order with any job, live or cancelled, is not touched, so an order whose
 * jobs Production deliberately cancelled is not re-raised on the next boot.
 * Orders already cancelled or completed are left alone: nothing to make.
 */
export function raiseJobsForOpenOrders(): number {
  /*
   * Every open order, not only the jobless: `syncOrderJobs` is idempotent and
   * touches nothing the floor has acted on, so running it over the whole open
   * book on boot costs nothing on a book already in step — and it is what
   * corrected the jobs planned at 137.5 pieces when the pieces rule was fixed
   * (2026-09-12): an untouched job follows its line's figure, and the line's
   * figure had been wrong. A job Production cancelled stays cancelled: the
   * sync counts cancelled jobs as absent for planning but the *raise* below
   * is skipped for any order that has ever had one, so a deliberate cancel is
   * not undone by the next boot.
   */
  const orders = db.prepare(
    `SELECT o.id,
            EXISTS (SELECT 1 FROM work_orders w WHERE w.order_id = o.id) AS has_any
       FROM orders o WHERE o.status NOT IN ('cancelled', 'completed')`
  ).all() as { id: number; has_any: number }[];
  let raised = 0;
  let adjusted = 0;
  for (const { id, has_any } of orders) {
    const r = syncOrderJobs(id, null, { raise: !has_any });
    raised += r.raised.length;
    adjusted += r.adjusted.length;
  }
  if (raised || adjusted) {
    console.log(`Sales orders on boot: raised ${raised} work order${raised === 1 ? '' : 's'}, corrected ${adjusted} untouched planned figure${adjusted === 1 ? '' : 's'}.`);
  }
  return raised;
}

function cancel(jobId: number) {
  db.prepare("UPDATE work_orders SET status = 'cancelled' WHERE id = ?").run(jobId);
}
