import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { plantLanes, linesFreeFrom } from '../src/services/plantLoad.js';
import { makeCustomer, makeOrder } from './helpers/factory.js';

/**
 * What the plant itself is doing — how many jobs it runs at once, and what it
 * is already committed to (2026-11-17).
 *
 * Both are what the production planner was missing. It modelled a plant that
 * runs **one** job at a time and started every queue wherever it was told, so
 * a second press laid its jobs straight over the first — measured on a
 * planted book, 84 of 196 days carried two or three jobs on a one-line plant.
 *
 * Most of these are about what must **not** count: a day of catch-up entries
 * must not make the plant look bigger, and a job about to be re-planned must
 * not push its own replacement outwards.
 */

let seq = 0;

function job(o: Partial<{ start: string; end: string; status: string }> = {}): number {
  const order = makeOrder({ customerId: makeCustomer(), currency: 'INR' });
  return Number((db.prepare(
    `INSERT INTO work_orders (number, order_id, order_line, qty_planned, planned_start, planned_end, revised_start, revised_end, status)
     VALUES (?, ?, 0, 1000, ?, ?, '', '', ?) RETURNING id`
  ).get(`WO/L-${++seq}`, order, o.start ?? '', o.end ?? '', o.status ?? 'planned') as { id: number }).id);
}

const shift = (jobId: number, date: string) => db.prepare(
  `INSERT INTO production_entries (work_order_id, date, shift, qty_ok, qty_reject) VALUES (?, ?, 'A', 1000, 0)`
).run(jobId, date);

const clearShifts = () => db.exec('DELETE FROM production_entries');
const clearJobs = () => db.exec('DELETE FROM work_orders');

describe('how many jobs the plant runs at once', () => {
  test('is the jobs booked on a typical day', () => {
    clearShifts();
    const jobs = Array.from({ length: 6 }, () => job());
    for (const d of ['2026-11-01', '2026-11-02', '2026-11-03']) {
      for (const w of jobs.slice(0, 4)) shift(w, d);
    }
    const p = plantLanes();
    assert.equal(p.lanes, 4);
    assert.equal(p.days, 3, 'three days of shift book behind it');
  });

  /**
   * The reason it is a median, and the same reason the output rate is: one
   * day of catch-up entries — a fortnight of back-dated shifts keyed to a
   * single date — would pull an average up hard, and a plant sized by that
   * average plans every job to start sooner than a line can take it.
   */
  test('a catch-up day does not make the plant look bigger', () => {
    clearShifts();
    const jobs = Array.from({ length: 12 }, () => job());
    for (const d of ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']) {
      for (const w of jobs.slice(0, 2)) shift(w, d);
    }
    for (const w of jobs) shift(w, '2026-11-05');   // one day, twelve jobs
    const p = plantLanes();
    assert.equal(p.lanes, 2, 'the typical day, not the average');
    assert.equal(p.busiest, 12, 'but the day itself is reported');
    assert.ok(p.mean > p.lanes, 'and the average is carried so the gap can be seen');
  });

  /** Several shifts on one job on one day is one job, not two. */
  test('two shifts on one job is one job', () => {
    clearShifts();
    const w = job();
    db.prepare(`INSERT INTO production_entries (work_order_id, date, shift, qty_ok, qty_reject) VALUES (?, '2026-11-01', 'B', 1000, 0)`).run(w);
    shift(w, '2026-11-01');
    assert.equal(plantLanes().lanes, 1);
  });

  /**
   * A book with nothing in it says so rather than guessing: one line, and
   * `days: 0` for the screen to say there is nothing behind the figure.
   */
  test('an empty shift book is one line, and says it is empty', () => {
    clearShifts();
    assert.deepEqual(plantLanes(), { lanes: 1, mean: 0, busiest: 0, days: 0 });
  });
});

describe('when the plant comes free', () => {
  test('is the latest finishes, one per line', () => {
    clearJobs();
    job({ start: '2026-11-01', end: '2026-11-10' });
    job({ start: '2026-11-01', end: '2026-11-20' });
    job({ start: '2026-11-01', end: '2026-11-15' });
    const a = linesFreeFrom(2);
    assert.deepEqual(a.free_from, ['2026-11-21', '2026-11-16'], 'the day after, never the day of');
    assert.equal(a.committed_to, '2026-11-20');
    assert.equal(a.jobs, 3);
  });

  /** Fewer committed jobs than lines: the rest are free, and say nothing. */
  test('says nothing about a line nothing is on', () => {
    clearJobs();
    job({ start: '2026-11-01', end: '2026-11-10' });
    assert.deepEqual(linesFreeFrom(4).free_from, ['2026-11-11']);
  });

  test('and an empty book commits nothing', () => {
    clearJobs();
    assert.deepEqual(linesFreeFrom(3), { free_from: [], committed_to: '', jobs: 0 });
  });

  /**
   * The rule that makes a **re-plan** honest. A job in the queue is about to
   * be given new dates, so the dates it holds now are not a commitment — and
   * counting them would push the job's own replacement out behind itself,
   * walking the whole book forward a month on every press.
   */
  test('a job about to be re-planned is not a commitment', () => {
    clearJobs();
    const keep = job({ start: '2026-11-01', end: '2026-11-10' });
    const replan = job({ start: '2026-11-01', end: '2027-06-30' });
    assert.equal(linesFreeFrom(1).committed_to, '2027-06-30');
    const after = linesFreeFrom(1, [replan]);
    assert.equal(after.committed_to, '2026-11-10');
    assert.equal(after.jobs, 1);
    assert.ok(keep > 0);
  });

  /** A job that is finished or cancelled holds no line. */
  test('a finished or cancelled job holds no line', () => {
    clearJobs();
    job({ start: '2026-11-01', end: '2027-01-01', status: 'done' });
    job({ start: '2026-11-01', end: '2027-02-01', status: 'cancelled' });
    job({ start: '2026-11-01', end: '2026-11-10' });
    assert.equal(linesFreeFrom(3).committed_to, '2026-11-10');
  });

  /** A job nobody has dated is not a commitment either — it is the queue. */
  test('an undated job commits nothing', () => {
    clearJobs();
    job();
    job({ start: '2026-11-01', end: '2026-11-10' });
    assert.deepEqual(linesFreeFrom(3).free_from, ['2026-11-11']);
  });

  /** The revised date is the one that stands, here as everywhere else. */
  test('reads the date that stands, not the original', () => {
    clearJobs();
    const w = job({ start: '2026-11-01', end: '2026-11-10' });
    db.prepare("UPDATE work_orders SET revised_end = '2026-12-25' WHERE id = ?").run(w);
    assert.equal(linesFreeFrom(1).committed_to, '2026-12-25');
  });
});
