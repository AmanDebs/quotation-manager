import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { computeTotals } from '../src/services/totals.js';
import { receivedByLine } from '../src/services/stock.js';

/**
 * The purchase order's two rules that are expensive to rediscover: what TCS
 * does to a total, and which line a delivery belongs to.
 */

describe('tax collected at source', () => {
  const line = { description: 'HDPE', qty: 1000, unit: 'kg', unit_price: 85, tax_pct: 18 };

  /**
   * The claim the whole design rests on. TCS was added to a function every
   * document in the app saves through, and the server recomputes on every
   * save — so if the default moved anything, the next edit of any document
   * already raised would silently restate its amounts.
   */
  test('at nothing, every figure is what it was before TCS existed', () => {
    for (const taxType of ['none', 'cgst_sgst', 'igst'] as const) {
      for (const currency of ['INR', 'USD', 'EUR']) {
        for (const freight of [0, 1800]) {
          const withOut = computeTotals([line], taxType, freight, 0, currency);
          const withZero = computeTotals([line], taxType, freight, 0, currency, 0);
          assert.deepEqual(withZero, withOut, `${taxType}/${currency}/${freight}`);
          assert.equal(withOut.tcs_amount, 0);
        }
      }
    }
  });

  /**
   * Charged on the taxable value *and* the tax on it, which is what Aglo's own
   * purchase order adds up to — not on the goods alone.
   */
  test('is a percentage of the value plus its tax', () => {
    const t = computeTotals([line], 'igst', 0, 0, 'USD', 0.1);
    assert.equal(t.subtotal, 85000);
    assert.equal(t.tax_total, 15300);
    assert.equal(t.tcs_amount, 100.3); // 0.1% of 100,300
    assert.equal(t.grand_total, 100400.3);
  });

  test('rides through the rupee rounding rather than round it twice', () => {
    const t = computeTotals([line], 'igst', 0, 0, 'INR', 0.1);
    assert.equal(t.tcs_amount, 100.3);
    // The whole is rounded once, at the end, as INR always is here.
    assert.equal(t.grand_total, 100400);
  });

  test('a rate of nothing prints nothing rather than a zero row', () => {
    assert.equal(computeTotals([line], 'igst', 0, 0, 'INR').tcs_amount, 0);
  });
});

describe('which line a delivery was against', () => {
  const makePo = () => {
    const s = db.prepare("INSERT INTO suppliers (name) VALUES ('Alternicq')").run();
    const po = db.prepare(
      `INSERT INTO purchase_orders (number, supplier_id, date) VALUES (?, ?, '2026-09-04')`
    ).run(`PO/TEST/${Date.now()}${Math.random()}`, Number(s.lastInsertRowid));
    return Number(po.lastInsertRowid);
  };
  const receive = (poId: number, line: number, qty: number) =>
    db.prepare(
      "INSERT INTO po_receipts (po_id, po_line, date, qty) VALUES (?, ?, '2026-09-05', ?)"
    ).run(poId, line, qty);

  /**
   * The bug this table exists to remove. Received used to be a sum over the
   * stock ledger grouped by material, so two lines of one material each
   * reported the *other's* delivery as well as their own.
   */
  test('two lines of the same material keep their own quantities', () => {
    const po = makePo();
    receive(po, 0, 400);
    receive(po, 2, 600);

    const got = receivedByLine(po);
    assert.equal(got.get(0), 400);
    assert.equal(got.get(2), 600);
    // The line between them had no delivery, and says so.
    assert.equal(got.get(1), undefined);
  });

  test('part deliveries against one line add up', () => {
    const po = makePo();
    receive(po, 0, 400);
    receive(po, 0, 600);
    assert.equal(receivedByLine(po).get(0), 1000);
  });

  /**
   * A line naming a product writes no stock movement — there is no
   * finished-goods ledger — so under the old rule it could never show progress
   * and an order carrying one could never close.
   */
  test('a line with no material still records what arrived', () => {
    const po = makePo();
    receive(po, 1, 500);
    assert.equal(receivedByLine(po).get(1), 500);
  });

  test('one order does not see another order’s deliveries', () => {
    const a = makePo();
    const b = makePo();
    receive(a, 0, 400);
    assert.equal(receivedByLine(b).size, 0);
  });
});
