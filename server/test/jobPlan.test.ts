import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { layOutQueue, byDue, summarise, SORTS, type QueueJob } from '../src/services/jobPlan.js';
import type { OutputRate } from '../src/services/outputRate.js';

/**
 * Laying a queue of jobs out on the calendar (2026-11-16).
 *
 * The function is pure, so none of this needs a database. Most of the cases
 * are about what the plan must **not** do: overlap two jobs on one machine,
 * plan work that is already made, stall a whole press on one unmeasured
 * product, or stay silent about a promise it breaks.
 */

let seq = 0;
const job = (o: Partial<QueueJob> = {}): QueueJob => ({
  id: ++seq,
  number: o.number ?? `WO/Q-${seq}`,
  product_id: o.product_id === undefined ? seq : o.product_id,
  customer_name: o.customer_name ?? 'Bharat Engineering Works',
  item: o.item ?? '28mm PCO 1810',
  order_id: o.order_id ?? seq,
  order_number: o.order_number ?? `SO/Q-${seq}`,
  pieces: o.pieces ?? 1_00_000,
  due: o.due === undefined ? null : o.due,
  due_source: o.due_source ?? (o.due ? 'order' : 'none'),
});

const rate = (productId: number, pcsPerDay: number): [number, OutputRate] =>
  [productId, { product_id: productId, pcs_per_day: pcsPerDay, source: 'measured', days: 5, last_run: '2026-11-01' }];

describe('laying out a queue', () => {
  /**
   * The invariant the whole thing rests on: one queue, one job at a time, no
   * gap and no overlap. Asserted across the queue rather than per row,
   * because an off-by-one in the cursor is invisible on any single job.
   */
  test('jobs run end to end — no gap and no overlap', () => {
    const a = job({ pieces: 1_00_000, product_id: 1 });
    const b = job({ pieces: 50_000, product_id: 2 });
    const c = job({ pieces: 10_000, product_id: 3 });
    const out = layOutQueue([a, b, c], new Map([rate(1, 50_000), rate(2, 50_000), rate(3, 50_000)]), '2026-11-20');
    assert.deepEqual(out.map((p) => [p.days, p.planned_start, p.planned_end]), [
      [2, '2026-11-20', '2026-11-21'],
      [1, '2026-11-22', '2026-11-22'],
      [1, '2026-11-23', '2026-11-23'],
    ]);
    for (let i = 1; i < out.length; i += 1) {
      const prevEnd = Date.parse(out[i - 1].planned_end);
      const start = Date.parse(out[i].planned_start);
      assert.equal(start - prevEnd, 86_400_000, 'the queue gapped or overlapped');
    }
  });

  /** Seven production days a week — the client's own answer — so nothing is skipped. */
  test('it runs through a Sunday, because this plant does', () => {
    const [p] = layOutQueue([job({ pieces: 3_00_000, product_id: 1 })], new Map([rate(1, 1_00_000)]), '2026-11-20');
    assert.equal(p.planned_start, '2026-11-20');   // a Friday
    assert.equal(p.planned_end, '2026-11-22');     // the Sunday
  });

  /**
   * **The balance, not the plan.** A job half made needs half the days, and
   * scheduling the whole figure again would push everything behind it out by
   * days nobody is going to work.
   */
  test('a part-made job is planned for what is left', () => {
    const out = layOutQueue(
      [job({ pieces: 20_000, product_id: 1 }), job({ pieces: 1_00_000, product_id: 1 })],
      new Map([rate(1, 20_000)]), '2026-11-20',
    );
    assert.equal(out[0].days, 1);
    assert.equal(out[1].planned_start, '2026-11-21');
  });

  test('a tiny job still takes a day', () => {
    const [p] = layOutQueue([job({ pieces: 200, product_id: 1 })], new Map([rate(1, 1_00_000)]), '2026-11-20');
    assert.equal(p.days, 1);
    assert.equal(p.planned_start, p.planned_end);
  });

  /**
   * A job the app cannot time is named and **skipped**, not guessed at and
   * not blocking: one unmeasured product must not stall a press over eighty
   * jobs, and the rows after it keep the dates they would have had.
   */
  test('a job with no rate takes no slot and does not shift the ones after it', () => {
    const out = layOutQueue(
      [job({ pieces: 1_00_000, product_id: 1 }), job({ pieces: 1_00_000, product_id: 9 }), job({ pieces: 1_00_000, product_id: 1 })],
      new Map([rate(1, 1_00_000)]), '2026-11-20',
    );
    assert.deepEqual(out.map((p) => p.blocked), [null, 'no-rate', null]);
    assert.deepEqual(out[1], { ...out[1], planned_start: '', planned_end: '', days: null, rate: null });
    assert.equal(out[2].planned_start, '2026-11-21', 'the unplannable job ate a day');
  });

  test('a job naming no product at all is the same case', () => {
    const [p] = layOutQueue([job({ product_id: null })], new Map([rate(1, 1_00_000)]), '2026-11-20');
    assert.equal(p.blocked, 'no-rate');
    assert.equal(p.planned_start, '');
  });

  /** Nothing left to make is nothing to schedule — and not a day of machine time. */
  test('a job with nothing left to make is named and skipped', () => {
    const out = layOutQueue(
      [job({ pieces: 0, product_id: 1 }), job({ pieces: 1_00_000, product_id: 1 })],
      new Map([rate(1, 1_00_000)]), '2026-11-20',
    );
    assert.equal(out[0].blocked, 'nothing-left');
    assert.equal(out[1].planned_start, '2026-11-20');
  });

  /**
   * The reason this is worth building: the app already knows when every order
   * is due, so a plan can say which promises it breaks — the question no
   * screen in this app could answer before.
   */
  test('a job that finishes after the customer’s date is marked late', () => {
    const out = layOutQueue(
      [job({ pieces: 1_00_000, product_id: 1, due: '2026-11-21' }), job({ pieces: 1_00_000, product_id: 1, due: '2026-11-20' })],
      new Map([rate(1, 1_00_000)]), '2026-11-20',
    );
    assert.deepEqual(out.map((p) => p.late), [false, true]);
  });

  test('and finishing on the due date is not late', () => {
    const [p] = layOutQueue([job({ pieces: 1_00_000, product_id: 1, due: '2026-11-20' })], new Map([rate(1, 1_00_000)]), '2026-11-20');
    assert.equal(p.late, false);
  });

  test('an order nobody has dated is never late', () => {
    const [p] = layOutQueue([job({ pieces: 9_00_000, product_id: 1, due: null })], new Map([rate(1, 1_000)]), '2026-11-20');
    assert.equal(p.late, false);
  });

  /** The planner's own order, however it was reached — this function sorts nothing. */
  test('the order given is the order run', () => {
    const a = job({ number: 'WO/A', pieces: 1_00_000, product_id: 1 });
    const b = job({ number: 'WO/B', pieces: 1_00_000, product_id: 1 });
    const out = layOutQueue([b, a], new Map([rate(1, 1_00_000)]), '2026-11-20');
    assert.deepEqual(out.map((p) => p.number), ['WO/B', 'WO/A']);
  });

  test('a start date that cannot be read dates nothing rather than guessing', () => {
    const [p] = layOutQueue([job({ pieces: 1_00_000, product_id: 1 })], new Map([rate(1, 1_00_000)]), 'not a date');
    assert.equal(p.planned_end, '', 'an unreadable start produced a date anyway');
  });
});

describe('the order a queue opens in', () => {
  test('is soonest customer date first, with the undated last', () => {
    const rows = [
      job({ number: 'WO/3', due: null }),
      job({ number: 'WO/1', due: '2026-11-20' }),
      job({ number: 'WO/2', due: '2026-12-01' }),
    ];
    assert.deepEqual([...rows].sort(byDue).map((j) => j.number), ['WO/1', 'WO/2', 'WO/3']);
  });
});

describe('what the whole plan comes to', () => {
  const rates = new Map([rate(1, 1_00_000), rate(2, 50_000)]);

  /**
   * The figure over a table has to describe the rows under it. A plan of
   * three jobs spanning four days says four days, and the span is the first
   * start to the last finish rather than a count of the rows.
   */
  test('is the span, the days and the pieces of what it actually dates', () => {
    const plan = layOutQueue([
      job({ pieces: 1_00_000, product_id: 1 }),            // 1 day
      job({ pieces: 1_50_000, product_id: 2 }),            // 3 days
    ], rates, '2026-11-20');
    const s = summarise(plan);
    assert.equal(s.jobs, 2);
    assert.equal(s.days, 4);
    assert.equal(s.pieces, 2_50_000);
    assert.equal(s.from, '2026-11-20');
    assert.equal(s.to, '2026-11-23');
  });

  /**
   * A job the plan cannot date commits no time, so it is **counted and
   * nothing else** — adding its pieces to the total would promise work the
   * plan does not actually schedule.
   */
  test('a job it cannot date is counted, never committed', () => {
    const plan = layOutQueue([
      job({ pieces: 1_00_000, product_id: 1 }),
      job({ pieces: 9_99_999, product_id: 99 }),           // no rate
      job({ pieces: 0, product_id: 1 }),                   // nothing left
    ], rates, '2026-11-20');
    const s = summarise(plan);
    assert.equal(s.jobs, 1);
    assert.equal(s.blocked, 2);
    assert.equal(s.pieces, 1_00_000);
    assert.equal(s.days, 1);
    assert.equal(s.to, '2026-11-20');
  });

  /** Nothing datable is a blank span, not a span of the start date. */
  test('a plan that dates nothing states no span', () => {
    const s = summarise(layOutQueue([job({ pieces: 1_000, product_id: 99 })], rates, '2026-11-20'));
    assert.deepEqual([s.jobs, s.blocked, s.from, s.to], [0, 1, '', '']);
  });

  /**
   * The two counts a planner decides on, and they are different questions:
   * *late* is a promise this plan breaks, *undated* is a promise nobody ever
   * made — which on a book where no screen offers a customer date is most of
   * them, and reads as a broken column rather than an absence unless it is
   * said out loud.
   */
  test('late and undated are counted apart', () => {
    const plan = layOutQueue([
      job({ pieces: 1_00_000, product_id: 1, due: '2026-11-25' }),   // in time
      job({ pieces: 1_00_000, product_id: 1, due: '2026-11-20' }),   // late
      job({ pieces: 1_00_000, product_id: 1, due: null }),           // nobody said
    ], rates, '2026-11-20');
    const s = summarise(plan);
    assert.equal(s.late, 1);
    assert.equal(s.undated, 1);
  });
});

describe('how late a late job is', () => {
  const rates = new Map([rate(1, 1_00_000)]);

  /**
   * *Three days* and *seven weeks* are different problems, and subtracting
   * two dates in your head down a column of forty-seven is how a fortnight's
   * slip goes unnoticed — the order book's own reasoning about its slip
   * column, one screen over.
   */
  test('is stated in days, not left to be worked out', () => {
    const [p] = layOutQueue(
      [job({ pieces: 5_00_000, product_id: 1, due: '2026-11-21' })], rates, '2026-11-20');
    assert.equal(p.planned_end, '2026-11-24');
    assert.equal(p.late, true);
    assert.equal(p.late_days, 3);
  });

  /** Finishing **on** the customer's date is not late, and is not 0 days late either. */
  test('finishing on the day is not late', () => {
    const [p] = layOutQueue(
      [job({ pieces: 1_00_000, product_id: 1, due: '2026-11-20' })], rates, '2026-11-20');
    assert.equal(p.late, false);
    assert.equal(p.late_days, 0);
  });

  /** Early is not negative-late: a job in good time says nothing. */
  test('and finishing early states nothing', () => {
    const [p] = layOutQueue(
      [job({ pieces: 1_00_000, product_id: 1, due: '2026-12-31' })], rates, '2026-11-20');
    assert.equal(p.late_days, 0);
  });
});

describe('the rule a queue opens on', () => {
  const q = (number: string, o: Partial<QueueJob> = {}) => job({ number, ...o });

  /**
   * A policy rather than a drag: nudging one place at a time is right for the
   * last correction and no use on the client's own 47-job screen, where
   * moving the fortieth row to the front is thirty-nine presses.
   */
  test('shortest first clears the floor fastest', () => {
    const rows = [q('WO/1', { pieces: 5_00_000 }), q('WO/2', { pieces: 10_000 }), q('WO/3', { pieces: 90_000 })];
    assert.deepEqual([...rows].sort(SORTS.shortest).map((j) => j.number), ['WO/2', 'WO/3', 'WO/1']);
    assert.deepEqual([...rows].sort(SORTS.longest).map((j) => j.number), ['WO/1', 'WO/3', 'WO/2']);
  });

  /** One sales order's jobs run together, which is how this plant loads a lorry. */
  test('by sales order keeps an order together', () => {
    const rows = [
      q('WO/1', { order_number: 'SO/9' }),
      q('WO/2', { order_number: 'SO/1' }),
      q('WO/3', { order_number: 'SO/9' }),
    ];
    assert.deepEqual([...rows].sort(SORTS.order).map((j) => j.number), ['WO/2', 'WO/1', 'WO/3']);
  });

  /**
   * Nothing left to make is an absence rather than the smallest job on the
   * book, so it sorts last under either size rule — otherwise a queue asked
   * for the shortest first would open on the rows it cannot date at all.
   */
  test('a job with nothing left is not the shortest job', () => {
    const rows = [q('WO/1', { pieces: 0 }), q('WO/2', { pieces: 50_000 })];
    assert.deepEqual([...rows].sort(SORTS.shortest).map((j) => j.number), ['WO/2', 'WO/1']);
  });

  /** Ties break on the job number, so one book always lays out one way. */
  test('a tie is settled, never left to chance', () => {
    const rows = [q('WO/9', { pieces: 1_000 }), q('WO/1', { pieces: 1_000 })];
    assert.deepEqual([...rows].sort(SORTS.shortest).map((j) => j.number), ['WO/1', 'WO/9']);
  });

  test('and the default is still soonest customer date first', () => {
    assert.equal(SORTS.due, byDue);
  });
});
