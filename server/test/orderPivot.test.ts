import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import {
  orderLines, pivotOrderLines, stateOf, PIVOT_OTHER,
  PIVOT_DIMENSIONS, PIVOT_MEASURES, type Filters, type OrderPivot,
} from '../src/services/orderLines.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * The order book folded whichever way somebody asks (2026-10-30, the client:
 * *"can you create a pivot table"*).
 *
 * Almost everything here is about what must **not** happen. A pivot is read as
 * authoritative — it is a total over rows nobody will check — so the failures
 * worth fearing are the quiet ones: a balance summed before it is clamped, an
 * order counted once per line, a currency added to another, a scrapped lot
 * still counted as made, or a column silently dropped past the cap. Each has
 * a case, and the last group asserts the invariant that catches a fold
 * written wrongly whatever the shape: a row's total is the sum of its cells
 * and the grand total is the sum of the rows.
 */

const bisleri = makeCustomer('Bisleri International Pvt Ltd');
const orient = makeCustomer('Orient Beverage Limited');
const loc = Number((db.prepare("INSERT INTO locations (name) VALUES ('Plant') RETURNING id").get() as { id: number }).id);

let seq = 0;

function makeOrder(o: {
  customer: number; date?: string; currency?: string; isExport?: number;
  status?: string; spoc?: string; port?: string;
}): number {
  return Number((db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status,
                         is_export, spoc, port_of_discharge)
     VALUES (?, ?, ?, 1, ?, 'igst', ?, ?, ?, ?) RETURNING id`
  ).get(`SO/P-${++seq}`, o.date ?? '2026-09-10', o.customer, o.currency ?? 'INR',
    o.status ?? 'pending', o.isExport ?? 0, o.spoc ?? 'Rumela', o.port ?? '') as { id: number }).id);
}

function addLine(orderId: number, l: {
  desc: string; color?: string; pcs: number; pos: number; amount?: number; charge?: number;
}): void {
  db.prepare(
    `INSERT INTO order_items (order_id, description, color, qty, unit, unit_price, amount, total_pcs, is_charge, sort_order)
     VALUES (?, ?, ?, ?, 'per 1000', 10, ?, ?, ?, ?)`
  ).run(orderId, l.desc, l.color ?? '', l.pcs / 1000, l.amount ?? (l.pcs / 1000) * 10,
    l.pcs, l.charge ?? 0, l.pos);
}

function ship(orderId: number, line: number, qty: number): void {
  const trip = Number((db.prepare(
    "INSERT INTO despatches (order_id, location_id, date) VALUES (?, ?, '2026-09-20') RETURNING id"
  ).get(orderId, loc) as { id: number }).id);
  db.prepare('INSERT INTO despatch_items (despatch_id, order_line, qty) VALUES (?, ?, ?)').run(trip, line, qty);
}

/** A job on a line, which is where the book's two date columns come from. */
function plan(orderId: number, line: number, d: { start?: string; end?: string }): number {
  return Number((db.prepare(
    `INSERT INTO work_orders (number, order_id, order_line, qty_planned, status, planned_start, planned_end)
     VALUES (?, ?, ?, 1000, 'released', ?, ?) RETURNING id`
  ).get(`WO/P-${++seq}`, orderId, line, d.start ?? '', d.end ?? '') as { id: number }).id);
}

const batch = (woId: number) => Number((db.prepare(
  "INSERT INTO batches (number, work_order_id, date) VALUES (?, ?, '2026-09-02') RETURNING id"
).get(`B/P-${++seq}`, woId) as { id: number }).id);

const shift = (woId: number, batchId: number | null, ok: number) =>
  db.prepare(
    `INSERT INTO production_entries (work_order_id, batch_id, date, qty_ok, qty_reject)
     VALUES (?, ?, '2026-09-02', ?, 0)`
  ).run(woId, batchId, ok);

const scrap = (batchId: number) =>
  db.prepare("UPDATE batches SET disposition = 'scrapped', disposition_date = '2026-09-07' WHERE id = ?").run(batchId);

/** The one row of a one-row sheet. */
const only = (p: OrderPivot) => {
  assert.equal(p.grids.length, 1, 'expected exactly one grid');
  return p.grids[0];
};
const rowFor = (p: OrderPivot, key: string) => {
  const r = only(p).rows.find((x) => x.keys[0] === key);
  assert.ok(r, `no row for ${JSON.stringify(key)}`);
  return r;
};

describe('the vocabulary', () => {
  test('is sent with the answer, so the pickers hold no second copy', () => {
    const p = pivotOrderLines();
    assert.deepEqual(p.dimensions, PIVOT_DIMENSIONS);
    assert.deepEqual(p.measures, PIVOT_MEASURES);
    assert.ok(p.dimensions.length > 5);
  });

  test('refuses a rate, a raw billed quantity and the shelf as measures', () => {
    /*
     * All three look summable and none is. The rate is per-unit and in
     * whatever basis the line names; the billed quantity mixes those bases;
     * and the shelf is the same figure on every line of that product.
     */
    for (const key of ['rate', 'unit_price', 'billing_qty', 'in_stock']) {
      assert.ok(!PIVOT_MEASURES.some((m) => m.key === key), `${key} must not be a measure`);
    }
  });

  test('a key the build does not know falls back rather than throwing', () => {
    const p = pivotOrderLines({}, { rows: ['nonsense'], column: 'also nonsense', measure: 'bogus' });
    assert.deepEqual(p.rows, ['customer']);
    assert.equal(p.column, '');
    assert.equal(p.measure, 'ordered');
  });

  test('the same dimension twice down the side is one level, not two', () => {
    const p = pivotOrderLines({}, { rows: ['color', 'color'] });
    assert.deepEqual(p.rows, ['color']);
  });

  test('only a money measure is drawn per currency', () => {
    assert.equal(pivotOrderLines({}, { measure: 'ordered' }).money, false);
    assert.equal(pivotOrderLines({}, { measure: 'value' }).money, true);
  });
});

describe('what it adds up', () => {
  /*
   * One order of two lines, one of them over-shipped — which this book allows
   * on purpose, the dispatch form tolerating ±10%.
   */
  const over = makeOrder({ customer: bisleri, spoc: 'Overs' });
  addLine(over, { desc: 'Cap', color: 'Green', pcs: 100_000, pos: 0 });
  addLine(over, { desc: 'Handle', color: 'Red', pcs: 50_000, pos: 1 });
  // A charge line, which never reaches this view at all.
  addLine(over, { desc: 'Freight', pcs: 0, pos: 2, amount: 5_000, charge: 1 });
  ship(over, 0, 110_000); // 10,000 more than ordered
  ship(over, 1, 20_000);

  const blanks = makeOrder({ customer: orient, spoc: 'Blanks' });
  addLine(blanks, { desc: 'Preform', pcs: 7_000, pos: 0 });

  /*
   * Narrowed to this block's own SPOC. Every `describe` body runs before any
   * test does, so the whole fixture book exists by the time one asserts —
   * which is exactly the filtering the pivot is for.
   */
  const f: Filters = { columns: { values: { spoc: ['Overs'] } } };

  test('balance is clamped per line, then summed', () => {
    const p = pivotOrderLines(f, { rows: ['customer'], measure: 'balance' });
    const row = rowFor(p, 'Bisleri International Pvt Ltd');
    /*
     * 0 on the over-shipped line and 30,000 on the other. Summed the other
     * way round — SUM(ordered) - SUM(sent) — it would read 20,000, and the
     * 10,000 over-shipped would quietly cancel part of a real shortfall.
     */
    assert.equal(row.total, 30_000);
    const ordered = rowFor(pivotOrderLines(f, { measure: 'ordered' }), 'Bisleri International Pvt Ltd').total;
    const sent = rowFor(pivotOrderLines(f, { measure: 'sent' }), 'Bisleri International Pvt Ltd').total;
    assert.equal(ordered - sent, 20_000, 'the unclamped figure, which is the one not to report');
    assert.notEqual(row.total, ordered - sent);
  });

  test('a charge line is not in the sheet', () => {
    const p = pivotOrderLines(f, { rows: ['item'], measure: 'value' });
    assert.ok(!only(p).rows.some((r) => r.keys[0] === 'Freight'));
    // And its money is not in the total either.
    assert.equal(only(p).total, (100_000 / 1000) * 10 + (50_000 / 1000) * 10);
  });

  test('a blank value is its own group rather than being dropped', () => {
    const g: Filters = { columns: { values: { spoc: ['Blanks'] } } };
    const p = pivotOrderLines(g, { rows: ['color'], measure: 'ordered' });
    const row = rowFor(p, '');
    assert.equal(row.total, 7_000, 'no colour recorded is a group, not a dropped line');
    // Nobody recorded a port on these either, so that whole dimension is one
    // blank group — a real answer on this book rather than an empty sheet.
    assert.deepEqual(only(pivotOrderLines(g, { rows: ['port'] })).rows.map((r) => r.keys[0]), ['']);
  });
});

describe('an order is counted once, however many lines it has', () => {
  const a = makeOrder({ customer: bisleri, spoc: 'Meisha' });
  addLine(a, { desc: 'Cap', pcs: 1_000, pos: 0 });
  addLine(a, { desc: 'Handle', pcs: 1_000, pos: 1 });
  addLine(a, { desc: 'Preform', pcs: 1_000, pos: 2 });

  test('`orders` is distinct, never a sum', () => {
    const p = pivotOrderLines({ columns: { values: { spoc: ['Meisha'] } } }, { rows: ['spoc'], measure: 'orders' });
    const row = rowFor(p, 'Meisha');
    assert.equal(row.total, 1, 'one order, not three');
    assert.equal(row.count, 3, 'over three lines');
    const lines = rowFor(pivotOrderLines({ columns: { values: { spoc: ['Meisha'] } } }, { rows: ['spoc'], measure: 'lines' }), 'Meisha');
    assert.equal(lines.total, 3);
  });

  test('and is still distinct inside a cell, not only in the row total', () => {
    const p = pivotOrderLines(
      { columns: { values: { spoc: ['Meisha'] } } },
      { rows: ['spoc'], column: 'customer', measure: 'orders' },
    );
    const row = rowFor(p, 'Meisha');
    assert.equal(row.cells['Bisleri International Pvt Ltd'], 1);
    assert.equal(row.total, 1);
  });
});

describe('a scrapped lot is not output', () => {
  const o = makeOrder({ customer: orient, spoc: 'Ashwin' });
  addLine(o, { desc: 'Cap', pcs: 20_000, pos: 0 });
  const wo = plan(o, 0, { start: '2026-10-05', end: '2026-10-09' });
  const good = batch(wo);
  const bad = batch(wo);
  shift(wo, good, 8_000);
  shift(wo, bad, 5_000);

  test('`made` reads `LIVE_OK` through the lines, so condemning a lot moves it', () => {
    const made = () => rowFor(pivotOrderLines({ columns: { values: { spoc: ['Ashwin'] } } }, { rows: ['spoc'], measure: 'made' }), 'Ashwin').total;
    assert.equal(made(), 13_000);
    scrap(bad);
    assert.equal(made(), 8_000, 'the condemned 5,000 stops counting');
  });
});

describe('money', () => {
  const inr = makeOrder({ customer: bisleri, currency: 'INR', spoc: 'Prasun' });
  addLine(inr, { desc: 'Cap', pcs: 10_000, pos: 0, amount: 1_000 });
  const usd = makeOrder({ customer: bisleri, currency: 'USD', spoc: 'Prasun', isExport: 1 });
  addLine(usd, { desc: 'Cap', pcs: 10_000, pos: 0, amount: 400 });

  const f: Filters = { columns: { values: { spoc: ['Prasun'] } } };

  test('is drawn once per currency and never added across', () => {
    const p = pivotOrderLines(f, { rows: ['customer'], measure: 'value' });
    assert.equal(p.grids.length, 2);
    const by = new Map(p.grids.map((g) => [g.currency, g.total]));
    assert.equal(by.get('INR'), 1_000);
    assert.equal(by.get('USD'), 400);
    // Nothing anywhere states 1,400.
    assert.ok(!p.grids.some((g) => g.total === 1_400));
  });

  test('while pieces add across currencies, in one sheet', () => {
    const p = pivotOrderLines(f, { rows: ['customer'], measure: 'ordered' });
    assert.equal(p.grids.length, 1);
    assert.equal(only(p).currency, '');
    assert.equal(only(p).total, 20_000);
  });

  test('and the stacked sheets share one column axis, so they can be read together', () => {
    const p = pivotOrderLines(f, { rows: ['customer'], column: 'trade', measure: 'value' });
    // Export and domestic both appear on both sheets' axis even though each
    // currency holds only one of them — otherwise the two grids could not be
    // read against each other.
    assert.deepEqual([...p.columns].sort(), ['0', '1']);
  });
});

describe('the column axis', () => {
  test('a month axis draws every month in the span, including the empty ones', () => {
    const o = makeOrder({ customer: orient, spoc: 'Tannistha' });
    addLine(o, { desc: 'Cap', pcs: 1_000, pos: 0 });
    addLine(o, { desc: 'Handle', pcs: 1_000, pos: 1 });
    plan(o, 0, { start: '2026-10-01', end: '2026-10-02' });
    plan(o, 1, { start: '2027-01-15', end: '2027-01-16' });
    const p = pivotOrderLines(
      { columns: { values: { spoc: ['Tannistha'] } } },
      { rows: ['spoc'], column: 'start_month', measure: 'ordered' },
    );
    assert.deepEqual(p.columns, ['2026-10', '2026-11', '2026-12', '2027-01']);
    const row = rowFor(p, 'Tannistha');
    // The two quiet months are columns with nothing in them, which is the
    // point: a gap has to be visible.
    assert.equal(row.cells['2026-11'], undefined);
    assert.equal(row.cells['2026-10'], 1_000);
  });

  test('a line with no date is its own column, and goes last', () => {
    const o = makeOrder({ customer: orient, spoc: 'Sanjib' });
    addLine(o, { desc: 'Cap', pcs: 1_000, pos: 0 });
    plan(o, 0, { start: '2026-10-01' });
    addLine(o, { desc: 'Handle', pcs: 2_000, pos: 1 }); // no job at all
    const p = pivotOrderLines(
      { columns: { values: { spoc: ['Sanjib'] } } },
      { rows: ['spoc'], column: 'start_month', measure: 'ordered' },
    );
    assert.equal(p.columns[p.columns.length - 1], '', 'silence is not a date');
    assert.equal(rowFor(p, 'Sanjib').cells[''], 2_000);
  });

  test('past the cap the tail is folded into one column, and the totals still add up', () => {
    const o = makeOrder({ customer: orient, spoc: 'Wide' });
    for (let i = 0; i < 45; i += 1) {
      addLine(o, { desc: 'Cap', color: `Shade ${String(i).padStart(2, '0')}`, pcs: 1_000 + i, pos: i });
    }
    const p = pivotOrderLines(
      { columns: { values: { spoc: ['Wide'] } } },
      { rows: ['spoc'], column: 'color', measure: 'ordered' },
    );
    assert.equal(p.folded, 5, 'five colours past the cap of forty');
    assert.equal(p.columns.length, 41, 'forty, plus the one they were folded into');
    assert.ok(p.columns.includes(PIVOT_OTHER));
    const row = rowFor(p, 'Wide');
    const expected = Array.from({ length: 45 }, (_, i) => 1_000 + i).reduce((a, b) => a + b, 0);
    assert.equal(row.total, expected, 'nothing is lost by folding');
    assert.equal(Object.values(row.cells).reduce((a, b) => a + b, 0), expected);
  });

  test('a distinct count folded into `Other` unions its orders rather than adding them', () => {
    // Two orders, each with 25 colours, so the tail of the colour axis holds
    // lines from both. Added rather than unioned, `Other` would over-count.
    const a = makeOrder({ customer: bisleri, spoc: 'Fold' });
    const b = makeOrder({ customer: bisleri, spoc: 'Fold' });
    for (let i = 0; i < 45; i += 1) {
      addLine(a, { desc: 'Cap', color: `Tone ${String(i).padStart(2, '0')}`, pcs: 1_000, pos: i });
      addLine(b, { desc: 'Cap', color: `Tone ${String(i).padStart(2, '0')}`, pcs: 1_000, pos: i });
    }
    const p = pivotOrderLines(
      { columns: { values: { spoc: ['Fold'] } } },
      { rows: ['spoc'], column: 'color', measure: 'orders' },
    );
    const row = rowFor(p, 'Fold');
    assert.ok(p.folded > 0);
    // Each colour is on both orders, so every cell — the folded one included
    // — is 2, and the row is 2 and not the number of cells doubled.
    assert.equal(row.cells[PIVOT_OTHER], 2);
    assert.equal(row.total, 2);
  });
});

describe('it folds exactly the lines the list shows', () => {
  test('state matches `stateOf` for the same line', () => {
    const o = makeOrder({ customer: orient, spoc: 'Statey' });
    addLine(o, { desc: 'Cap', pcs: 10_000, pos: 0 });
    ship(o, 0, 4_000);
    const f: Filters = { columns: { values: { spoc: ['Statey'] } } };
    const line = orderLines(f)[0];
    assert.equal(line.state, stateOf(line.ordered, line.made, line.sent, 0));
    const p = pivotOrderLines(f, { rows: ['state'], measure: 'lines' });
    assert.deepEqual(only(p).rows.map((r) => r.keys[0]), [line.state]);
  });

  test('every filter narrows it — the whole reason it sits on the order book', () => {
    const o = makeOrder({ customer: orient, spoc: 'Narrow', isExport: 1, status: 'scheduled' });
    addLine(o, { desc: 'Teal Cap', color: 'Teal', pcs: 9_000, pos: 0 });
    addLine(o, { desc: 'Pink Cap', color: 'Pink', pcs: 3_000, pos: 1 });

    const all = pivotOrderLines({ columns: { values: { spoc: ['Narrow'] } } }, { measure: 'ordered' });
    assert.equal(only(all).total, 12_000);

    // A column filter.
    const teal = pivotOrderLines(
      { columns: { values: { spoc: ['Narrow'], color: ['Teal'] } } },
      { measure: 'ordered' },
    );
    assert.equal(only(teal).total, 9_000);

    // The search box, the status picker and export/domestic.
    assert.equal(only(pivotOrderLines({ columns: { values: { spoc: ['Narrow'] } }, q: 'Pink' }, { measure: 'ordered' })).total, 3_000);
    assert.equal(only(pivotOrderLines({ columns: { values: { spoc: ['Narrow'] } }, status: 'scheduled' }, { measure: 'ordered' })).total, 12_000);
    assert.equal(pivotOrderLines({ columns: { values: { spoc: ['Narrow'] } }, isExport: 0 }, { measure: 'ordered' }).lines, 0);

    // And scope, which is what keeps one salesperson's sheet their own.
    const scoped = pivotOrderLines(
      { columns: { values: { spoc: ['Narrow'] } }, scopeSql: 'customer_id IN (?)', scopeParams: [bisleri] },
      { measure: 'ordered' },
    );
    assert.equal(scoped.lines, 0, 'another owner\'s order is not in the fold');
  });
});

describe('the figures agree with each other', () => {
  /*
   * The invariant that catches a fold written wrongly whatever its shape. Run
   * over several shapes at once rather than asserting figures, because the
   * arithmetic a pivot gets wrong is almost always an accumulator written at
   * the wrong level.
   */
  const shapes: { rows: string[]; column?: string; measure: string }[] = [
    { rows: ['customer'], measure: 'ordered' },
    { rows: ['customer'], column: 'color', measure: 'ordered' },
    { rows: ['customer', 'spoc'], column: 'state', measure: 'balance' },
    { rows: ['item'], column: 'month', measure: 'value' },
    { rows: ['spoc'], column: 'customer', measure: 'lines' },
    { rows: ['month'], column: 'trade', measure: 'sent' },
  ];

  for (const s of shapes) {
    test(`${s.rows.join(' + ')} by ${s.column ?? 'nothing'}, ${s.measure}`, () => {
      const p = pivotOrderLines({}, s);
      for (const g of p.grids) {
        for (const r of g.rows) {
          if (p.column) {
            const sum = Object.values(r.cells).reduce((a, b) => a + b, 0);
            assert.ok(Math.abs(sum - r.total) < 0.005, `row cells ${sum} vs total ${r.total}`);
          }
          assert.ok(r.keys.length === p.rows.length);
        }
        // The grand total is the sum of the rows — except for a distinct
        // count, where it is a union and is correctly smaller.
        const rows = g.rows.reduce((a, r) => a + r.total, 0);
        assert.ok(Math.abs(rows - g.total) < 0.005, `rows ${rows} vs grand ${g.total}`);
        const lines = g.rows.reduce((a, r) => a + r.count, 0);
        assert.equal(lines, g.count);
      }
    });
  }

  test('a distinct count totals as a union, which is smaller than the sum of its rows', () => {
    // Bisleri's orders are spread over several SPOCs, so each row counts its
    // own orders and the sheet counts them once between them.
    const p = pivotOrderLines({}, { rows: ['spoc'], measure: 'orders' });
    const g = only(p);
    const rows = g.rows.reduce((a, r) => a + r.total, 0);
    assert.ok(g.total <= rows);
    assert.ok(g.total > 0);
  });

  test('`lines` over no dimension at all is every line in the fold', () => {
    const p = pivotOrderLines({}, { measure: 'lines' });
    assert.equal(only(p).total, p.lines);
    assert.equal(only(p).total, orderLines().length);
  });
});
