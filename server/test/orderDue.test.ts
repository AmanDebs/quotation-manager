import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { plannedReport, unscheduledReport, type ReportFilter } from '../src/services/reports.js';
import { productDemand } from '../src/services/orderLines.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * When a sales order is due.
 *
 * `orders.promised_date` and `orders.revised_date` came off the order form on
 * 2026-09-25, and six readers were left keyed on columns no screen can fill —
 * so every one of them went quiet on orders raised from that day on.
 * `ORDER_DUE` is the repair: the order's own date where it states one, else
 * the latest finish across its live jobs.
 *
 * Most of what is worth pinning is the **precedence**, because getting it the
 * other way round would be worse than the gap it fixes: a promise to the buyer
 * is not the plant's plan, and reading the plan as the promise would say an
 * order is on time when it is late.
 */

const ALL: ReportFilter = { scope: { sql: '', params: [] }, companyId: 0 };
let seq = 0;

function order(
  customerId: number,
  o: Partial<{ status: string; revised: string; scheduled: string; promised: string }> = {},
): number {
  return Number((db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status,
                         revised_date, scheduled_date, promised_date)
     VALUES (?, '2026-09-01', ?, 1, 'USD', 'none', ?, ?, ?, ?) RETURNING id`
  ).get(`SO/D-${++seq}`, customerId, o.status ?? 'pending',
    o.revised ?? '', o.scheduled ?? '', o.promised ?? '') as { id: number }).id);
}

/** A job on one line of an order, with whatever dates the case is about. */
function job(
  orderId: number,
  o: Partial<{ line: number; plannedEnd: string; revisedEnd: string; status: string }> = {},
): number {
  return Number((db.prepare(
    `INSERT INTO work_orders (order_id, order_line, number, status, qty_planned, planned_end, revised_end)
     VALUES (?, ?, ?, ?, 1000, ?, ?) RETURNING id`
  ).get(orderId, o.line ?? 0, `WO/D-${++seq}`, o.status ?? 'released',
    o.plannedEnd ?? '', o.revisedEnd ?? '') as { id: number }).id);
}

/** A booked proforma, which is what the two production sheets actually list. */
function pi(customerId: number, orderId: number): number {
  return Number((db.prepare(
    `INSERT INTO proforma_invoices (number, date, customer_id, company_id, currency, order_id,
                                    grand_total, status, prepared_by)
     VALUES (?, '2026-09-01', ?, 1, 'USD', ?, 100, 'in_production', 'Meisha') RETURNING id`
  ).get(`PI/D-${++seq}`, customerId, orderId) as { id: number }).id);
}

/** Which dates the *Planned for production* sheet filed this customer under. */
function plannedCells(customerId: number): Record<string, number> {
  const [row] = plannedReport(ALL).rows.filter((r) => r.customer_id === customerId);
  return row ? row.cells : {};
}

const unscheduled = (customerId: number) =>
  unscheduledReport(ALL).rows.filter((r) => r.customer_id === customerId);

describe('an order with no date of its own falls through to its jobs', () => {
  test('the latest finish across them is the date it is due', () => {
    const c = makeCustomer();
    const o = order(c);
    job(o, { line: 0, plannedEnd: '2026-10-05' });
    job(o, { line: 1, plannedEnd: '2026-10-20' });
    pi(c, o);
    // Latest, not earliest: the question is when the whole order is done.
    assert.deepEqual(plannedCells(c), { '2026-10-20': 100 });
  });

  test('and a revised job finish is the one read, by JOB_END its own rule', () => {
    const c = makeCustomer();
    const o = order(c);
    job(o, { plannedEnd: '2026-10-20', revisedEnd: '2026-11-02' });
    pi(c, o);
    assert.deepEqual(plannedCells(c), { '2026-11-02': 100 });
  });

  test('a cancelled job dates nothing — it is not work anybody is doing', () => {
    const c = makeCustomer();
    const o = order(c);
    job(o, { plannedEnd: '2026-10-20', status: 'cancelled' });
    pi(c, o);
    assert.deepEqual(plannedCells(c), {});
    assert.equal(unscheduled(c).length, 1, 'back on the other sheet, which is honest');
  });

  /* `MAX('')` is `''`, not NULL, so a job stating no finish would otherwise
     date the order to the start of time rather than falling through. */
  test('a job stating no finish dates nothing either', () => {
    const c = makeCustomer();
    const o = order(c);
    job(o, { plannedEnd: '' });
    pi(c, o);
    assert.deepEqual(plannedCells(c), {});
    assert.equal(unscheduled(c).length, 1);
  });

  test('an order with no job at all is still undated', () => {
    const c = makeCustomer();
    pi(c, order(c));
    assert.deepEqual(plannedCells(c), {});
    assert.equal(unscheduled(c).length, 1);
  });
});

describe('a stated date beats the floor plan', () => {
  /*
   * The precedence that matters. `promised_date` is what was promised to the
   * buyer and a job date is the plant's own plan, so overdue goes on meaning
   * *past what we promised* — and the imported backlog, 600-odd orders
   * carrying a stated date, answers exactly as it did before this landed.
   */
  test('the promised date wins over a later job finish', () => {
    const c = makeCustomer();
    const o = order(c, { promised: '2026-09-15' });
    job(o, { plannedEnd: '2026-10-20' });
    pi(c, o);
    assert.deepEqual(plannedCells(c), { '2026-09-15': 100 });
  });

  test('and the revised date wins over both', () => {
    const c = makeCustomer();
    const o = order(c, { revised: '2026-09-25', scheduled: '2026-09-20', promised: '2026-09-15' });
    job(o, { plannedEnd: '2026-10-20' });
    pi(c, o);
    assert.deepEqual(plannedCells(c), { '2026-09-25': 100 });
  });

  test('a stated date earlier than the plan is not quietly improved on', () => {
    const c = makeCustomer();
    const o = order(c, { promised: '2026-08-01' });
    job(o, { plannedEnd: '2026-12-31' });
    pi(c, o);
    assert.deepEqual(plannedCells(c), { '2026-08-01': 100 }, 'late is late');
  });
});

describe('the two production sheets stay exact complements', () => {
  /*
   * Both read the one expression, so an order the fallback can now date
   * leaves *Yet to be scheduled* and appears on *Planned for production* in
   * the same move. Before the fallback it sat on the second sheet for ever,
   * whatever the floor had planned.
   */
  test('a job-dated order moves from one sheet to the other, never to both or neither', () => {
    const c = makeCustomer();
    const stated = order(c, { revised: '2026-09-20' });
    const byJob = order(c);
    const undatedAnywhere = order(c);
    pi(c, stated);
    pi(c, byJob);
    pi(c, undatedAnywhere);
    assert.equal(Object.keys(plannedCells(c)).length, 1, 'only the stated one so far');
    assert.equal(unscheduled(c)[0].total, 200, 'the other two');

    job(byJob, { plannedEnd: '2026-10-09' });
    assert.deepEqual(plannedCells(c), { '2026-09-20': 100, '2026-10-09': 100 });
    assert.equal(unscheduled(c)[0].total, 100, 'the one nothing anywhere dates');
  });
});

describe('next due on the by-product view', () => {
  /** One goods line of one product, so the fold has something to group. */
  function line(orderId: number, description: string, sortOrder = 0): void {
    db.prepare(
      `INSERT INTO order_items (order_id, description, color, qty, unit, unit_price, amount, total_pcs, is_charge, sort_order)
       VALUES (?, ?, 'Natural', 10, 'per 1000', 10, 100, 10000, 0, ?)`
    ).run(orderId, description, sortOrder);
  }

  const dueFor = (description: string) =>
    productDemand({}).filter((r) => r.description === description)[0]?.next_due;

  test('falls through to the line own job finish where the order states nothing', () => {
    const c = makeCustomer();
    const o = order(c);
    line(o, 'Fallback Preform');
    job(o, { line: 0, plannedEnd: '2026-10-18' });
    assert.equal(dueFor('Fallback Preform'), '2026-10-18');
  });

  /* It read `promised_date` alone, so a revision was ignored — two
     corrections in one expression, and this is the half nobody would have
     reported, the figure having looked perfectly reasonable. */
  test('the revised order date wins over the promised one', () => {
    const c = makeCustomer();
    const o = order(c, { revised: '2026-09-28', promised: '2026-09-10' });
    line(o, 'Revised Preform');
    assert.equal(dueFor('Revised Preform'), '2026-09-28');
  });

  test('and a stated date wins over the job', () => {
    const c = makeCustomer();
    const o = order(c, { promised: '2026-09-12' });
    line(o, 'Stated Preform');
    job(o, { line: 0, plannedEnd: '2026-10-18' });
    assert.equal(dueFor('Stated Preform'), '2026-09-12');
  });

  test('the soonest across every open line of that product is what is reported', () => {
    const c = makeCustomer();
    const far = order(c);
    const near = order(c);
    line(far, 'Shared Preform');
    line(near, 'Shared Preform');
    job(far, { line: 0, plannedEnd: '2026-11-30' });
    job(near, { line: 0, plannedEnd: '2026-10-02' });
    assert.equal(dueFor('Shared Preform'), '2026-10-02');
  });

  test('a line nothing anywhere dates reports no date rather than today', () => {
    const c = makeCustomer();
    line(order(c), 'Undated Preform');
    assert.equal(dueFor('Undated Preform'), '');
  });
});
