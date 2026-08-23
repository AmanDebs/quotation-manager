import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { valuation } from '../src/services/costing.js';
import { db } from '../src/db/connection.js';
import { onHand } from '../src/services/stock.js';
import { makeMaterial, makeLocation, makeMove } from './helpers/factory.js';

/**
 * Moving average, chosen with Aglo on 2026-08-21 over FIFO. Nothing is stored:
 * the figures come from replaying `material_moves` in `date, id` order, which
 * is what lets a mis-keyed receipt be corrected by deleting it.
 */

const loc = makeLocation();
const value = (m: number) => valuation().get(m);

describe('the average', () => {
  test('one priced receipt is worth what it cost', () => {
    const m = makeMaterial();
    makeMove({ materialId: m, locationId: loc, qty: 1000, rate: 80, date: '2026-08-01' });
    const v = value(m);
    assert.equal(v?.qty, 1000);
    assert.equal(v?.avg_rate, 80);
    assert.equal(v?.value, 80000);
  });

  test('two receipts average by quantity, not by rate', () => {
    const m = makeMaterial();
    makeMove({ materialId: m, locationId: loc, qty: 1000, rate: 80, date: '2026-08-01' });
    makeMove({ materialId: m, locationId: loc, qty: 3000, rate: 100, date: '2026-08-02' });
    // (1000×80 + 3000×100) / 4000 = 95, not the midpoint of 80 and 100.
    assert.equal(value(m)?.avg_rate, 95);
  });

  test('an issue takes the average without moving it', () => {
    const m = makeMaterial();
    makeMove({ materialId: m, locationId: loc, qty: 1000, rate: 80, date: '2026-08-01' });
    makeMove({ materialId: m, locationId: loc, qty: -400, date: '2026-08-03' });
    const v = value(m);
    assert.equal(v?.qty, 600);
    assert.equal(v?.avg_rate, 80, 'consuming stock does not change what the rest cost');
    assert.equal(v?.value, 48000);
  });
});

/**
 * Entering an unpriced receipt at zero was tried and makes unpriced stock look
 * free, dragging every later average down: 500 kg unrated plus 500 kg at 80
 * came out at 40, a claim that half the shed cost nothing.
 */
describe('stock that arrived without a price', () => {
  test('adds quantity but stays out of the average', () => {
    const m = makeMaterial();
    makeMove({ materialId: m, locationId: loc, qty: 500, rate: null, date: '2026-08-01' });
    makeMove({ materialId: m, locationId: loc, qty: 500, rate: 80, date: '2026-08-02' });
    const v = value(m);
    assert.equal(v?.qty, 1000, 'it is in the shed, so it counts');
    assert.equal(v?.avg_rate, 80, 'not 40 — unpriced is unknown, not free');
  });

  test('and says how much is being valued by extrapolation', () => {
    const m = makeMaterial();
    makeMove({ materialId: m, locationId: loc, qty: 500, rate: null, date: '2026-08-01' });
    makeMove({ materialId: m, locationId: loc, qty: 500, rate: 80, date: '2026-08-02' });
    const v = value(m);
    assert.equal(v?.unpriced_qty, 500,
      'the fix is to record a rate on the opening balance, not to read silence as zero');
  });
});

/**
 * A kilo is worth the same at either plant. A per-location average would make
 * a lorry between Jungalpur and PACK SKRL change the company's stock value.
 */
test('valuation is per material and group-wide, while quantity is per location', () => {
  const second = makeLocation();
  const m = makeMaterial();
  makeMove({ materialId: m, locationId: loc, qty: 1000, rate: 80, date: '2026-08-01' });
  makeMove({ materialId: m, locationId: second, qty: 1000, rate: 100, date: '2026-08-02' });

  assert.equal(value(m)?.avg_rate, 90, 'one average across both plants');
  assert.equal(onHand(m, loc), 1000, 'but the quantities stay where the stock is');
  assert.equal(onHand(m, second), 1000);
  assert.equal(onHand(m), 2000);
});

test('a transfer between plants leaves the value alone', () => {
  const second = makeLocation();
  const m = makeMaterial();
  makeMove({ materialId: m, locationId: loc, qty: 1000, rate: 80, date: '2026-08-01' });
  const beforeValue = value(m)?.value;
  makeMove({ materialId: m, locationId: loc, qty: -300, date: '2026-08-02', source: 'transfer' });
  makeMove({ materialId: m, locationId: second, qty: 300, rate: 80, date: '2026-08-02', source: 'transfer' });
  assert.equal(value(m)?.value, beforeValue, 'moving stock is not a change in what it cost');
});

/**
 * The material physically left. Hiding it would make the ledger agree with the
 * paperwork rather than with the store.
 */
test('issuing more than is on hand shows negative rather than clamping', () => {
  const m = makeMaterial();
  makeMove({ materialId: m, locationId: loc, qty: 100, rate: 50, date: '2026-08-01' });
  makeMove({ materialId: m, locationId: loc, qty: -150, date: '2026-08-02' });
  assert.equal(onHand(m, loc), -50);
});

test('deleting a mis-keyed receipt corrects the valuation, because nothing was stored', () => {
  const m = makeMaterial();
  makeMove({ materialId: m, locationId: loc, qty: 1000, rate: 80, date: '2026-08-01' });
  const wrong = makeMove({ materialId: m, locationId: loc, qty: 1000, rate: 800, date: '2026-08-02' });
  assert.equal(value(m)?.avg_rate, 440, 'the fat-fingered rate is in the average');

  db.prepare('DELETE FROM material_moves WHERE id = ?').run(wrong);
  assert.equal(value(m)?.avg_rate, 80, 'and gone again once the row is');
});
