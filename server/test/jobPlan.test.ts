import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { layOutQueue, byDue, type QueueJob } from '../src/services/jobPlan.js';
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
