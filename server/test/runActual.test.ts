import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { writeRun, runsFor, runActuals, allocatedByJob, runError, type RunInput }
  from '../src/services/runPlan.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * What a shift actually made, and what happens to what it did not.
 *
 * The case this whole phase turns on is the last group: **a run that falls
 * short gives the difference back to the planner when it is signed off**, and
 * it does so by construction — the allocation stops counting, what was made
 * is already in the shift book, and the balance reappears. There is no
 * shortfall record anywhere, which is the point: nothing to keep in step.
 */

const customerId = makeCustomer();
const line = Number((db.prepare(
  `INSERT INTO machines (name, type, shifts_per_day) VALUES ('Line A', 'moulding', 2) RETURNING id`
).get() as { id: number }).id);

let seq = 0;
function makeProduct(name: string, rate: number | null): number {
  return Number((db.prepare(
    `INSERT INTO products (name, color, unit, pcs_per_day) VALUES (?, 'Natural', 'per 1000', ?) RETURNING id`
  ).get(name, rate) as { id: number }).id);
}

function makeJob(product: number, qty: number): number {
  seq += 1;
  const orderId = Number((db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status)
     VALUES (?, '2026-11-01', ?, 1, 'INR', 'igst', 'pending') RETURNING id`
  ).get(`SO/ACT-${seq}`, customerId) as { id: number }).id);
  db.prepare(
    `INSERT INTO order_items (order_id, product_id, description, color, qty, unit, unit_price,
                              amount, total_pcs, is_charge, sort_order)
     VALUES (?, ?, 'Item', 'Natural', 1, 'per 1000', 10, 10, ?, 0, 0)`
  ).run(orderId, product, qty);
  return Number((db.prepare(
    `INSERT INTO work_orders (number, order_id, order_line, product_id, qty_planned, status)
     VALUES (?, ?, 0, ?, ?, 'planned') RETURNING id`
  ).get(`WO/ACT-${seq}`, orderId, product, qty) as { id: number }).id);
}

const run = (o: Partial<RunInput> & { lines: RunInput['lines'] }): RunInput =>
  ({ date: '2026-12-01', machine_id: line, shift: 'A', notes: '', ...o });

/** Book a shift against a run, as `POST /:id/entries` does. */
const book = (runId: number, jobId: number, ok: number, reject = 0, downtime = 0) =>
  db.prepare(
    `INSERT INTO production_entries
       (work_order_id, run_id, date, shift, qty_ok, qty_reject, downtime_mins)
     VALUES (?, ?, '2026-12-01', 'A', ?, ?, ?)`
  ).run(jobId, runId, ok, reject, downtime);

const close = (runId: number, done = true) =>
  db.prepare('UPDATE production_runs SET status = ? WHERE id = ?').run(done ? 'done' : '', runId);

const read = (runId: number) => runsFor({}).find((r) => r.id === runId);

describe('a run says what it actually made', () => {
  test('read from the shift book, never stored on the run', () => {
    const p = makeProduct('Actual Preform', 100000);
    const j = makeJob(p, 100000);
    const id = writeRun(run({ lines: [{ work_order_id: j, qty_planned: 50000 }] }), null);
    book(id, j, 42000, 300, 45);

    const r = read(id);
    assert.equal(r?.qty_planned, 50000);
    assert.equal(r?.made, 42000);
    assert.equal(r?.rejected, 300);
    assert.equal(r?.downtime_mins, 45);
    assert.equal(r?.shortfall, 8000);
  });

  test('and correcting a mis-keyed shift corrects the run', () => {
    // `production.ts`'s rule about every roll-up of output: deleting the entry
    // is how a mistake is fixed, and the figure follows by construction.
    const p = makeProduct('Corrected Cap', 100000);
    const j = makeJob(p, 100000);
    const id = writeRun(run({ lines: [{ work_order_id: j, qty_planned: 50000 }] }), null);
    book(id, j, 50000);
    assert.equal(read(id)?.made, 50000);
    db.prepare('DELETE FROM production_entries WHERE run_id = ?').run(id);
    assert.equal(read(id)?.made, 0);
    assert.equal(read(id)?.shortfall, 50000);
  });

  test('a shared run says whose pieces were whose', () => {
    const p = makeProduct('Shared Preform', 100000);
    const a = makeJob(p, 100000);
    const b = makeJob(p, 100000);
    const id = writeRun(run({ lines: [
      { work_order_id: a, qty_planned: 30000 },
      { work_order_id: b, qty_planned: 20000 },
    ] }), null);
    book(id, a, 28000, 100);
    book(id, b, 20000, 50);

    const r = read(id);
    assert.equal(r?.made, 48000);
    const byJob = Object.fromEntries((r?.allocations ?? []).map((x) => [x.work_order_id, x]));
    assert.equal(byJob[a].made, 28000);
    assert.equal(byJob[b].made, 20000);
    assert.equal(byJob[a].qty_planned, 30000);
    // The run's figure is exactly its allocations', never a third number.
    assert.equal((r?.allocations ?? []).reduce((s, x) => s + x.made, 0), r?.made);
  });

  test('a scrapped lot does not count as made here either', () => {
    // `LIVE_OK`'s rule. A run reading as complete over condemned output would
    // close a shortfall that is real.
    const p = makeProduct('Scrapped Run Cap', 100000);
    const j = makeJob(p, 100000);
    const id = writeRun(run({ lines: [{ work_order_id: j, qty_planned: 50000 }] }), null);
    const lot = Number((db.prepare(
      `INSERT INTO batches (number, work_order_id, date, disposition)
       VALUES ('B-ACT', ?, '2026-12-01', 'scrapped') RETURNING id`
    ).get(j) as { id: number }).id);
    db.prepare(
      `INSERT INTO production_entries (work_order_id, run_id, batch_id, date, shift, qty_ok)
       VALUES (?, ?, ?, '2026-12-01', 'A', 50000)`
    ).run(j, id, lot);

    assert.equal(read(id)?.made, 0);
    assert.equal(read(id)?.shortfall, 50000);
  });

  test('an over-run is not a negative shortfall', () => {
    const p = makeProduct('Over Run Preform', 200000);
    const j = makeJob(p, 200000);
    const id = writeRun(run({ lines: [{ work_order_id: j, qty_planned: 50000 }] }), null);
    book(id, j, 58000);
    assert.equal(read(id)?.made, 58000);
    assert.equal(read(id)?.shortfall, 0);
  });

  test('a run nothing was booked against made nothing, not nothing-known', () => {
    const p = makeProduct('Untouched Cap', 100000);
    const j = makeJob(p, 100000);
    const id = writeRun(run({ lines: [{ work_order_id: j, qty_planned: 40000 }] }), null);
    assert.equal(read(id)?.made, 0);
    assert.equal(read(id)?.shortfall, 40000);
    assert.equal(runActuals([id]).get(id), undefined);
  });
});

describe('signing a shift off gives its shortfall back', () => {
  test('an open run holds its whole claim, made or not', () => {
    const p = makeProduct('Claim Preform', 100000);
    const j = makeJob(p, 100000);
    const id = writeRun(run({ lines: [{ work_order_id: j, qty_planned: 50000 }] }), null);
    book(id, j, 40000);
    // While it is open the job reads as planned for 50,000 — including the
    // 10,000 the shift did not get to.
    assert.equal(allocatedByJob([j]).get(j), 50000);
  });

  test('and a closed one holds none, so the difference reappears', () => {
    const p = makeProduct('Shortfall Preform', 100000);
    const j = makeJob(p, 100000);
    const id = writeRun(run({ lines: [{ work_order_id: j, qty_planned: 50000 }] }), null);
    book(id, j, 40000);
    close(id);

    // The claim is gone; what was made is in the shift book. The job's
    // remaining is 100,000 − 40,000, which is the 10,000 shortfall plus the
    // 50,000 nobody has planned yet.
    assert.equal(allocatedByJob([j]).get(j), undefined);
    // And the run still says what it was planned for — two facts, not one.
    assert.equal(read(id)?.qty_planned, 50000);
    assert.equal(read(id)?.made, 40000);
    assert.equal(read(id)?.status, 'done');
  });

  test('a shift that made nothing gives all of it back', () => {
    // The line was down all day. This is the run that most needs closing, so
    // there is deliberately no guard on what was made.
    const p = makeProduct('Lost Shift Cap', 100000);
    const j = makeJob(p, 100000);
    const id = writeRun(run({ lines: [{ work_order_id: j, qty_planned: 50000 }] }), null);
    book(id, j, 0, 0, 720);
    close(id);
    assert.equal(allocatedByJob([j]).get(j), undefined);
    assert.equal(read(id)?.downtime_mins, 720);
  });

  test('reopening puts the claim back', () => {
    // A signature given by mistake must be withdrawable: it is not an
    // artefact out in the world, unlike an issued certificate.
    const p = makeProduct('Reopened Cap', 100000);
    const j = makeJob(p, 100000);
    const id = writeRun(run({ lines: [{ work_order_id: j, qty_planned: 50000 }] }), null);
    close(id);
    assert.equal(allocatedByJob([j]).get(j), undefined);
    close(id, false);
    assert.equal(allocatedByJob([j]).get(j), 50000);
  });

  test('the freed quantity can be planned again, and the ceiling allows it', () => {
    // The loop closing: what a shift did not make is plannable into a later
    // one, and `runError`'s *never exceed the work order* does not refuse it,
    // because the closed run no longer counts.
    // 300,000 a day is 150,000 a shift, so the shift's own capacity is never
    // the binding constraint here — what is being asserted is the work-order
    // ceiling, and a fixture that tripped the other guard would pass for the
    // wrong reason.
    const p = makeProduct('Replan Preform', 300000);
    const j = makeJob(p, 100000);
    const first = writeRun(run({ lines: [{ work_order_id: j, qty_planned: 50000 }] }), null);
    book(first, j, 40000);
    // While open, the job has 100,000 − 50,000 planned = 50,000 left to claim.
    assert.match(String(runError(run({ date: '2026-12-02', lines: [{ work_order_id: j, qty_planned: 60000 }] }))),
      /cannot commit more/);
    close(first);
    // Closed, the balance is 100,000 − 40,000 made = 60,000, all of it free.
    assert.equal(runError(run({ date: '2026-12-02', lines: [{ work_order_id: j, qty_planned: 60000 }] })), null);
    assert.match(String(runError(run({ date: '2026-12-02', lines: [{ work_order_id: j, qty_planned: 60001 }] }))),
      /cannot commit more/);
  });
});

describe('what a deleted plan does not delete', () => {
  test('the shift book survives its run', () => {
    // `ON DELETE SET NULL`, never CASCADE: a planner tidying the board is not
    // saying a day's production never happened.
    const p = makeProduct('Survivor Preform', 100000);
    const j = makeJob(p, 100000);
    const id = writeRun(run({ lines: [{ work_order_id: j, qty_planned: 50000 }] }), null);
    book(id, j, 45000, 200);
    db.prepare('DELETE FROM production_runs WHERE id = ?').run(id);

    const rows = db.prepare(
      'SELECT run_id, qty_ok, qty_reject FROM production_entries WHERE work_order_id = ?'
    ).all(j) as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].run_id, null);
    assert.equal(Number(rows[0].qty_ok), 45000);
    // And the allocation goes with the run, which is right — it was a plan.
    assert.equal(allocatedByJob([j]).get(j), undefined);
  });
});
