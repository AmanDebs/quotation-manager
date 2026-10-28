import './helpers/scratch.js';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { dueAt, queueMail, sendDue, composeDigest, outboxStatus, istClock } from '../src/services/mailShifts.js';
import type { OutboxRow } from '../src/services/mailShifts.js';

/**
 * Notifications leaving twice a day instead of one at a time.
 *
 * 2026-10-28, the client: *"I want Batch processing of emails : Two Shifts —
 * 11am and 5pm"*. Two things are worth pinning and neither is the wording.
 *
 * **The clock**, because it is the half that is silently wrong rather than
 * visibly wrong: the shifts are Kolkata hours and the queue is stored in UTC,
 * so an off-by-one around midnight would move a whole evening's messages to
 * the wrong day and nobody would ever see why.
 *
 * **What must not be sent** — anything whose shift has not come, anything
 * already sent, and anything at all while mail is unconfigured, which is what
 * keeps this suite as offline as the rest of it.
 */

/** A fixed day to reason about: 2026-10-28, with IST at +5:30 as it always is. */
const IST = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.parse(`${date}T00:00:00Z`) + (h * 60 + m - 330) * 60_000);
};

const KEYS = ['MAIL_API_KEY', 'MAIL_FROM', 'MAIL_PROVIDER', 'MAIL_API_URL', 'MAIL_SHIFTS'] as const;

function configure(on: boolean) {
  for (const k of KEYS) delete process.env[k];
  if (on) {
    process.env.MAIL_API_KEY = 'k';
    process.env.MAIL_FROM = 'Aglo Polymers <no-reply@aglopolymers.com>';
  }
}

interface Posted { to: string[]; subject: string; text: string }

/** Run a shift against a stub, and report what it actually posted. */
async function runShift(now: Date, ok = true): Promise<Posted[]> {
  const real = globalThis.fetch;
  const posted: Posted[] = [];
  globalThis.fetch = (async (_url: unknown, init: { body?: unknown } = {}) => {
    const b = JSON.parse(String(init.body ?? '{}')) as { to: string[]; subject: string; text: string };
    posted.push({ to: b.to, subject: b.subject, text: b.text });
    return new Response(ok ? '{"id":"x"}' : '{"message":"Sender not valid"}', { status: ok ? 200 : 403 });
  }) as unknown as typeof fetch;
  try {
    await sendDue(now);
  } finally {
    globalThis.fetch = real;
  }
  return posted;
}

const row = (id: number, over: Partial<OutboxRow> = {}): OutboxRow => ({
  id,
  to_email: 'a@b.com',
  subject: `Subject ${id}`,
  body: `Body ${id}`,
  because: '',
  queued_at: '2026-10-28 05:12:00',
  due_at: '2026-10-28 05:30:00',
  ...over,
});

beforeEach(() => {
  db.prepare('DELETE FROM mail_outbox').run();
  configure(true);
});

describe('which shift a message belongs to', () => {
  test('before the morning shift it goes out that morning', () => {
    assert.equal(dueAt(IST('2026-10-28', '09:14')).toISOString(), IST('2026-10-28', '11:00').toISOString());
  });

  test('on the hour exactly it goes out in that shift, not the next', () => {
    // *At or after*: a message queued as the tick runs must not wait six hours.
    assert.equal(dueAt(IST('2026-10-28', '11:00')).toISOString(), IST('2026-10-28', '11:00').toISOString());
  });

  test('a minute after it waits for the evening', () => {
    assert.equal(dueAt(IST('2026-10-28', '11:01')).toISOString(), IST('2026-10-28', '17:00').toISOString());
  });

  test('after the evening shift it waits for tomorrow morning', () => {
    assert.equal(dueAt(IST('2026-10-28', '17:30')).toISOString(), IST('2026-10-29', '11:00').toISOString());
  });

  test('and late evening is tomorrow in Kolkata, not in UTC', () => {
    /* The one that is silently wrong if the arithmetic is done in UTC.
       23:00 IST on the 28th is 17:30 UTC on the 28th — still the 28th by the
       clock the server runs on, and already an evening Kolkata has finished.
       Its shift is the 29th's morning. */
    const queued = IST('2026-10-28', '23:00');
    assert.equal(queued.toISOString(), '2026-10-28T17:30:00.000Z');
    assert.equal(dueAt(queued).toISOString(), IST('2026-10-29', '11:00').toISOString());
  });

  test('and 00:30 IST is still that new day, not the one before', () => {
    const queued = IST('2026-10-29', '00:30');
    assert.equal(queued.toISOString(), '2026-10-28T19:00:00.000Z');
    assert.equal(dueAt(queued).toISOString(), IST('2026-10-29', '11:00').toISOString());
  });

  test('the shifts are readable back as the Kolkata clock', () => {
    assert.equal(istClock(IST('2026-10-28', '17:00')), '17:00');
    assert.equal(istClock(IST('2026-10-29', '00:30')), '00:30');
  });
});

describe('nothing leaves before its shift', () => {
  test('a message queued this morning is not sent at noon', async () => {
    queueMail(['a@b.com'], 'Approval needed', 'Body.');
    // Queued now, so due at the next shift — which is later than now by
    // construction unless the clock is exactly on the hour.
    const due = db.prepare('SELECT due_at FROM mail_outbox').get() as { due_at: string };
    const before = new Date(`${due.due_at.replace(' ', 'T')}Z`.replace(/Z$/, 'Z'));
    const posted = await runShift(new Date(before.getTime() - 60_000));
    assert.equal(posted.length, 0, 'sent before its shift');
    assert.equal(outboxStatus().waiting, 1);
  });

  test('and is sent once it has come', async () => {
    queueMail(['a@b.com'], 'Approval needed', 'Body.');
    const posted = await runShift(IST('2030-01-01', '12:00'));
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0].to, ['a@b.com']);
    assert.equal(outboxStatus().waiting, 0);
  });

  test('and is never sent twice', async () => {
    queueMail(['a@b.com'], 'Approval needed', 'Body.');
    await runShift(IST('2030-01-01', '12:00'));
    const again = await runShift(IST('2030-01-02', '12:00'));
    assert.equal(again.length, 0);
  });
});

describe('one message per person per shift', () => {
  test('each recipient gets their own, carrying only their own rows', async () => {
    queueMail(['a@b.com', 'c@d.com'], 'Jobs to plan: SO/1', 'Plan them.', 'Work Orders');
    queueMail(['a@b.com'], 'Ready to release: SO/2', 'Release it.', 'Sales Orders');
    const posted = await runShift(IST('2030-01-01', '12:00'));
    assert.equal(posted.length, 2, 'one email per person, not per notification');
    const mine = posted.find((p) => p.to[0] === 'a@b.com')!;
    const theirs = posted.find((p) => p.to[0] === 'c@d.com')!;
    assert.match(mine.subject, /^2 updates/);
    assert.ok(mine.text.includes('Jobs to plan: SO/1') && mine.text.includes('Ready to release: SO/2'));
    // The second person was only told about one of them, and must not read
    // the other in a digest — the scoping rule, which batching must not undo.
    assert.equal(theirs.subject, 'Jobs to plan: SO/1');
    assert.ok(!theirs.text.includes('Ready to release'));
  });

  test('a single update is sent as itself, not wrapped in a digest', () => {
    const { subject, body } = composeDigest([row(1, { subject: 'Approval needed: QT/8', body: 'Waiting.' })]);
    assert.equal(subject, 'Approval needed: QT/8');
    assert.equal(body.trim(), 'Waiting.');
  });

  test('and the reason is printed once over the batch, not once per message', () => {
    const { body } = composeDigest([
      row(1, { because: 'Work Orders' }),
      row(2, { because: 'Work Orders' }),
      row(3, { because: 'Dispatches' }),
    ]);
    assert.equal(body.match(/You are receiving/g)?.length, 1);
    assert.match(body, /holds: Work Orders, Dispatches\./);
  });

  test('a digest says which shift it is and when each thing happened', () => {
    const { subject, body } = composeDigest([
      row(1, { queued_at: '2026-10-28 05:12:00' }),
      row(2, { queued_at: '2026-10-28 06:40:00' }),
    ]);
    assert.equal(subject, '2 updates (11:00)');
    assert.ok(body.includes('10:42'), 'the first is stamped with its Kolkata time');
    assert.ok(body.includes('12:10'), 'and so is the second');
  });
});

describe('a provider that refuses', () => {
  test('leaves the rows queued, with its own words on them', async () => {
    queueMail(['a@b.com'], 'Approval needed', 'Body.');
    const posted = await runShift(IST('2030-01-01', '12:00'), false);
    assert.equal(posted.length, 1, 'it was attempted');
    const r = db.prepare('SELECT sent_at, attempts, last_error FROM mail_outbox').get() as
      { sent_at: string; attempts: number; last_error: string };
    assert.equal(r.sent_at, '', 'not marked sent');
    assert.equal(r.attempts, 1);
    assert.match(r.last_error, /Sender not valid/);
    assert.equal(outboxStatus().waiting, 1, 'still waiting, so the next tick retries');
  });

  test('is given up on rather than retried for ever, and says so', async () => {
    queueMail(['a@b.com'], 'Approval needed', 'Body.');
    for (let i = 0; i < 5; i += 1) await runShift(IST('2030-01-01', '12:00'), false);
    const after = await runShift(IST('2030-01-01', '12:00'), false);
    assert.equal(after.length, 0, 'no sixth attempt');
    const status = outboxStatus();
    assert.equal(status.waiting, 0);
    // Counted rather than silent: a notification that never arrives and says
    // nothing about it is the failure the whole feature exists to end.
    assert.equal(status.stuck, 1);
  });
});

describe('a server that was not running at eleven', () => {
  test('sends that shift late rather than losing it', async () => {
    /* Each row carries its own due time, so catching up is the ordinary send
       rather than a special case — and a restart at 11:30 is a redeploy,
       which on this app is pushing to a branch. */
    queueMail(['a@b.com'], 'Approval needed', 'Body.');
    const posted = await runShift(IST('2030-01-01', '11:30'));
    assert.equal(posted.length, 1);
  });

  test('and one that was off all day sends both shifts together, once', async () => {
    db.prepare(
      `INSERT INTO mail_outbox (to_email, subject, body, because, queued_at, due_at)
       VALUES ('a@b.com', 'Morning', 'M.', '', '2026-10-28 04:00:00', '2026-10-28 05:30:00'),
              ('a@b.com', 'Evening', 'E.', '', '2026-10-28 09:00:00', '2026-10-28 11:30:00')`
    ).run();
    const posted = await runShift(IST('2026-10-28', '18:00'));
    assert.equal(posted.length, 1, 'one email, not one per shift missed');
    assert.equal(posted[0].subject, '2 updates (17:00)', 'labelled by the later shift it covers');
    assert.ok(posted[0].text.includes('Morning') && posted[0].text.includes('Evening'));
  });
});

describe('with mail unconfigured', () => {
  test('nothing is queued at all', async () => {
    configure(false);
    assert.equal(queueMail(['a@b.com'], 'Approval needed', 'Body.'), 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mail_outbox').get()!.n, 0);
    // And a send makes no request, which is what keeps this suite offline.
    const posted = await runShift(IST('2030-01-01', '12:00'));
    assert.equal(posted.length, 0);
  });

  test('and a blank or malformed address never becomes a row', () => {
    assert.equal(queueMail(['', '  ', 'not an address'], 'Approval needed', 'Body.'), 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mail_outbox').get()!.n, 0);
  });
});
