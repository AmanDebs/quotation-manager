import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import {
  jobListWhere, jobFacet, jobSummary, readJobFilters, isJobFilterColumn,
  JOB_FILTERABLE, JOB_ORDER, type JobFilters,
} from '../src/services/workOrderList.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * A filter on each heading of the Work Orders list (2026-10-13, the client:
 * *"add filter to all columns in work order similar to sales order"*).
 *
 * The subtle half — a blank is a tickable value, a blank date is in no range, a
 * tick list is measured with this column's own filter left out — belongs to
 * `columnFilters.ts` and is covered by `orderLineFilters.test.ts`, which was
 * written against it when the order book was the only caller. What is tested
 * here is what is **particular to this list**: that each heading filters on the
 * figure its own cell prints, which is the only thing somebody reading the
 * screen can mean by it, and that the three aliases this list had to grow —
 * the item label, the colour and the made figure — say what the column says.
 */

let seq = 0;

/** A customer with a sales order, since a job is only visible through one. */
function order(o: Partial<{
  date: string; number: string; customer: number; isExport: number; poNumber: string;
}> = {}) {
  const customerId = o.customer ?? makeCustomer(`Buyer ${++seq}`);
  const id = Number((db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status, is_export, po_number)
     VALUES (?, ?, ?, 1, 'INR', 'igst', 'pending', ?, ?) RETURNING id`
  ).get(o.number ?? `SO/F-${++seq}`, o.date ?? '2026-09-01', customerId,
    o.isExport ?? 0, o.poNumber ?? '') as { id: number }).id);
  return { id, customerId };
}

/** A catalogue product, so the Item column has a name to prefer. */
function product(name: string, color = '') {
  return Number((db.prepare(
    `INSERT INTO products (name, color, unit, unit_price) VALUES (?, ?, 'per 1000', 10) RETURNING id`
  ).get(name, color) as { id: number }).id);
}

/** A goods line at a position, which is what a job's colour is read from. */
function line(orderId: number, o: Partial<{ color: string; pos: number }> = {}) {
  db.prepare(
    `INSERT INTO order_items (order_id, description, color, qty, unit, unit_price, amount, is_charge, sort_order)
     VALUES (?, 'A line', ?, 1, 'per 1000', 10, 10, 0, ?)`
  ).run(orderId, o.color ?? '', o.pos ?? 0);
}

/** A job, under a number of its own: they are unique per company. */
function job(orderId: number, o: Partial<{
  description: string; productId: number | null; qty: number; status: string;
  plannedStart: string; plannedEnd: string; revisedStart: string; revisedEnd: string; line: number;
}> = {}) {
  const number = `WO/F-${++seq}`;
  const id = Number((db.prepare(
    `INSERT INTO work_orders (order_id, order_line, number, status, description, product_id, qty_planned,
                              planned_start, planned_end, revised_start, revised_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).get(orderId, o.line ?? 0, number, o.status ?? 'released',
    o.description ?? 'A job', o.productId ?? null, o.qty ?? 1000,
    o.plannedStart ?? '', o.plannedEnd ?? '', o.revisedStart ?? '', o.revisedEnd ?? '') as { id: number }).id);
  return { id, number };
}

/** A shift booked against a job, optionally into a lot that can be condemned. */
function shift(workOrderId: number, ok: number, batchId: number | null = null) {
  db.prepare(
    `INSERT INTO production_entries (work_order_id, date, shift, qty_ok, qty_reject, batch_id)
     VALUES (?, '2026-09-10', 'A', ?, 0, ?)`
  ).run(workOrderId, ok, batchId);
}

/** Jobs matching the filters, by number — what the page would draw. */
function numbers(f: JobFilters): string[] {
  const { sql, params } = jobListWhere(f);
  return (db.prepare(`${sql} ${JOB_ORDER}`).all(...(params as never[])) as { number: string }[])
    .map((r) => r.number);
}

/**
 * A filter written the way the URL states it, so the reader is tested too,
 * narrowed to the orders this case raised.
 *
 * These cases share one database — the whole file does — so each one says
 * which orders it is asking about through the same clause the app scopes with.
 * Without it a case would answer about the fixtures of every case before it,
 * which is the shape of a test that passes for the wrong reason.
 */
const from = (orderIds: number[], query: Record<string, string> = {}): JobFilters => ({
  scopeSql: `w.order_id IN (${orderIds.map(() => '?').join(', ')})`,
  scopeParams: orderIds,
  columns: readJobFilters(query),
});

describe('each heading filters on what its own cell prints', () => {
  test('the job number', () => {
    const o = order();
    const a = job(o.id);
    job(o.id);
    assert.deepEqual(numbers(from([o.id], { 'f.job': a.number })), [a.number]);
  });

  test('the customer, which is a join rather than a column of the job', () => {
    const a = order();
    const b = order();
    db.prepare('UPDATE customers SET name = ? WHERE id = ?').run('Nadal Industries Ltd', a.customerId);
    const theirs = job(a.id);
    job(b.id);
    assert.deepEqual(numbers(from([a.id, b.id], { 'f.customer': 'Nadal Industries Ltd' })), [theirs.number]);
  });

  test('the status, under the key this list has always used', () => {
    const o = order();
    const planned = job(o.id, { status: 'planned' });
    job(o.id, { status: 'done' });
    // `?status=` rather than `f.status`: the dashboard's factory chips link
    // here with it, and it is read into the Status column's own tick list so
    // that dropdown can clear it.
    assert.deepEqual(numbers(from([o.id], { status: 'planned' })), [planned.number]);
  });

  test('and two statuses at once, which a single select could never ask', () => {
    const o = order();
    const a = job(o.id, { status: 'planned' });
    const b = job(o.id, { status: 'running' });
    job(o.id, { status: 'done' });
    assert.deepEqual(
      numbers(from([o.id], { status: 'planned\nrunning' })).sort(),
      [a.number, b.number].sort(),
    );
  });

  test('the planned pieces, as a range', () => {
    const o = order();
    const small = job(o.id, { qty: 1_000 });
    const big = job(o.id, { qty: 500_000 });
    assert.deepEqual(numbers(from([o.id], { 'f.qty_min': '100000' })), [big.number]);
    assert.deepEqual(numbers(from([o.id], { 'f.qty_max': '100000' })), [small.number]);
  });
});

describe('the Item column is the catalogue product, and the filter follows it', () => {
  /*
   * The cell prints the product's name where the job names one and the job's
   * own wording where it does not (2026-10-08). The filter reads the same
   * alias, so a dropdown cannot offer a value that matches no row — two copies
   * of *what does this cell say* being exactly how that happens.
   */
  const WORDING = '48mm Seal Cap - dual colour, printed';

  test('a job naming a product is found by the product name, not by its wording', () => {
    const o = order();
    const cap = job(o.id, { productId: product('48mm Seal Cap'), description: WORDING });
    assert.deepEqual(numbers(from([o.id], { 'f.item': '48mm Seal Cap' })), [cap.number]);
    assert.deepEqual(numbers(from([o.id], { 'f.item': WORDING })), []);
  });

  test('a job naming no product falls back to its own wording', () => {
    const o = order();
    const custom = job(o.id, { productId: null, description: 'Tooling trial run' });
    assert.deepEqual(numbers(from([o.id], { 'f.item': 'Tooling trial run' })), [custom.number]);
  });
});

describe('the Colour column reads the line, then the catalogue', () => {
  test('the order line wins where it states one', () => {
    const o = order();
    line(o.id, { color: 'Red yellow' });
    const w = job(o.id, { productId: product('Preform', 'Natural') });
    assert.deepEqual(numbers(from([o.id], { 'f.color': 'Red yellow' })), [w.number]);
  });

  test('the catalogue answers where the line states none', () => {
    const o = order();
    line(o.id, { color: '' });
    const w = job(o.id, { productId: product('Preform', 'Catalogue Grey') });
    assert.deepEqual(numbers(from([o.id], { 'f.color': 'Catalogue Grey' })), [w.number]);
  });

  /*
   * A blank is a real answer here — this book is full of jobs on lines nobody
   * stated a colour for — so it is offered in the list and has to be tickable.
   * `IN` never matches NULL, which is the arm `columnWhere` adds for it.
   */
  test('and a blank is a value somebody can tick', () => {
    const o = order();
    line(o.id, { color: 'Red' });
    line(o.id, { color: '', pos: 1 });
    job(o.id);
    const none = job(o.id, { line: 1 });
    assert.deepEqual(numbers(from([o.id], { 'f.color': '' })), [none.number]);
  });
});

describe('the four date columns are four questions, not two', () => {
  /*
   * The page draws both pairs precisely so the slip between them can be read.
   * A filter that silently asked about whichever date stands would answer a
   * question the screen does not ask.
   */
  test('a planned finish is not a revised one', () => {
    const o = order();
    const plan = job(o.id, { plannedEnd: '2026-10-07' });
    const rev = job(o.id, { plannedEnd: '2026-09-01', revisedEnd: '2026-10-07' });
    assert.deepEqual(numbers(from([o.id], { 'f.planned_end_from': '2026-10-01' })), [plan.number]);
    assert.deepEqual(numbers(from([o.id], { 'f.revised_end_from': '2026-10-01' })), [rev.number]);
  });

  test('both ends count, inclusively', () => {
    const o = order();
    const on = job(o.id, { plannedStart: '2026-09-17' });
    job(o.id, { plannedStart: '2026-09-16' });
    job(o.id, { plannedStart: '2026-09-18' });
    assert.deepEqual(
      numbers(from([o.id], { 'f.planned_start_from': '2026-09-17', 'f.planned_start_to': '2026-09-17' })),
      [on.number],
    );
  });

  /*
   * The trap `columnWhere` records: a date is stored as text, so SQLite reads
   * `'' <= '2026-10-01'` as **true** — an upper bound alone would otherwise
   * return every unplanned job, which on this book is most of them.
   */
  test('an undated job is in no range at all', () => {
    const o = order();
    const dated = job(o.id, { plannedStart: '2026-09-17' });
    job(o.id, { plannedStart: '' });
    assert.deepEqual(numbers(from([o.id], { 'f.planned_start_to': '2026-12-31' })), [dated.number]);
  });
});

describe('the Made column counts what the floor still has', () => {
  /*
   * It reads LIVE_OK, the same expression the figure on the row reads — so a
   * condemned lot stops counting in one place and therefore in both. A raw sum
   * of qty_ok would leave a scrapped job sitting in a *made at least 1,000*
   * filter over pieces that no longer exist.
   */
  function lot(workOrderId: number, disposition = '') {
    return Number((db.prepare(
      `INSERT INTO batches (work_order_id, number, date, disposition)
       VALUES (?, ?, '2026-09-10', ?) RETURNING id`
    ).get(workOrderId, `B/F-${++seq}`, disposition) as { id: number }).id);
  }

  test('a job with output is found; one with none is not', () => {
    const o = order();
    const made = job(o.id);
    job(o.id);
    shift(made.id, 4_000);
    assert.deepEqual(numbers(from([o.id], { 'f.made_min': '1' })), [made.number]);
  });

  test('and a scrapped lot takes its pieces out of the answer', () => {
    const o = order();
    const w = job(o.id);
    const b = lot(w.id);
    shift(w.id, 10_000, b);
    assert.deepEqual(numbers(from([o.id], { 'f.made_min': '1' })), [w.number]);
    db.prepare("UPDATE batches SET disposition = 'scrapped' WHERE id = ?").run(b);
    assert.deepEqual(numbers(from([o.id], { 'f.made_min': '1' })), [], 'condemned output is not made');
  });
});

describe('a tick list is measured over the book, not the page', () => {
  test('it counts every matching job and offers the blank', () => {
    const o = order();
    line(o.id, { color: 'Red' });
    line(o.id, { color: '', pos: 1 });
    job(o.id);
    job(o.id);
    job(o.id, { line: 1 });
    const f = jobFacet(from([o.id]), 'color');
    assert.deepEqual(f.values.find((v) => v.value === 'Red'), { value: 'Red', count: 2 });
    assert.deepEqual(f.values.find((v) => v.value === ''), { value: '', count: 1 });
  });

  /*
   * Excel's own rule, and the one that makes a choice undoable: a list narrowed
   * by itself would show only what was already ticked, so unticking could never
   * put anything back.
   */
  test('a column ignores its own filter and obeys every other', () => {
    const a = order();
    const b = order();
    db.prepare('UPDATE customers SET name = ? WHERE id = ?').run('Anmol Agro', a.customerId);
    db.prepare('UPDATE customers SET name = ? WHERE id = ?').run('J D Impex', b.customerId);
    job(a.id, { status: 'planned' });
    job(b.id, { status: 'done' });

    const ticked = from([a.id, b.id], { 'f.customer': 'Anmol Agro' });
    const own = jobFacet(ticked, 'customer').values.map((v) => v.value);
    assert.ok(own.includes('J D Impex'), 'the other customer is still offered, so the tick can be undone');

    const other = jobFacet(ticked, 'status').values.map((v) => v.value);
    assert.deepEqual(other, ['planned'], 'but the Status list obeys the customer filter');
  });

  test('the search box narrows it on the server', () => {
    const a = order();
    const b = order();
    db.prepare('UPDATE customers SET name = ? WHERE id = ?')
      .run('Bisleri International Pvt. Ltd., Kolkata', a.customerId);
    db.prepare('UPDATE customers SET name = ? WHERE id = ?').run('Nadal Industries Ltd', b.customerId);
    job(a.id);
    job(b.id);
    const f = jobFacet(from([a.id, b.id]), 'customer', { search: 'bisleri' });
    assert.deepEqual(f.values.map((v) => v.value), ['Bisleri International Pvt. Ltd., Kolkata']);
  });
});

describe('the figures over the table describe the same set as the rows', () => {
  test('the summary obeys the column filters', () => {
    const o = order();
    const big = job(o.id, { qty: 100_000, status: 'planned' });
    job(o.id, { qty: 1_000, status: 'done' });
    shift(big.id, 25_000);

    const all = jobSummary(from([o.id]));
    assert.equal(all.jobs, 2);
    assert.equal(all.planned, 101_000);

    const filtered = jobSummary(from([o.id], { status: 'planned' }));
    assert.equal(filtered.jobs, 1, 'a chip that names the queue must count the queue');
    assert.equal(filtered.planned, 100_000);
    assert.equal(filtered.made, 25_000);
    assert.equal(filtered.unplanned, 1);
  });
});

describe('the vocabulary is the code', () => {
  test('a column this build does not know is not one', () => {
    assert.equal(isJobFilterColumn('customer'), true);
    assert.equal(isJobFilterColumn('promised'), false);
    assert.equal(isJobFilterColumn(undefined), false);
  });

  /*
   * A link carrying a key this build has no column for is **ignored rather
   * than refused**: the vocabulary is the code's, and a bookmark from an older
   * client must not 400.
   */
  test('and a query key naming one is ignored rather than refused', () => {
    const o = order();
    const only = job(o.id);
    assert.deepEqual(numbers(from([o.id], { 'f.promised': '2026-10-01' })), [only.number]);
  });

  test('every column names an alias the list query actually selects', () => {
    const o = order();
    job(o.id);
    const { sql, params } = jobListWhere(from([o.id]));
    // Run it against a real row, so a renamed alias trips here rather than
    // reaching the screen as a dropdown that filters nothing.
    const row = db.prepare(`${sql} LIMIT 1`).get(...(params as never[])) as Record<string, unknown>;
    for (const [col, spec] of Object.entries(JOB_FILTERABLE)) {
      // Every expression here is a bare alias, which is what keeps one
      // mechanism covering a join, a COALESCE and a correlated subquery alike.
      assert.ok(spec.sql in row, `${col} filters on ${spec.sql}, which the query does not select`);
    }
  });
});

/**
 * The sales order book's own three, brought over (2026-10-15, the client with
 * both pages in front of them: *"Add the filter options that are available in
 * sales order in work order too"*).
 *
 * What is worth asserting is what is **particular** to a list of jobs: that
 * export and company are facts about the **order** behind the job rather than
 * about the job, that the search reaches the five things somebody standing at
 * this list actually has in hand, and — the one that matters most — that the
 * search cannot be a way past data scoping. `searchClause` brackets its own
 * OR, and the case below is what would notice if it ever stopped.
 */
describe("the sales order book's filters, read over jobs", () => {
  test("export and domestic are the order's flag, not the job's", () => {
    const dom = order({ isExport: 0 });
    const exp = order({ isExport: 1 });
    line(dom.id); line(exp.id);
    const a = job(dom.id, { description: 'Domestic run' });
    const b = job(exp.id, { description: 'Export run' });
    const ids = [dom.id, exp.id];

    assert.deepEqual(numbers({ ...from(ids), isExport: 1 }), [b.number]);
    assert.deepEqual(numbers({ ...from(ids), isExport: 0 }), [a.number]);
    // Absent is not 0 — leaving the tabs on *All* must not mean domestic.
    assert.equal(numbers(from(ids)).length, 2);
  });

  test('the company narrows to one selling entity', () => {
    const o = order();
    line(o.id);
    const a = job(o.id);
    assert.deepEqual(numbers({ ...from([o.id]), companyId: 1 }), [a.number]);
    assert.deepEqual(numbers({ ...from([o.id]), companyId: 2 }), []);
  });

  test('the search reaches all five columns', () => {
    const cust = makeCustomer('Olam Palm Gabon SA');
    const o = order({ customer: cust, number: 'SO-EX/F-OLAM', poNumber: 'OLAM-PO-4471' });
    line(o.id);
    const pid = product('29/21 CTC Preforms');
    const a = job(o.id, { productId: pid, description: "the job's own wording" });
    const ids = [o.id];

    assert.deepEqual(numbers({ ...from(ids), q: a.number }), [a.number], 'the job number');
    assert.deepEqual(numbers({ ...from(ids), q: 'SO-EX/F-OLAM' }), [a.number], 'the sales order');
    assert.deepEqual(numbers({ ...from(ids), q: 'OLAM-PO-4471' }), [a.number], "the buyer's PO");
    assert.deepEqual(numbers({ ...from(ids), q: 'gabon' }), [a.number], 'the customer');
    assert.deepEqual(numbers({ ...from(ids), q: 'preforms' }), [a.number], 'the product');
    assert.deepEqual(numbers({ ...from(ids), q: 'nothing like it' }), []);
  });

  test('a percent sign is a character, not a wildcard', () => {
    const o = order({ customer: makeCustomer('50% Recycled Handles Ltd') });
    const other = order({ customer: makeCustomer('Ordinary Buyer Ltd') });
    line(o.id); line(other.id);
    const a = job(o.id);
    job(other.id);
    const ids = [o.id, other.id];
    // Unescaped, LIKE '%%%' matches every row — which is the whole book
    // answering a search for one character.
    assert.deepEqual(numbers({ ...from(ids), q: '50%' }), [a.number]);
  });

  /**
   * The one that would be a hole rather than a nuisance. `scopeClause` shares
   * this WHERE, so an unbracketed `scope AND x LIKE ? OR y LIKE ?` binds as
   * `(scope AND x) OR y` and the search becomes a way straight past data
   * scoping — the trap `services/search.ts` records and brackets against.
   */
  test('and it cannot reach past the scope it is ANDed with', () => {
    const mine = order({ customer: makeCustomer('Searchable Mine Ltd') });
    const theirs = order({ customer: makeCustomer('Searchable Theirs Ltd') });
    line(mine.id); line(theirs.id);
    const a = job(mine.id);
    job(theirs.id);
    // Scoped to one order, searching a term both customers match.
    assert.deepEqual(numbers({ ...from([mine.id]), q: 'Searchable' }), [a.number]);
  });

  test('the three compose with each other and with a heading filter', () => {
    const o = order({ isExport: 1, customer: makeCustomer('Composable Buyer Ltd') });
    line(o.id, { color: 'Sky Blue' });
    const a = job(o.id, { description: 'Composable job' });
    const f = from([o.id], { 'f.color': 'Sky Blue' });

    assert.deepEqual(numbers({ ...f, isExport: 1, companyId: 1, q: 'composable' }), [a.number]);
    // Each one alone is enough to exclude it, which is what makes it an AND.
    assert.deepEqual(numbers({ ...f, isExport: 0, q: 'composable' }), []);
    assert.deepEqual(numbers({ ...f, isExport: 1, q: 'nothing like it' }), []);
    assert.deepEqual(numbers({ ...f, isExport: 1, companyId: 2, q: 'composable' }), []);
  });

  test('and the summary and the tick lists narrow with the rows', () => {
    const dom = order({ isExport: 0, customer: makeCustomer('Summary Domestic Ltd') });
    const exp = order({ isExport: 1, customer: makeCustomer('Summary Export Ltd') });
    line(dom.id); line(exp.id);
    job(dom.id, { qty: 1000 });
    job(exp.id, { qty: 7000 });
    const ids = [dom.id, exp.id];

    assert.equal(jobSummary({ ...from(ids), isExport: 1 }).planned, 7000);
    assert.equal(jobSummary({ ...from(ids), isExport: 1 }).jobs, 1);
    // A tick list is built from the same statement, so it narrows for free —
    // which is the whole point of the list being described in one place.
    assert.deepEqual(
      jobFacet({ ...from(ids), isExport: 1 }, 'customer').values.map((v) => v.value),
      ['Summary Export Ltd']
    );
  });
});
