import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { approversFor } from '../src/services/approvalMail.js';
import { mailConfigured } from '../src/services/mail.js';
import { setUserAccess } from '../src/services/accessPolicy.js';
import { makeCustomer, makeUser } from './helpers/factory.js';

/**
 * Who hears that a document is waiting.
 *
 * The transport is a provider's HTTP API and is not exercised here — what is
 * worth pinning is the **policy**, because getting it wrong is a leak rather
 * than a missing email: the approvals queue is scoped, so mailing every
 * approver would hand a salesperson the number, customer and total of a
 * document they cannot open.
 */

const emailOf = (id: number) =>
  (db.prepare('SELECT email FROM users WHERE id = ?').get(id) as { email: string }).email;

describe('email is off until it is configured', () => {
  /* The whole suite runs offline because of this: nothing in `server/test`
     sets these, so every notification is a no-op rather than a request. */
  test('an unconfigured deployment sends nothing', () => {
    assert.equal(mailConfigured(), false);
  });
});

describe('who an approval notification goes to', () => {
  test('somebody holding the cell is told', () => {
    const c = makeCustomer();
    const admin = makeUser('super_admin');
    assert.ok(approversFor(c).some((p) => p.id === admin));
  });

  test('somebody who cannot approve is not', () => {
    const c = makeCustomer();
    const floor = makeUser('production');
    const logi = makeUser('logistics');
    const quality = makeUser('quality');
    const to = approversFor(c).map((p) => p.id);
    for (const id of [floor, logi, quality]) assert.ok(!to.includes(id));
  });

  /* Unticking Approvals on the User Permissions page has to stop the email as
     well as the button, or the client's own matrix would be half-obeyed. */
  test('the effective table decides, not the recommended one', () => {
    const c = makeCustomer();
    const sales = makeUser('sales');
    db.prepare("UPDATE customers SET owner_id = ? WHERE id = ?").run(sales, c);
    assert.ok(approversFor(c).some((p) => p.id === sales), 'Sales holds approval: full by default');
    setUserAccess(sales, 'sales', { approval: 'view' });
    assert.ok(!approversFor(c).some((p) => p.id === sales), 'and loses the email with the cell');
    setUserAccess(sales, 'sales', { approval: 'full' });
  });

  test('a deactivated account is left out', () => {
    const c = makeCustomer();
    const gone = makeUser('super_admin');
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(gone);
    assert.ok(!approversFor(c).some((p) => p.id === gone));
  });

  test('an account with no address is left out rather than mailed to nothing', () => {
    const c = makeCustomer();
    const blank = makeUser('super_admin');
    db.prepare("UPDATE users SET email = '' WHERE id = ?").run(blank);
    assert.ok(!approversFor(c).some((p) => p.id === blank));
  });

  test('the person who just submitted it is not told about their own press', () => {
    const c = makeCustomer();
    const admin = makeUser('super_admin');
    assert.ok(!approversFor(c, admin).some((p) => p.id === admin));
  });

  test('every address is real', () => {
    const c = makeCustomer();
    makeUser('super_admin');
    for (const p of approversFor(c)) assert.match(p.email, /@/);
    assert.equal(approversFor(c)[0].email, emailOf(approversFor(c)[0].id));
  });
});

/**
 * The scoping half, which is the one that would be a leak rather than a gap.
 * Ownership restricts Sales and nobody else — `visibleCustomerIdsFor`'s rule,
 * read for a person who is not the caller.
 */
describe('and only about documents they could open', () => {
  test('a Sales approver is told about a customer in their book', () => {
    const sales = makeUser('sales');
    const mine = makeCustomer('Mine', sales);
    assert.ok(approversFor(mine).some((p) => p.id === sales));
  });

  test('and not about one that is not', () => {
    const sales = makeUser('sales');
    const theirs = makeCustomer('Somebody else');
    assert.ok(!approversFor(theirs).some((p) => p.id === sales));
  });

  /* A customer is in your book two ways — assigned, or you have raised a
     document for them. The email follows the same rule as the queue. */
  test('having worked on a customer puts them in the book, and on the list', () => {
    const sales = makeUser('sales');
    const c = makeCustomer('Worked on');
    assert.ok(!approversFor(c).some((p) => p.id === sales));
    db.prepare(
      `INSERT INTO quotations (number, date, customer_id, currency, created_by)
       VALUES ('QT/T/1', '2026-10-01', ?, 'INR', ?)`
    ).run(c, sales);
    assert.ok(approversFor(c).some((p) => p.id === sales), 'and now it is');
  });

  test('a super admin is told about every customer, owning none', () => {
    const admin = makeUser('super_admin');
    const a = makeCustomer();
    const b = makeCustomer('Another', makeUser('sales'));
    assert.ok(approversFor(a).some((p) => p.id === admin));
    assert.ok(approversFor(b).some((p) => p.id === admin));
  });
});
