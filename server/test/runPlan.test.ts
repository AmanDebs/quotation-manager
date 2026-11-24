import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { runError, writeRun, runsFor, allocatedByJob, shiftCapacity, type RunInput }
  from '../src/services/runPlan.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * The shift plan's guards.
 *
 * A run is the first thing in this hierarchy that is *stored*, so it is the
 * first thing that can contradict the record — and most of these cases are
 * about what must **not** be refused, because a planning screen that declines
 * ordinary work is one nobody uses. The two that carry the design are *one run
 * is one changeover* (which is what makes a run's product and colour
 * derivable rather than stored) and *never exceed the work order*.
 */

const customerId = makeCustomer();
let line = 0, slowLine = 0, oneShift = 0, stopped = 0;

function makeProduct(name: string, color: string, rate: number | null): number {
  return Number((db.prepare(
    `INSERT INTO products (name, color, unit, pcs_per_day) VALUES (?, ?, 'per 1000', ?) RETURNING id`
  ).get(name, color, rate) as { id: number }).id);
}

function makeLine(name: string, shifts = 2, changeover = 0): number {
  return Number((db.prepare(
    `INSERT INTO machines (name, type, shifts_per_day, changeover_mins)
     VALUES (?, 'moulding', ?, ?) RETURNING id`
  ).get(name, shifts, changeover) as { id: number }).id);
}

let orderSeq = 0;
/** A job on its own order line, carrying a colour. */
function makeJob(o: { product: number; color: string; qty: number; status?: string }): number {
  const orderId = Number((db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status)
     VALUES (?, '2026-11-01', ?, 1, 'INR', 'igst', 'pending') RETURNING id`
  ).get(`SO/RUN-${++orderSeq}`, customerId) as { id: number }).id);
  db.prepare(
    `INSERT INTO order_items (order_id, product_id, description, color, qty, unit, unit_price,
                              amount, total_pcs, is_charge, sort_order)
     VALUES (?, ?, 'Item', ?, 1, 'per 1000', 10, 10, ?, 0, 0)`
  ).run(orderId, o.product, o.color, o.qty);
  return Number((db.prepare(
    `INSERT INTO work_orders (number, order_id, order_line, product_id, qty_planned, status)
     VALUES (?, ?, 0, ?, ?, ?) RETURNING id`
  ).get(`WO/RUN-${orderSeq}`, orderId, o.product, o.qty, o.status ?? 'planned') as { id: number }).id);
}

const run = (o: Partial<RunInput> & { lines: RunInput['lines'] }): RunInput => ({
  date: '2026-12-01', machine_id: line, shift: 'A', notes: '', ...o,
});

line = makeLine('Line A');
slowLine = makeLine('Line Slow');
oneShift = makeLine('Line One Shift', 1);
stopped = makeLine('Line Stopped', 0);

describe('a run has to be a real slot', () => {
  const p = makeProduct('Run Preform', 'Natural', 100000);
  const j = makeJob({ product: p, color: 'Natural', qty: 50000 });

  test('on a date, a shift this plant runs, and a line on file', () => {
    assert.match(String(runError(run({ date: 'soon', lines: [{ work_order_id: j, qty_planned: 1000 }] }))), /needs a date/);
    assert.match(String(runError(run({ shift: 'C', lines: [{ work_order_id: j, qty_planned: 1000 }] }))), /not a shift this plant runs/);
    assert.match(String(runError(run({ machine_id: 9999, lines: [{ work_order_id: j, qty_planned: 1000 }] }))), /not on file/);
  });

  test('a line that does not run that shift has no slot to plan into', () => {
    // Said rather than silently allowed, or a plan would commit work to a
    // shift nobody works.
    const msg = String(runError(run({ machine_id: oneShift, shift: 'B', lines: [{ work_order_id: j, qty_planned: 1000 }] })));
    assert.match(msg, /runs 1 shift a day/);
    assert.match(String(runError(run({ machine_id: stopped, lines: [{ work_order_id: j, qty_planned: 1000 }] }))), /not running/);
  });

  test('and not on a day the plant is shut', () => {
    db.prepare(`INSERT INTO plant_shutdowns (date, note) VALUES ('2026-12-25', 'Christmas')`).run();
    assert.match(String(runError(run({ date: '2026-12-25', lines: [{ work_order_id: j, qty_planned: 1000 }] }))), /plant is shut/);
    // And the day beside it is fine, which is what says the list is read
    // rather than the date being refused for its own sake.
    assert.equal(runError(run({ date: '2026-12-26', lines: [{ work_order_id: j, qty_planned: 1000 }] })), null);
  });

  test('a run making nothing is not a run', () => {
    // A run is defined by its allocations — one with none has no product and
    // no colour. Clearing a run is deleting it, which is a different act.
    assert.match(String(runError(run({ lines: [] }))), /at least one work order/);
  });
});

describe('one run is one changeover', () => {
  const preform = makeProduct('Changeover Preform', 'Natural', 100000);
  const cap = makeProduct('Changeover Cap', 'Natural', 100000);
  const natA = makeJob({ product: preform, color: 'Natural', qty: 50000 });
  const natB = makeJob({ product: preform, color: 'Natural', qty: 50000 });
  const black = makeJob({ product: preform, color: 'Black', qty: 50000 });
  const other = makeJob({ product: cap, color: 'Natural', qty: 50000 });

  test('two work orders of one product and colour share a run — the whole point', () => {
    // This is "one production batch fulfils multiple work orders", and it is
    // expressed as two allocations rather than a shared quantity, so no piece
    // ever belongs to two jobs.
    assert.equal(runError(run({ lines: [
      { work_order_id: natA, qty_planned: 20000 },
      { work_order_id: natB, qty_planned: 20000 },
    ] })), null);
  });

  test('two products on one run are two runs', () => {
    const msg = String(runError(run({ lines: [
      { work_order_id: natA, qty_planned: 1000 },
      { work_order_id: other, qty_planned: 1000 },
    ] })));
    assert.match(msg, /One run is one product/);
  });

  test('two colours on one run are two runs', () => {
    const msg = String(runError(run({ lines: [
      { work_order_id: natA, qty_planned: 1000 },
      { work_order_id: black, qty_planned: 1000 },
    ] })));
    assert.match(msg, /One run is one colour/);
    assert.match(msg, /Black/);
  });

  test('the same work order twice is refused, never merged', () => {
    // Quietly adding them would hide a double entry somebody meant to correct.
    assert.match(String(runError(run({ lines: [
      { work_order_id: natA, qty_planned: 1000 },
      { work_order_id: natA, qty_planned: 1000 },
    ] }))), /twice/);
  });
});

describe('a run never commits more than the work order asks for', () => {
  const p = makeProduct('Ceiling Preform', 'Natural', 1000000);
  const j = makeJob({ product: p, color: 'Natural', qty: 100000 });

  test('the whole balance is allowed, and a piece more is not', () => {
    assert.equal(runError(run({ lines: [{ work_order_id: j, qty_planned: 100000 }] })), null);
    assert.match(String(runError(run({ lines: [{ work_order_id: j, qty_planned: 100001 }] }))),
      /cannot commit more than the work order asks for/);
  });

  test('what is already made does not wait to be planned', () => {
    // The ceiling is the balance, not the instruction — `progressFor`'s own
    // figure and the one `layOutQueue` plans.
    const made = makeJob({ product: p, color: 'Natural', qty: 100000 });
    db.prepare(`INSERT INTO production_entries (work_order_id, date, shift, qty_ok)
                VALUES (?, '2026-11-10', 'A', 60000)`).run(made);
    assert.equal(runError(run({ lines: [{ work_order_id: made, qty_planned: 40000 }] })), null);
    assert.match(String(runError(run({ lines: [{ work_order_id: made, qty_planned: 40001 }] }))), /40,000 left to make/);
  });

  test('runs already on the book count towards it', () => {
    const j2 = makeJob({ product: p, color: 'Natural', qty: 100000 });
    writeRun(run({ lines: [{ work_order_id: j2, qty_planned: 70000 }] }), null);
    assert.equal(allocatedByJob([j2]).get(j2), 70000);
    assert.equal(runError(run({ lines: [{ work_order_id: j2, qty_planned: 30000 }] })), null);
    assert.match(String(runError(run({ lines: [{ work_order_id: j2, qty_planned: 30001 }] }))), /cannot commit more/);
  });

  test('and a run re-saved unchanged does not refuse itself', () => {
    // The defect the dispatch dialog shipped with: a run counting its own
    // quantities as a second commitment.
    const j3 = makeJob({ product: p, color: 'Natural', qty: 100000 });
    const input = run({ lines: [{ work_order_id: j3, qty_planned: 100000 }] });
    const id = writeRun(input, null);
    assert.equal(runError(input, id), null);
    // Without the exception it is refused, which is what that argument is for.
    assert.match(String(runError(input)), /cannot commit more/);
  });

  test('a finished or cancelled job takes no more work', () => {
    const done = makeJob({ product: p, color: 'Natural', qty: 1000, status: 'done' });
    const gone = makeJob({ product: p, color: 'Natural', qty: 1000, status: 'cancelled' });
    assert.match(String(runError(run({ lines: [{ work_order_id: done, qty_planned: 100 }] }))), /finished/);
    assert.match(String(runError(run({ lines: [{ work_order_id: gone, qty_planned: 100 }] }))), /cancelled/);
  });

  test('a job on this run for nothing is named rather than dropped', () => {
    assert.match(String(runError(run({ lines: [{ work_order_id: j, qty_planned: 0 }] }))), /on this run for nothing/);
  });
});

describe('a run fits the shift it is in', () => {
  test('capacity is the line\'s own, and a run past it is refused', () => {
    // 100,000 a day over two shifts is 50,000 a shift.
    const p = makeProduct('Capacity Preform', 'Natural', 100000);
    const j = makeJob({ product: p, color: 'Natural', qty: 500000 });
    assert.equal(runError(run({ lines: [{ work_order_id: j, qty_planned: 50000 }] })), null);
    assert.match(String(runError(run({ lines: [{ work_order_id: j, qty_planned: 50001 }] }))),
      /makes about 50,000 .* in one shift/);
  });

  test('a changeover comes off the shift it is lost in', () => {
    const p = makeProduct('Changeover Cost Cap', 'Natural', 100000);
    const slow = makeLine('Line With Changeover', 2, 72);  // 72 of 720 minutes = 10%
    const j = makeJob({ product: p, color: 'Natural', qty: 500000 });
    assert.equal(shiftCapacity(p, { id: slow, name: '', shifts_per_day: 2, changeover_mins: 72 } as never), 45000);
    assert.equal(runError(run({ machine_id: slow, lines: [{ work_order_id: j, qty_planned: 45000 }] })), null);
    assert.match(String(runError(run({ machine_id: slow, lines: [{ work_order_id: j, qty_planned: 45001 }] }))), /in one shift/);
  });

  test('a product with no rate is planned anyway, never refused', () => {
    // `hasRecipe: false`'s rule. A capacity of nought would refuse every run
    // of a product the first time it is made, which is most of the catalogue.
    const p = makeProduct('Unrated Cap', 'Natural', null);
    const j = makeJob({ product: p, color: 'Natural', qty: 900000 });
    assert.equal(shiftCapacity(p, { id: line, name: '', shifts_per_day: 2, changeover_mins: 0 } as never), null);
    assert.equal(runError(run({ lines: [{ work_order_id: j, qty_planned: 900000 }] })), null);
  });

  test('a one-shift line makes a whole day in its one shift', () => {
    const p = makeProduct('One Shift Preform', 'Natural', 80000);
    const j = makeJob({ product: p, color: 'Natural', qty: 500000 });
    assert.equal(runError(run({ machine_id: oneShift, lines: [{ work_order_id: j, qty_planned: 80000 }] })), null);
    assert.match(String(runError(run({ machine_id: oneShift, lines: [{ work_order_id: j, qty_planned: 80001 }] }))), /in one shift/);
  });
});

describe('a saved run reads back as what it is making', () => {
  test('with its product and colour derived, never stored', () => {
    const p = makeProduct('Readback Preform', 'Natural', 500000);
    const a = makeJob({ product: p, color: 'Sky Blue', qty: 60000 });
    const b = makeJob({ product: p, color: 'Sky Blue', qty: 60000 });
    const id = writeRun(run({ date: '2026-12-09', lines: [
      { work_order_id: a, qty_planned: 30000 },
      { work_order_id: b, qty_planned: 20000 },
    ] }), null);

    const row = runsFor({ from: '2026-12-09', to: '2026-12-09' }).find((r) => r.id === id);
    assert.ok(row);
    assert.equal(row.product_name, 'Readback Preform');
    assert.equal(row.color, 'Sky Blue');
    // The run's quantity is the sum of its allocations — never a third figure.
    assert.equal(row.qty_planned, 50000);
    assert.equal(row.allocations.length, 2);
    assert.equal(row.allocations.reduce((s, x) => s + x.qty_planned, 0), row.qty_planned);
  });

  test('a run of three jobs is one row, not three', () => {
    // What a plain join would get silently wrong.
    const p = makeProduct('Three Job Cap', 'White', 500000);
    const jobs = [0, 1, 2].map(() => makeJob({ product: p, color: 'White', qty: 40000 }));
    const id = writeRun(run({ date: '2026-12-10', lines: jobs.map((j) => ({ work_order_id: j, qty_planned: 10000 })) }), null);
    const rows = runsFor({ from: '2026-12-10', to: '2026-12-10' });
    assert.equal(rows.filter((r) => r.id === id).length, 1);
    assert.equal(rows.find((r) => r.id === id)?.allocations.length, 3);
  });

  test('re-saving a run replaces what it held rather than adding to it', () => {
    const p = makeProduct('Replace Cap', 'Red', 500000);
    const a = makeJob({ product: p, color: 'Red', qty: 90000 });
    const b = makeJob({ product: p, color: 'Red', qty: 90000 });
    const id = writeRun(run({ date: '2026-12-11', lines: [{ work_order_id: a, qty_planned: 10000 }] }), null);
    writeRun(run({ date: '2026-12-11', lines: [{ work_order_id: b, qty_planned: 20000 }] }), null, id);
    const row = runsFor({ from: '2026-12-11', to: '2026-12-11' }).find((r) => r.id === id);
    assert.equal(row?.allocations.length, 1);
    assert.equal(row?.allocations[0].work_order_id, b);
    // And the job it no longer names is uncommitted again.
    assert.equal(allocatedByJob([a]).get(a), undefined);
  });
});
