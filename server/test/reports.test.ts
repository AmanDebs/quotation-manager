import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import {
  plannedReport, unscheduledReport, dispatchReport, dueReport, monthsBetween,
  dueColour, daysBetween, addDaysIso, type ReportFilter,
} from '../src/services/reports.js';
import { fiscalYearRange } from '../src/services/numbering.js';
import { scopeClause } from '../src/middleware/scope.js';
import type { AuthedRequest } from '../src/middleware/auth.js';
import { makeCustomer, makeUser, makeInvoice, makePayment } from './helpers/factory.js';

/**
 * The Reports page's four sheets. Most cases are about what each one leaves
 * out, since a pivot that quietly includes the wrong document reads as fact.
 */

const ALL: ReportFilter = { scope: { sql: '', params: [] }, companyId: 0 };
let seq = 0;

function order(customerId: number, o: Partial<{ status: string; revised: string; scheduled: string; promised: string; company: number }> = {}): number {
  return Number((db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status, revised_date, scheduled_date, promised_date)
     VALUES (?, '2026-09-01', ?, ?, 'USD', 'none', ?, ?, ?, ?) RETURNING id`
  ).get(`SO/R-${++seq}`, customerId, o.company ?? 1, o.status ?? 'pending', o.revised ?? '', o.scheduled ?? '', o.promised ?? '') as { id: number }).id);
}

function pi(customerId: number, o: Partial<{ status: string; orderId: number | null; validity: string; total: number; currency: string; spoc: string; company: number }> = {}): number {
  return Number((db.prepare(
    `INSERT INTO proforma_invoices (number, date, customer_id, company_id, currency, order_id, grand_total, status, validity_date, prepared_by)
     VALUES (?, '2026-09-01', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).get(`PI/R-${++seq}`, customerId, o.company ?? 1, o.currency ?? 'USD', o.orderId ?? null, o.total ?? 1000,
    o.status ?? 'sent', o.validity ?? '', o.spoc ?? 'Meisha') as { id: number }).id);
}

const rowsOf = (p: ReturnType<typeof plannedReport>, customerId: number) => p.rows.filter((r) => r.customer_id === customerId);

describe('planned for production', () => {
  test('the revised date wins, then scheduled, then promised; all blank is left out', () => {
    const c = makeCustomer();
    pi(c, { status: 'in_production', orderId: order(c, { revised: '2026-09-20', scheduled: '2026-09-10', promised: '2026-09-01' }), total: 100 });
    pi(c, { status: 'in_production', orderId: order(c, { scheduled: '2026-09-12', promised: '2026-09-01' }), total: 200 });
    pi(c, { status: 'in_production', orderId: order(c, { promised: '2026-09-15' }), total: 300 });
    pi(c, { status: 'in_production', orderId: order(c), total: 400 });
    const [row] = rowsOf(plannedReport(ALL), c);
    assert.deepEqual(row.cells, { '2026-09-20': 100, '2026-09-12': 200, '2026-09-15': 300 });
    assert.equal(row.total, 600);
  });

  test('a finished or cancelled order, an unbooked proforma and a cancelled one are left out', () => {
    const c = makeCustomer();
    pi(c, { status: 'in_production', orderId: order(c, { status: 'completed', revised: '2026-09-20' }) });
    pi(c, { status: 'in_production', orderId: order(c, { status: 'cancelled', revised: '2026-09-20' }) });
    pi(c, { status: 'order_confirmed' });
    pi(c, { status: 'cancelled', orderId: order(c, { revised: '2026-09-20' }) });
    assert.equal(rowsOf(plannedReport(ALL), c).length, 0);
  });

  test('one row per customer, SPOC and currency; totals are per currency, never one figure', () => {
    const c = makeCustomer('Zed');
    pi(c, { status: 'in_production', orderId: order(c, { revised: '2026-09-20' }), total: 100, spoc: 'Meisha' });
    pi(c, { status: 'in_production', orderId: order(c, { revised: '2026-09-20' }), total: 50, spoc: 'Meisha' });
    pi(c, { status: 'in_production', orderId: order(c, { revised: '2026-09-25' }), total: 70, spoc: 'Ashwin' });
    pi(c, { status: 'in_production', orderId: order(c, { revised: '2026-09-20' }), total: 9, spoc: 'Meisha', currency: 'INR' });
    const p = plannedReport(ALL);
    const rows = rowsOf(p, c);
    assert.deepEqual(rows.map((r) => [r.spoc, r.currency, r.total, r.count]), [['Ashwin', 'USD', 70, 1], ['Meisha', 'INR', 9, 1], ['Meisha', 'USD', 150, 2]]);
    assert.equal(rows[2].counts['2026-09-20'], 2);
    const usd = p.totals.find((t) => t.currency === 'USD')!;
    const inr = p.totals.find((t) => t.currency === 'INR')!;
    assert.ok(usd.cells['2026-09-20'] >= 150 && inr.cells['2026-09-20'] >= 9);
    assert.ok(p.columns.includes('2026-09-20') && p.columns.includes('2026-09-25'));
  });

  test('the company filter and Sales scoping narrow it', () => {
    const owner = makeUser('sales');
    const mine = makeCustomer('Mine', owner);
    const theirs = makeCustomer('Theirs');
    pi(mine, { status: 'in_production', orderId: order(mine, { revised: '2026-10-01' }) });
    pi(theirs, { status: 'in_production', orderId: order(theirs, { revised: '2026-10-01' }) });
    const second = Number((db.prepare("INSERT INTO companies (company_name) VALUES ('Second Co') RETURNING id").get() as { id: number }).id);
    pi(mine, { status: 'in_production', orderId: order(mine, { revised: '2026-10-02', company: second }), company: second });
    const req = { user: { id: owner, team_role: 'sales' } } as unknown as AuthedRequest;
    const scoped = plannedReport({ scope: scopeClause(req, 'p.customer_id'), companyId: 0 });
    assert.equal(rowsOf(scoped, theirs).length, 0);
    assert.equal(rowsOf(scoped, mine).length, 1);
    const one = plannedReport({ scope: { sql: '', params: [] }, companyId: second });
    assert.deepEqual(rowsOf(one, mine)[0].cells, { '2026-10-02': 1000 });
  });
});

describe('yet to be scheduled', () => {
  test('sent is pending; confirmed, advance received, and booked with no date are confirmed', () => {
    const c = makeCustomer();
    pi(c, { status: 'sent', total: 1 });
    pi(c, { status: 'order_confirmed', total: 10 });
    pi(c, { status: 'advance_received', total: 100 });
    pi(c, { status: 'in_production', total: 1000 });                                  // booked by hand, no order
    pi(c, { status: 'in_production', orderId: order(c), total: 10000 });               // booked, order has no date
    const [row] = rowsOf(unscheduledReport(ALL), c);
    assert.deepEqual(row.cells, { pending: 1, confirmed: 11110 });
    assert.deepEqual(unscheduledReport(ALL).columns, ['pending', 'confirmed']);
  });

  test('a lapsed offer, a draft and a cancellation are nobody`s pending work', () => {
    const c = makeCustomer();
    pi(c, { status: 'sent', validity: '2020-01-01' });
    pi(c, { status: 'draft' });
    pi(c, { status: 'cancelled' });
    assert.equal(rowsOf(unscheduledReport(ALL), c).length, 0);
  });

  test('over booked proformas the two sheets are exact complements', () => {
    const c = makeCustomer();
    pi(c, { status: 'in_production', orderId: order(c, { revised: '2026-09-20' }), total: 1 });   // planned
    pi(c, { status: 'in_production', orderId: order(c), total: 10 });                            // yet to be scheduled
    pi(c, { status: 'in_production', orderId: order(c, { status: 'completed', revised: '2026-09-20' }), total: 100 }); // neither
    const planned = rowsOf(plannedReport(ALL), c);
    const yet = rowsOf(unscheduledReport(ALL), c);
    assert.equal(planned[0].total, 1);
    assert.equal(yet[0].total, 10);
  });
});

describe('dispatch by month', () => {
  test('buckets invoices by their month, every month in the range being a column', () => {
    const c = makeCustomer();
    makeInvoice({ customerId: c, currency: 'USD', total: 100, date: '2026-04-15' });
    makeInvoice({ customerId: c, currency: 'USD', total: 50, date: '2026-04-30' });
    makeInvoice({ customerId: c, currency: 'USD', total: 7, date: '2026-06-01' });
    makeInvoice({ customerId: c, currency: 'USD', total: 999, date: '2026-07-01' });   // past `to`
    makeInvoice({ customerId: c, currency: 'USD', total: 999, date: '2026-03-31' });   // before `from`
    const p = dispatchReport(ALL, '2026-04-01', '2026-06-30');
    assert.deepEqual(p.columns, ['2026-04', '2026-05', '2026-06']);
    const [row] = rowsOf(p, c);
    assert.deepEqual(row.cells, { '2026-04': 150, '2026-06': 7 });
    assert.equal(row.total, 157);
  });

  test('months and the fiscal year', () => {
    assert.deepEqual(monthsBetween('2025-11-05', '2026-02-01'), ['2025-11', '2025-12', '2026-01', '2026-02']);
    assert.deepEqual(monthsBetween('2026-04-01', '2026-04-01'), ['2026-04']);
    assert.deepEqual(fiscalYearRange('2026-02-10'), { from: '2025-04-01', to: '2026-03-31' });
    assert.deepEqual(fiscalYearRange('2026-04-01'), { from: '2026-04-01', to: '2027-03-31' });
  });
});

describe('due', () => {
  test('the colours and the arithmetic', () => {
    assert.equal(dueColour(-1), 'red');
    assert.equal(dueColour(0), 'yellow');
    assert.equal(dueColour(7), 'yellow');
    assert.equal(dueColour(8), 'green');
    assert.equal(dueColour(14), 'green');
    assert.equal(dueColour(15), null);
    assert.equal(daysBetween('2026-09-28', '2026-10-02'), 4);
    assert.equal(daysBetween('2026-09-15', '2026-09-10'), -5);
    assert.equal(addDaysIso('2026-09-30', 14), '2026-10-14');
  });

  const setDue = (id: number, due: string) => db.prepare('UPDATE commercial_invoices SET due_date = ? WHERE id = ?').run(due, id);

  test('inside the window or overdue is listed and coloured; beyond it, or settled, is not', () => {
    const c = makeCustomer('Due Co');
    const today = '2026-09-15';
    const overdue = makeInvoice({ customerId: c, currency: 'USD', total: 100 }); setDue(overdue, '2026-09-10');
    const soon = makeInvoice({ customerId: c, currency: 'USD', total: 200 }); setDue(soon, '2026-09-22');
    const later = makeInvoice({ customerId: c, currency: 'USD', total: 300 }); setDue(later, '2026-09-29');
    const beyond = makeInvoice({ customerId: c, currency: 'USD', total: 400 }); setDue(beyond, '2026-09-30');
    const paid = makeInvoice({ customerId: c, currency: 'USD', total: 500 }); setDue(paid, '2026-09-10');
    makePayment({ customerId: c, amount: 500, currency: 'USD', invoiceId: paid });
    const part = makeInvoice({ customerId: c, currency: 'USD', total: 600 }); setDue(part, '2026-09-16');
    makePayment({ customerId: c, amount: 150, currency: 'USD', invoiceId: part });
    const r = dueReport(ALL, today);
    const g = r.groups.find((x) => x.customer_id === c)!;
    assert.equal(r.until, '2026-09-29');
    assert.deepEqual(g.invoices.map((i) => [i.id, i.days_to_due, i.colour, i.balance_due]),
      [[overdue, -5, 'red', 100], [part, 1, 'yellow', 450], [soon, 7, 'yellow', 200], [later, 14, 'green', 300]]);
    assert.equal(g.invoiced, 1200);
    assert.equal(g.due, 1050);
    assert.equal(g.undated.count, 0);
  });

  test('no due date and no ETA is listed apart, not dropped; an ETA stands in as the date', () => {
    const c = makeCustomer('Undated Co');
    const bare = makeInvoice({ customerId: c, currency: 'INR', total: 700 });
    const shipped = makeInvoice({ customerId: c, currency: 'INR', total: 800 });
    const o = order(c);
    db.prepare('UPDATE commercial_invoices SET order_id = ? WHERE id = ?').run(o, shipped);
    db.prepare(`INSERT INTO despatches (order_id, date, invoice_id, eta) VALUES (?, '2026-09-06', ?, '2026-09-20')`).run(o, shipped);
    const r = dueReport(ALL, '2026-09-15');
    const g = r.groups.find((x) => x.customer_id === c)!;
    assert.deepEqual(g.undated.invoices.map((i) => [i.id, i.days_to_due, i.colour]), [[bare, null, null]]);
    assert.equal(g.undated.due, 700);
    assert.deepEqual(g.invoices.map((i) => [i.id, i.due_date, i.due_on_arrival, i.colour]), [[shipped, '2026-09-20', true, 'yellow']]);
    assert.equal(g.invoiced, 800);
    assert.ok(r.undated_count >= 1);
  });

  test('groups are per customer and per currency', () => {
    const c = makeCustomer('Two Books');
    const a = makeInvoice({ customerId: c, currency: 'USD', total: 10 }); setDue(a, '2026-09-10');
    const b = makeInvoice({ customerId: c, currency: 'INR', total: 20 }); setDue(b, '2026-09-10');
    const groups = dueReport(ALL, '2026-09-15').groups.filter((g) => g.customer_id === c);
    assert.deepEqual(groups.map((g) => [g.currency, g.due]), [['INR', 20], ['USD', 10]]);
  });
});
