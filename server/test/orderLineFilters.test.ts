import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import {
  countOrderLines, lineFacet, orderLines, productDemand,
  FILTERABLE, FILTER_COLUMNS, LINE_STATE_SQL, stateOf, type ColumnFilters,
} from '../src/services/orderLines.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * A filter on each column of the order book, the way a spreadsheet does it
 * (2026-09-24, the client with the lines view in front of them: *"Is it
 * possible to add filter in header of each column like in excel"*).
 *
 * Two things are worth testing here and the rest follows from them. **The
 * filter has to run in SQL**, because the lines are paged — so `state`, which
 * is a TypeScript rule, gained a second copy, and the first group below is the
 * price of that: both read over the same rows, asserted never to differ. And
 * **a tick list has to be measured over the whole book**, not over the page on
 * screen, which is what `lineFacet` is for; the group at the end checks it
 * counts rows nobody has fetched and that it leaves its own column's filter
 * out, without which a choice could never be undone.
 */

const customerId = makeCustomer('Bisleri International Pvt Ltd');
const otherId = makeCustomer('Orient Beverage Limited');
const loc = Number((db.prepare("INSERT INTO locations (name) VALUES ('Plant') RETURNING id").get() as { id: number }).id);
const userId = Number((db.prepare(
  "INSERT INTO users (name, email, password_hash, team_role) VALUES ('Rumela Roy', 'rumela@example.com', 'x', 'sales') RETURNING id"
).get() as { id: number }).id);

function makeOrder(o: {
  number: string; date: string; customer: number; promised?: string; revised?: string;
  port?: string; spoc?: string;
}): number {
  return Number((db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status,
                         promised_date, revised_date, port_of_discharge, created_by, spoc)
     VALUES (?, ?, ?, 1, 'INR', 'igst', 'pending', ?, ?, ?, ?, ?) RETURNING id`
  ).get(o.number, o.date, o.customer, o.promised ?? '', o.revised ?? '', o.port ?? '',
    userId, o.spoc ?? 'Rumela Roy') as { id: number }).id);
}

function addLine(orderId: number, l: { desc: string; color?: string; pcs: number; pos: number; productId?: number }): void {
  db.prepare(
    `INSERT INTO order_items (order_id, product_id, description, color, qty, unit, unit_price, amount, total_pcs, is_charge, sort_order)
     VALUES (?, ?, ?, ?, ?, 'per 1000', 10, 100, ?, 0, ?)`
  ).run(orderId, l.productId ?? null, l.desc, l.color ?? '', l.pcs / 1000, l.pcs, l.pos);
}

function ship(orderId: number, line: number, qty: number): void {
  const trip = Number((db.prepare(
    "INSERT INTO despatches (order_id, location_id, date) VALUES (?, ?, '2026-09-20') RETURNING id"
  ).get(orderId, loc) as { id: number }).id);
  db.prepare('INSERT INTO despatch_items (despatch_id, order_line, qty) VALUES (?, ?, ?)').run(trip, line, qty);
}

let jobSeq = 0;

/** A job on a line, which is where the book's two date columns now come from. */
function plan(orderId: number, line: number, d: {
  start?: string; end?: string; revisedStart?: string; revisedEnd?: string; status?: string;
}): void {
  db.prepare(
    `INSERT INTO work_orders (number, order_id, order_line, qty_planned, status,
                              planned_start, planned_end, revised_start, revised_end)
     VALUES (?, ?, ?, 1000, ?, ?, ?, ?, ?)`
  ).run(`WO/F-${++jobSeq}`, orderId, line, d.status ?? 'released',
    d.start ?? '', d.end ?? '', d.revisedStart ?? '', d.revisedEnd ?? '');
}

/** A catalogue product, so the Item column prints a name rather than the line's own words. */
const productId = Number((db.prepare(
  "INSERT INTO products (name, color, unit) VALUES ('48mm Preform', 'Bisleri', 'per 1000') RETURNING id"
).get() as { id: number }).id);

// Four orders, shaped so every filter has something to bite on and something
// to leave out.
const a = makeOrder({ number: 'SO/26-27/001', date: '2026-09-24', customer: customerId, promised: '2026-09-27', revised: '2026-09-25', port: 'Nhava Sheva' });
addLine(a, { desc: '48mm Handle', color: 'Bisleri Green', pcs: 20000, pos: 0 });
// A split run: two jobs on one line, one of them moved. The line's dates are
// the earliest start and the latest finish across both.
plan(a, 0, { start: '2026-10-01', end: '2026-10-05' });
plan(a, 0, { start: '2026-10-03', end: '2026-10-08', revisedStart: '2026-09-28' });

const b = makeOrder({ number: 'SO/26-27/002', date: '2026-09-23', customer: otherId, promised: '2026-09-28' });
addLine(b, { desc: 'ignored, the product names it', color: 'Bisleri', pcs: 51000, pos: 0, productId });
addLine(b, { desc: '48mm Seal Cap', color: '', pcs: 50000, pos: 1 });
// Line 0 is planned and then finishes later than planned; line 1 has no job.
plan(b, 0, { start: '2026-10-10', end: '2026-10-12', revisedEnd: '2026-10-20' });

const c = makeOrder({ number: 'SO/26-27/003', date: '2026-09-20', customer: customerId, port: 'Nhava Sheva', spoc: '' });
addLine(c, { desc: '2Ltr Deluxe Handle', color: 'Bisleri', pcs: 300000, pos: 0 });
ship(c, 0, 120000);

const d = makeOrder({ number: 'SO/26-27/004', date: '2026-09-18', customer: otherId });
addLine(d, { desc: '48mm Handle', color: 'Red-White', pcs: 5000, pos: 0 });
ship(d, 0, 5000);
// A start and no finish, beside a cancelled job that must count for nothing.
plan(d, 0, { start: '2026-09-18' });
plan(d, 0, { start: '2030-01-01', end: '2030-01-09', status: 'cancelled' });

const ALL = orderLines({});
const of = (columns: ColumnFilters) => orderLines({ columns });
const numbersIn = (columns: ColumnFilters) => [...new Set(of(columns).map((l) => l.order_number))].sort();

describe('the state filter, which is the one rule written twice', () => {
  /**
   * `stateOf` decides what the column prints and `LINE_STATE_SQL` decides what
   * the filter matches. Two copies is what this codebase pays only where
   * paging forces it — and if they ever disagree, a row is filtered out of a
   * list it is visibly a member of, which is the worst way for a filter to be
   * wrong. Run over every line on file, and then over every state.
   */
  test('SQL and TypeScript agree over every combination of the four figures', () => {
    // The rule itself rather than the plumbing, the shape `qcRegister.test.ts`
    // uses: feed both the same four numbers, including the boundaries that
    // decide each arm — nothing ordered, exactly what was ordered, more than
    // was ordered, and an over-shipment of a line ordering nothing.
    const figures = [0, 1, 999, 1000, 1001];
    const rows: { ordered: number; made: number; sent: number; jobs: number }[] = [];
    for (const ordered of figures) {
      for (const sent of figures) {
        for (const made of [0, 5]) {
          for (const jobs of [0, 1]) rows.push({ ordered, made, sent, jobs });
        }
      }
    }
    assert.equal(rows.length, 100);

    const select = rows
      .map((r) => `SELECT ${r.ordered} AS ordered, ${r.sent} AS sent, ${r.made} AS made, ${r.jobs} AS scheduled_jobs`)
      .join(' UNION ALL ');
    const viaSql = db.prepare(`SELECT ${LINE_STATE_SQL} AS state FROM (${select})`).all() as { state: string }[];

    assert.equal(viaSql.length, rows.length);
    rows.forEach((r, i) => {
      assert.equal(
        viaSql[i].state,
        stateOf(r.ordered, r.made, r.sent, r.jobs),
        `ordered ${r.ordered}, sent ${r.sent}, made ${r.made}, jobs ${r.jobs}`,
      );
    });
  });

  test('and they agree about every line actually on file', () => {
    for (const state of ['not_scheduled', 'scheduled', 'partially_dispatched', 'fully_dispatched']) {
      const printed = ALL.filter((l) => l.state === state).map((l) => `${l.order_id}:${l.order_line}`).sort();
      const matched = of({ values: { state: [state] } }).map((l) => `${l.order_id}:${l.order_line}`).sort();
      assert.deepEqual(matched, printed, state);
    }
  });

  test('two states ticked is an either-or, not an and', () => {
    const both = of({ values: { state: ['partially_dispatched', 'fully_dispatched'] } });
    assert.deepEqual([...new Set(both.map((l) => l.state))].sort(), ['fully_dispatched', 'partially_dispatched']);
  });
});

describe('filtering by the value in a column', () => {
  test('customer, by the name the column prints', () => {
    assert.deepEqual(numbersIn({ values: { customer: ['Bisleri International Pvt Ltd'] } }), ['SO/26-27/001', 'SO/26-27/003']);
  });

  test('item reads the catalogue name where the line names a product, and the line otherwise', () => {
    assert.deepEqual(numbersIn({ values: { item: ['48mm Preform'] } }), ['SO/26-27/002']);
    assert.deepEqual(numbersIn({ values: { item: ['48mm Handle'] } }), ['SO/26-27/001', 'SO/26-27/004']);
  });

  test('order number, dest port and colour', () => {
    assert.deepEqual(numbersIn({ values: { order_number: ['SO/26-27/002'] } }), ['SO/26-27/002']);
    assert.deepEqual(numbersIn({ values: { port: ['Nhava Sheva'] } }), ['SO/26-27/001', 'SO/26-27/003']);
    assert.deepEqual(numbersIn({ values: { color: ['Bisleri'] } }), ['SO/26-27/002', 'SO/26-27/003']);
  });

  /**
   * *Nothing recorded* is an answer, and on this book a common one — most
   * orders name no port and many lines no colour. A list that could not offer
   * it would have no way to ask the one question those rows are the answer to.
   */
  test('a blank is tickable, and means the rows with nothing in that column', () => {
    const noPort = of({ values: { port: [''] } });
    assert.ok(noPort.length > 0);
    assert.ok(noPort.every((l) => !l.port_of_discharge));
    const noColour = of({ values: { color: [''] } });
    assert.deepEqual([...new Set(noColour.map((l) => l.description))], ['48mm Seal Cap']);
    // And beside a named value it is an either-or like any other tick.
    assert.equal(of({ values: { color: ['', 'Red-White'] } }).length, noColour.length + 1);
  });

  /**
   * The column shows who is *handling* the order rather than who typed it in
   * (2026-09-24). A blank is tickable here like anywhere else, and on this
   * book it is common: the SPOC is filled in when there is one.
   */
  test('SPOC names whoever is handling it, and a blank is its own answer', () => {
    assert.deepEqual(numbersIn({ values: { spoc: ['Rumela Roy'] } }), ['SO/26-27/001', 'SO/26-27/002', 'SO/26-27/004']);
    assert.deepEqual(numbersIn({ values: { spoc: [''] } }), ['SO/26-27/003']);
  });

  test('two columns filtered is an and', () => {
    assert.deepEqual(
      numbersIn({ values: { customer: ['Bisleri International Pvt Ltd'], port: ['Nhava Sheva'] } }),
      ['SO/26-27/001', 'SO/26-27/003'],
    );
    assert.deepEqual(numbersIn({ values: { customer: ['Orient Beverage Limited'], port: ['Nhava Sheva'] } }), []);
  });
});

/*
 * The book's two date columns are the floor's, not the order header's
 * (2026-09-25, at the client's word): when work on this line starts and when
 * it finishes, read from the jobs raised against it.
 */
describe('the start and finish a line gets from its jobs', () => {
  const lineOf = (number: string, pos = 0) =>
    ALL.find((l) => l.order_number === number && l.order_line === pos)!;

  test("the earliest start and the latest finish across the line's jobs", () => {
    const l = lineOf('SO/26-27/001');
    // Jobs at 01/10→05/10 and 03/10→08/10, the second moved to start 28/09.
    assert.equal(l.job_start, '2026-09-28');
    assert.equal(l.job_end, '2026-10-08');
  });

  test('a revised date stands in for the plan, and the plan is still readable', () => {
    const l = lineOf('SO/26-27/002');
    assert.equal(l.job_start, '2026-10-10');
    assert.equal(l.job_end, '2026-10-20');       // revised
    assert.equal(l.planned_end, '2026-10-12');   // what it replaced
  });

  test('a line with no job has no dates, and neither does the line beside it', () => {
    assert.equal(lineOf('SO/26-27/003').job_start, null);
    assert.equal(lineOf('SO/26-27/003').job_end, null);
    assert.equal(lineOf('SO/26-27/002', 1).job_start, null);
  });

  test('a cancelled job counts for nothing', () => {
    const l = lineOf('SO/26-27/004');
    assert.equal(l.job_start, '2026-09-18');
    // The cancelled job runs to 2030; the line must not claim it.
    assert.equal(l.job_end, null);
  });

  /** The order's own dates are still on the row — the export carries them. */
  test("the order's own production dates are untouched", () => {
    assert.equal(lineOf('SO/26-27/001').promised_date, '2026-09-27');
    assert.equal(lineOf('SO/26-27/001').revised_date, '2026-09-25');
  });
});

describe('filtering by a range', () => {
  test('a date range takes both ends, and either alone', () => {
    assert.deepEqual(numbersIn({ from: { date: '2026-09-23' } }), ['SO/26-27/001', 'SO/26-27/002']);
    assert.deepEqual(numbersIn({ to: { date: '2026-09-20' } }), ['SO/26-27/003', 'SO/26-27/004']);
    assert.deepEqual(numbersIn({ from: { date: '2026-09-20' }, to: { date: '2026-09-23' } }), ['SO/26-27/002', 'SO/26-27/003']);
  });

  test('both ends are inclusive — the day you name is a day you get', () => {
    assert.deepEqual(numbersIn({ from: { date: '2026-09-24' }, to: { date: '2026-09-24' } }), ['SO/26-27/001']);
  });

  /**
   * An order with no revised date is not "before today". Sweeping the blanks
   * into every range would answer a question about the plan with the rows
   * that have no plan — and there are hundreds of those on the live book.
   */
  test('a blank date is in no range at all', () => {
    // SO/003 has no job, so it has no start date — and an order with no start
    // date is not "before today".
    const all = numbersIn({ from: { start: '1900-01-01' }, to: { start: '2999-12-31' } });
    assert.deepEqual(all, ['SO/26-27/001', 'SO/26-27/002', 'SO/26-27/004']);
  });

  test('the job dates are filtered apart from the order date', () => {
    assert.deepEqual(numbersIn({ from: { start: '2026-10-05' } }), ['SO/26-27/002']);
    // SO/004 states a start and no finish, so it is in no finish range either.
    assert.deepEqual(numbersIn({ to: { end: '2026-10-09' } }), ['SO/26-27/001']);
  });

  test('quantity and sent take a min and a max', () => {
    assert.deepEqual(numbersIn({ min: { qty: 100000 } }), ['SO/26-27/003']);
    assert.deepEqual(numbersIn({ max: { qty: 20000 } }), ['SO/26-27/001', 'SO/26-27/004']);
    assert.deepEqual(numbersIn({ min: { sent: 1 } }), ['SO/26-27/003', 'SO/26-27/004']);
  });

  /**
   * Balance is `ordered - sent` floored at zero on the client, so the filter
   * has to be that same arithmetic — a filter that read `ordered` alone would
   * quietly disagree with the figure printed in the cell beside it.
   */
  test('balance is what the column prints, not what is ordered', () => {
    const balances = new Map(ALL.map((l) => [`${l.order_id}:${l.order_line}`, Math.max(0, l.ordered - l.sent)]));
    const open = of({ min: { balance: 1 } });
    assert.ok(open.every((l) => (balances.get(`${l.order_id}:${l.order_line}`) ?? 0) >= 1));
    // The fully shipped line has ordered 5,000 and a balance of nothing, so a
    // max of 0 finds it and a filter on `ordered` never would.
    const settled = of({ max: { balance: 0 } });
    assert.deepEqual(settled.map((l) => l.order_number), ['SO/26-27/004']);
    assert.equal(settled[0].ordered, 5000);
  });
});

describe('everything that reads the book reads the same filters', () => {
  test('the count the pager shows counts the filtered set', () => {
    const f = { columns: { values: { customer: ['Bisleri International Pvt Ltd'] } } };
    assert.equal(countOrderLines(f), orderLines(f).length);
    assert.ok(countOrderLines(f) < countOrderLines({}));
  });

  test('the per-product fold and the export see them too', () => {
    const rows = productDemand({ columns: { values: { item: ['48mm Handle'] } } });
    // Two groups, not one: that item is ordered in two colours, and the fold
    // keys a custom line on description *and* colour — a real distinction on
    // this book, which is why it is asserted rather than summed away.
    assert.deepEqual(rows.map((r) => r.color).sort(), ['Bisleri Green', 'Red-White']);
    assert.equal(rows.reduce((a, r) => a + r.ordered, 0), 25000, 'both orders of that item');
    assert.equal(productDemand({}).length > rows.length, true, 'and the filter narrowed it');
  });

  test('a paged read filters before it pages, not after', () => {
    const f = { columns: { values: { customer: ['Bisleri International Pvt Ltd'] } } };
    const page = orderLines(f, { limit: 1, offset: 0 });
    assert.equal(page.length, 1);
    assert.equal(page[0].customer_name, 'Bisleri International Pvt Ltd');
  });
});

describe('the tick list a column offers', () => {
  test('is measured over the whole book, not the page on screen', () => {
    const facet = lineFacet({}, 'customer');
    assert.deepEqual(facet.values.map((v) => v.value).sort(), ['Bisleri International Pvt Ltd', 'Orient Beverage Limited']);
    // Three lines are that customer's; the page the screen would hold is one.
    const bisleri = facet.values.find((v) => v.value === 'Bisleri International Pvt Ltd');
    assert.equal(bisleri?.count, ALL.filter((l) => l.customer_name === 'Bisleri International Pvt Ltd').length);
  });

  /**
   * Excel's rule, and the one that makes a choice undoable: the list for a
   * column ignores that column's own filter. Narrowed by itself it would show
   * only what was already ticked, and nothing could ever be added back.
   */
  test('ignores its own column, and obeys every other', () => {
    const picked: ColumnFilters = { values: { customer: ['Bisleri International Pvt Ltd'] } };
    const own = lineFacet({ columns: picked }, 'customer');
    assert.equal(own.values.length, 2, 'the other customer must still be offered');

    const colours = lineFacet({ columns: picked }, 'color');
    assert.deepEqual(colours.values.map((v) => v.value).sort(), ['Bisleri', 'Bisleri Green']);
    assert.ok(!colours.values.some((v) => v.value === 'Red-White'), 'that colour is another customer’s');
  });

  test('offers the blank as a value of its own', () => {
    const ports = lineFacet({}, 'port');
    assert.ok(ports.values.some((v) => v.value === '' && v.count > 0));
  });

  test('searches on the server, and a wildcard finds the character', () => {
    assert.deepEqual(lineFacet({}, 'item', { search: 'handle' }).values.map((v) => v.value).sort(),
      ['2Ltr Deluxe Handle', '48mm Handle']);
    // `%` and `_` are LIKE's own; unescaped, the first would match everything.
    assert.equal(lineFacet({}, 'item', { search: '%' }).values.length, 0);
    assert.equal(lineFacet({}, 'customer', { search: 'orient' }).values.length, 1);
  });

  test('says how many values there are when it caps the list', () => {
    const capped = lineFacet({}, 'item', { limit: 1 });
    assert.equal(capped.values.length, 1);
    assert.equal(capped.total, lineFacet({}, 'item').values.length);
    assert.ok(capped.total > capped.values.length, 'the panel has to be able to say it is showing part');
  });
});

describe('the column list itself', () => {
  test('every column names an expression and a kind the page can draw', () => {
    for (const col of FILTER_COLUMNS) {
      const meta = FILTERABLE[col];
      assert.ok(meta.sql.trim().length, `${col} has no expression`);
      assert.ok(['values', 'dates', 'numbers'].includes(meta.kind), `${col}/${meta.kind}`);
    }
  });

  /** A filter nobody set must not narrow anything — the state of every list on first open. */
  test('an empty filter is not a filter', () => {
    assert.equal(of({}).length, ALL.length);
    assert.equal(of({ values: {}, from: {}, to: {}, min: {}, max: {} }).length, ALL.length);
    assert.equal(of({ values: { customer: [] } }).length, ALL.length);
  });
});
