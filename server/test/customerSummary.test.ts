import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import type { AuthedRequest } from '../src/middleware/auth.js';
import type { TeamRole } from '../src/services/permissions.js';
import { customerSummary } from '../src/services/customerSummary.js';
import { makeCustomer, makeProforma, makeInvoice, makePayment, makeQuotation } from './helpers/factory.js';

/**
 * The customer page answers two kinds of question, and both can be silently
 * wrong: what this customer owes, and what this reader is allowed to see.
 */

/** A session, which is all `allows()` reads. */
const as = (role: TeamRole) => ({ user: { team_role: role } }) as unknown as AuthedRequest;

/** A date relative to today, so a test cannot start failing as the calendar moves. */
const daysAgo = (n: number) =>
  (db.prepare(`SELECT date('now', '-${n} days') AS d`).get() as { d: string }).d;

describe('what each team may read', () => {
  test('a section the caller may not read is absent, not empty', () => {
    const c = makeCustomer();
    makeQuotation({ customerId: c, status: 'sent' });
    makeInvoice({ customerId: c, currency: 'INR', total: 1000 });

    const sales = customerSummary(as('sales'), c);
    assert.ok(sales.quotations, 'sales may read quotations');
    assert.equal(sales.quotations?.total, 1);

    const production = customerSummary(as('production'), c);
    /*
     * Not `{ total: 0, rows: [] }` — absent. An empty section would say "this
     * customer has no quotations", which is a different and false statement,
     * and it would leave the client deciding whether to show the heading.
     */
    assert.equal(production.quotations, undefined);
    assert.equal(production.proformas, undefined);
    assert.equal(production.money, undefined, 'and no prices reach the floor');
  });

  test('quality sees its own tolerances and nothing commercial', () => {
    const c = makeCustomer();
    makeInvoice({ customerId: c, currency: 'INR', total: 1000 });
    const s = customerSummary(as('quality'), c);
    assert.ok(s.qc);
    assert.equal(s.money, undefined);
    assert.equal(s.invoices, undefined);
    assert.equal(s.payments, undefined);
  });

  test('the super admin sees every section', () => {
    const s = customerSummary(as('super_admin'), makeCustomer());
    for (const key of ['money', 'enquiries', 'quotations', 'proformas', 'orders',
      'invoices', 'followups', 'payments', 'qc'] as const) {
      assert.ok(s[key], `${key} is present`);
    }
  });
});

describe('the money table', () => {
  test('is per currency, and never sums across them', () => {
    const c = makeCustomer();
    makeInvoice({ customerId: c, currency: 'INR', total: 5000 });
    makeInvoice({ customerId: c, currency: 'EUR', total: 800 });

    const rows = customerSummary(as('super_admin'), c).money!.rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => [r.currency, r.invoiced]), [['EUR', 800], ['INR', 5000]]);
  });

  test('outstanding follows the receivables rule, advance included', () => {
    const c = makeCustomer();
    const pi = makeProforma({ customerId: c, currency: 'EUR', total: 10_000 });
    makePayment({ customerId: c, piId: pi, amount: 4000, currency: 'EUR' });
    makeInvoice({ customerId: c, currency: 'EUR', total: 10_000, piId: pi });

    const [row] = customerSummary(as('super_admin'), c).money!.rows;
    assert.equal(row.received, 4000, 'the advance is credited to the invoice raised from that PI');
    assert.equal(row.outstanding, 6000);
  });

  test('advance held is what no invoice has absorbed, and is not counted twice', () => {
    const c = makeCustomer();
    const pi = makeProforma({ customerId: c, currency: 'EUR', total: 10_000 });
    makePayment({ customerId: c, piId: pi, amount: 10_000, currency: 'EUR' });
    // A part shipment: only €4,000 of the €10,000 has been billed so far.
    makeInvoice({ customerId: c, currency: 'EUR', total: 4000, piId: pi });

    const [row] = customerSummary(as('super_admin'), c).money!.rows;
    assert.equal(row.received, 4000, 'an invoice cannot be credited beyond its own total');
    assert.equal(row.outstanding, 0);
    // The other €6,000 is money the customer has sent that no invoice has
    // reached. Reported here rather than inside `received`, where it would be
    // the same money stated twice.
    assert.equal(row.advance_held, 6000);
  });

  test('an advance against a proforma with no invoice yet is entirely held', () => {
    const c = makeCustomer();
    const pi = makeProforma({ customerId: c, currency: 'USD', total: 7000 });
    makePayment({ customerId: c, piId: pi, amount: 2100, currency: 'USD' });

    const [row] = customerSummary(as('super_admin'), c).money!.rows;
    assert.equal(row.invoiced, 0);
    assert.equal(row.advance_held, 2100);
  });

  test('overdue counts invoices unpaid past sixty days', () => {
    const c = makeCustomer();
    makeInvoice({ customerId: c, currency: 'INR', total: 1000, date: daysAgo(90) });
    makeInvoice({ customerId: c, currency: 'INR', total: 1000, date: daysAgo(10) });
    // Old, but settled — an invoice that has been paid is not overdue.
    const paid = makeInvoice({ customerId: c, currency: 'INR', total: 1000, date: daysAgo(120) });
    makePayment({ customerId: c, invoiceId: paid, amount: 1000, currency: 'INR' });

    const [row] = customerSummary(as('super_admin'), c).money!.rows;
    assert.equal(row.overdue, 1);
    assert.equal(row.outstanding, 2000);
  });
});

describe('money in a currency the document is not billed in', () => {
  test('is reported rather than credited', () => {
    const c = makeCustomer();
    const inv = makeInvoice({ customerId: c, currency: 'EUR', total: 5000 });
    makePayment({ customerId: c, invoiceId: inv, amount: 5000, currency: 'INR' });

    const money = customerSummary(as('super_admin'), c).money!;
    assert.equal(money.rows[0].received, 0, '₹5,000 is not €5,000');
    assert.equal(money.rows[0].outstanding, 5000);
    assert.deepEqual(money.currency_mismatch, [{ currency: 'INR', amount: 5000 }]);
  });

  /**
   * The trap this measurement exists for. An advance on a proforma is reported
   * by `proformaAdvance` *and* by `invoiceReceivable` for every invoice raised
   * from that proforma, so a mismatch merged out of those reports would be
   * counted once per invoice. Measured over the payments themselves, it cannot.
   */
  test('and is reported once, however many invoices hang off the proforma', () => {
    const c = makeCustomer();
    const pi = makeProforma({ customerId: c, currency: 'EUR', total: 10_000 });
    makePayment({ customerId: c, piId: pi, amount: 3000, currency: 'INR' });
    makeInvoice({ customerId: c, currency: 'EUR', total: 4000, piId: pi });
    makeInvoice({ customerId: c, currency: 'EUR', total: 6000, piId: pi });

    const money = customerSummary(as('super_admin'), c).money!;
    assert.deepEqual(money.currency_mismatch, [{ currency: 'INR', amount: 3000 }]);
    assert.equal(money.rows[0].advance_held, 0, 'and it is not held either — it credits nothing');
  });
});

describe('the rest of the page', () => {
  test('a section shows the newest few and says how many there are', () => {
    const c = makeCustomer();
    for (let i = 0; i < 9; i += 1) makeQuotation({ customerId: c, status: 'draft' });
    const s = customerSummary(as('sales'), c).quotations!;
    assert.equal(s.total, 9);
    assert.equal(s.rows.length, 6, 'the head of the list, with the total beside it');
  });

  test('a superseded quotation is marked rather than hidden', () => {
    const c = makeCustomer();
    const newer = makeQuotation({ customerId: c, status: 'sent' });
    makeQuotation({ customerId: c, status: 'sent', supersededBy: newer });
    const rows = customerSummary(as('sales'), c).quotations!.rows;
    assert.equal(rows.filter((q) => q.superseded).length, 1);
  });

  test('the tolerances listed are this customer’s own, not the product default', () => {
    const c = makeCustomer();
    const other = makeCustomer();
    const product = Number(db.prepare(
      "INSERT INTO products (name, unit) VALUES ('Preform 28mm', 'per 1000')"
    ).run().lastInsertRowid);
    const param = (customerId: number | null) => db.prepare(
      `INSERT INTO product_qc_params (product_id, customer_id, name, kind, unit, min_value, max_value)
       VALUES (?, ?, 'Wall thickness', 'numeric', 'mm', 0.3, 0.5)`
    ).run(product, customerId);

    param(null);      // the product's default — belongs to nobody
    param(other);     // another customer's override
    param(c);

    // Field by field rather than deep-equal on the row: `node:sqlite` hands
    // back null-prototype objects, which deepStrictEqual reports as different
    // from an object literal holding exactly the same values.
    const mine = customerSummary(as('quality'), c).qc!.products;
    assert.equal(mine.length, 1, 'only the row this customer owns');
    assert.equal(mine[0].product_id, product);
    assert.equal(mine[0].product_name, 'Preform 28mm');
    assert.equal(mine[0].params, 1);
  });

  test('an overdue follow-up is flagged, and a closed one is not', () => {
    const c = makeCustomer();
    const add = (due: string, done: number) => db.prepare(
      'INSERT INTO followups (doc_type, customer_id, due_date, note, done) VALUES (?, ?, ?, ?, ?)'
    ).run('general', c, due, 'Chase', done);
    add(daysAgo(7), 0);
    add(daysAgo(7), 1);

    const rows = customerSummary(as('sales'), c).followups!.rows;
    assert.equal(rows.filter((f) => f.overdue).length, 1);
  });

  test('a payment says which document it was banked against', () => {
    const c = makeCustomer();
    const pi = makeProforma({ customerId: c, currency: 'INR', total: 1000 });
    makePayment({ customerId: c, piId: pi, amount: 250, currency: 'INR' });
    const [row] = customerSummary(as('super_admin'), c).payments!.rows;
    const number = (db.prepare('SELECT number FROM proforma_invoices WHERE id = ?').get(pi) as { number: string }).number;
    assert.equal(row.against, number);
  });

  test('and one customer’s figures are never another’s', () => {
    const mine = makeCustomer();
    const theirs = makeCustomer();
    makeInvoice({ customerId: theirs, currency: 'INR', total: 9999 });
    const s = customerSummary(as('super_admin'), mine);
    assert.deepEqual(s.money!.rows, []);
    assert.equal(s.invoices!.total, 0);
  });
});
