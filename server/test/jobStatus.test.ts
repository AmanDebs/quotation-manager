import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { syncJobStatus, impliedJobStatus, DUE_TO_START } from '../src/services/jobStatus.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * A job's status follows what has been booked against it.
 *
 * The rules that need holding down are the ones about *not* moving: a person's
 * status is a floor, `paused` and `cancelled` are decisions rather than
 * observations, and `released` is an act no amount of output implies.
 */

let seq = 0;

function job(qtyPlanned: number, status = 'planned'): number {
  const orderId = Number((db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status)
     VALUES (?, '2026-09-01', ?, 1, 'INR', 'igst', 'pending') RETURNING id`
  ).get(`SO/JS-${++seq}`, makeCustomer()) as { id: number }).id);
  return Number((db.prepare(
    `INSERT INTO work_orders (number, company_id, order_id, order_line, qty_planned, status)
     VALUES (?, 1, ?, 0, ?, ?) RETURNING id`
  ).get(`WO/JS-${seq}`, orderId, qtyPlanned, status) as { id: number }).id);
}

const shift = (jobId: number, ok: number) => Number((db.prepare(
  "INSERT INTO production_entries (work_order_id, date, qty_ok, qty_reject) VALUES (?, '2026-09-03', ?, 0) RETURNING id"
).get(jobId, ok) as { id: number }).id);

/** Spread, because node:sqlite hands back a null-prototype row and strict
 *  deepEqual counts the prototype as part of the value. */
const row = (jobId: number) => ({ ...db.prepare(
  'SELECT status, status_before_auto FROM work_orders WHERE id = ?'
).get(jobId) as { status: string; status_before_auto: string } });

/** What the status route does: a hand-set status is the floor. */
const setByHand = (jobId: number, status: string) =>
  db.prepare("UPDATE work_orders SET status = ?, status_before_auto = '' WHERE id = ?").run(status, jobId);

describe('what the booked output implies', () => {
  test('nothing booked implies nothing', () => {
    assert.equal(impliedJobStatus(job(1000)), null);
  });

  test('some of it made is running; all of it is done', () => {
    const a = job(1000);
    shift(a, 400);
    assert.equal(impliedJobStatus(a), 'running');
    shift(a, 600);
    assert.equal(impliedJobStatus(a), 'done');
  });

  test('past the plan is still done, not something else', () => {
    const a = job(1000);
    shift(a, 2860);
    assert.equal(impliedJobStatus(a), 'done');
  });

  test('a job with nothing to make can run but never complete', () => {
    const a = job(0);
    shift(a, 500);
    assert.equal(impliedJobStatus(a), 'running');
  });

  test('a job that is not there implies nothing', () => {
    assert.equal(impliedJobStatus(999999), null);
  });
});

describe('the status follows it, both ways', () => {
  test('booking output on a released job runs it, and remembers where it was', () => {
    const a = job(1000, 'released');
    const e = shift(a, 400);
    assert.equal(syncJobStatus(a), 'running');
    assert.deepEqual(row(a), { status: 'running', status_before_auto: 'released' });

    // The mis-keyed shift is deleted: back to what a person had set, not to
    // the bottom of the ladder.
    db.prepare('DELETE FROM production_entries WHERE id = ?').run(e);
    assert.equal(syncJobStatus(a), 'released');
    assert.deepEqual(row(a), { status: 'released', status_before_auto: '' });
  });

  test('a job nobody released runs too, and goes back to not planned', () => {
    const a = job(1000);
    const e = shift(a, 400);
    assert.equal(syncJobStatus(a), 'running');
    assert.equal(row(a).status_before_auto, 'planned');
    db.prepare('DELETE FROM production_entries WHERE id = ?').run(e);
    assert.equal(syncJobStatus(a), 'planned');
  });

  test('making everything completes it, and removing a shift re-opens it', () => {
    const a = job(1000, 'released');
    shift(a, 600);
    const last = shift(a, 400);
    assert.equal(syncJobStatus(a), 'done');
    db.prepare('DELETE FROM production_entries WHERE id = ?').run(last);
    assert.equal(syncJobStatus(a), 'running');
  });

  test('correcting the planned figure can complete a job', () => {
    const a = job(1000, 'released');
    shift(a, 400);
    assert.equal(syncJobStatus(a), 'running');
    db.prepare('UPDATE work_orders SET qty_planned = 400 WHERE id = ?').run(a);
    assert.equal(syncJobStatus(a), 'done');
  });

  test('it is idempotent: a second call with nothing changed writes nothing', () => {
    const a = job(1000, 'released');
    shift(a, 400);
    syncJobStatus(a);
    const before = row(a);
    assert.equal(syncJobStatus(a), 'running');
    assert.deepEqual(row(a), before);
  });
});

describe('what it must not move', () => {
  test('cancelled is a decision — output never un-cancels a job', () => {
    const a = job(1000, 'cancelled');
    shift(a, 400);
    assert.equal(syncJobStatus(a), 'cancelled');
    assert.equal(row(a).status, 'cancelled');
  });

  test('paused is a decision too — the shift that ran before it does not restart it', () => {
    const a = job(1000, 'paused');
    shift(a, 400);
    assert.equal(syncJobStatus(a), 'paused');
  });

  test('a job completed by hand on a short run stays completed', () => {
    const a = job(1000, 'released');
    shift(a, 400);
    syncJobStatus(a);
    setByHand(a, 'done');
    // More output, then less: neither moves it, the floor being a person's.
    shift(a, 100);
    assert.equal(syncJobStatus(a), 'done');
    db.prepare('DELETE FROM production_entries WHERE work_order_id = ?').run(a);
    assert.equal(syncJobStatus(a), 'done');
  });

  test('released is an act: no amount of output ever sets it', () => {
    const a = job(1000);
    shift(a, 400);
    syncJobStatus(a);
    assert.equal(row(a).status, 'running', 'it went to running, not released');
    db.prepare('DELETE FROM production_entries WHERE work_order_id = ?').run(a);
    assert.equal(syncJobStatus(a), 'planned');
  });

  test('a scrapped lot stops counting, so it does not hold a job running', () => {
    const a = job(1000, 'released');
    const batch = Number((db.prepare(
      `INSERT INTO batches (work_order_id, number, date, disposition) VALUES (?, 'B/JS/1', '2026-09-03', '') RETURNING id`
    ).get(a) as { id: number }).id);
    db.prepare("INSERT INTO production_entries (work_order_id, batch_id, date, qty_ok, qty_reject) VALUES (?, ?, '2026-09-03', 1000, 0)")
      .run(a, batch);
    assert.equal(syncJobStatus(a), 'done');
    db.prepare("UPDATE batches SET disposition = 'scrapped' WHERE id = ?").run(batch);
    assert.equal(syncJobStatus(a), 'released', 'condemned output kept the job going');
  });

  test('a job that is not there is left alone', () => {
    assert.equal(syncJobStatus(999999), null);
  });
});

/**
 * The floor's queue: due to start, and nobody has said whether it did. SQL
 * rather than a function, so it is asked of the database the way the list asks
 * it — the five branches are what a wrong answer would put on or off the
 * floor's screen.
 */
describe('a job due to start with no answer', () => {
  const due = (jobId: number) => Number((db.prepare(
    `SELECT ${DUE_TO_START('w')} AS d FROM work_orders w WHERE w.id = ?`
  ).get(jobId) as { d: number }).d);

  const dated = (start: string, status = 'released', revised = '') => {
    const id = job(1000, status);
    db.prepare('UPDATE work_orders SET planned_start = ?, revised_start = ? WHERE id = ?')
      .run(start, revised, id);
    return id;
  };

  test('a start date in the past, still only released: due', () => {
    assert.equal(due(dated('2020-01-01')), 1);
  });

  test('a start date still to come: not yet', () => {
    assert.equal(due(dated('2099-01-01')), 0);
  });

  test('no start date at all: never asked — silence is not a date', () => {
    assert.equal(due(dated('')), 0);
  });

  test('already running, done, paused or cancelled: the answer has been given', () => {
    for (const s of ['running', 'done', 'paused', 'cancelled']) {
      assert.equal(due(dated('2020-01-01', s)), 0, `${s} was still being asked about`);
    }
  });

  test('the revised date is what is asked about, in both directions', () => {
    // Overdue on the plan, but moved out: no longer due.
    assert.equal(due(dated('2020-01-01', 'released', '2099-01-01')), 0);
    // Planned far out, revised into the past: due on the date that stands.
    assert.equal(due(dated('2099-01-01', 'released', '2020-01-01')), 1);
  });
});
