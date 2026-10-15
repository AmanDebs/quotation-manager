import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import type { AuthedRequest } from '../src/middleware/auth.js';
import { raiseForError, customerChangeError } from '../src/middleware/scope.js';
import { makeCustomer, makeUser } from './helpers/factory.js';

/**
 * Taking a customer out of use (2026-10-15, the client: *"Add an option to
 * disable products and customers so that they cannot be used in future"*).
 *
 * The cases worth writing are almost all about what must **not** be refused.
 * A guard that stops a new document is the whole feature; one that stops a
 * document already on file from being saved is the trap this codebase has
 * built once already, and nothing on screen would say why.
 *
 * The product half is not here, deliberately. There is no equivalent choke
 * point: a product is named per line in six item tables that are deleted and
 * reinserted on every save, so a guard there would have to tell a line that
 * was already present from one just added, or it would refuse every document
 * that legitimately names a disabled product. The catalogue picker is what
 * stops it being put on anything new, and `?active=1` is route-level SQL,
 * which is the layer this codebase verifies with curl.
 */

const SALES = makeUser('sales', 'Disable — sales');
const OTHER = makeUser('sales', 'Disable — other');

const as = (id: number) => ({ user: { id, team_role: 'sales' } }) as unknown as AuthedRequest;
const disable = (id: number) => db.prepare('UPDATE customers SET active = 0 WHERE id = ?').run(id);
const enable = (id: number) => db.prepare('UPDATE customers SET active = 1 WHERE id = ?').run(id);

describe('a disabled customer cannot be raised for', () => {
  test('and the refusal names them rather than claiming they do not exist', () => {
    const c = makeCustomer('Petite Bottling Company', SALES);
    assert.equal(raiseForError(as(SALES), c), null, 'in use to begin with');

    disable(c);
    const bad = raiseForError(as(SALES), c);
    assert.ok(bad, 'disabled, so refused');
    /*
     * The sentence matters as much as the refusal. "Customer not found" about
     * a customer somebody disabled five minutes ago is a lie, and it sends
     * them to create a duplicate — which is the expensive mistake on this
     * book, every document and payment hanging off the one row.
     */
    assert.match(bad!, /Petite Bottling Company/);
    assert.match(bad!, /disabled/);
    assert.match(bad!, /Customers page/);
    assert.equal(/not found/.test(bad!), false);
  });

  test('putting them back puts it back', () => {
    const c = makeCustomer(undefined, SALES);
    disable(c);
    assert.ok(raiseForError(as(SALES), c));
    enable(c);
    assert.equal(raiseForError(as(SALES), c), null);
  });

  test('a customer that is simply not on file still answers that', () => {
    assert.equal(raiseForError(as(SALES), 999999), 'Customer not found');
    assert.equal(raiseForError(as(SALES), null), 'Customer not found');
  });

  test('ownership is not what this asks — anybody may raise for anybody in use', () => {
    const c = makeCustomer(undefined, OTHER);
    assert.equal(raiseForError(as(SALES), c), null);
    disable(c);
    assert.match(raiseForError(as(SALES), c)!, /disabled/);
  });
});

describe('what a disabled customer must not stop', () => {
  /*
   * The one that would have been the shipped bug. Every document carries its
   * customer in the body on every PUT, so a guard asked unconditionally would
   * make each one unsavable the moment its customer was disabled — including,
   * for an order, by an edit nothing to do with the customer.
   */
  test('an ordinary save of a document that already names them', () => {
    const c = makeCustomer(undefined, SALES);
    disable(c);
    assert.equal(
      customerChangeError(as(SALES), c, c, SALES), null,
      'the customer has not changed, so there is nothing to refuse'
    );
  });

  test('even for a document somebody else raised', () => {
    const c = makeCustomer(undefined, OTHER);
    disable(c);
    assert.equal(customerChangeError(as(SALES), c, c, OTHER), null);
  });

  test('but moving a document onto one is refused, in that customer\'s words', () => {
    const live = makeCustomer(undefined, SALES);
    const dead = makeCustomer('Shuttered Traders', SALES);
    disable(dead);
    assert.equal(customerChangeError(as(SALES), live, live, SALES), null, 'unchanged');
    const bad = customerChangeError(as(SALES), live, dead, SALES);
    assert.match(bad!, /Shuttered Traders/);
    assert.match(bad!, /disabled/);
  });

  test('moving a document away from a disabled customer is allowed', () => {
    const dead = makeCustomer(undefined, SALES);
    const live = makeCustomer(undefined, SALES);
    disable(dead);
    assert.equal(
      customerChangeError(as(SALES), dead, live, SALES), null,
      'the customer being left is nobody\'s business; the one arriving is in use'
    );
  });
});

describe('the column itself', () => {
  test('a customer is in use the moment they are created', () => {
    const c = makeCustomer(undefined, SALES);
    const row = db.prepare('SELECT active FROM customers WHERE id = ?').get(c) as { active: number };
    assert.equal(row.active, 1, 'nobody has to enable a customer they have just added');
  });

  test('and a product is in the catalogue the moment it is added', () => {
    const info = db.prepare(
      "INSERT INTO products (name, unit, unit_price) VALUES ('Disable — fixture', 'unit', 1)"
    ).run();
    const row = db.prepare('SELECT active FROM products WHERE id = ?').get(Number(info.lastInsertRowid)) as
      { active: number };
    assert.equal(row.active, 1);
  });
});
