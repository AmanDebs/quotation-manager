import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { writeRun, type RunInput } from '../src/services/runPlan.js';
import {
  pivotProduction, productionRows, summariseProduction, PROD_OTHER,
} from '../src/services/productionReport.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * The production record, folded.
 *
 * Most of these are about what must **not** happen, and three carry the
 * weight: a run's downtime must be counted **once however many work orders
 * share it**, a shift must be **one shift** at every grain, and a shortfall
 * must be clamped per allocation so a shift that beat its plan cannot cancel
 * a real shortfall somewhere else.
 */

const customerId = makeCustomer();

const lineA = Number((db.prepare(
  `INSERT INTO machines (name, type, shifts_per_day) VALUES ('Line A', 'moulding', 2) RETURNING id`
).get() as { id: number }).id);
const lineB = Number((db.prepare(
  `INSERT INTO machines (name, type, shifts_per_day) VALUES ('Line B', 'moulding', 2) RETURNING id`
).get() as { id: number }).id);

let seq = 0;
function makeProduct(name: string, rate: number | null): number {
  return Number((db.prepare(
    `INSERT INTO products (name, color, unit, pcs_per_day) VALUES (?, 'Natural', 'per 1000', ?) RETURNING id`
  ).get(name, rate) as { id: number }).id);
}

function makeJob(product: number, qty: number, color = 'Natural'): number {
  seq += 1;
  const orderId = Number((db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status)
     VALUES (?, '2026-11-01', ?, 1, 'INR', 'igst', 'pending') RETURNING id`
  ).get(`SO/RPT-${seq}`, customerId) as { id: number }).id);
  db.prepare(
    `INSERT INTO order_items (order_id, product_id, description, color, qty, unit, unit_price,
                              amount, total_pcs, is_charge, sort_order)
     VALUES (?, ?, 'Item', ?, 1, 'per 1000', 10, 10, ?, 0, 0)`
  ).run(orderId, product, color, qty);
  return Number((db.prepare(
    `INSERT INTO work_orders (number, order_id, order_line, product_id, qty_planned, status)
     VALUES (?, ?, 0, ?, ?, 'planned') RETURNING id`
  ).get(`WO/RPT-${seq}`, orderId, product, qty) as { id: number }).id);
}

const run = (o: Partial<RunInput> & { lines: RunInput['lines'] }): RunInput =>
  ({ date: '2026-12-01', machine_id: lineA, shift: 'A', notes: '', ...o });

/** Book a shift against a run, as `POST /:id/entries` does. */
const book = (runId: number, jobId: number, okQty: number, reject = 0, downtime = 0, date = '2026-12-01') =>
  db.prepare(
    `INSERT INTO production_entries
       (work_order_id, run_id, date, shift, qty_ok, qty_reject, downtime_mins)
     VALUES (?, ?, ?, 'A', ?, ?, ?)`
  ).run(jobId, runId, date, okQty, reject, downtime);

const close = (runId: number) =>
  db.prepare(`UPDATE production_runs SET status = 'done' WHERE id = ?`).run(runId);

/** The one grid, since production carries no currency. */
const grid = (p: ReturnType<typeof pivotProduction>) => p.grids[0];
const cell = (p: ReturnType<typeof pivotProduction>, keys: string[]) =>
  grid(p).rows.find((r) => r.keys.join('|') === keys.join('|'));

describe('the grain, and what a run is', () => {
  test('one row per work order share of a run', () => {
    const p = makeProduct('Grain Preform', 100000);
    const a = makeJob(p, 100000);
    const b = makeJob(p, 100000);
    const id = writeRun(run({ date: '2027-01-04', lines: [
      { work_order_id: a, qty_planned: 30000 },
      { work_order_id: b, qty_planned: 20000 },
    ] }), null);
    const rows = productionRows({ from: '2027-01-04', to: '2027-01-04' });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.run_id), [id, id]);
    assert.deepEqual(rows.map((r) => r.planned).sort((x, y) => x - y), [20000, 30000]);
  });

  test('a shared run is one shift, not three', () => {
    // Distinct, never a sum: a per-run figure added over its allocations is
    // multiplied by the number of work orders on it.
    const p = makeProduct('One Shift Cap', 100000);
    const jobs = [makeJob(p, 50000), makeJob(p, 50000), makeJob(p, 50000)];
    writeRun(run({ date: '2027-01-05', lines: jobs.map((j) => ({ work_order_id: j, qty_planned: 10000 })) }), null);
    const pv = pivotProduction({ from: '2027-01-05', to: '2027-01-05' }, { rows: ['line'], measure: 'runs' });
    assert.equal(grid(pv).total, 1);
    assert.equal(grid(pv).count, 3, 'three allocations behind the one shift');
  });

  test('downtime is the run’s own and is counted once however many share it', () => {
    // The trap this measure exists for: the route writes a stoppage once, on
    // the first entry, because the *line* was down rather than the work
    // order — so reading it per allocation would report it twice.
    const p = makeProduct('Downtime Preform', 100000);
    const a = makeJob(p, 100000);
    const b = makeJob(p, 100000);
    const id = writeRun(run({ date: '2027-01-06', lines: [
      { work_order_id: a, qty_planned: 20000 },
      { work_order_id: b, qty_planned: 15000 },
    ] }), null);
    book(id, a, 19500, 200, 35, '2027-01-06');
    book(id, b, 14000, 90, 0, '2027-01-06');

    const pv = pivotProduction({ from: '2027-01-06', to: '2027-01-06' }, { rows: ['line'], measure: 'downtime' });
    assert.equal(grid(pv).total, 35, 'one stoppage, not 70');
    assert.equal(summariseProduction(productionRows({ from: '2027-01-06', to: '2027-01-06' })).downtime_mins, 35);
  });

  test('and each share says what it alone made', () => {
    const rows = productionRows({ from: '2027-01-06', to: '2027-01-06' });
    const byJob = Object.fromEntries(rows.map((r) => [r.job_number, r]));
    const [first, second] = Object.values(byJob).sort((x, y) => y.made - x.made);
    assert.equal(first.made, 19500);
    assert.equal(second.made, 14000);
    assert.equal(first.rejected, 200);
    assert.equal(second.rejected, 90);
  });
});

describe('the measures', () => {
  test('a scrapped lot is not output here either', () => {
    // `LIVE_OK`'s rule, which every roll-up in this app follows: a run reading
    // as complete over condemned pieces would close a real shortfall.
    const p = makeProduct('Scrap Report Cap', 100000);
    const j = makeJob(p, 100000);
    const id = writeRun(run({ date: '2027-01-07', lines: [{ work_order_id: j, qty_planned: 50000 }] }), null);
    const lot = Number((db.prepare(
      `INSERT INTO batches (number, work_order_id, date, disposition)
       VALUES ('B-RPT', ?, '2027-01-07', 'scrapped') RETURNING id`
    ).get(j) as { id: number }).id);
    db.prepare(
      `INSERT INTO production_entries (work_order_id, run_id, batch_id, date, shift, qty_ok)
       VALUES (?, ?, ?, '2027-01-07', 'A', 50000)`
    ).run(j, id, lot);

    const f = { from: '2027-01-07', to: '2027-01-07' };
    assert.equal(grid(pivotProduction(f, { rows: ['line'], measure: 'made' })).total, 0);
    assert.equal(grid(pivotProduction(f, { rows: ['line'], measure: 'short' })).total, 50000);
  });

  test('a shift that beat its plan cannot cancel a real shortfall', () => {
    // Clamped per allocation and only then summed. `SUM(planned) - SUM(made)`
    // would report 0 here, which is true of nothing: one job is 10,000 short.
    const p = makeProduct('Clamp Preform', 300000);
    const a = makeJob(p, 100000);
    const b = makeJob(p, 100000);
    const id = writeRun(run({ date: '2027-01-08', lines: [
      { work_order_id: a, qty_planned: 40000 },
      { work_order_id: b, qty_planned: 40000 },
    ] }), null);
    book(id, a, 30000, 0, 0, '2027-01-08');
    book(id, b, 50000, 0, 0, '2027-01-08');

    const f = { from: '2027-01-08', to: '2027-01-08' };
    assert.equal(grid(pivotProduction(f, { rows: ['line'], measure: 'planned' })).total, 80000);
    assert.equal(grid(pivotProduction(f, { rows: ['line'], measure: 'made' })).total, 80000);
    assert.equal(grid(pivotProduction(f, { rows: ['line'], measure: 'short' })).total, 10000);
  });

  test('capacity is the line’s own and is counted once per run', () => {
    // 100,000 a day over two shifts is 50,000 a shift, whatever the run is
    // planned for and however many work orders share it.
    const f = { from: '2027-01-06', to: '2027-01-06' };
    assert.equal(grid(pivotProduction(f, { rows: ['line'], measure: 'capacity' })).total, 50000);
  });

  test('a product with no rate contributes no capacity rather than a zero', () => {
    const p = makeProduct('Rateless Cap', null);
    const j = makeJob(p, 50000);
    writeRun(run({ date: '2027-01-09', lines: [{ work_order_id: j, qty_planned: 20000 }] }), null);
    const f = { from: '2027-01-09', to: '2027-01-09' };
    assert.equal(grid(pivotProduction(f, { rows: ['line'], measure: 'capacity' })).total, 0);
    assert.equal(grid(pivotProduction(f, { rows: ['line'], measure: 'planned' })).total, 20000);
  });
});

describe('the fold', () => {
  test('a row’s cells sum to its total, and the rows to the grand total', () => {
    // The invariant that catches a fold written at the wrong level. A sheet
    // whose total does not equal its own rows is worse than no sheet.
    for (const shape of [
      { rows: ['product'], column: 'shift', measure: 'planned' },
      { rows: ['line', 'shift'], column: 'date', measure: 'made' },
      { rows: ['color'], column: 'line', measure: 'short' },
      { rows: ['job'], column: 'month', measure: 'planned' },
    ]) {
      const pv = pivotProduction({}, shape);
      const g = grid(pv);
      for (const r of g.rows) {
        const sum = pv.columns.reduce((n, c) => n + (r.cells[c] ?? 0), 0);
        assert.equal(Math.round(sum), Math.round(r.total), `row ${r.keys} of ${JSON.stringify(shape)}`);
      }
      const rowSum = g.rows.reduce((n, r) => n + r.total, 0);
      assert.equal(Math.round(rowSum), Math.round(g.total), `grand total of ${JSON.stringify(shape)}`);
    }
  });

  test('a run split across two cells is counted once in the grand total', () => {
    // The `orders` measure's own consequence, read for runs: each cell counts
    // its own distinct, and the grand total has a Set of its own.
    const p1 = makeProduct('Split One', 100000);
    const p2 = makeProduct('Split Two', 100000);
    const a = makeJob(p1, 50000);
    const b = makeJob(p2, 50000, 'Black');
    // One run cannot hold two products through `writeRun`, so the row is
    // planted directly — what is under test is the fold, not the guard.
    const id = Number((db.prepare(
      `INSERT INTO production_runs (date, machine_id, shift, notes) VALUES ('2027-02-01', ?, 'A', '') RETURNING id`
    ).get(lineA) as { id: number }).id);
    db.prepare('INSERT INTO run_allocations (run_id, work_order_id, qty_planned) VALUES (?, ?, 10000)').run(id, a);
    db.prepare('INSERT INTO run_allocations (run_id, work_order_id, qty_planned) VALUES (?, ?, 10000)').run(id, b);

    const f = { from: '2027-02-01', to: '2027-02-01' };
    const byProduct = pivotProduction(f, { rows: ['product'], measure: 'runs' });
    assert.equal(grid(byProduct).rows.length, 2);
    assert.deepEqual(grid(byProduct).rows.map((r) => r.total), [1, 1], 'one shift in each row');
    assert.equal(grid(byProduct).total, 1, 'and one shift in all');
  });

  test('an unknown dimension or measure reads as the default, never as nothing', () => {
    const pv = pivotProduction({}, { rows: ['nonsense'], column: 'bogus', measure: 'invented' });
    assert.equal(pv.rows[0], 'product');
    assert.equal(pv.column, '');
    assert.equal(pv.measure, 'planned');
    assert.ok(grid(pv).total > 0);
  });

  test('the same dimension twice is one level', () => {
    const pv = pivotProduction({}, { rows: ['line', 'line'] });
    assert.deepEqual(pv.rows, ['line']);
  });

  test('every dimension and measure the sheet offers actually folds', () => {
    // A key in the table that the fold does not know would be a control
    // somebody picks and gets an empty sheet from.
    const pv = pivotProduction({});
    for (const d of pv.dimensions) {
      const one = pivotProduction({}, { rows: [d.key] });
      assert.equal(one.rows[0], d.key, `dimension ${d.key}`);
    }
    for (const m of pv.measures) {
      const one = pivotProduction({}, { measure: m.key });
      assert.equal(one.measure, m.key, `measure ${m.key}`);
    }
  });
});

describe('the filters', () => {
  test('each narrows on its own, and the halves partition the whole', () => {
    const all = productionRows({});
    const lineAOnly = productionRows({ machine_id: lineA });
    const lineBOnly = productionRows({ machine_id: lineB });
    assert.equal(lineAOnly.length + lineBOnly.length, all.length, 'nothing dropped, nothing twice');
    assert.ok(lineAOnly.every((r) => r.machine_id === lineA));
  });

  test('a date range takes either end inclusively', () => {
    const one = productionRows({ from: '2027-01-06', to: '2027-01-06' });
    assert.ok(one.length > 0);
    assert.ok(one.every((r) => r.date === '2027-01-06'));
    assert.equal(productionRows({ from: '2027-01-07', to: '2027-01-06' }).length, 0);
  });

  test('a blank colour is a value, and no key at all is no filter', () => {
    // Present-and-empty against absent — the distinction the book's own tick
    // lists rely on, which a `|| undefined` would quietly collapse.
    const p = makeProduct('Colourless Cap', 100000);
    const j = makeJob(p, 50000, '');
    // The product carries 'Natural', so the line's blank must fall through to
    // it — which is what makes this the honest test of the COALESCE.
    db.prepare(`UPDATE products SET color = '' WHERE id = ?`).run(p);
    writeRun(run({ date: '2027-03-01', lines: [{ work_order_id: j, qty_planned: 10000 }] }), null);

    const blank = productionRows({ from: '2027-03-01', to: '2027-03-01', color: '' });
    assert.equal(blank.length, 1);
    assert.equal(blank[0].color, '');
    assert.equal(productionRows({ from: '2027-03-01', to: '2027-03-01', color: 'Natural' }).length, 0);
    assert.equal(productionRows({ from: '2027-03-01', to: '2027-03-01' }).length, 1, 'no key is no filter');
  });

  test('signed off and open are complements', () => {
    const all = productionRows({});
    const open = productionRows({ signed: 'open' });
    const done = productionRows({ signed: 'done' });
    assert.equal(open.length + done.length, all.length);
  });

  test('a shift filter is read however it was spelled', () => {
    // `production_entries.shift` was free text before the vocabulary landed,
    // so the comparison is normalised on both sides.
    assert.ok(productionRows({ shift: 'a' }).length > 0);
    assert.equal(productionRows({ shift: ' A ' }).length, productionRows({ shift: 'A' }).length);
  });

  test('scope is applied, and reaches past nothing', () => {
    const mine = productionRows({ scopeSql: 'o.customer_id = ?', scopeParams: [customerId] });
    const theirs = productionRows({ scopeSql: 'o.customer_id = ?', scopeParams: [customerId + 999] });
    assert.ok(mine.length > 0);
    assert.equal(theirs.length, 0);
  });
});

describe('the summary', () => {
  test('a shift nobody has booked against is not behind — it has not run', () => {
    // The defect the board's own strip shipped with: `shortfall > 0` on a
    // future shift is the whole plan, so every one read as short.
    const p = makeProduct('Future Cap', 100000);
    const j = makeJob(p, 100000);
    writeRun(run({ date: '2027-04-01', lines: [{ work_order_id: j, qty_planned: 50000 }] }), null);
    const s = summariseProduction(productionRows({ from: '2027-04-01', to: '2027-04-01' }));
    assert.equal(s.planned, 50000);
    assert.equal(s.short, 50000, 'the figure is honest');
    assert.equal(s.awaiting, 0, 'but nobody is waiting on it');
  });

  test('one that ran and fell short is, until it is signed off', () => {
    const p = makeProduct('Behind Preform', 100000);
    const j = makeJob(p, 100000);
    const id = writeRun(run({ date: '2027-04-02', lines: [{ work_order_id: j, qty_planned: 50000 }] }), null);
    book(id, j, 38000, 0, 0, '2027-04-02');
    const f = { from: '2027-04-02', to: '2027-04-02' };
    assert.equal(summariseProduction(productionRows(f)).awaiting, 1);
    close(id);
    assert.equal(summariseProduction(productionRows(f)).awaiting, 0, 'signed off is not waiting');
  });

  test('and the summary describes the filtered set, not the fold', () => {
    // Whatever rows and columns are picked, the strip over the sheet is the
    // same facts — the rule every figure-over-a-table in this app follows.
    const f = { from: '2027-01-06', to: '2027-01-06' };
    const a = pivotProduction(f, { rows: ['product'], column: 'shift' });
    const b = pivotProduction(f, { rows: ['line', 'date'], column: 'color', measure: 'made' });
    assert.deepEqual(a.summary, b.summary);
    assert.equal(a.summary.runs, 1);
    assert.equal(a.summary.allocations, 2);
  });
});

describe('the column axis', () => {
  test('is capped, and the tail is gathered rather than dropped', () => {
    const p = makeProduct('Wide Cap', 1000000);
    const j = makeJob(p, 10000000);
    // 45 days across the top, which is past the 40-column cap.
    for (let i = 0; i < 45; i++) {
      const day = `2027-06-${String(i + 1).padStart(2, '0')}`;
      const date = i < 30 ? day : `2027-07-${String(i - 29).padStart(2, '0')}`;
      writeRun({ date, machine_id: lineB, shift: 'A', notes: '', lines: [{ work_order_id: j, qty_planned: 1000 }] }, null);
    }
    const pv = pivotProduction({ from: '2027-06-01', to: '2027-07-31' }, {
      rows: ['product'], column: 'date', measure: 'planned',
    });
    assert.equal(pv.columns.length, 41, '40 columns plus the gathered tail');
    assert.equal(pv.columns[40], PROD_OTHER);
    assert.equal(pv.folded, 5);
    const row = cell(pv, [String(p)]);
    const sum = pv.columns.reduce((n, c) => n + (row?.cells[c] ?? 0), 0);
    assert.equal(sum, 45000, 'every day still counted, five of them in the tail');
  });
});
