import { db } from '../db/connection.js';
import { progressFor } from './production.js';

/**
 * What the recorded output says a job's status is.
 *
 * A work order's status was the one status in this app still set entirely by
 * hand: `insertJob` wrote `planned`, releasing wrote `released`, and nothing
 * ever moved it again. So a job could read *Scheduled* over three shifts and
 * 100% made — the figures on the row moving while the pill beside them stood
 * still, which is the same status-contradicting-the-record failure
 * `orderStatus.ts` was written to end one document up. This is that file
 * applied to the job, and it deliberately borrows its shape rather than
 * inventing a second one.
 *
 * **A person's status is a floor; the recorded output owns everything above
 * it.** `status_before_auto` holds the status that was in place *before this
 * code first raised the job above it*, and is empty whenever the status on the
 * row is a person's own. So a job released and then part-made reads *Running*
 * and remembers *Scheduled*; delete the shift that was mis-keyed and it goes
 * back to *Scheduled*, not to *Not planned*.
 *
 * **It moves both ways**, which is the half forward-only gets wrong. A
 * production entry can be deleted — that is exactly how a mis-keyed one is
 * corrected, as `production.ts` says of its own figures — and a job left at
 * *Running* over an empty shift book would be remembering a fact the record no
 * longer contains.
 *
 * **Two statuses are never touched, in or out.** `cancelled` is a decision,
 * not an observation, and nothing on the floor may un-cancel a job. `paused`
 * is the same: it says somebody stopped the run, and booking the shift that
 * ran *before* they stopped it must not quietly restart it. (It is retired
 * from the picker besides, so only rows already holding it are affected.)
 *
 * **Only the two observable rungs are derived.** `released` is an act —
 * somebody committed the job to a slot — and no amount of output implies it,
 * so it is never set here; it stays what releasing writes. What the output can
 * say is that the job *is running*, and that everything planned *has been
 * made*.
 */

/** Forward order. `paused` and `cancelled` are deliberately absent. */
const LADDER = ['planned', 'released', 'running', 'done'] as const;

export type JobStatus = typeof LADDER[number] | 'paused' | 'cancelled';

/** Statuses this code will not move, in or out. */
const FROZEN = ['cancelled', 'paused'];

const rank = (s: string) => {
  const i = LADDER.indexOf(s as never);
  return i === -1 ? 0 : i;
};

/**
 * The furthest rung the booked output supports — **raw**, without comparing it
 * to what the job currently says. Keeping the measurement apart from the
 * policy is what lets the status come back down when an entry is withdrawn;
 * `syncJobStatus` decides how far down, against the floor a person set.
 *
 * `progressFor` is asked rather than the entries summed here, so a **scrapped
 * lot does not keep a job running**: condemned output stops counting as made
 * (`LIVE_OK`), and a job whose only lot was scrapped has produced nothing.
 *
 * Null when nothing has been booked, and for a job that is not there.
 */
export function impliedJobStatus(jobId: number): 'running' | 'done' | null {
  const job = db.prepare('SELECT qty_planned FROM work_orders WHERE id = ?').get(jobId) as
    | { qty_planned: number } | undefined;
  if (!job) return null;

  const target = Number(job.qty_planned) || 0;
  const { produced } = progressFor(jobId, target);
  if (produced <= 0) return null;
  // A job with nothing to make cannot be complete against it — the rule
  // `allMade` states about a price-only order line, one document down.
  return target > 0 && produced >= target ? 'done' : 'running';
}

/**
 * Bring a job's status into line with what has been booked against it.
 *
 * Returns the status the job now holds, or null when there is no such job.
 * Call it after anything that changes the output on a job or the figure it is
 * measured against, and **before** `syncOrderStatus`, which reads job statuses
 * in turn.
 */
export function syncJobStatus(jobId: number): string | null {
  const row = db.prepare('SELECT status, status_before_auto FROM work_orders WHERE id = ?').get(jobId) as
    | { status: string; status_before_auto: string } | undefined;
  if (!row) return null;
  if (FROZEN.includes(row.status)) return row.status;

  // What a person last chose. While this code holds the job above it the floor
  // is remembered; otherwise the status on the row *is* the floor.
  const floor = row.status_before_auto || row.status;
  const implied = impliedJobStatus(jobId);
  const next: string = implied && rank(implied) > rank(floor) ? implied : floor;
  const memory = next === floor ? '' : floor;
  if (next === row.status && memory === row.status_before_auto) return row.status;

  db.prepare('UPDATE work_orders SET status = ?, status_before_auto = ? WHERE id = ?')
    .run(next, memory, jobId);
  return next;
}
