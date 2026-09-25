import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { despatchLimitError, despatchDateError, todayInKolkata,
  advanceBlockError } from '../src/services/despatchLimits.js';
import { preDispatchDue } from '../src/services/receivables.js';
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

/**
 * Nothing leaves until the advance the order asks for has arrived (2026-09-23).
 *
 * Most of these assert what is **not** refused, for the reason the ceiling's
 * own tests give: this one holds a lorry, so a rule that fires wrongly is worse
 * than no rule at all. Everything ambiguous has to fall to "no advance decided".
 */
describe('the advance gate on a dispatch', () => {
  // The fixtures here use the **export** phrasing — *Balance against shipping
  // documents* — because this group is about the advance on its own. The
  // domestic *Balance before Dispatch* raises the figure to the whole order
  // value, which is the group below.

  const orderWith = (terms: string, total: number, over: Record<string, unknown> = {}) => {
    const c = makeCustomer();
    const cols = ['number', 'date', 'customer_id', 'currency', 'tax_type', 'status', 'payment_terms', 'grand_total'];
    const vals: unknown[] = [`SO/${Math.random().toString(36).slice(2, 8)}`, '2026-09-01', c, 'INR', 'igst', 'confirmed', terms, total];
    for (const [k, v] of Object.entries(over)) { cols.push(k); vals.push(v); }
    const r = db.prepare(
      `INSERT INTO orders (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id, customer_id`
    ).get(...(vals as never[])) as { id: number; customer_id: number };
    return r;
  };
  const bank = (o: { id: number; customer_id: number }, amount: number, currency = 'INR') =>
    db.prepare(
      `INSERT INTO payments (customer_id, order_id, amount, currency, date, method)
       VALUES (?, ?, ?, ?, '2026-09-02', 'bank')`
    ).run(o.customer_id, o.id, amount, currency);

  test('terms asking for an advance nobody has banked refuse the trip', () => {
    const o = orderWith('30% Advance and Balance against shipping documents', 59000);
    const err = advanceBlockError(o.id);
    assert.ok(err, 'a trip must be refused');
    assert.match(String(err), /has not been received/);
    assert.match(String(err), /17,700/, 'the sentence names what is due');
    assert.match(String(err), /nothing has been recorded/);
  });

  test('the advance recorded in full opens it', () => {
    const o = orderWith('30% Advance and Balance against shipping documents', 59000);
    bank(o, 17700);
    assert.equal(advanceBlockError(o.id), null);
  });

  test('a part advance is still an advance not received, and the sentence says what is short', () => {
    const o = orderWith('30% Advance and Balance against shipping documents', 59000);
    bank(o, 10000);
    const err = String(advanceBlockError(o.id));
    assert.match(err, /10,000 has been recorded/);
    assert.match(err, /7,700 is still outstanding/);
  });

  test('terms naming no percentage decide no advance, so nothing is held', () => {
    // A credit term, cash against documents, and the export book's own `30-70`
    // — none of these is a commitment this can read, and guessing one would
    // hold a real lorry over a sentence nobody wrote as a figure.
    for (const terms of ['Net 30 days', '100% CAD', '30-70', '', 'Credit - 30 days after ship arrival']) {
      const o = orderWith(terms, 59000);
      assert.equal(advanceBlockError(o.id), null, `"${terms}" should decide nothing`);
    }
  });

  /*
   * The client's list gained *100% Advance* on 2026-09-25, and it is the one
   * term on it that asks for the whole document up front. It carries no "and
   * Balance" clause — there is no balance — so `balanceBeforeDispatch` is
   * false and the figure comes from the percentage alone, which is already
   * everything. Worth a case of its own because the two routes to the whole
   * value (this, and a partial advance whose balance settles before dispatch)
   * must agree about the money and differ about the word.
   */
  test('100% Advance holds the whole order value, on the advance basis', () => {
    const o = orderWith('100% Advance', 59000);
    const err = String(advanceBlockError(o.id));
    assert.match(err, /59,000/, 'the whole total is what is due');
    assert.equal(preDispatchDue(o.id).due, 59000);
    assert.equal(preDispatchDue(o.id).basis, 'advance');
    bank(o, 58999);
    assert.ok(advanceBlockError(o.id), 'a rupee short is still short');
    bank(o, 1);
    assert.equal(advanceBlockError(o.id), null);
  });

  test('an order with no total decides nothing either', () => {
    const o = orderWith('30% Advance and Balance against shipping documents', 0);
    assert.equal(advanceBlockError(o.id), null);
  });

  test('a stored advance_due is the more specific answer and overrides the terms', () => {
    const o = orderWith('30% Advance and Balance against shipping documents', 59000, { advance_due: 5000 });
    bank(o, 5000);
    assert.equal(advanceBlockError(o.id), null, 'the figure somebody agreed, not 30% of the total');
  });

  test('the legacy typed advance_amount counts as received', () => {
    // An order raised before payments could be recorded against one carries its
    // advance in that column and nowhere else; refusing it would hold a lorry
    // for money the record says arrived.
    const o = orderWith('30% Advance and Balance against shipping documents', 59000, { advance_amount: 17700 });
    assert.equal(advanceBlockError(o.id), null);
  });

  test('an advance in another currency is credited to nothing, so it does not open the gate', () => {
    const o = orderWith('30% Advance and Balance against shipping documents', 59000);
    bank(o, 17700, 'EUR');
    assert.ok(advanceBlockError(o.id), 'money the ledger cannot count cannot release a lorry');
  });

  test('a paise of rounding is not an unpaid advance', () => {
    const o = orderWith('33.33% Advance and Balance against shipping documents', 100);
    bank(o, 33.33);
    assert.equal(advanceBlockError(o.id), null);
  });

  test('a full advance term holds until the whole sum is in', () => {
    const o = orderWith('100% Advance', 59000);
    assert.ok(advanceBlockError(o.id));
    bank(o, 59000);
    assert.equal(advanceBlockError(o.id), null);
  });
});

/**
 * And the balance, where the terms settle it before the goods leave
 * (2026-09-23: *"Yes, hold the balance before dispatch too"*).
 *
 * The distinction is the client's own, written into their two term lists: a
 * domestic sale settles the balance **before Dispatch** and an export one
 * **against shipping documents**, which cannot be presented until the
 * container has gone. So one holds the whole order value and the other holds
 * the advance alone, and the tests that matter most are the ones asserting the
 * export side is *not* held.
 */
describe('the balance where the terms settle it before dispatch', () => {
  const orderWith = (terms: string, total: number, over: Record<string, unknown> = {}) => {
    const c = makeCustomer();
    const cols = ['number', 'date', 'customer_id', 'currency', 'tax_type', 'status', 'payment_terms', 'grand_total'];
    const vals: unknown[] = [`SO/${Math.random().toString(36).slice(2, 8)}`, '2026-09-01', c, 'INR', 'igst', 'confirmed', terms, total];
    for (const [k, v] of Object.entries(over)) { cols.push(k); vals.push(v); }
    const r = db.prepare(
      `INSERT INTO orders (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id, customer_id`
    ).get(...(vals as never[])) as { id: number; customer_id: number };
    return r;
  };
  const bank = (o: { id: number; customer_id: number }, amount: number) =>
    db.prepare(
      `INSERT INTO payments (customer_id, order_id, amount, currency, date, method)
       VALUES (?, ?, ?, 'INR', '2026-09-02', 'bank')`
    ).run(o.customer_id, o.id, amount);

  test('the advance alone no longer opens the gate', () => {
    const o = orderWith('30% Advance and Balance before Dispatch', 59000);
    bank(o, 17700);
    const err = String(advanceBlockError(o.id));
    assert.match(err, /has not been paid for/);
    assert.match(err, /whole INR 59,000 is due/);
    assert.match(err, /41,300 is still outstanding/);
  });

  test('and the whole value does', () => {
    const o = orderWith('30% Advance and Balance before Dispatch', 59000);
    bank(o, 59000);
    assert.equal(advanceBlockError(o.id), null);
  });

  test('an export term settled against shipping documents holds the advance only', () => {
    // The bill of lading exists only once the container has gone, so holding
    // the balance for it would hold every export shipment for ever.
    const o = orderWith('30% Advance and Balance against shipping documents', 59000);
    bank(o, 17700);
    assert.equal(advanceBlockError(o.id), null);
  });

  test('the basis says which figure it is', () => {
    assert.equal(preDispatchDue(orderWith('30% Advance and Balance before Dispatch', 59000).id).basis, 'full');
    assert.equal(preDispatchDue(orderWith('30% Advance and Balance against shipping documents', 59000).id).basis, 'advance');
    assert.equal(preDispatchDue(orderWith('30 Days Credit', 59000).id).basis, 'none');
  });

  test('“before dispatch” in terms that name no money still asks for nothing', () => {
    // A sentence this cannot price is not a commitment it may hold a lorry on.
    const o = orderWith('Payment before dispatch', 59000);
    assert.equal(advanceBlockError(o.id), null);
  });

  test('both spellings are read, this app having one on screen and the other in the schema', () => {
    for (const terms of ['30% Advance and Balance before Dispatch', '30% Advance and balance before despatch']) {
      assert.equal(preDispatchDue(orderWith(terms, 59000).id).due, 59000, terms);
    }
  });

  test('a stored advance_due still wins, and the balance still follows it', () => {
    const o = orderWith('30% Advance and Balance before Dispatch', 59000, { advance_due: 5000 });
    const d = preDispatchDue(o.id);
    assert.equal(d.basis, 'full');
    assert.equal(d.due, 59000, 'the balance is the rest of the order whatever the advance was agreed at');
  });
});
