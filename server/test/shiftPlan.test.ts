import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { layOutShifts, summariseShifts, slotKey, type ShiftJob, type LineSpec }
  from '../src/services/shiftPlan.js';

/**
 * The shift scheduler.
 *
 * It is a pure function, so these need no database at all — the shape
 * `jobPlan.test.ts` beside it already has. The cases that carry the design are
 * that **two jobs of one product and colour share a slot** (which is what a
 * run is), that **a changeover costs the slot it happens in**, and that a line
 * already running the right thing is **preferred over an equally free one** —
 * which is the only honest reading of *minimise unnecessary changeovers*.
 */

const KEYS = ['A', 'B'];

const line = (id: number, o: Partial<LineSpec> = {}): LineSpec =>
  ({ id, name: `Line ${id}`, shifts_per_day: 2, changeover_mins: 0, ...o });

let seq = 0;
const job = (o: Partial<ShiftJob> & { pieces: number }): ShiftJob => {
  seq += 1;
  return {
    id: seq, number: `WO/${String(seq).padStart(3, '0')}`,
    product_id: 1, product_name: 'Preform', color: 'Natural',
    customer_name: 'C', order_id: 1, order_number: 'SO/1',
    due: null, due_source: 'none',
    current: { planned_start: '', planned_end: '', revised_start: '', revised_end: '' },
    ...o,
  };
};

/** 50,000 a shift of anything, on any line. */
const flat = (n: number) => () => n;

const plan = (jobs: ShiftJob[], lines: LineSpec[], rate: (p: number | null, l: number) => number | null,
  start = '2026-12-01', shape = {}) =>
  layOutShifts(jobs, lines, rate, start, { shiftKeys: KEYS, ...shape });

describe('a job is laid out shift by shift', () => {
  test('a job bigger than a shift takes as many as it needs', () => {
    const r = plan([job({ pieces: 120000 })], [line(1)], flat(50000));
    // 120,000 at 50,000 a shift is three slots: 50 + 50 + 20.
    assert.equal(r.runs.length, 3);
    assert.deepEqual(r.runs.map((x) => x.qty_planned), [50000, 50000, 20000]);
    assert.equal(r.jobs[0].placed, 120000);
    assert.equal(r.jobs[0].shifts, 3);
  });

  test('and fills the day before moving to the next', () => {
    const r = plan([job({ pieces: 120000 })], [line(1)], flat(50000));
    assert.deepEqual(r.runs.map((x) => `${x.date} ${x.shift}`),
      ['2026-12-01 A', '2026-12-01 B', '2026-12-02 A']);
  });

  test('a one-shift line runs one slot a day', () => {
    const r = plan([job({ pieces: 120000 })], [line(1, { shifts_per_day: 1 })], flat(50000));
    assert.deepEqual(r.runs.map((x) => `${x.date} ${x.shift}`),
      ['2026-12-01 A', '2026-12-02 A', '2026-12-03 A']);
  });

  test('a job that fits one shift takes one', () => {
    const r = plan([job({ pieces: 30000 })], [line(1)], flat(50000));
    assert.equal(r.runs.length, 1);
    assert.equal(r.runs[0].qty_planned, 30000);
    assert.equal(r.jobs[0].planned_start, '2026-12-01');
    assert.equal(r.jobs[0].planned_end, '2026-12-01');
  });
});

describe('two jobs of one product and colour share a slot', () => {
  test('which is what a run is — two allocations, never one quantity', () => {
    const a = job({ pieces: 30000 });
    const b = job({ pieces: 15000 });
    const r = plan([a, b], [line(1)], flat(50000));
    assert.equal(r.runs.length, 1);
    const run = r.runs[0];
    assert.equal(run.qty_planned, 45000);
    assert.equal(run.allocations.length, 2);
    assert.deepEqual(run.allocations.map((x) => x.qty_planned), [30000, 15000]);
    // No piece belongs to two jobs: the run is exactly its allocations.
    assert.equal(run.allocations.reduce((s, x) => s + x.qty_planned, 0), run.qty_planned);
  });

  test('and the overflow goes to the next slot, still shared', () => {
    const a = job({ pieces: 40000 });
    const b = job({ pieces: 30000 });
    const r = plan([a, b], [line(1)], flat(50000));
    assert.equal(r.runs.length, 2);
    assert.equal(r.runs[0].qty_planned, 50000);   // 40,000 of a + 10,000 of b
    assert.equal(r.runs[1].qty_planned, 20000);   // the rest of b
    assert.equal(r.runs[0].allocations.length, 2);
  });

  test('a different colour never shares, however much room is left', () => {
    const a = job({ pieces: 10000, color: 'Natural' });
    const b = job({ pieces: 10000, color: 'Black' });
    const r = plan([a, b], [line(1)], flat(50000));
    assert.equal(r.runs.length, 2);
    assert.deepEqual(r.runs.map((x) => x.color), ['Natural', 'Black']);
  });

  test('nor does a different product', () => {
    const a = job({ pieces: 10000, product_id: 1 });
    const b = job({ pieces: 10000, product_id: 2, product_name: 'Cap' });
    const r = plan([a, b], [line(1)], flat(50000));
    assert.equal(r.runs.length, 2);
    assert.deepEqual(r.runs.map((x) => x.product_id), [1, 2]);
  });
});

describe('a changeover costs the slot it happens in', () => {
  test('the first slot on a line is never a changeover', () => {
    // There is nothing to change from.
    const r = plan([job({ pieces: 10000 })], [line(1, { changeover_mins: 72 })], flat(50000));
    assert.equal(r.runs[0].changeover, false);
    assert.equal(r.runs[0].capacity, 50000);
  });

  test('but the next product on that line is', () => {
    const a = job({ pieces: 50000, color: 'Natural' });
    const b = job({ pieces: 10000, color: 'Black' });
    // 72 of 720 minutes is a tenth of the shift.
    const r = plan([a, b], [line(1, { changeover_mins: 72 })], flat(50000));
    assert.equal(r.runs[0].changeover, false);
    assert.equal(r.runs[1].changeover, true);
    assert.equal(r.runs[1].capacity, 45000);
  });

  test('and a line with no changeover stated costs nothing, as the plant runs today', () => {
    const a = job({ pieces: 50000, color: 'Natural' });
    const b = job({ pieces: 10000, color: 'Black' });
    const r = plan([a, b], [line(1)], flat(50000));
    assert.equal(r.runs[1].changeover, true);
    assert.equal(r.runs[1].capacity, 50000);
  });

  test('going back to a colour the line ran before is still a changeover', () => {
    // The line is running something else now — what it ran yesterday is not
    // what is in the machine. Each job here fits its slot, so the three runs
    // are one per job and the changeovers are the two colour changes.
    const r = plan([
      job({ pieces: 50000, color: 'Natural' }),
      job({ pieces: 10000, color: 'Black' }),
      job({ pieces: 10000, color: 'Natural' }),
    ], [line(1, { changeover_mins: 72 })], flat(50000));
    assert.deepEqual(r.runs.map((x) => x.color), ['Natural', 'Black', 'Natural']);
    assert.deepEqual(r.runs.map((x) => x.changeover), [false, true, true]);
  });

  test('but a job spilling into a second slot is not changing anything over', () => {
    // The case that corrected the one above: a job too big for its slot
    // continues on the line's next one, and continuing is not a change.
    const r = plan([
      job({ pieces: 50000, color: 'Natural' }),
      job({ pieces: 50000, color: 'Black' }),
    ], [line(1, { changeover_mins: 72 })], flat(50000));
    assert.deepEqual(r.runs.map((x) => x.color), ['Natural', 'Black', 'Black']);
    // 45,000 of the Black fits the changed-over slot; the last 5,000 spills
    // into a slot that is already Black and so costs nothing.
    assert.deepEqual(r.runs.map((x) => x.changeover), [false, true, false]);
    assert.deepEqual(r.runs.map((x) => x.qty_planned), [50000, 45000, 5000]);
  });
});

describe('the line that frees first takes the work', () => {
  test('so two lines halve the calendar', () => {
    const r = plan([job({ pieces: 50000 }), job({ pieces: 50000, color: 'Black' })],
      [line(1), line(2)], flat(50000));
    // Both on the same day and shift, on different lines.
    assert.deepEqual(r.runs.map((x) => `${x.date} ${x.shift} L${x.machine_id}`),
      ['2026-12-01 A L1', '2026-12-01 A L2']);
  });

  test('a line already running the right thing beats an equally free one', () => {
    // The tie-break that avoids a changeover: line 1 is mid-Natural with room,
    // so the second Natural job joins it rather than opening line 2.
    const r = plan([job({ pieces: 20000 }), job({ pieces: 20000 })],
      [line(1, { changeover_mins: 72 }), line(2, { changeover_mins: 72 })], flat(50000));
    assert.equal(r.runs.length, 1);
    assert.equal(r.runs[0].machine_id, 1);
    assert.equal(r.runs[0].allocations.length, 2);
  });

  test('but it is a tie-break, not a reordering — an earlier slot still wins', () => {
    // Line 2 is free on the 1st while line 1 is busy until the 3rd. The job
    // goes to line 2 and takes the changeover: trading a promise for some
    // minutes is the planner's call, not this function's.
    const busy = new Set([slotKey('2026-12-01', 1, 'A'), slotKey('2026-12-01', 1, 'B'),
      slotKey('2026-12-02', 1, 'A'), slotKey('2026-12-02', 1, 'B')]);
    const r = plan([job({ pieces: 10000 })], [line(1), line(2)], flat(50000),
      '2026-12-01', { busy });
    assert.equal(r.runs[0].machine_id, 2);
    assert.equal(r.runs[0].date, '2026-12-01');
  });

  test('and a line holding the wrong colour does not win a slot it has not got', () => {
    /*
     * The case that found a real defect. Line 1 opens with Natural and keeps
     * room; line 2 is empty. A Black job can share neither, so on line 1 it
     * would land on the *next* slot while on line 2 it lands on this one —
     * and scoring line 1 at its current cursor made it win the tie and push
     * the work a shift later than it needed to go.
     */
    const r = plan([
      job({ pieces: 20000, color: 'Natural' }),
      job({ pieces: 20000, color: 'Black' }),
    ], [line(1), line(2)], flat(50000));
    assert.equal(r.runs[0].machine_id, 1);
    assert.equal(r.runs[1].machine_id, 2);
    assert.deepEqual(r.runs.map((x) => `${x.date} ${x.shift}`),
      ['2026-12-01 A', '2026-12-01 A']);
  });

  test('a line that runs no shifts takes nothing', () => {
    const r = plan([job({ pieces: 10000 })], [line(1, { shifts_per_day: 0 }), line(2)], flat(50000));
    assert.equal(r.runs.length, 1);
    assert.equal(r.runs[0].machine_id, 2);
  });

  test('a line that cannot make the product takes nothing of it', () => {
    const r = plan([job({ pieces: 10000, product_id: 7 })], [line(1), line(2)],
      (p, l) => (l === 2 ? 50000 : null));
    assert.equal(r.runs[0].machine_id, 2);
  });
});

describe('what it will not plan onto', () => {
  test('a slot already committed is stepped over', () => {
    const busy = new Set([slotKey('2026-12-01', 1, 'A')]);
    const r = plan([job({ pieces: 10000 })], [line(1)], flat(50000), '2026-12-01', { busy });
    assert.equal(r.runs[0].shift, 'B');
    assert.equal(r.runs[0].date, '2026-12-01');
  });

  test('and so is a committed slot in the middle of a job', () => {
    // The case that bites: a job spanning several shifts must step over a
    // slot something else already holds rather than planning on top of it —
    // which is what a second press of the planner would otherwise do.
    const busy = new Set([slotKey('2026-12-01', 1, 'B'), slotKey('2026-12-02', 1, 'A')]);
    const r = plan([job({ pieces: 120000 })], [line(1)], flat(50000), '2026-12-01', { busy });
    assert.deepEqual(r.runs.map((x) => `${x.date} ${x.shift}`),
      ['2026-12-01 A', '2026-12-02 B', '2026-12-03 A']);
    // Still three production shifts — a committed slot costs calendar, never
    // work, which is the shut-down list's own rule one unit down.
    assert.equal(r.jobs[0].shifts, 3);
    assert.equal(r.jobs[0].placed, 120000);
  });

  test('and a day the plant is shut is skipped whole', () => {
    const shutdowns = new Set(['2026-12-01']);
    const r = plan([job({ pieces: 10000 })], [line(1)], flat(50000), '2026-12-01', { shutdowns });
    assert.equal(r.runs[0].date, '2026-12-02');
  });

  test('a job with nothing left is named, not planned', () => {
    const r = plan([job({ pieces: 0 })], [line(1)], flat(50000));
    assert.equal(r.runs.length, 0);
    assert.equal(r.jobs[0].blocked, 'nothing-left');
  });

  test('a product no line can make is named rather than guessed at', () => {
    // `hasRecipe: false`'s rule, and the answer `layOutQueue` gives too.
    const r = plan([job({ pieces: 10000 })], [line(1)], () => null);
    assert.equal(r.runs.length, 0);
    assert.equal(r.jobs[0].blocked, 'no-rate');
  });

  test('and with no line at all nothing is planned', () => {
    const r = plan([job({ pieces: 10000 })], [], flat(50000));
    assert.equal(r.runs.length, 0);
    assert.equal(r.jobs[0].blocked, 'no-line');
  });
});

describe('what the plan says about the promises it breaks', () => {
  test('a job finishing after the customer\'s date is late, in days', () => {
    const r = plan([job({ pieces: 300000, due: '2026-12-02', due_source: 'order' })],
      [line(1)], flat(50000));
    // Six shifts over three days: the 1st, 2nd and 3rd.
    assert.equal(r.jobs[0].planned_end, '2026-12-03');
    assert.equal(r.jobs[0].late, true);
    assert.equal(r.jobs[0].late_days, 1);
  });

  test('finishing on the day is not late', () => {
    const r = plan([job({ pieces: 100000, due: '2026-12-01', due_source: 'order' })],
      [line(1)], flat(50000));
    assert.equal(r.jobs[0].planned_end, '2026-12-01');
    assert.equal(r.jobs[0].late, false);
    assert.equal(r.jobs[0].late_days, 0);
  });

  test('and a job nobody has dated is never late', () => {
    const r = plan([job({ pieces: 300000 })], [line(1)], flat(50000));
    assert.equal(r.jobs[0].late, false);
  });
});

describe('what the whole plan comes to', () => {
  test('is counted over what it actually plans', () => {
    const s = summariseShifts(plan([
      job({ pieces: 100000, due: '2026-12-01', due_source: 'order' }),
      job({ pieces: 50000, color: 'Black' }),
      job({ pieces: 0 }),
    ], [line(1)], flat(50000)));
    assert.equal(s.jobs, 2);
    assert.equal(s.blocked, 1);
    assert.equal(s.pieces, 150000);
    assert.equal(s.runs, 3);
    assert.equal(s.changeovers, 1);
    // Late and undated are counted apart: a promise this breaks and a promise
    // nobody made are different problems.
    assert.equal(s.undated, 1);
    assert.equal(s.from, '2026-12-01');
  });

  test('a plan that plans nothing states no span', () => {
    const s = summariseShifts(plan([job({ pieces: 0 })], [line(1)], flat(50000)));
    assert.equal(s.runs, 0);
    assert.equal(s.from, '');
    assert.equal(s.to, '');
  });
});
