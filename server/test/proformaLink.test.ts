import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import {
  proformaLinkError, proformaUnlinkError, orderProforma,
  syncProformaOrdered, syncProformaUnordered,
  type LinkOrderRow, type LinkProformaRow,
} from '../src/services/documentChain.js';
import { makeCustomer, makeOrder, makeProforma, makeInvoice } from './helpers/factory.js';

/**
 * Attaching a proforma to an order that was not booked from it.
 *
 * The link is written by `POST /orders` and nowhere else, so on a real book it
 * exists only where somebody pressed *Book Sales Order* — which is why an
 * order typed straight in names no proforma anywhere in the app.
 *
 * What is worth asserting is almost entirely **what must not happen**: the act
 * is the same one booking performs, it freezes a document, and the way back
 * has to stay open. Most of these cases fail if the guard is loosened by one
 * condition.
 */

const orderRow = (id: number) =>
  db.prepare('SELECT id, number, customer_id FROM orders WHERE id = ?').get(id) as unknown as LinkOrderRow;
const piRow = (id: number) =>
  db.prepare('SELECT id, number, customer_id, order_id FROM proforma_invoices WHERE id = ?')
    .get(id) as unknown as LinkProformaRow;

/** What the route does once the guard has passed. */
const attach = (orderId: number, piId: number) => {
  db.prepare('UPDATE proforma_invoices SET order_id = ? WHERE id = ?').run(orderId, piId);
  syncProformaOrdered(piId);
};
/** And the way back — the order's own delete does these two, in this order. */
const detach = (orderId: number, piId: number) => {
  syncProformaUnordered(orderId);
  db.prepare('UPDATE proforma_invoices SET order_id = NULL WHERE id = ?').run(piId);
};

const statusOf = (piId: number) =>
  (db.prepare('SELECT status FROM proforma_invoices WHERE id = ?').get(piId) as { status: string }).status;

const setStatus = (piId: number, status: string) =>
  db.prepare('UPDATE proforma_invoices SET status = ? WHERE id = ?').run(status, piId);

describe('attaching a proforma to a sales order', () => {
  test('a free proforma of the same customer is allowed, which is the whole point', () => {
    const c = makeCustomer();
    const o = makeOrder({ customerId: c, currency: 'INR' });
    const pi = makeProforma({ customerId: c, currency: 'INR', total: 1000 });
    assert.equal(proformaLinkError(orderRow(o), piRow(pi)), null);
  });

  test('another customer’s proforma is refused by name', () => {
    const o = makeOrder({ customerId: makeCustomer(), currency: 'INR' });
    const pi = makeProforma({ customerId: makeCustomer(), currency: 'INR', total: 1000 });
    const msg = proformaLinkError(orderRow(o), piRow(pi));
    assert.match(String(msg), /different customer/i);
    // The chain runs through one buyer: every figure derived along it — the
    // advance, the invoices the order can reach — is nonsense otherwise.
    assert.match(String(msg), new RegExp(piRow(pi).number.replace(/\//g, '\\/')));
  });

  test('a proforma already booked into another order is refused in booking’s own words', () => {
    const c = makeCustomer();
    const first = makeOrder({ customerId: c, currency: 'INR' });
    const second = makeOrder({ customerId: c, currency: 'INR' });
    const pi = makeProforma({ customerId: c, currency: 'INR', total: 1000, orderId: first });
    const msg = String(proformaLinkError(orderRow(second), piRow(pi)));
    // `alreadyOrderedError` asked rather than restated, so the two doors refuse
    // identically — re-pointing it would orphan the first order's figures.
    assert.match(msg, /has already been booked from this proforma/);
    assert.match(msg, new RegExp(orderRow(first).number.replace(/\//g, '\\/')));
  });

  test('an order that already carries one is refused, naming the one it has', () => {
    const c = makeCustomer();
    const o = makeOrder({ customerId: c, currency: 'INR' });
    const held = makeProforma({ customerId: c, currency: 'INR', total: 1000, orderId: o });
    const other = makeProforma({ customerId: c, currency: 'INR', total: 2000 });
    const msg = String(proformaLinkError(orderRow(o), piRow(other)));
    // Two proformas on one order is what doubles a job row on the Work Orders
    // list and makes *which proforma covers this* unanswerable.
    assert.match(msg, /already attached/i);
    assert.match(msg, new RegExp(piRow(held).number.replace(/\//g, '\\/')));
  });

  test('attaching confirms the proforma and remembers where it was', () => {
    const c = makeCustomer();
    const o = makeOrder({ customerId: c, currency: 'INR' });
    const pi = makeProforma({ customerId: c, currency: 'INR', total: 1000 });
    setStatus(pi, 'advance_received');
    attach(o, pi);
    assert.equal(statusOf(pi), 'in_production');
    assert.equal(orderProforma(o)?.id, pi);
  });

  test('and a cancelled proforma keeps its own status, which is a decision', () => {
    const c = makeCustomer();
    const o = makeOrder({ customerId: c, currency: 'INR' });
    const pi = makeProforma({ customerId: c, currency: 'INR', total: 1000 });
    setStatus(pi, 'cancelled');
    // Not refused — the guard asks the same three questions booking asks, and
    // booking does not read the status either. The picker is what leaves a
    // dead document out, which is the safe direction.
    assert.equal(proformaLinkError(orderRow(o), piRow(pi)), null);
    attach(o, pi);
    assert.equal(statusOf(pi), 'cancelled');
  });
});

describe('and taking it off again', () => {
  test('the proforma goes back to the status attaching found it on', () => {
    const c = makeCustomer();
    const o = makeOrder({ customerId: c, currency: 'INR' });
    const pi = makeProforma({ customerId: c, currency: 'INR', total: 1000 });
    setStatus(pi, 'sent');
    attach(o, pi);
    assert.equal(statusOf(pi), 'in_production');
    assert.equal(proformaUnlinkError(orderRow(o), piRow(pi)), null);
    detach(o, pi);
    assert.equal(statusOf(pi), 'sent');
    assert.equal(orderProforma(o), null);
    assert.equal(piRow(pi).order_id, null);
  });

  test('attach, detach and attach again leaves it exactly where it started', () => {
    const c = makeCustomer();
    const o = makeOrder({ customerId: c, currency: 'INR' });
    const pi = makeProforma({ customerId: c, currency: 'INR', total: 1000 });
    setStatus(pi, 'order_confirmed');
    attach(o, pi); detach(o, pi);
    assert.equal(statusOf(pi), 'order_confirmed');
    attach(o, pi);
    assert.equal(statusOf(pi), 'in_production');
    detach(o, pi);
    assert.equal(statusOf(pi), 'order_confirmed');
  });

  test('a proforma that is not on this order is refused', () => {
    const c = makeCustomer();
    const o = makeOrder({ customerId: c, currency: 'INR' });
    const pi = makeProforma({ customerId: c, currency: 'INR', total: 1000 });
    assert.match(String(proformaUnlinkError(orderRow(o), piRow(pi))), /not attached/i);
  });

  test('an invoice raised from that proforma refuses it, naming the invoice', () => {
    const c = makeCustomer();
    const o = makeOrder({ customerId: c, currency: 'INR' });
    const pi = makeProforma({ customerId: c, currency: 'INR', total: 1000, orderId: o });
    const inv = makeInvoice({ customerId: c, currency: 'INR', total: 1000, piId: pi });
    const msg = String(proformaUnlinkError(orderRow(o), piRow(pi)));
    // That invoice reaches this order *through* the link, the way
    // dispatchProgress() walks — severing it would quietly change what the
    // order reports as billed.
    assert.match(msg, /Delete that invoice first/);
    const n = (db.prepare('SELECT number FROM commercial_invoices WHERE id = ?').get(inv) as { number: string }).number;
    assert.match(msg, new RegExp(n.replace(/\//g, '\\/')));
  });

  test('an invoice raised against the order itself does not refuse it', () => {
    const c = makeCustomer();
    const o = makeOrder({ customerId: c, currency: 'INR' });
    const pi = makeProforma({ customerId: c, currency: 'INR', total: 1000, orderId: o });
    // It names the order directly, so it reaches it with or without this link.
    makeInvoice({ customerId: c, currency: 'INR', total: 1000, orderId: o });
    assert.equal(proformaUnlinkError(orderRow(o), piRow(pi)), null);
  });

  test('and an invoice from a different proforma does not refuse it either', () => {
    const c = makeCustomer();
    const o = makeOrder({ customerId: c, currency: 'INR' });
    const pi = makeProforma({ customerId: c, currency: 'INR', total: 1000, orderId: o });
    const other = makeProforma({ customerId: c, currency: 'INR', total: 500 });
    makeInvoice({ customerId: c, currency: 'INR', total: 500, piId: other });
    assert.equal(proformaUnlinkError(orderRow(o), piRow(pi)), null);
  });
});
