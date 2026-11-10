import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import type { AuthedRequest } from '../src/middleware/auth.js';
import { numberInUseError, duplicateNumberMessage, nextNumber } from '../src/services/numbering.js';
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

/**
 * And a counter hands out a number that is **free** (2026-11-10, the client:
 * *"I am not able to change the PI number after duplicating a PI"*).
 *
 * The sentence in the screenshot was the backstop, which only fires when the
 * index refuses a write -- so the number was never typed, it was *drawn*. The
 * counter knows what it has issued and nothing about what somebody entered by
 * hand, and three of these documents have an editable number box precisely so
 * the desk can enter numbers from their old book.
 *
 * Worse, the refusal rolls back the counter's own increment with the failed
 * INSERT, so the series wedges on that value and every document of that type
 * is refused for ever, with no document on screen to change the number on.
 *
 * Most of these are about what must **not** be stepped over: skipping is only
 * ever right for a number this company already has on a document.
 */
describe('a counter steps over what is already on a document', () => {
  /*
   * Each case numbers in a company of its own, so every figure below is an
   * absolute one rather than a number that depends on what ran before it.
   */
  const company = (pattern: string) => {
    const id = Number(
      db.prepare("INSERT INTO companies (company_name, is_default) VALUES ('Skip Co', 0)")
        .run().lastInsertRowid
    );
    db.prepare('UPDATE companies SET pi_export_pattern = ? WHERE id = ?').run(pattern, id);
    return id;
  };
  const seqOf = (companyId: number, key: string, year: number) =>
    (db.prepare('SELECT next_num FROM sequences WHERE company_id = ? AND doc_type = ? AND year = ?')
      .get(companyId, key, year) as { next_num: number } | undefined)?.next_num;
  const draw = (companyId: number, date = '2026-11-10') =>
    nextNumber('proforma', { isExport: true, companyId, date });

  test('skips nothing when nothing is taken', () => {
    // The ordinary path, and the one that must not move: consecutive numbers.
    const co = company('SKIP/A/{FY}/{SEQ}');
    assert.equal(draw(co), 'SKIP/A/26-27/001');
    assert.equal(draw(co), 'SKIP/A/26-27/002');
  });

  test('steps over a number somebody typed onto a document', () => {
    const co = company('SKIP/B/{FY}/{SEQ}');
    const c = makeCustomer(undefined, ADMIN);
    proforma({ number: 'SKIP/B/26-27/001', customerId: c, companyId: co });
    assert.equal(draw(co), 'SKIP/B/26-27/002');
  });

  test('and winds past a whole run of them, the imported-book shape', () => {
    const co = company('SKIP/C/{FY}/{SEQ}');
    const c = makeCustomer(undefined, ADMIN);
    for (const n of ['001', '002', '003', '004']) {
      proforma({ number: `SKIP/C/26-27/${n}`, customerId: c, companyId: co });
    }
    assert.equal(draw(co), 'SKIP/C/26-27/005');
  });

  test('the counter lands where it stopped, so the scan happens once', () => {
    // Without writing it back, every create on a hand-numbered book would
    // re-scan the whole series from the beginning.
    const co = company('SKIP/D/{FY}/{SEQ}');
    const c = makeCustomer(undefined, ADMIN);
    for (const n of ['001', '002']) {
      proforma({ number: `SKIP/D/26-27/${n}`, customerId: c, companyId: co });
    }
    assert.equal(draw(co), 'SKIP/D/26-27/003');
    assert.equal(seqOf(co, 'proforma_export', 2026), 3);
    assert.equal(draw(co), 'SKIP/D/26-27/004');
  });

  test('never over another company number, which counts from its own series', () => {
    // The decisive one. The index is per company and so is the skip; stepping
    // over a number the group holds elsewhere would leave a gap in this
    // company's own books to avoid a collision that cannot happen.
    const theirs = company('SKIP/E/{FY}/{SEQ}');
    const ours = company('SKIP/E/{FY}/{SEQ}');
    const c = makeCustomer(undefined, ADMIN);
    proforma({ number: 'SKIP/E/26-27/001', customerId: c, companyId: theirs });
    assert.equal(draw(ours), 'SKIP/E/26-27/001');
  });

  test('nor over a number in another fiscal year', () => {
    const co = company('SKIP/F/{FY}/{SEQ}');
    const c = makeCustomer(undefined, ADMIN);
    proforma({ number: 'SKIP/F/25-26/001', customerId: c, companyId: co, date: '2026-03-30' });
    assert.equal(draw(co), 'SKIP/F/26-27/001');
  });

  test('and a pattern naming no sequence is left to the index rather than scanned', () => {
    // Every value formats the same string, so there is nothing to advance to.
    // Scanning would spin to the cap for a refusal it cannot avoid.
    const co = company('SKIP/G/{FY}');
    const c = makeCustomer(undefined, ADMIN);
    proforma({ number: 'SKIP/G/26-27', customerId: c, companyId: co });
    assert.equal(draw(co), 'SKIP/G/26-27');
  });
});
