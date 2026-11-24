import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { productPlan, summarisePlan } from '../src/services/productPlan.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * The production plan folded **product → colour → work order**.
 *
 * Most of these assert what must *not* happen. The two that matter most are
 * the fold itself — `productDemand` keys a catalogue line on the product alone
 * and labels the row with whichever colour it saw first, so two colours of one
 * product collapse into one arbitrarily-labelled row — and the reconciliation
 * invariant, that a product's figures are exactly the sum of its colours'. A
 * planning screen whose total does not equal its own rows is worse than none.
 */

const customerId = makeCustomer();

function makeProduct(name: string, color: string, rate: number | null): number {
  return Number((db.prepare(
    `INSERT INTO products (name, color, unit, pcs_per_day) VALUES (?, ?, 'per 1000', ?) RETURNING id`
  ).get(name, color, rate) as { id: number }).id);
}

function makeOpenOrder(number: string, date = '2026-11-01'): number {
  return Number((db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status)
     VALUES (?, ?, ?, 1, 'INR', 'igst', 'pending') RETURNING id`
  ).get(number, date, customerId) as { id: number }).id);
}

/** One goods line at a stated piece count, at `pos` within its order. */
function addLine(orderId: number, o: {
  pos: number; productId?: number | null; description: string; color: string; pieces: number;
}): void {
  db.prepare(
    `INSERT INTO order_items (order_id, product_id, description, color, qty, unit, unit_price,
                              amount, total_pcs, is_charge, sort_order)
     VALUES (?, ?, ?, ?, ?, 'per 1000', 10, ?, ?, 0, ?)`
  ).run(orderId, o.productId ?? null, o.description, o.color,
    o.pieces / 1000, (o.pieces / 1000) * 10, o.pieces, o.pos);
}

/** A job against one order line. `qty` is the instruction, in pieces. */
function addJob(orderId: number, o: {
  number: string; line: number; productId: number | null; qty: number;
  status?: string; start?: string; end?: string;
}): number {
  return Number((db.prepare(
    `INSERT INTO work_orders (number, order_id, order_line, product_id, qty_planned,
                              planned_start, planned_end, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).get(o.number, orderId, o.line, o.productId, o.qty,
    o.start ?? '', o.end ?? '', o.status ?? 'planned') as { id: number }).id);
}

/** A shift booked against a job, optionally into a lot. */
function book(jobId: number, qtyOk: number, batchId: number | null = null): void {
  db.prepare(
    `INSERT INTO production_entries (work_order_id, batch_id, date, shift, qty_ok)
     VALUES (?, ?, '2026-11-10', 'A', ?)`
  ).run(jobId, batchId, qtyOk);
}

const find = (plan: ReturnType<typeof productPlan>, item: string) => {
  const row = plan.find((p) => p.item === item);
  assert.ok(row, `no plan row for ${item}`);
  return row;
};

describe('the product plan folds by product and colour', () => {
  test('two colours of one product are two rows, each with its own figures', () => {
    // The whole point of the hierarchy, and the bug in `productDemand`: on the
    // same product, Natural and Black are two things to run and two things to
    // reconcile. Folded on the product alone they are one row wearing one of
    // the two colours, chosen by whichever line was read first.
    const pid = makeProduct('28mm PCO 1881', 'Natural', 50000);
    const o = makeOpenOrder('SO/PLAN-1');
    addLine(o, { pos: 0, productId: pid, description: 'Preform', color: 'Natural', pieces: 120000 });
    addLine(o, { pos: 1, productId: pid, description: 'Preform', color: 'Black', pieces: 80000 });

    const row = find(productPlan(), '28mm PCO 1881');
    assert.equal(row.colours.length, 2);
    assert.deepEqual(row.colours.map((c) => c.color), ['Black', 'Natural']);
    assert.equal(row.colours.find((c) => c.color === 'Natural')?.ordered, 120000);
    assert.equal(row.colours.find((c) => c.color === 'Black')?.ordered, 80000);
    // And the product is still the sum of them — rules 1 and 2, by construction.
    assert.equal(row.ordered, 200000);
  });

  test('a product is exactly the sum of its colours, on every figure', () => {
    const pid = makeProduct('48mm Seal Cap', 'White', 20000);
    const o = makeOpenOrder('SO/PLAN-2');
    addLine(o, { pos: 0, productId: pid, description: 'Cap', color: 'White', pieces: 60000 });
    addLine(o, { pos: 1, productId: pid, description: 'Cap', color: 'Red', pieces: 40000 });
    const j = addJob(o, { number: 'WO/PLAN-2A', line: 0, productId: pid, qty: 60000 });
    book(j, 25000);

    const row = find(productPlan(), '48mm Seal Cap');
    for (const k of ['ordered', 'planned', 'made', 'shipped', 'pending', 'unplanned'] as const) {
      assert.equal(
        row[k],
        row.colours.reduce((sum, c) => sum + c[k], 0),
        `${k} does not reconcile with its colours`,
      );
    }
    assert.equal(row.jobs, row.colours.reduce((sum, c) => sum + c.jobs, 0));
  });

  test('demand no job covers is reported rather than hidden', () => {
    // Reconciliation rule 3 at this level. 40,000 pieces sold and instructed
    // to nobody is exactly what a planner opens this screen to find.
    const pid = makeProduct('20 LTR Threaded Cap', 'Blue', 10000);
    const o = makeOpenOrder('SO/PLAN-3');
    addLine(o, { pos: 0, productId: pid, description: 'Cap', color: 'Blue', pieces: 100000 });
    addJob(o, { number: 'WO/PLAN-3A', line: 0, productId: pid, qty: 60000 });

    const row = find(productPlan(), '20 LTR Threaded Cap');
    assert.equal(row.ordered, 100000);
    assert.equal(row.planned, 60000);
    assert.equal(row.unplanned, 40000);
  });

  test('a split run is two work orders under one colour', () => {
    const pid = makeProduct('Handle 45mm', 'Natural', 30000);
    const o = makeOpenOrder('SO/PLAN-4');
    addLine(o, { pos: 0, productId: pid, description: 'Handle', color: 'Natural', pieces: 90000 });
    addJob(o, { number: 'WO/PLAN-4A', line: 0, productId: pid, qty: 50000 });
    addJob(o, { number: 'WO/PLAN-4B', line: 0, productId: pid, qty: 40000 });

    const colour = find(productPlan(), 'Handle 45mm').colours[0];
    assert.equal(colour.jobs, 2);
    assert.equal(colour.planned, 90000);
    assert.equal(colour.unplanned, 0);
    assert.deepEqual(colour.work_orders.map((w) => w.number).sort(), ['WO/PLAN-4A', 'WO/PLAN-4B']);
  });

  test('a cancelled job commits nothing', () => {
    // Every roll-up in this app leaves a cancelled job out: counting its
    // qty_planned would report work nobody is going to do, and would close the
    // `unplanned` gap that is the reason to look.
    const pid = makeProduct('Dual Colour Cap', 'Green', 10000);
    const o = makeOpenOrder('SO/PLAN-5');
    addLine(o, { pos: 0, productId: pid, description: 'Cap', color: 'Green', pieces: 50000 });
    addJob(o, { number: 'WO/PLAN-5A', line: 0, productId: pid, qty: 50000, status: 'cancelled' });

    const row = find(productPlan(), 'Dual Colour Cap');
    assert.equal(row.jobs, 0);
    assert.equal(row.planned, 0);
    assert.equal(row.unplanned, 50000);
  });

  test('a scrapped lot does not count as made', () => {
    // `LIVE_OK`'s rule. The pending figure is what is owed to the customer, so
    // condemned output must leave it where it was — otherwise the plan reports
    // goods nobody can ship.
    const pid = makeProduct('Preform 119gm', 'Clear', 10000);
    const o = makeOpenOrder('SO/PLAN-6');
    addLine(o, { pos: 0, productId: pid, description: 'Preform', color: 'Clear', pieces: 50000 });
    const j = addJob(o, { number: 'WO/PLAN-6A', line: 0, productId: pid, qty: 50000 });
    const lot = Number((db.prepare(
      `INSERT INTO batches (number, work_order_id, date, disposition) VALUES ('B-6', ?, '2026-11-10', 'scrapped') RETURNING id`
    ).get(j) as { id: number }).id);
    book(j, 20000, lot);

    const row = find(productPlan(), 'Preform 119gm');
    assert.equal(row.made, 0);
    assert.equal(row.pending, 50000);
    assert.equal(row.colours[0].work_orders[0].made, 0);
    assert.equal(row.colours[0].work_orders[0].balance, 50000);
  });

  test('an over-run leaves nothing to make, never negative work', () => {
    const pid = makeProduct('Over Run Cap', 'Amber', 10000);
    const o = makeOpenOrder('SO/PLAN-7');
    addLine(o, { pos: 0, productId: pid, description: 'Cap', color: 'Amber', pieces: 10000 });
    const j = addJob(o, { number: 'WO/PLAN-7A', line: 0, productId: pid, qty: 10000 });
    book(j, 14000);

    const row = find(productPlan(), 'Over Run Cap');
    assert.equal(row.pending, 0);
    assert.equal(row.colours[0].work_orders[0].balance, 0);
  });
});

describe('and says how long the pending work takes', () => {
  test('days is the pending work at the rate, and at least a day', () => {
    const pid = makeProduct('Rated Preform', 'Natural', 40000);
    const o = makeOpenOrder('SO/PLAN-8');
    addLine(o, { pos: 0, productId: pid, description: 'Preform', color: 'Natural', pieces: 100000 });

    const row = find(productPlan(), 'Rated Preform');
    assert.equal(row.rate?.pcs_per_day, 40000);
    assert.equal(row.rate?.source, 'stated');
    // 100,000 at 40,000 a day is 2.5 — ceil, because a part day is a day the
    // line is occupied.
    assert.equal(row.days, 3);
  });

  test('a product with no rate has no days, never zero', () => {
    // `hasRecipe: false`'s rule. A zero would read as *this takes no time*,
    // which is the one answer that would quietly wreck a plan.
    const pid = makeProduct('Unrated Cap', 'Pink', null);
    const o = makeOpenOrder('SO/PLAN-9');
    addLine(o, { pos: 0, productId: pid, description: 'Cap', color: 'Pink', pieces: 70000 });

    const row = find(productPlan(), 'Unrated Cap');
    assert.equal(row.rate, null);
    assert.equal(row.days, null);
    assert.equal(summarisePlan([row]).no_rate, 1);
  });

  test('a product owing nothing is not counted as missing a rate', () => {
    // It needs no rate: there is nothing left to plan, and counting it would
    // send somebody to type a figure that changes no date on any screen.
    const pid = makeProduct('Finished Cap', 'Grey', null);
    const o = makeOpenOrder('SO/PLAN-10');
    addLine(o, { pos: 0, productId: pid, description: 'Cap', color: 'Grey', pieces: 10000 });
    const j = addJob(o, { number: 'WO/PLAN-10A', line: 0, productId: pid, qty: 10000 });
    book(j, 10000);

    const row = find(productPlan(), 'Finished Cap');
    assert.equal(row.pending, 0);
    assert.equal(row.days, null);
    assert.equal(summarisePlan([row]).no_rate, 0);
  });
});

describe('and groups what the catalogue cannot name', () => {
  test('a custom line naming no product groups by its own wording', () => {
    // An employee meeting a new product mid-order is expected, so the line is
    // a real thing to plan rather than one to drop or sweep into a "custom"
    // pile — `productDemand`'s own rule.
    const o = makeOpenOrder('SO/PLAN-11');
    addLine(o, { pos: 0, productId: null, description: 'Bespoke Jig', color: 'Natural', pieces: 500 });

    const row = find(productPlan(), 'Bespoke Jig');
    assert.equal(row.product_id, null);
    assert.equal(row.ordered, 500);
    assert.equal(row.rate, null);
    assert.equal(row.colours[0].color, 'Natural');
  });

  test('a line stating no colour is its own group, and sorts last', () => {
    const pid = makeProduct('Mixed Colour Cap', '', 10000);
    const o = makeOpenOrder('SO/PLAN-12');
    addLine(o, { pos: 0, productId: pid, description: 'Cap', color: 'Zinc', pieces: 1000 });
    addLine(o, { pos: 1, productId: pid, description: 'Cap', color: '', pieces: 2000 });

    const row = find(productPlan(), 'Mixed Colour Cap');
    assert.deepEqual(row.colours.map((c) => c.color), ['Zinc', '']);
    assert.equal(row.colours[1].ordered, 2000);
  });
});
