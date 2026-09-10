import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import {
  batchesOnDespatch, setDespatchBatches, despatchBatchError, batchesForOrder, tripsForBatches,
} from '../src/services/batch.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * Which lot went on which lorry — the last leg of the traceability chain.
 *
 * Two things are being protected here. **The link stores one fact and derives
 * the rest**: it names a batch and a trip, and which order line, product and
 * job that implicates is read back through the batch's own work order, so
 * these assert that moving the job moves the answer. And **a named lot is held
 * to the Hard Stop exactly** — the line-level gate can only ask whether *some*
 * lot of a line is certified, and naming one is what makes the precise
 * question askable, so most of these are about what it refuses.
 */

let seq = 0;

interface Fixture { orderId: number; woId: number; productId: number }

/** An order with one goods line and a released job against it. */
function order(line = 0): Fixture {
  const productId = Number((db.prepare(
    "INSERT INTO products (name, unit, unit_price) VALUES (?, 'per 1000', 10) RETURNING id"
  ).get(`Cap ${++seq}`) as { id: number }).id);
  const orderId = Number((db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status)
     VALUES (?, '2026-09-01', ?, 1, 'INR', 'igst', 'confirmed') RETURNING id`
  ).get(`SO/D-${seq}`, makeCustomer()) as { id: number }).id);
  db.prepare(
    `INSERT INTO order_items (order_id, product_id, description, qty, unit, unit_price, amount, total_pcs, sort_order)
     VALUES (?, ?, 'Cap', 100, 'per 1000', 10, 1000, 100000, 0)`
  ).run(orderId, productId);
  const woId = Number((db.prepare(
    `INSERT INTO work_orders (number, order_id, order_line, product_id, qty_planned, status)
     VALUES (?, ?, ?, ?, 100000, 'released') RETURNING id`
  ).get(`WO/D-${seq}`, orderId, line, productId) as { id: number }).id);
  return { orderId, woId, productId };
}

/** A lot, certified unless told otherwise. */
function batch(woId: number, coa: string | null = 'COA/1'): number {
  const id = Number((db.prepare(
    "INSERT INTO batches (number, work_order_id, date) VALUES (?, ?, '2026-09-02') RETURNING id"
  ).get(`B/${++seq}`, woId) as { id: number }).id);
  if (coa) {
    db.prepare("UPDATE batches SET coa_no = ?, coa_date = '2026-09-03' WHERE id = ?")
      .run(`${coa}/${seq}`, id);
  }
  return id;
}

const trip = (orderId: number, challan = '') => Number((db.prepare(
  `INSERT INTO despatches (order_id, date, destination, challan_no, cn_no)
   VALUES (?, '2026-09-04', 'Hazipur', ?, 'CN-9') RETURNING id`
).get(orderId, challan) as { id: number }).id);

const numberOf = (id: number) =>
  String((db.prepare('SELECT number FROM batches WHERE id = ?').get(id) as { number: string }).number);

describe('what may be named on a trip', () => {
  test('naming no lots at all is always fine', () => {
    const { orderId } = order();
    assert.equal(despatchBatchError(orderId, []), null);
    // Which is what protects every dispatch already on file: batching is
    // something a floor starts doing, not something imposed backwards.
    assert.equal(despatchBatchError(orderId, undefined as unknown as unknown[]), null);
  });

  test('a certified lot made on this order is fine', () => {
    const { orderId, woId } = order();
    assert.equal(despatchBatchError(orderId, [batch(woId)]), null);
  });

  /** The specification's Hard Stop, asked of the exact lot rather than the line. */
  test('a lot with no certificate is refused', () => {
    const { orderId, woId } = order();
    const b = batch(woId, null);
    assert.match(String(despatchBatchError(orderId, [b])), /has no Certificate of Analysis/);
  });

  /**
   * The line-level gate would have passed this: the line *does* have a cleared
   * lot. Naming the uncertified one is what makes the difference, and is the
   * whole reason the link is worth storing.
   */
  test('even when another lot of the same line is certified', () => {
    const { orderId, woId } = order();
    batch(woId);                       // certified, and not the one loaded
    const uncleared = batch(woId, null);
    assert.match(String(despatchBatchError(orderId, [uncleared])), /has no Certificate/);
  });

  test('a lot made against another order is refused', () => {
    const mine = order();
    const theirs = order();
    const b = batch(theirs.woId);
    assert.match(
      String(despatchBatchError(mine.orderId, [b])),
      new RegExp(`Batch ${numberOf(b)} was made against another order`)
    );
  });

  test('and a lot that is not on file at all', () => {
    const { orderId } = order();
    assert.match(String(despatchBatchError(orderId, [999999])), /not on file/);
  });

  /** A malformed id resolves to the same refusal rather than throwing. */
  test('as does a malformed one', () => {
    const { orderId } = order();
    assert.match(String(despatchBatchError(orderId, ['nonsense'])), /not on file/);
  });

  test('one bad lot refuses the whole trip, however many good ones ride with it', () => {
    const { orderId, woId } = order();
    const ok = batch(woId);
    const bad = batch(woId, null);
    assert.equal(despatchBatchError(orderId, [ok]), null);
    assert.match(String(despatchBatchError(orderId, [ok, bad])), /has no Certificate/);
  });
});

describe('what the link stores, and what it derives', () => {
  test('a trip carries the lots it was given, and rewriting replaces them whole', () => {
    const { orderId, woId } = order();
    const [a, b, c] = [batch(woId), batch(woId), batch(woId)];
    const d = trip(orderId);
    setDespatchBatches(d, [a, b]);
    assert.deepEqual(batchesOnDespatch(d).map((x) => x.id), [a, b]);
    setDespatchBatches(d, [c]);
    assert.deepEqual(batchesOnDespatch(d).map((x) => x.id), [c], 'the old lots survived a rewrite');
    setDespatchBatches(d, []);
    assert.equal(batchesOnDespatch(d).length, 0);
  });

  test('naming one lot twice says nothing more than naming it once', () => {
    const { orderId, woId } = order();
    const b = batch(woId);
    const d = trip(orderId);
    setDespatchBatches(d, [b, b, b]);
    assert.equal(batchesOnDespatch(d).length, 1);
  });

  /**
   * The point of storing only the link: which line a lot filled is a fact
   * about the lot's own job, so moving the job moves the answer and there is
   * no second copy to go stale.
   */
  test('the order line is read back through the job, never stored on the link', () => {
    const { orderId, woId } = order(0);
    const b = batch(woId);
    const d = trip(orderId);
    setDespatchBatches(d, [b]);
    assert.equal(batchesOnDespatch(d)[0].order_line, 0);
    db.prepare('UPDATE work_orders SET order_line = 3 WHERE id = ?').run(woId);
    assert.equal(batchesOnDespatch(d)[0].order_line, 3, 'the link kept a stale line of its own');
  });

  test('and so is the certificate, so issuing one afterwards shows on the trip', () => {
    const { orderId, woId } = order();
    const b = batch(woId, null);
    const d = trip(orderId);
    setDespatchBatches(d, [b]);          // written directly; the route would refuse it
    assert.equal(batchesOnDespatch(d)[0].coa_no, '');
    db.prepare("UPDATE batches SET coa_no = 'COA/26-27/007' WHERE id = ?").run(b);
    assert.equal(batchesOnDespatch(d)[0].coa_no, 'COA/26-27/007');
  });
});

describe('where a lot went', () => {
  test('every trip it travelled on, newest last', () => {
    const { orderId, woId } = order();
    const b = batch(woId);
    const first = trip(orderId, 'DC/26-27/001');
    const second = trip(orderId, 'DC/26-27/002');
    setDespatchBatches(first, [b]);
    setDespatchBatches(second, [b]);
    const went = tripsForBatches([b]).get(b)!;
    assert.equal(went.length, 2, 'a lot split over two trips reported one');
    assert.deepEqual(went.map((t) => t.reference), ['DC/26-27/001', 'DC/26-27/002']);
    assert.equal(went[0].destination, 'Hazipur');
  });

  /** A trip recorded before challans existed has only its consignment note. */
  test('and is identified by its challan, or by its CN where it has none', () => {
    const { orderId, woId } = order();
    const b = batch(woId);
    const d = trip(orderId);             // no challan number
    setDespatchBatches(d, [b]);
    assert.equal(tripsForBatches([b]).get(b)![0].reference, 'CN-9');
  });

  test('a lot nobody has shipped reports nothing, which is not the same as not shipped', () => {
    const { woId } = order();
    assert.equal(tripsForBatches([batch(woId)]).size, 0);
    assert.equal(tripsForBatches([]).size, 0);
  });
});

describe('the picker on the dispatch form', () => {
  test('offers every lot on the order and says which may actually go', () => {
    const { orderId, woId } = order();
    const cleared = batch(woId);
    const bare = batch(woId, null);
    const lots = batchesForOrder(orderId);
    assert.deepEqual(lots.map((l) => l.id).sort(), [cleared, bare].sort());
    // Shown rather than filtered away: a picker that omits the batch somebody
    // is looking for reads as a fault, where one that shows it and says why
    // says what to do about it.
    assert.equal(lots.find((l) => l.id === bare)!.cleared, false);
    assert.equal(lots.find((l) => l.id === cleared)!.cleared, true);
  });

  test('but not a cancelled job’s, and not another order’s', () => {
    const mine = order();
    const theirs = order();
    const keep = batch(mine.woId);
    batch(theirs.woId);
    const cancelled = Number((db.prepare(
      `INSERT INTO work_orders (number, order_id, order_line, qty_planned, status)
       VALUES (?, ?, 0, 100, 'cancelled') RETURNING id`
    ).get(`WO/X-${++seq}`, mine.orderId) as { id: number }).id);
    batch(cancelled);
    assert.deepEqual(batchesForOrder(mine.orderId).map((l) => l.id), [keep]);
  });
});
