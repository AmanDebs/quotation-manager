import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import {
  SHIFTS, SHIFT_KEYS, shiftHours, normaliseShift, isKnownShift,
  shutdownDates, productionLines,
} from '../src/services/shifts.js';
import { measuredShiftRates, shiftRates, outputRates } from '../src/services/outputRate.js';
import { layOutQueue, type QueueJob } from '../src/services/jobPlan.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * Lines, shifts and the days the plant does not run.
 *
 * Almost every case here is about something **not** moving: the shift rate
 * must not be read as a day rate, a line nobody edited must behave as it did,
 * and an empty shut-down list must leave every date the scheduler produces
 * exactly where it was — which is what makes this safe to land on a live book.
 */

const customerId = makeCustomer();

function makeProduct(name: string, rate: number | null): number {
  return Number((db.prepare(
    `INSERT INTO products (name, unit, pcs_per_day) VALUES (?, 'per 1000', ?) RETURNING id`
  ).get(name, rate) as { id: number }).id);
}

function makeJob(productId: number, number: string): number {
  const orderId = Number((db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status)
     VALUES (?, '2026-11-01', ?, 1, 'INR', 'igst', 'pending') RETURNING id`
  ).get(`SO/${number}`, customerId) as { id: number }).id);
  return Number((db.prepare(
    `INSERT INTO work_orders (number, order_id, order_line, product_id, qty_planned, status)
     VALUES (?, ?, 0, ?, 100000, 'planned') RETURNING id`
  ).get(number, orderId, productId) as { id: number }).id);
}

const book = (jobId: number, date: string, shift: string, qtyOk: number) =>
  db.prepare(
    `INSERT INTO production_entries (work_order_id, date, shift, qty_ok) VALUES (?, ?, ?, ?)`
  ).run(jobId, date, shift, qtyOk);

const job = (o: Partial<QueueJob> & { id: number; pieces: number }): QueueJob => ({
  number: `WO/${o.id}`, product_id: 1, customer_name: 'C', item: 'I',
  order_id: 1, order_number: 'SO/1', due: null, due_source: 'none',
  current: { planned_start: '', planned_end: '', revised_start: '', revised_end: '' },
  ...o,
});

const RATE = new Map([[1, { product_id: 1, pcs_per_day: 1000, source: 'measured' as const, days: 5, last_run: '2026-11-01' }]]);

describe('the shift vocabulary', () => {
  test('is the two shifts this plant runs, of twelve hours', () => {
    // The brief named A/B/C; the client's own COA reads `05032026A+B`, and
    // their answer when asked was two. The paper won.
    assert.deepEqual(SHIFT_KEYS, ['A', 'B']);
    assert.equal(SHIFTS.every((s) => s.hours === 12), true);
    assert.equal(shiftHours('A'), 12);
  });

  test('reads a stored value back however it was typed', () => {
    assert.equal(normaliseShift(' a '), 'A');
    assert.equal(normaliseShift('B'), 'B');
    assert.equal(normaliseShift(null), '');
  });

  test('and keeps one this build does not offer, rather than refusing it', () => {
    // `unitOptions`' rule: every entry on file was typed by hand, and a record
    // is not corrected by a release that stops offering its value.
    assert.equal(normaliseShift('C'), 'C');
    assert.equal(isKnownShift('C'), false);
    assert.equal(isKnownShift('a'), true);
  });
});

describe('a line is a machine', () => {
  test('and carries the shifts and changeover that make it one to plan into', () => {
    db.prepare(
      `INSERT INTO machines (name, code, type, shifts_per_day, changeover_mins)
       VALUES ('Line 1', 'L1', 'moulding', 2, 45)`
    ).run();
    const line = productionLines().find((l) => l.name === 'Line 1');
    assert.ok(line);
    assert.equal(line.shifts_per_day, 2);
    assert.equal(line.changeover_mins, 45);
    // Derived, never stored: a column would be a figure able to disagree with
    // the two it is the product of.
    assert.equal(line.hours_per_day, 24);
  });

  test('a line nobody has edited runs two shifts, as the plant already does', () => {
    db.prepare(`INSERT INTO machines (name, type) VALUES ('Line Default', 'moulding')`).run();
    const line = productionLines().find((l) => l.name === 'Line Default');
    assert.equal(line?.shifts_per_day, 2);
    assert.equal(line?.changeover_mins, 0);
  });

  test('a line set to no shifts is not running, and is not defaulted back', () => {
    // Reading nought as the default two would plan work onto a line somebody
    // deliberately stopped.
    db.prepare(`INSERT INTO machines (name, type, shifts_per_day) VALUES ('Line Down', 'moulding', 0)`).run();
    const line = productionLines().find((l) => l.name === 'Line Down');
    assert.equal(line?.shifts_per_day, 0);
    assert.equal(line?.hours_per_day, 0);
  });

  test('a retired line is not offered', () => {
    db.prepare(`INSERT INTO machines (name, type, active) VALUES ('Line Gone', 'moulding', 0)`).run();
    assert.equal(productionLines().some((l) => l.name === 'Line Gone'), false);
  });
});

describe('the rate measured per shift', () => {
  test('is the typical shift, not the typical day', () => {
    // Two shifts of 20,000 on each of three days: the day rate is 40,000 and
    // the shift rate is 20,000. Reading one as the other is what halves or
    // doubles every duration, which is why they are two functions.
    const p = makeProduct('Twin Shift Preform', null);
    const j = makeJob(p, 'WO/SH-1');
    for (const d of ['2026-11-01', '2026-11-02', '2026-11-03']) {
      book(j, d, 'A', 20000);
      book(j, d, 'B', 20000);
    }
    assert.equal(measuredShiftRates([p]).get(p)?.pcs_per_day, 20000);
    assert.equal(outputRates([p]).get(p)?.pcs_per_day, 40000);
  });

  test('counts a shift that produced nothing good as a zero', () => {
    // The rate is in good pieces, so dropping a bad shift would raise the
    // figure on exactly the evidence that should lower it.
    const p = makeProduct('Bad Shift Cap', null);
    const j = makeJob(p, 'WO/SH-2');
    book(j, '2026-11-01', 'A', 10000);
    book(j, '2026-11-01', 'B', 0);
    book(j, '2026-11-02', 'A', 10000);
    book(j, '2026-11-02', 'B', 0);
    // Four shifts: 0, 0, 10000, 10000 — the median of which is 5,000.
    assert.equal(measuredShiftRates([p]).get(p)?.pcs_per_day, 5000);
  });

  test('a product nobody has run has no shift rate, never zero', () => {
    const p = makeProduct('Never Run', null);
    assert.equal(measuredShiftRates([p]).get(p), undefined);
    assert.equal(shiftRates([p]).get(p), undefined);
  });

  test('an entry carrying no shift is its own shift rather than being dropped', () => {
    // Every row booked before the vocabulary existed reads ''. Folding those
    // into a named shift would invent a fact; dropping them would throw away
    // most of the book.
    const p = makeProduct('Legacy Entries', null);
    const j = makeJob(p, 'WO/SH-3');
    book(j, '2026-11-01', '', 30000);
    book(j, '2026-11-02', '', 30000);
    assert.equal(measuredShiftRates([p]).get(p)?.days, 2);
    assert.equal(measuredShiftRates([p]).get(p)?.pcs_per_day, 30000);
  });
});

describe('a typed rate is a day rate, divided by the shifts the line runs', () => {
  test('so there is no second column to disagree with the first', () => {
    const p = makeProduct('Stated Preform', 60000);
    assert.equal(shiftRates([p], 2).get(p)?.pcs_per_day, 30000);
    assert.equal(shiftRates([p], 1).get(p)?.pcs_per_day, 60000);
    assert.equal(shiftRates([p], 3).get(p)?.pcs_per_day, 20000);
    assert.equal(shiftRates([p], 2).get(p)?.source, 'stated');
  });

  test('and the measurement it overrides rides along to be read against it', () => {
    const p = makeProduct('Overridden Cap', 100000);
    const j = makeJob(p, 'WO/SH-4');
    book(j, '2026-11-01', 'A', 12000);
    book(j, '2026-11-02', 'A', 12000);
    const r = shiftRates([p], 2).get(p);
    assert.equal(r?.source, 'stated');
    assert.equal(r?.pcs_per_day, 50000);
    assert.equal(r?.measured?.pcs_per_day, 12000);
  });

  test('a line set to no shifts never divides by zero', () => {
    // Whether such a line takes work at all is the scheduler's decision, not
    // this function's — so it floors at one rather than answering infinity.
    const p = makeProduct('Floored Cap', 40000);
    assert.equal(shiftRates([p], 0).get(p)?.pcs_per_day, 40000);
  });
});

describe('the days the plant does not run', () => {
  test('are empty by default, so nothing the scheduler does moves', () => {
    // The client's answer on 2026-11-16 was seven days. This list is what
    // lets them say otherwise without anything changing until they do.
    assert.equal(shutdownDates().size, 0);
    const plan = layOutQueue([job({ id: 1, pieces: 3000 })], RATE, '2026-11-02');
    assert.equal(plan[0].planned_start, '2026-11-02');
    assert.equal(plan[0].planned_end, '2026-11-04');
  });

  test('a shut-down inside a run pushes its finish out without adding work', () => {
    const closed = new Set(['2026-11-03']);
    const plan = layOutQueue([job({ id: 1, pieces: 3000 })], RATE, '2026-11-02', { shutdowns: closed });
    // Still three production days — the 2nd, the 4th and the 5th.
    assert.equal(plan[0].days, 3);
    assert.equal(plan[0].planned_start, '2026-11-02');
    assert.equal(plan[0].planned_end, '2026-11-05');
  });

  test('a run never starts on a shut day', () => {
    const closed = new Set(['2026-11-02', '2026-11-03']);
    const plan = layOutQueue([job({ id: 1, pieces: 1000 })], RATE, '2026-11-02', { shutdowns: closed });
    assert.equal(plan[0].planned_start, '2026-11-04');
    assert.equal(plan[0].planned_end, '2026-11-04');
  });

  test('and the job behind it in the queue steps over it too', () => {
    const closed = new Set(['2026-11-04']);
    const plan = layOutQueue(
      [job({ id: 1, pieces: 2000 }), job({ id: 2, pieces: 1000 })],
      RATE, '2026-11-02', { shutdowns: closed },
    );
    assert.equal(plan[0].planned_end, '2026-11-03');
    // The line frees on the 4th, which is shut, so the next job takes the 5th.
    assert.equal(plan[1].planned_start, '2026-11-05');
  });

  test('a retired shut-down opens its day again', () => {
    db.prepare(`INSERT INTO plant_shutdowns (date, note, active) VALUES ('2026-12-25', 'Christmas', 1)`).run();
    db.prepare(`INSERT INTO plant_shutdowns (date, note, active) VALUES ('2026-12-26', 'Cancelled', 0)`).run();
    const days = shutdownDates();
    assert.equal(days.has('2026-12-25'), true);
    assert.equal(days.has('2026-12-26'), false);
  });

  test('a calendar with every day shut reports rather than hanging', () => {
    // A mistake somebody can make on one screen. Past a year of steps the day
    // is returned as it stands — visibly wrong, where a spin takes the whole
    // press down with it.
    const closed = new Set<string>();
    for (let i = 0; i < 400; i++) {
      closed.add(new Date(Date.UTC(2026, 10, 2 + i)).toISOString().slice(0, 10));
    }
    const plan = layOutQueue([job({ id: 1, pieces: 1000 })], RATE, '2026-11-02', { shutdowns: closed });
    assert.ok(plan[0].planned_start);
  });
});
