import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { syncOrderStatus } from '../src/services/orderStatus.js';
import { makeCustomer, makeInvoice } from './helpers/factory.js';

/**
 * Where an order sits, and who decided it.
 *
 * The rule is one sentence — a person's status is a floor, the facts own
 * everything above it — and almost every test here is about the second half of
 * that being able to go *down*. The ladder used to be forward-only, which was
 * right about the world (a lorry cannot un-leave) and wrong about the record: a
 * despatch, a job and a shift can all be deleted, and that is how a mis-keyed
 * one is corrected. Forward-only left the status claiming a fact the register
 * no longer held.
 */

let seq = 0;

function order(status = 'pending'): number {
  const id = (db.prepare(
    `INSERT INTO orders (number, date, customer_id, currency, tax_type, status)
     VALUES (?, '2026-09-01', ?, 'INR', 'igst', ?) RETURNING id`
  ).get(`SO/OS-${++seq}`, makeCustomer(), status) as { id: number }).id;
  db.prepare(
    `INSERT INTO order_items (order_id, description, qty, unit, unit_price, amount, total_pcs, sort_order)
     VALUES (?, '28mm Cap', 100, 'per 1000', 10, 1000, 100000, 0)`
  ).run(id);
  return id;
}

const statusOf = (id: number) =>
  (db.prepare('SELECT status FROM orders WHERE id = ?').get(id) as { status: string }).status;
const memoryOf = (id: number) =>
  (db.prepare('SELECT status_before_auto FROM orders WHERE id = ?').get(id) as { status_before_auto: string })
    .status_before_auto;

/** What a person choosing a status does, per `POST /orders/:id/status`. */
const setByHand = (id: number, status: string) =>
  db.prepare("UPDATE orders SET status = ?, status_before_auto = '' WHERE id = ?").run(status, id);

/** A job released to the floor — which is one of the two things that schedules it. */
const job = (orderId: number) => (db.prepare(
  `INSERT INTO work_orders (number, order_id, order_line, qty_planned, status)
   VALUES (?, ?, 0, 100000, 'released') RETURNING id`
).get(`WO/OS-${++seq}`, orderId) as { id: number }).id;

/** A job merely **raised**: sitting at `planned`, with no date and no slot. */
const rawJob = (orderId: number) => (db.prepare(
  `INSERT INTO work_orders (number, order_id, order_line, qty_planned, status)
   VALUES (?, ?, 0, 100000, 'planned') RETURNING id`
).get(`WO/OS-${++seq}`, orderId) as { id: number }).id;

const shift = (jobId: number, ok = 5000) => (db.prepare(
  `INSERT INTO production_entries (work_order_id, date, qty_ok, qty_reject)
   VALUES (?, '2026-09-03', ?, 0) RETURNING id`
).get(jobId, ok) as { id: number }).id;

const despatch = (orderId: number) => (db.prepare(
  `INSERT INTO despatches (order_id, date) VALUES (?, '2026-09-04') RETURNING id`
).get(orderId) as { id: number }).id;

/**
 * The two rungs between Pending and In production, which the ladder used to
 * collapse into one.
 *
 * `confirmed` reads **Work Order** on screen because the client's word is that
 * the step means the job has been raised — and until 2026-09-10 the ladder
 * disagreed with its own label, jumping a raised job straight to `scheduled`.
 * It was the only one of the seven rungs nothing could reach.
 */
describe('raising a job and scheduling it are different steps', () => {
  /**
   * `confirmed` — *Work Order* — is retired (2026-09-11): every order raises
   * its own jobs on booking, so a job merely raised is what every order has
   * on its first day and the rung said nothing. Pending now means booked with
   * nothing released.
   */
  test('a job merely raised leaves the order Pending', () => {
    const o = order();
    rawJob(o);
    assert.equal(syncOrderStatus(o), 'pending');
  });

  test('a start date on it schedules the order', () => {
    const o = order();
    const j = rawJob(o);
    assert.equal(syncOrderStatus(o), 'pending');
    db.prepare("UPDATE work_orders SET planned_start = '2026-09-20' WHERE id = ?").run(j);
    assert.equal(syncOrderStatus(o), 'scheduled');
  });

  test('and so does releasing it, which is the other way a desk says so', () => {
    const o = order();
    const j = rawJob(o);
    db.prepare("UPDATE work_orders SET status = 'released' WHERE id = ?").run(j);
    assert.equal(syncOrderStatus(o), 'scheduled');
  });

  /** The ladder moves both ways, so withdrawing the commitment withdraws the rung. */
  test('putting it back to planned puts the order back to Pending', () => {
    const o = order();
    const j = job(o);
    assert.equal(syncOrderStatus(o), 'scheduled');
    db.prepare("UPDATE work_orders SET status = 'planned' WHERE id = ?").run(j);
    assert.equal(syncOrderStatus(o), 'pending');
  });

  test('a cancelled job schedules nothing', () => {
    const o = order();
    const j = rawJob(o);
    db.prepare("UPDATE work_orders SET status = 'cancelled', planned_start = '2026-09-20' WHERE id = ?").run(j);
    assert.equal(syncOrderStatus(o), 'pending');
  });
});

describe('the facts push the order up the ladder', () => {
  test('a job, a shift and a lorry each move it on', () => {
    const o = order();
    const j = job(o);
    syncOrderStatus(o);
    assert.equal(statusOf(o), 'scheduled', 'a released job should schedule the order');

    shift(j);
    syncOrderStatus(o);
    assert.equal(statusOf(o), 'in_production');

    despatch(o);
    syncOrderStatus(o);
    assert.equal(statusOf(o), 'partially_dispatched');
  });

  test('and syncing again changes nothing', () => {
    const o = order();
    job(o);
    syncOrderStatus(o);
    const before = memoryOf(o);
    assert.equal(syncOrderStatus(o), 'scheduled');
    assert.equal(memoryOf(o), before, 'a second sync rewrote the memory');
  });

  /** Unchanged, and deliberately so: a status below the facts is an omission. */
  test('a status set below what the facts say is advanced again', () => {
    const o = order();
    despatch(o);
    syncOrderStatus(o);
    setByHand(o, 'pending');
    syncOrderStatus(o);
    assert.equal(statusOf(o), 'partially_dispatched');
  });
});

describe('withdrawing the record takes the order back down', () => {
  /**
   * The bug this rewrite exists for. Deleting the only despatch used to leave
   * the order reading *Partially dispatched* over an empty register.
   */
  test('deleting the only despatch un-dispatches the order', () => {
    const o = order();
    const d = despatch(o);
    syncOrderStatus(o);
    assert.equal(statusOf(o), 'partially_dispatched');

    db.prepare('DELETE FROM despatches WHERE id = ?').run(d);
    syncOrderStatus(o);
    assert.equal(statusOf(o), 'pending', 'the status kept a trip that is no longer recorded');
    assert.equal(memoryOf(o), '', 'back at the floor, nothing should be remembered');
  });

  test('deleting the only job un-schedules it', () => {
    const o = order();
    const j = job(o);
    syncOrderStatus(o);
    assert.equal(statusOf(o), 'scheduled');
    db.prepare('DELETE FROM work_orders WHERE id = ?').run(j);
    syncOrderStatus(o);
    assert.equal(statusOf(o), 'pending');
  });

  test('deleting a mis-keyed shift falls back to the job that remains', () => {
    const o = order();
    const j = job(o);
    const s = shift(j);
    syncOrderStatus(o);
    assert.equal(statusOf(o), 'in_production');
    db.prepare('DELETE FROM production_entries WHERE id = ?').run(s);
    syncOrderStatus(o);
    assert.equal(statusOf(o), 'scheduled', 'the job is still there, so it is still scheduled');
  });
});

describe('what a person chose is a floor', () => {
  test('an early status is not dragged down by the absence of facts', () => {
    const o = order();
    setByHand(o, 'ready');
    syncOrderStatus(o);
    assert.equal(statusOf(o), 'ready', 'the facts pulled a deliberate status backwards');
    assert.equal(memoryOf(o), '', 'nothing was raised, so nothing should be remembered');
  });

  /**
   * The half a per-rung memory could not do: the order goes up past the floor
   * and comes back to it, rather than to what the facts alone would say.
   */
  test('and it still holds after the facts raise the order and are withdrawn', () => {
    const o = order();
    setByHand(o, 'ready');
    const d = despatch(o);
    syncOrderStatus(o);
    assert.equal(statusOf(o), 'partially_dispatched');
    assert.equal(memoryOf(o), 'ready', 'the floor was not remembered');

    db.prepare('DELETE FROM despatches WHERE id = ?').run(d);
    syncOrderStatus(o);
    assert.equal(statusOf(o), 'ready', 'it fell past the floor to what the facts alone say');
    assert.equal(memoryOf(o), '');
  });
});

describe('closing an order', () => {
  /** Every goods line billed in full — the invoice walk, not the despatch record. */
  const billInFull = (orderId: number, customerId: number) => {
    const inv = makeInvoice({ customerId, currency: 'INR', total: 1000 });
    db.prepare('UPDATE commercial_invoices SET order_id = ? WHERE id = ?').run(orderId, inv);
    db.prepare(
      `INSERT INTO invoice_items (invoice_id, description, qty, unit, unit_price, amount, sort_order)
       VALUES (?, '28mm Cap', 100, 'per 1000', 10, 1000, 0)`
    ).run(inv);
    return inv;
  };
  const customerOf = (orderId: number) =>
    (db.prepare('SELECT customer_id FROM orders WHERE id = ?').get(orderId) as { customer_id: number }).customer_id;

  test('the invoices close it, and deleting one re-opens it', () => {
    const o = order();
    const inv = billInFull(o, customerOf(o));
    syncOrderStatus(o);
    assert.equal(statusOf(o), 'completed');

    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(inv);
    db.prepare('DELETE FROM commercial_invoices WHERE id = ?').run(inv);
    syncOrderStatus(o);
    assert.equal(statusOf(o), 'pending', 'a re-opened order stayed closed');
  });

  /**
   * Goods that came back were not delivered. A **return** credit note takes
   * its quantity off the billed figure by position, so a line returned in
   * full re-opens the order; an **adjustment** credits money alone and must
   * leave the order closed, nothing having moved.
   */
  test('a return re-opens it; an adjustment does not', () => {
    const o = order();
    const inv = billInFull(o, customerOf(o));
    syncOrderStatus(o);
    assert.equal(statusOf(o), 'completed');

    const note = (kind: string, qty: number) => {
      const id = (db.prepare(
        `INSERT INTO credit_notes (number, date, invoice_id, customer_id, company_id, kind, currency, grand_total, approval_status)
         VALUES (?, '2026-09-10', ?, ?, 1, ?, 'INR', 100, 'approved') RETURNING id`
      ).get(`CN/OS-${++seq}`, inv, customerOf(o), kind) as { id: number }).id;
      db.prepare("INSERT INTO credit_note_items (credit_note_id, description, qty, unit, sort_order) VALUES (?, '28mm Cap', ?, 'per 1000', 0)").run(id, qty);
      return id;
    };
    note('adjustment', 100);
    syncOrderStatus(o);
    assert.equal(statusOf(o), 'completed', 'an adjustment re-opened the order for goods still with the buyer');

    const back = note('return', 100);
    syncOrderStatus(o);
    // Not `pending`: the invoice still stands, and an order with an invoice
    // on it is part-dispatched by the ladder's own rule. What matters is that
    // it is no longer *Completed* over goods sitting in the yard.
    assert.equal(statusOf(o), 'partially_dispatched', 'a full return left the order reading Completed');

    // Un-approving the note (what an edit does) puts the credit — and the
    // closing — back where they were.
    db.prepare("UPDATE credit_notes SET approval_status = 'not_submitted' WHERE id = ?").run(back);
    syncOrderStatus(o);
    assert.equal(statusOf(o), 'completed');
  });

  /**
   * The commercial decision the original design was right to protect: closing
   * is often taken when a short shipment is accepted, and the invoices will
   * never add up. Setting the status by hand clears the memory, so nothing
   * here can re-open it.
   */
  test('but an order closed by hand stays closed', () => {
    const o = order();
    despatch(o);
    setByHand(o, 'completed');
    syncOrderStatus(o);
    assert.equal(statusOf(o), 'completed', 'a deliberately closed order was re-opened');
  });
});

describe('cancelled is a decision, not an observation', () => {
  test('nothing on the floor moves an order out of it', () => {
    const o = order('cancelled');
    const j = job(o);
    shift(j);
    despatch(o);
    syncOrderStatus(o);
    assert.equal(statusOf(o), 'cancelled');
  });

  test('and nothing moves an order into it', () => {
    const o = order();
    despatch(o);
    syncOrderStatus(o);
    assert.notEqual(statusOf(o), 'cancelled');
  });
});
