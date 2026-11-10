import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import type { AuthedRequest } from '../src/middleware/auth.js';
import { numberInUseError, duplicateNumberMessage } from '../src/services/numbering.js';
import { makeCustomer, makeUser } from './helpers/factory.js';

/**
 * Which document already holds a number (2026-11-10, the client with a
 * proforma they could not save: *"I am receiving this error in proforma
 * invoice"*).
 *
 * The number really was on another proforma -- the per-company unique index
 * was right to refuse it. What it could not do was say **which**, and on a
 * book of several hundred, with the lists scoped per owner, *"choose a
 * different one"* is advice nobody can follow.
 *
 * Most of these are therefore about what the sentence has to carry, and about
 * what must **not** be refused: an ordinary save sends the document's own
 * number back on every press, so a guard that read that as a clash would make
 * every one of these documents unsavable.
 */
const ADMIN = makeUser('super_admin', 'Numbers -- admin');
const SALES = makeUser('sales', 'Numbers -- sales');
const as = (id: number) =>
  ({ user: { id, team_role: id === ADMIN ? 'super_admin' : 'sales' } }) as unknown as AuthedRequest;

function proforma(o: { number: string; customerId: number; date?: string; companyId?: number }): number {
  const info = db.prepare(
    `INSERT INTO proforma_invoices (number, date, customer_id, company_id, currency)
     VALUES (?, ?, ?, ?, 'INR')`
  ).run(o.number, o.date ?? '2026-10-01', o.customerId, o.companyId ?? 1);
  return Number(info.lastInsertRowid);
}

describe('a number already on another document', () => {
  test('names the document, its date and its customer', () => {
    const c = makeCustomer('Davat Beverages Private Limited', ADMIN);
    proforma({ number: 'AGLO/PI/26-27/010', customerId: c, date: '2026-10-12' });
    const mine = proforma({ number: 'AGLO/PI/26-27/011', customerId: c });

    const msg = numberInUseError(as(ADMIN), 'proforma_invoices', 1, 'AGLO/PI/26-27/010', mine);
    assert.ok(msg, 'the clash was not refused');
    assert.ok(msg.includes('AGLO/PI/26-27/010'), 'the number is not named');
    assert.ok(msg.includes('proforma invoice'), 'the kind of document is not named');
    assert.ok(msg.includes('12-10-2026'), 'the date is not named');
    assert.ok(msg.includes('Davat Beverages Private Limited'), 'the customer is not named');
  });

  test('and says so rather than naming a customer the reader cannot see', () => {
    /*
     * The clash is decided per company and the lists are scoped per owner, so
     * the document in the way is quite often somebody else's. Printing its
     * customer would hand a Sales login a name their own book does not carry;
     * saying only that another proforma has it would send them hunting a row
     * that is not on their screen. It says which of the two it is.
     */
    const theirs = makeCustomer('Not In My Book Pvt Ltd', ADMIN);
    const mine = makeCustomer('Mine Ltd', SALES);
    proforma({ number: 'AGLO/PI/26-27/020', customerId: theirs });
    const ours = proforma({ number: 'AGLO/PI/26-27/021', customerId: mine });

    const msg = numberInUseError(as(SALES), 'proforma_invoices', 1, 'AGLO/PI/26-27/020', ours);
    assert.ok(msg, 'the clash was not refused');
    assert.ok(msg.includes('not in your book'), 'it does not say why the document cannot be found');
    assert.ok(!msg.includes('Not In My Book'), 'it named a customer the reader cannot read');
  });

  test('a document never clashes with itself', () => {
    // The half that would make every save impossible: an ordinary press sends
    // the document's own number back, untouched.
    const c = makeCustomer(undefined, ADMIN);
    const id = proforma({ number: 'AGLO/PI/26-27/030', customerId: c });
    assert.equal(numberInUseError(as(ADMIN), 'proforma_invoices', 1, 'AGLO/PI/26-27/030', id), null);
  });

  test('nor with a document of another company, which numbers from its own series', () => {
    // Each entity counts from 001, which is exactly why the index is per
    // company rather than global.
    const second = Number(
      db.prepare("INSERT INTO companies (company_name, is_default) VALUES ('Second Entity', 0)")
        .run().lastInsertRowid
    );
    const c = makeCustomer(undefined, ADMIN);
    const id = proforma({ number: 'AGLO/PI/26-27/040', customerId: c, companyId: second });
    assert.equal(numberInUseError(as(ADMIN), 'proforma_invoices', 1, 'AGLO/PI/26-27/040', id), null);
  });

  test('a blank is not a clash', () => {
    // A cleared box keeps the issued number -- the writers' own rule -- so
    // there is nothing here to refuse.
    const c = makeCustomer(undefined, ADMIN);
    proforma({ number: 'AGLO/PI/26-27/050', customerId: c });
    assert.equal(numberInUseError(as(ADMIN), 'proforma_invoices', 1, '', undefined), null);
    assert.equal(numberInUseError(as(ADMIN), 'proforma_invoices', 1, '   ', undefined), null);
  });

  test('and a number nothing holds is free', () => {
    assert.equal(numberInUseError(as(ADMIN), 'proforma_invoices', 1, 'AGLO/PI/26-27/999', undefined), null);
  });

  test('a create has no id to leave out, so the clash still bites', () => {
    // The number is drawn from the series inside the transaction that writes
    // it, so there is no row yet to exclude.
    const c = makeCustomer(undefined, ADMIN);
    proforma({ number: 'AGLO/PI/26-27/060', customerId: c });
    assert.ok(numberInUseError(as(ADMIN), 'proforma_invoices', 1, 'AGLO/PI/26-27/060'));
  });
});

describe('the backstop, for the paths no guard reaches first', () => {
  test('reads the document out of the database own message', () => {
    const err = new Error('UNIQUE constraint failed: proforma_invoices.company_id, proforma_invoices.number');
    const msg = duplicateNumberMessage(err);
    assert.ok(msg, 'the index refusal was not recognised');
    assert.ok(msg.includes('proforma invoice'), msg);
    // On a create there is no number box, so this must not send somebody
    // looking for a control that is not on the page.
    assert.ok(!msg.toLowerCase().includes('choose a different one'));
  });

  test('and covers the documents with no box of their own', () => {
    const of = (m: string) => duplicateNumberMessage(new Error(m)) ?? '';
    assert.ok(of('UNIQUE constraint failed: work_orders.number').includes('work order'));
    assert.ok(of('UNIQUE constraint failed: purchase_orders.number').includes('purchase order'));
    assert.ok(of('UNIQUE constraint failed: orders.number').includes('sales order'));
  });

  test('and says nothing about an error that is not one', () => {
    // It is read in a catch-all handler, so a wrong yes here would dress an
    // unrelated failure up as a numbering problem.
    assert.equal(duplicateNumberMessage(new Error('UNIQUE constraint failed: users.email')), null);
    assert.equal(duplicateNumberMessage(new Error('FOREIGN KEY constraint failed')), null);
    assert.equal(duplicateNumberMessage(new Error('no such column: numbers')), null);
  });
});
