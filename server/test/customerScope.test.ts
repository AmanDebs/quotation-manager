import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import type { AuthedRequest } from '../src/middleware/auth.js';
import type { TeamRole } from '../src/services/permissions.js';
import {
  visibleCustomerIds, canAccessCustomer, canRaiseFor, scopeClause, customerChangeError,
} from '../src/middleware/scope.js';
import { makeCustomer, makeQuotation, makeUser } from './helpers/factory.js';

/**
 * Whose book a customer is in.
 *
 * Two rules meet here and they used to be one: a document may be raised for
 * **any** customer on file (2026-10-07), while which documents you *read* is
 * still decided by the customer. What reconciles them is that raising a
 * document puts its customer in your book — without which a quotation raised
 * for somebody else's customer would vanish from its own author's list the
 * instant it was saved.
 *
 * Every session here is built fresh, because `visibleCustomerIds` memoises its
 * answer on the request: reusing one across a write would be asserting against
 * a cache rather than against the book.
 */
const MINE = makeUser('sales', 'Scope — mine');
const THEIRS = makeUser('sales', 'Scope — theirs');

const as = (id: number, role: TeamRole = 'sales') =>
  ({ user: { id, team_role: role } }) as unknown as AuthedRequest;

describe('a customer is in your book two ways', () => {
  test('assigned to you', () => {
    const c = makeCustomer(undefined, MINE);
    assert.ok(visibleCustomerIds(as(MINE))?.includes(c));
    assert.equal(canAccessCustomer(as(MINE), c), true);
  });

  test('or you have raised a document for them', () => {
    const c = makeCustomer(undefined, THEIRS);
    // Before: somebody else's customer, and none of their documents are yours.
    assert.equal(canAccessCustomer(as(MINE), c), false);

    makeQuotation({ customerId: c, status: 'draft', createdBy: MINE });

    /*
     * After: the customer is in your book, so the quotation you just raised is
     * one you can read. This is the whole point — the alternative is a document
     * its own author gets a 404 on.
     */
    assert.equal(canAccessCustomer(as(MINE), c), true);
  });

  test('a document somebody else raised does not put them in your book', () => {
    const c = makeCustomer(undefined, THEIRS);
    makeQuotation({ customerId: c, status: 'draft', createdBy: THEIRS });
    assert.equal(canAccessCustomer(as(MINE), c), false);
    assert.equal(canAccessCustomer(as(THEIRS), c), true);
  });

  test('and a document nobody claimed does not put them in anybody’s', () => {
    const c = makeCustomer(undefined, null);
    makeQuotation({ customerId: c, status: 'draft', createdBy: null });
    // An imported backlog row with no author must not become everybody's: a
    // NULL `created_by` matches no `created_by = ?`, which is the safe way for
    // SQL to answer this and is asserted rather than assumed.
    assert.equal(canAccessCustomer(as(MINE), c), false);
    assert.equal(canAccessCustomer(as(THEIRS), c), false);
  });

  test('it is self-correcting: delete the document and the customer leaves again', () => {
    const c = makeCustomer(undefined, THEIRS);
    const q = makeQuotation({ customerId: c, status: 'draft', createdBy: MINE });
    assert.equal(canAccessCustomer(as(MINE), c), true);
    db.prepare('DELETE FROM quotations WHERE id = ?').run(q);
    assert.equal(canAccessCustomer(as(MINE), c), false);
  });

  test('a general follow-up carries no customer and does not widen anything', () => {
    const before = visibleCustomerIds(as(MINE))!.length;
    db.prepare(
      "INSERT INTO followups (doc_type, doc_id, customer_id, due_date, note, created_by) \
       VALUES ('general', NULL, NULL, '2026-10-01', '', ?)"
    ).run(MINE);
    // The NULL is dropped in SQL rather than landing in an `IN (…)` list as a
    // placeholder that matches nothing but still has to be bound.
    const ids = visibleCustomerIds(as(MINE))!;
    assert.equal(ids.length, before);
    assert.ok(!ids.includes(null as unknown as number));
  });

  test('only Sales is scoped at all', () => {
    for (const role of ['super_admin', 'logistics', 'production', 'quality', 'sys_admin'] as TeamRole[]) {
      assert.equal(visibleCustomerIds(as(MINE, role)), null, role);
      assert.equal(scopeClause(as(MINE, role)).sql, '', role);
    }
    // No session is nothing, not everything.
    assert.deepEqual(visibleCustomerIds({} as AuthedRequest), []);
  });
});

describe('raising a document is a different question from reading one', () => {
  test('any customer on file may be raised for', () => {
    const c = makeCustomer(undefined, THEIRS);
    assert.equal(canAccessCustomer(as(MINE), c), false, 'their documents are not yours');
    assert.equal(canRaiseFor(as(MINE), c), true, 'but you may quote them');
  });

  test('a customer that does not exist is refused by name rather than by SQLite', () => {
    assert.equal(canRaiseFor(as(MINE), 999999), false);
    assert.equal(canRaiseFor(as(MINE), null), false);
  });

  test('and no session raises nothing', () => {
    const c = makeCustomer(undefined, null);
    assert.equal(canRaiseFor({} as AuthedRequest, c), false);
  });
});

describe('moving a document to another customer', () => {
  test('your own document carries its customer with it, so it is allowed', () => {
    const mine = makeCustomer(undefined, MINE);
    const theirs = makeCustomer(undefined, THEIRS);
    assert.equal(customerChangeError(as(MINE), mine, theirs, MINE), null);
  });

  test('somebody else’s document cannot be moved out of your reach', () => {
    const mine = makeCustomer(undefined, MINE);
    const theirs = makeCustomer(undefined, THEIRS);
    const err = customerChangeError(as(MINE), mine, theirs, THEIRS);
    assert.match(String(err), /out of your reach/);
  });

  test('moving it onto a customer that is already yours is always allowed', () => {
    const a = makeCustomer(undefined, MINE);
    const b = makeCustomer(undefined, MINE);
    assert.equal(customerChangeError(as(MINE), a, b, THEIRS), null);
  });

  test('a customer that is not on file is refused', () => {
    const mine = makeCustomer(undefined, MINE);
    assert.equal(customerChangeError(as(MINE), mine, 999999, MINE), 'Customer not found');
  });

  test('not moving it is never refused', () => {
    // The PUT sends the whole row back, so an ordinary save must pass.
    const theirs = makeCustomer(undefined, THEIRS);
    assert.equal(customerChangeError(as(MINE), theirs, theirs, THEIRS), null);
  });

  test('and an unscoped team is never refused', () => {
    const theirs = makeCustomer(undefined, THEIRS);
    const mine = makeCustomer(undefined, MINE);
    assert.equal(customerChangeError(as(MINE, 'super_admin'), mine, theirs, THEIRS), null);
  });
});
