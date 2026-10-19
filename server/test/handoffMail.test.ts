import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { peopleWhoCan, narrowToSpoc } from '../src/services/recipients.js';
import { setUserAccess } from '../src/services/accessPolicy.js';
import { makeCustomer, makeUser } from './helpers/factory.js';

/**
 * Who is told that it is their turn.
 *
 * The client wrote the chain out (2026-10-19): quote and PI to the manager,
 * the sales order to the factory, the production log back to sales, the
 * release on to logistics, and QC before the goods go. What is worth pinning
 * is the **policy** rather than the transport or the wording — getting a
 * recipient wrong is either a leak (telling a salesperson about a document
 * they cannot open) or a silence (telling nobody that it is their turn), and
 * both are invisible from outside.
 *
 * Most of these assert who must **not** be told.
 */

const idsOf = (people: { id: number }[]) => new Set(people.map((p) => p.id));
const deskName = (id: number, name: string) =>
  db.prepare('UPDATE users SET desk_name = ? WHERE id = ?').run(name, id);

describe('each step is addressed by the cell its own button is behind', () => {
  test('a booked order reaches the floor, not the desk that booked it', () => {
    const c = makeCustomer();
    const admin = makeUser('super_admin');
    const floor = makeUser('production');
    const sales = makeUser('sales');
    const lorry = makeUser('logistics');
    const told = idsOf(peopleWhoCan('work_order', 'full', c));
    assert.ok(told.has(floor), 'production plans the jobs');
    assert.ok(told.has(admin));
    // Sales holds `work_order: view` and cannot plan a job, so telling them to
    // would be an instruction the app refuses.
    assert.ok(!told.has(sales), 'sales cannot plan a job');
    assert.ok(!told.has(lorry));
  });

  test('made output reaches the desk that releases it, not the floor', () => {
    const c = makeCustomer();
    const sales = makeUser('sales');
    const floor = makeUser('production');
    const quality = makeUser('quality');
    // Sales is the one team scoped by customer, so the order has to be in
    // their book before they can be told about it — see the scoping case
    // below, which is the other half of this rule.
    db.prepare('UPDATE customers SET owner_id = ? WHERE id = ?').run(sales, c);
    const told = idsOf(peopleWhoCan('order', 'full', c));
    assert.ok(told.has(sales));
    // Both read the order book at `view`; neither may release.
    assert.ok(!told.has(floor));
    assert.ok(!told.has(quality));
  });

  test('a release reaches logistics, not production', () => {
    const c = makeCustomer();
    const lorry = makeUser('logistics');
    const floor = makeUser('production');
    const told = idsOf(peopleWhoCan('dispatch', 'full', c));
    assert.ok(told.has(lorry));
    assert.ok(!told.has(floor), 'production holds dispatch: none');
  });

  test('a held line reaches quality, and quality alone of the four teams', () => {
    const c = makeCustomer();
    const quality = makeUser('quality');
    const lorry = makeUser('logistics');
    const floor = makeUser('production');
    const sales = makeUser('sales');
    const told = idsOf(peopleWhoCan('qc', 'full', c));
    assert.ok(told.has(quality));
    // The other three hold `qc: view` — they read a certificate, they do not
    // issue one, so the pre-dispatch check is not theirs to record.
    for (const other of [lorry, floor, sales]) assert.ok(!told.has(other));
  });

  test('and the invoice the release asks for is addressed to somebody who may raise one', () => {
    /*
     * The client chose Logistics as the desk told to raise the commercial
     * invoice and packing list, which is why `logistics.invoice` moved
     * `view → full` in the same change. This is the case that would have
     * caught shipping the email without the permission: an instruction the
     * app refuses is worse than no instruction.
     */
    const c = makeCustomer();
    const lorry = makeUser('logistics');
    assert.ok(idsOf(peopleWhoCan('invoice', 'full', c)).has(lorry));
  });
});

describe('who is left out, and why', () => {
  test('the person whose own action triggered it', () => {
    const c = makeCustomer();
    const floor = makeUser('production');
    assert.ok(!idsOf(peopleWhoCan('work_order', 'full', c, floor)).has(floor));
  });

  test('a deactivated account', () => {
    const c = makeCustomer();
    const gone = makeUser('production');
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(gone);
    assert.ok(!idsOf(peopleWhoCan('work_order', 'full', c)).has(gone));
  });

  test('an account with no email address, which otherwise looks like silence', () => {
    const c = makeCustomer();
    const quiet = makeUser('production');
    db.prepare("UPDATE users SET email = '' WHERE id = ?").run(quiet);
    assert.ok(!idsOf(peopleWhoCan('work_order', 'full', c)).has(quiet));
  });

  test('somebody whose own ticks have taken the cell away', () => {
    /* Read through the **effective** table, so the User Permissions page
       moves the email as well as the button. */
    const c = makeCustomer();
    const floor = makeUser('production');
    assert.ok(idsOf(peopleWhoCan('work_order', 'full', c)).has(floor));
    setUserAccess(floor, 'production', { work_order: 'view' });
    assert.ok(!idsOf(peopleWhoCan('work_order', 'full', c)).has(floor));
  });

  test('and somebody whose own ticks have just given it to them', () => {
    const c = makeCustomer();
    const quality = makeUser('quality');
    assert.ok(!idsOf(peopleWhoCan('dispatch', 'full', c)).has(quality));
    setUserAccess(quality, 'quality', { dispatch: 'full' });
    assert.ok(idsOf(peopleWhoCan('dispatch', 'full', c)).has(quality));
  });

  test('a salesperson is not told about a customer that is not theirs', () => {
    /* The order book is scoped, so this is a leak rather than a gap: the
       subject line carries the order number and the customer. */
    const mine = makeCustomer();
    const theirs = makeCustomer();
    const sales = makeUser('sales');
    db.prepare('UPDATE customers SET owner_id = ? WHERE id = ?').run(sales, mine);
    assert.ok(idsOf(peopleWhoCan('order', 'full', mine)).has(sales));
    assert.ok(!idsOf(peopleWhoCan('order', 'full', theirs)).has(sales));
  });

  test('while the factory teams are unscoped and hear about every order', () => {
    const theirs = makeCustomer();
    const floor = makeUser('production');
    assert.ok(idsOf(peopleWhoCan('work_order', 'full', theirs)).has(floor));
  });
});

describe("the order's own SPOC, where an account answers to that name", () => {
  const people = (rows: [number, string][]) =>
    rows.map(([id, desk_name]) => ({ id, name: `u${id}`, email: `u${id}@test.local`, desk_name }));

  test('only the person whose desk name matches', () => {
    const got = narrowToSpoc(people([[1, 'Meisha'], [2, 'Sanjib'], [3, '']]), 'Sanjib');
    assert.deepEqual(got.map((p) => p.id), [2]);
  });

  test('matched whatever the case, and padding', () => {
    const got = narrowToSpoc(people([[1, 'Meisha'], [2, '  sanjib ']]), ' SANJIB ');
    assert.deepEqual(got.map((p) => p.id), [2]);
  });

  test('an order naming no SPOC goes to everyone who could act', () => {
    /* Every imported backlog order, so narrowing on a blank would strand
       exactly the orders the desk has most of. */
    const all = people([[1, 'Meisha'], [2, 'Sanjib']]);
    assert.equal(narrowToSpoc(all, '').length, 2);
    assert.equal(narrowToSpoc(all, null).length, 2);
  });

  test('and a SPOC nobody answers to goes to everyone rather than nobody', () => {
    /* `users.desk_name` is blank on every account until the Team page is
       filled in, so this is the state on the day it ships: the rule tightens
       itself one person at a time instead of silencing the queue. */
    const all = people([[1, ''], [2, '']]);
    assert.equal(narrowToSpoc(all, 'Rumela').length, 2);
  });
});
