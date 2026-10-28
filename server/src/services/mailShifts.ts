import { db } from '../db/connection.js';
import { sendMail, mailConfigured, cleanAddresses } from './mail.js';

/**
 * Notifications leave twice a day, together.
 *
 * 2026-10-28, the client: *"I want Batch processing of emails : Two Shifts —
 * 11am and 5pm"*. Every notification this app sends left the instant the thing
 * happened — an order booked, four shifts logged, a release signed — so a busy
 * morning was a dozen separate emails to the same person about the same order,
 * which is how people learn to filter a sender into a folder they never open.
 * Now they queue, and one message per person goes out at each shift.
 *
 * **Queued, not re-derived at send time**, which is the one decision the rest
 * of this rests on and which cuts against this codebase's usual preference.
 * Everything here is an **event**: *submitted for approval by Meisha*,
 * *rejected, and the reason was this*, *these three lines are now waiting for
 * your release*. A state digest built at 17:00 could not carry a rejection's
 * reason — there is no "currently rejected" to read it back from — and
 * rebuilding the other five from scratch would mean a second set of
 * definitions beside `readyLines` and the approvals queue, which is exactly
 * how two screens come to disagree. The message is composed where the fact is
 * known, and this file decides only **when it leaves**.
 *
 * **So a digest is a record of the shift, not a to-do list**, and that is
 * stated rather than hidden: something submitted at 11:05 and approved at
 * 11:30 still appears in the 17:00 send, stamped with the time it happened.
 * The app's own badges and queues are the live answer and are right whenever
 * somebody opens them — the distinction `mail.ts` already draws about why a
 * badge and an email are different promises.
 *
 * **The test button is deliberately not batched.** `sendMail` stays the
 * immediate door and `queueMail` is the batching one, which lands the split
 * where it belongs: a notification about somebody else's work waits for the
 * shift, and a button somebody just pressed to prove the setting works must
 * answer now or it proves nothing.
 *
 * **Nothing is queued while mail is unconfigured**, the rule `fire` already
 * followed: a deployment that has signed up for nothing accumulates no rows,
 * and the test suite stays as offline as the rest of it.
 */

/**
 * The shifts, in whole hours, Asia/Kolkata.
 *
 * Constants rather than a Settings field: the client named two times, nothing
 * on any screen asks for them, and a second place to set them is a second
 * thing that can disagree with what people expect. `MAIL_SHIFTS` overrides
 * them, and is the measuring hook `MAIL_API_URL` is — it is how two sends a
 * day were exercised without waiting until eleven o'clock.
 */
const DEFAULT_SHIFTS = [11, 17];

/**
 * India has never observed daylight saving, so a fixed offset **is**
 * Asia/Kolkata — the same reading `workOrderList.ts` records for its own
 * `+330 minutes`, and what lets the arithmetic below be plain addition rather
 * than a walk through calendar fields.
 */
const IST_MIN = 330;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/** How often the queue is looked at. See `startMailShiftSchedule`. */
const TICK_MS = 5 * 60_000;

/** Attempts at one digest before it is left alone with its error showing. */
const MAX_ATTEMPTS = 5;

/** Sent rows are kept this long, so the card can say when the last shift ran. */
const KEEP_DAYS = 30;

export function shiftHours(): number[] {
  const raw = String(process.env.MAIL_SHIFTS ?? '').trim();
  if (!raw) return DEFAULT_SHIFTS;
  const hours = raw
    .split(',')
    .map((h) => Number(h.trim()))
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  // A setting nobody can read back is one that must not silently empty the
  // schedule: junk falls back to the two the client asked for.
  return hours.length ? [...new Set(hours)].sort((a, b) => a - b) : DEFAULT_SHIFTS;
}

/** `audit_log.at`'s own format, so SQL can compare it to `datetime('now')`. */
function sqlTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** A UTC instant read as the Kolkata wall clock, as `HH:MM`. */
export function istClock(at: Date): string {
  const shifted = new Date(at.getTime() + IST_MIN * 60_000);
  return shifted.toISOString().slice(11, 16);
}

/**
 * When a message queued at this instant will go out: the first shift at or
 * after it, which may be tomorrow's first.
 *
 * *At or after* rather than *after*, so a message queued exactly on the hour
 * goes out in that shift rather than waiting six hours for the next.
 */
export function dueAt(queued: Date): Date {
  const hours = shiftHours();
  // Shift into the frame whose UTC fields are the Kolkata wall clock, so the
  // day boundary and the hours below are the ones a person in Kolkata means.
  const ist = queued.getTime() + IST_MIN * 60_000;
  const dayStart = Math.floor(ist / DAY_MS) * DAY_MS;
  for (const h of hours) {
    const cand = dayStart + h * HOUR_MS;
    if (cand >= ist) return new Date(cand - IST_MIN * 60_000);
  }
  return new Date(dayStart + DAY_MS + hours[0] * HOUR_MS - IST_MIN * 60_000);
}

export interface OutboxRow {
  id: number;
  to_email: string;
  subject: string;
  body: string;
  because: string;
  queued_at: string;
  due_at: string;
}

/**
 * Hold a notification until its shift.
 *
 * One row per recipient: a provider refusing one address must not lose the
 * message for the others, and each person's digest is grouped from their own
 * rows. Addresses go through the same cleaning a direct send applies, so a
 * blank or malformed one is dropped **here** rather than becoming a row that
 * can never be sent and is retried until it gives up.
 */
export function queueMail(to: string[], subject: string, body: string, because = ''): number {
  if (!mailConfigured()) return 0;
  const addresses = cleanAddresses(to);
  if (!addresses.length) return 0;
  const now = new Date();
  const due = sqlTime(dueAt(now));
  const insert = db.prepare(
    `INSERT INTO mail_outbox (to_email, subject, body, because, queued_at, due_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const a of addresses) insert.run(a, subject, body, because, sqlTime(now), due);
  return addresses.length;
}

const RULE = '─'.repeat(56);

/**
 * One person's rows as one message.
 *
 * **A single update is sent as itself** — its own subject, its own body — so
 * the commonest case reads exactly as it did before batching, only later. A
 * digest wrapper around one item is chrome that says nothing.
 *
 * Several are stacked under their own subjects, each stamped with the time it
 * actually happened, since a digest's whole job is to say *when* as well as
 * *what*. The *why you are getting this* line is printed once at the foot,
 * deduplicated across the batch, rather than repeated under every block.
 */
export function composeDigest(rows: OutboxRow[]): { subject: string; body: string } {
  const reasons = [...new Set(rows.map((r) => r.because).filter(Boolean))];
  const credit = reasons.length
    ? [RULE, `You are receiving these because your team holds: ${reasons.join(', ')}.`]
    : [];

  if (rows.length === 1) {
    return {
      subject: rows[0].subject,
      body: [rows[0].body, ...(credit.length ? ['', ...credit] : [])].join('\n'),
    };
  }

  // The batch is labelled by the latest shift it covers. Ordinarily every row
  // shares one; after a restart that missed a shift, one send legitimately
  // carries both, and naming the later of them is the honest label for an
  // email arriving now.
  const label = istClock(new Date(`${rows[rows.length - 1].due_at.replace(' ', 'T')}Z`));
  return {
    subject: `${rows.length} updates (${label})`,
    body: [
      `${rows.length} updates, sent in the ${label} batch.`,
      '',
      ...rows.flatMap((r) => [
        RULE,
        `${r.subject}   ·   ${istClock(new Date(`${r.queued_at.replace(' ', 'T')}Z`))}`,
        RULE,
        '',
        r.body,
        '',
      ]),
      RULE,
      // Said once, because a digest naming something already dealt with is not
      // a fault: it is the record of a shift, and the app is where the live
      // answer is. Only on a digest — on one update it would be noise.
      'This is what happened since the last send. The app itself is always current.',
      ...credit,
    ].join('\n'),
  };
}

export interface ShiftResult {
  /** People written to. */
  sent: number;
  /** Individual notifications those digests carried. */
  messages: number;
  /** People whose digest the provider refused. */
  failed: number;
}

/**
 * Send everything whose shift has come, and prune what has long gone.
 *
 * **Sequentially**, one recipient at a time: this is a handful of addresses
 * twice a day, and firing them at a provider in parallel is how a batch earns
 * a rate-limit refusal that then looks exactly like the silence this feature
 * was built to end.
 *
 * A refused digest leaves its rows unsent with the provider's own words on
 * them, so the next tick tries again; after `MAX_ATTEMPTS` it is left alone
 * and counted by `outboxStatus`, which is what stops a bad key being retried
 * every five minutes for ever **and** stops the failure being silent.
 */
export async function sendDue(now = new Date()): Promise<ShiftResult> {
  const out: ShiftResult = { sent: 0, messages: 0, failed: 0 };
  if (!mailConfigured()) return out;

  const rows = db.prepare(
    `SELECT id, to_email, subject, body, because, queued_at, due_at
       FROM mail_outbox
      WHERE sent_at = '' AND attempts < ? AND due_at <= ?
      ORDER BY to_email, id`
  ).all(MAX_ATTEMPTS, sqlTime(now)) as unknown as OutboxRow[];

  const byRecipient = new Map<string, OutboxRow[]>();
  for (const r of rows) {
    const list = byRecipient.get(r.to_email) ?? [];
    list.push(r);
    byRecipient.set(r.to_email, list);
  }

  for (const [address, group] of byRecipient) {
    const { subject, body } = composeDigest(group);
    const result = await sendMail([address], subject, body);
    const ids = group.map((r) => r.id);
    const marks = ids.map(() => '?').join(',');
    if (result.sent) {
      db.prepare(`UPDATE mail_outbox SET sent_at = ? WHERE id IN (${marks})`)
        .run(sqlTime(new Date()), ...ids);
      out.sent += 1;
      out.messages += group.length;
    } else {
      db.prepare(
        `UPDATE mail_outbox SET attempts = attempts + 1, last_error = ? WHERE id IN (${marks})`
      ).run(result.reason.slice(0, 300), ...ids);
      out.failed += 1;
    }
  }

  db.prepare(`DELETE FROM mail_outbox WHERE sent_at <> '' AND sent_at < datetime('now', ?)`)
    .run(`-${KEEP_DAYS} days`);
  return out;
}

export interface OutboxStatus {
  /** The shifts, as a person reads them: ['11:00', '17:00']. */
  shifts: string[];
  /** Queued and not yet gone. */
  waiting: number;
  /** When the next send is, as the Kolkata clock. */
  next: string;
  /** Given up on, with their reason still on the row. */
  stuck: number;
  /** The last shift that actually went out, or '' on a book with none. */
  last_sent: string;
}

/** What the Settings card says about the queue. */
export function outboxStatus(now = new Date()): OutboxStatus {
  const counts = db.prepare(
    `SELECT
       SUM(CASE WHEN sent_at = '' AND attempts < ? THEN 1 ELSE 0 END) AS waiting,
       SUM(CASE WHEN sent_at = '' AND attempts >= ? THEN 1 ELSE 0 END) AS stuck,
       MAX(sent_at) AS last_sent
     FROM mail_outbox`
  ).get(MAX_ATTEMPTS, MAX_ATTEMPTS) as { waiting: number | null; stuck: number | null; last_sent: string | null };
  return {
    shifts: shiftHours().map((h) => `${String(h).padStart(2, '0')}:00`),
    waiting: Number(counts?.waiting ?? 0),
    stuck: Number(counts?.stuck ?? 0),
    next: istClock(dueAt(now)),
    last_sent: counts?.last_sent ? istClock(new Date(`${counts.last_sent.replace(' ', 'T')}Z`)) : '',
  };
}

/**
 * Look at the queue on boot, then every few minutes.
 *
 * **A tick rather than a timer set to the hour**, which is the one piece of
 * machinery worth explaining. A one-shot `setTimeout` to 17:00 is exact right
 * up until the process is restarted at 16:59 — and this app is redeployed by
 * pushing to a branch — so the schedule would quietly depend on nobody
 * shipping near a shift. Each row carries its own `due_at`, so a tick that
 * simply sends whatever is due is **self-correcting**: a restart at 11:30
 * sends the 11:00 batch a few minutes late, a restart at 14:00 sends nothing
 * because nothing is due until 17:00, and a server that was off all day sends
 * both at once when it comes back. The cost is that a shift leaves within
 * five minutes of its hour rather than on it.
 *
 * The same shape as `startBackupSchedule` and `startExpirySchedule`, unref
 * included: a timer must never be the reason the process will not exit.
 */
export function startMailShiftSchedule() {
  const run = () => {
    void sendDue().then(
      ({ sent, messages, failed }) => {
        if (sent || failed) {
          console.log(`Mail shift: ${messages} notifications to ${sent} recipients${failed ? `, ${failed} refused` : ''}`);
        }
      },
      // A failed send must never take the server down with it, and the rows
      // are still in the queue for the next tick.
      (err) => console.error('Mail shift failed:', err),
    );
  };
  run();
  const timer = setInterval(run, TICK_MS);
  timer.unref?.();
}
