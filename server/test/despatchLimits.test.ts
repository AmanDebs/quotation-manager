import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { despatchLimitError, despatchDateError, todayInKolkata } from '../src/services/despatchLimits.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * The ceiling on a despatch line. Most of these assert what is **not** refused:
 * the rule exists to catch a slipped digit, and a guard that also refuses the
 * ordinary short or slightly-over shipment would be worse than none.
 */

const order = (customerId: number) => {
  const r = db.prepare(
    `INSERT INTO orders (number, date, customer_id, currency, tax_type, status)
     VALUES (?, '2026-09-01', ?, 'INR', 'igst', 'confirmed') RETURNING id`
  ).get(`SO/${Math.random().toString(36).slice(2, 8)}`, customerId) as { id: number };
  return r.id;
};

const line = (orderId: number, description: string, totalPcs: number | null, sort: number, isCharge = 0) =>
  db.prepare(
    `INSERT INTO order_items (order_id, description, qty, unit, unit_price, amount, total_pcs, is_charge, sort_order)
     VALUES (?, ?, NULL, 'per 1000', 1, 0, ?, ?, ?)`
  ).run(orderId, description, totalPcs, isCharge, sort);

/** A trip already in the register, so "already sent" has something to find. */
const despatch = (orderId: number, at: number, qty: number) => {
  const d = db.prepare(
    `INSERT INTO despatches (order_id, date) VALUES (?, '2026-09-02') RETURNING id`
  ).get(orderId) as { id: number };
  db.prepare('INSERT INTO despatch_items (despatch_id, order_line, qty) VALUES (?, ?, ?)')
    .run(d.id, at, qty);
  return d.id;
};

describe('what a despatch line may say went out', () => {
  test('the ordinary case passes: a part shipment of what is left', () => {
    const o = order(makeCustomer());
    line(o, '26/22 Cap', 120000, 0);
    assert.equal(despatchLimitError(o, [{ order_line: 0, qty: 40000 }]), null);
  });

  test('exactly what is left passes', () => {
    const o = order(makeCustomer());
    line(o, '26/22 Cap', 120000, 0);
    assert.equal(despatchLimitError(o, [{ order_line: 0, qty: 120000 }]), null);
  });

  test('and so does a 10% over-shipment, which is their standard tolerance', () => {
    const o = order(makeCustomer());
    line(o, '26/22 Cap', 120000, 0);
    assert.equal(despatchLimitError(o, [{ order_line: 0, qty: 132000 }]), null);
  });

  test('a slipped digit is refused, and the message says what the line can take', () => {
    const o = order(makeCustomer());
    line(o, '26/22 Cap', 120000, 0);
    const msg = despatchLimitError(o, [{ order_line: 0, qty: 100_000_000 }]);
    assert.ok(msg, 'expected a refusal');
    assert.ok(msg!.includes('26/22 Cap'), msg!);
    assert.ok(msg!.includes('1,32,000'), msg!);
  });

  test('what has already gone comes off the ceiling', () => {
    const o = order(makeCustomer());
    line(o, '26/22 Cap', 120000, 0);
    despatch(o, 0, 100000);
    // 20,000 left, so 22,000 is the most another trip may carry.
    assert.equal(despatchLimitError(o, [{ order_line: 0, qty: 22000 }]), null);
    const msg = despatchLimitError(o, [{ order_line: 0, qty: 30000 }]);
    assert.ok(msg?.includes('1,00,000 already sent'), msg ?? '(none)');
  });

  test('editing a trip does not count that trip against itself', () => {
    const o = order(makeCustomer());
    line(o, '26/22 Cap', 120000, 0);
    const d = despatch(o, 0, 100000);
    // Re-saving the same trip unchanged: without the exclusion its own 100,000
    // would be "already sent" and it would refuse itself.
    assert.equal(despatchLimitError(o, [{ order_line: 0, qty: 100000 }], d), null);
    // And it is still bounded once excluded.
    assert.ok(despatchLimitError(o, [{ order_line: 0, qty: 500000 }], d));
  });

  test('a negative is refused whatever the line was ordered at', () => {
    const o = order(makeCustomer());
    line(o, '26/22 Cap', 120000, 0);
    assert.ok(despatchLimitError(o, [{ order_line: 0, qty: -5 }]));
    assert.ok(despatchLimitError(o, [{ order_line: 0, packs: -1 }]));
    // Including on a line with nothing to compare against.
    const o2 = order(makeCustomer());
    line(o2, 'Sold by weight', null, 0);
    assert.ok(despatchLimitError(o2, [{ order_line: 0, qty: -1 }]));
  });
});

describe('a line entered by billing quantity, with no packing figures', () => {
  test('is bounded at its quantity converted by its basis', () => {
    const o = order(makeCustomer());
    db.prepare(
      `INSERT INTO order_items (order_id, description, qty, unit, unit_price, amount, total_pcs, is_charge, sort_order)
       VALUES (?, 'Seal cap', 137.5, 'per 1000', 1, 137.5, NULL, 0, 0)`
    ).run(o);
    assert.equal(despatchLimitError(o, [{ order_line: 0, qty: 137_500 }]), null);
    const err = despatchLimitError(o, [{ order_line: 0, qty: 200_000 }]);
    assert.ok(err && err.includes('1,37,500'), err ?? 'no error');
  });
});

describe('what deliberately has no ceiling', () => {
  test('a weight-billed line, which states no piece count', () => {
    const o = order(makeCustomer());
    line(o, 'Sold by weight', null, 0);
    assert.equal(despatchLimitError(o, [{ order_line: 0, qty: 9_000_000 }]), null);
  });

  test('a charge line, which never ships', () => {
    const o = order(makeCustomer());
    line(o, 'Freight', null, 0, 1);
    assert.equal(despatchLimitError(o, [{ order_line: 0, qty: 9_000_000 }]), null);
  });

  test('a line the order does not have', () => {
    const o = order(makeCustomer());
    line(o, '26/22 Cap', 120000, 0);
    assert.equal(despatchLimitError(o, [{ order_line: 7, qty: 9_000_000 }]), null);
  });

  test('boxes are not bounded by the piece count — they are a different unit', () => {
    const o = order(makeCustomer());
    line(o, '26/22 Cap', 120000, 0);
    assert.equal(despatchLimitError(o, [{ order_line: 0, packs: 400 }]), null);
  });

  test('the position counts charge lines, as the rest of the chain does', () => {
    const o = order(makeCustomer());
    // Freight first, so the goods line sits at position 1.
    line(o, 'Freight', null, 0, 1);
    line(o, '26/22 Cap', 120000, 1);
    assert.ok(despatchLimitError(o, [{ order_line: 1, qty: 9_000_000 }]), 'position 1 is the goods line');
    assert.equal(despatchLimitError(o, [{ order_line: 0, qty: 9_000_000 }]), null, 'position 0 is the charge');
  });
});

/**
 * When a trip may say it left (2026-09-17): not before its order, not after
 * today on this desk, and the sea leg in order behind it.
 */
describe('when a despatch may say it left', () => {
  const TODAY = '2026-09-17';
  const o = () => {
    const id = order(makeCustomer());
    db.prepare("UPDATE orders SET date = '2026-09-10' WHERE id = ?").run(id);
    return id;
  };
  test('today, and any day back to the order, is allowed', () => {
    const id = o();
    assert.equal(despatchDateError(id, TODAY, {}, TODAY), null);
    assert.equal(despatchDateError(id, '2026-09-10', {}, TODAY), null, 'the order date itself');
    assert.equal(despatchDateError(id, '2026-09-12', {}, TODAY), null);
  });
  test('before the order is refused, naming the order', () => {
    const msg = despatchDateError(o(), '2026-09-03', {}, TODAY);
    assert.match(String(msg), /before the sales order .* was booked on 2026-09-10/);
  });
  test('after today is refused, and says where a planned sailing goes', () => {
    assert.match(String(despatchDateError(o(), '2026-09-18', {}, TODAY)), /in the future.*ETD/);
  });
  test('the sea leg has to follow the trip: ETD not before it, ETA not before ETD', () => {
    const id = o();
    assert.equal(despatchDateError(id, '2026-09-12', { etd: '2026-09-12', eta: '2026-10-01' }, TODAY), null);
    assert.match(String(despatchDateError(id, '2026-09-12', { etd: '2026-09-11' }, TODAY)), /ETD .* before the dispatch date/);
    assert.match(String(despatchDateError(id, '2026-09-12', { etd: '2026-09-20', eta: '2026-09-19' }, TODAY)), /ETA .* before ETD/);
    assert.match(String(despatchDateError(id, '2026-09-12', { eta: '2026-09-11' }, TODAY)), /ETA .* before the dispatch date/);
    assert.equal(despatchDateError(id, '2026-09-12', { etd: '', eta: '' }, TODAY), null, 'blank sea-leg dates are not judged');
  });
  test('a malformed date is refused before anything else is asked', () => {
    assert.match(String(despatchDateError(o(), '17/09/2026', {}, TODAY)), /YYYY-MM-DD/);
  });
  test("today is Kolkata's day, not Greenwich's", () => {
    // 21:30 UTC on the 17th is 03:00 on the 18th in Kolkata.
    assert.equal(todayInKolkata(new Date('2026-09-17T21:30:00Z')), '2026-09-18');
    assert.equal(todayInKolkata(new Date('2026-09-17T12:00:00Z')), '2026-09-17');
  });
});
