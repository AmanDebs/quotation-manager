import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeTotals, billedQty, round2, piecesOrdered, piecesPerBillingUnit, piecesPerBillingUnitOf, isPieceBasis, PIECES_ORDERED_SQL } from '../src/services/totals.js';
import { db } from '../src/db/connection.js';

/**
 * `computeTotals` is the only place money is worked out, so it is the place
 * where being wrong is most expensive. Every case below is a rule stated in
 * CLAUDE.md that used to be enforced only by prose.
 */

const goods = (over: Partial<Parameters<typeof computeTotals>[0][number]> = {}) => ({
  description: 'Preform', qty: 1000, unit: 'pcs', unit_price: 2, tax_pct: 18, ...over,
});

describe('billedQty', () => {
  test('a charge line always bills as one, so the price is the amount', () => {
    assert.equal(billedQty({ qty: 5, unit: 'pcs', total_pcs: 9, is_charge: 1 }), 1);
  });

  test('quantity wins when there is one', () => {
    assert.equal(billedQty({ qty: 250, unit: 'kg', total_pcs: 9999 }), 250);
  });

  test('falls back to total pieces only where there is no quantity', () => {
    assert.equal(billedQty({ qty: null, unit: 'pcs', total_pcs: 4800 }), 4800);
  });

  test('a line with neither has no quantity — a price-only quotation', () => {
    assert.equal(billedQty({ qty: null, unit: 'pcs', total_pcs: null }), null);
  });
});

/**
 * A per-box rate is charged against boxes, and the line already states them:
 * 85 boxes of 4,200 is 3,57,000 pieces, so Total Qty over the pack size is
 * the quantity. `box` is the one piece basis whose divisor is not a constant,
 * which is why `PIECES_PER_BILLING_UNIT` could not carry it and why it had
 * none — the line fell through to the Total Qty fallback and billed 3,57,000
 * boxes (2026-11-14, the client: *"When I put unit as box it is not working
 * properly"*).
 *
 * Most of these are about what must **not** move: every other basis reads
 * exactly as it did, and `pcs_per_pack` is ignored everywhere but here.
 */
describe('a per-box rate bills by the box', () => {
  /** The client's own line: 85 boxes of 4,200 at 13.50. */
  const line = { qty: null, unit: 'box', total_pcs: 357000, pcs_per_pack: 4200 };

  test('Total Qty over the pack size is the box count', () => {
    assert.equal(billedQty(line), 85);
    assert.equal(computeTotals([{ ...line, description: 'Cap', unit_price: 13.5 }], 'none').subtotal, 1147.5);
  });

  test('and it beats a quantity stamped under the basis the line used to be on', () => {
    // The defect as the client met it: saved at `per 1000`, `computeTotals`
    // stamped qty 357, and switching the unit left that figure billing — so
    // the amount did not move at all. The derivation has to win, as it does
    // for every other piece basis.
    assert.equal(billedQty({ ...line, qty: 357 }), 85);
  });

  test('a pack size of nothing derives nothing rather than dividing by zero', () => {
    assert.equal(billedQty({ ...line, pcs_per_pack: 0 }), 357000);
    assert.equal(billedQty({ ...line, pcs_per_pack: null }), 357000);
    // ...and a quantity typed on such a line still stands.
    assert.equal(billedQty({ ...line, pcs_per_pack: null, qty: 85 }), 85);
  });

  test('a charge still bills as one, pack size or not', () => {
    assert.equal(billedQty({ ...line, is_charge: 1 }), 1);
  });

  test('no other basis reads the pack size', () => {
    assert.equal(billedQty({ ...line, unit: 'per 1000' }), 357);
    assert.equal(billedQty({ ...line, unit: 'unit' }), 357000);
    // A weight basis is not a count of boxes: Total Qty stands as kilos.
    assert.equal(billedQty({ ...line, unit: 'kg' }), 357000);
    assert.equal(billedQty({ ...line, unit: 'kg', qty: 250 }), 250);
  });

  test('piecesPerBillingUnitOf answers for the line, piecesPerBillingUnit for the unit', () => {
    assert.equal(piecesPerBillingUnitOf(line), 4200);
    assert.equal(piecesPerBillingUnitOf({ unit: 'per 1000', pcs_per_pack: 4200 }), 1000);
    // The unit alone cannot settle a box, which is what `isPieceBasis` says.
    assert.equal(piecesPerBillingUnit('box'), null);
    assert.equal(isPieceBasis('box'), false);
  });

  test('what the line orders in pieces is untouched — a box line still made 3,57,000', () => {
    // The floor, the order book and the dispatch ceiling all read this, and
    // none of them is about how the line is priced.
    assert.equal(piecesOrdered(line), 357000);
  });
});

describe('computeTotals', () => {
  test('the plain case: quantity times price, plus tax', () => {
    const t = computeTotals([goods()], 'igst');
    assert.equal(t.subtotal, 2000);
    assert.equal(t.tax_total, 360);
    assert.equal(t.grand_total, 2360);
  });

  test('no tax type means no tax, whatever the lines say', () => {
    const t = computeTotals([goods({ tax_pct: 18 })], 'none');
    assert.equal(t.tax_total, 0);
    assert.equal(t.grand_total, 2000);
  });

  /**
   * Confirmed with Aglo on 2026-08-18: they charge GST on both. Header freight
   * and insurance used to be added into the taxable value and then left out of
   * the tax, so every domestic document using them under-charged GST by
   * exactly the tax on the charges.
   */
  test('header freight and insurance are taxed', () => {
    const t = computeTotals([goods()], 'igst', 500, 300);
    assert.equal(t.subtotal, 2000);
    assert.equal(t.tax_total, round2(2800 * 0.18), 'tax covers goods and charges alike');
    assert.equal(t.grand_total, round2(2800 + 2800 * 0.18));
  });

  test('and land on the same total as the same money entered as a charge line', () => {
    const viaHeader = computeTotals([goods()], 'igst', 800, 0);
    const viaLine = computeTotals(
      [goods(), { description: 'Freight', qty: null, unit: 'lot', unit_price: 800, tax_pct: 18, is_charge: 1 }],
      'igst',
    );
    assert.equal(viaHeader.grand_total, viaLine.grand_total,
      'the two routes to the same charge must not disagree');
  });

  /**
   * A composite supply follows its principal supply, so the charge is spread
   * across the lines by amount and each share taxed at that line's rate.
   */
  test('with two rates, the charge is apportioned rather than guessed', () => {
    const t = computeTotals(
      [goods({ tax_pct: 18 }), goods({ description: 'Cap', unit_price: 2, tax_pct: 12 })],
      'igst', 1000, 0,
    );
    // Equal amounts, so the charge splits evenly: 500 at 18% and 500 at 12%.
    const onItems = 2000 * 0.18 + 2000 * 0.12;
    assert.equal(t.tax_total, round2(onItems + 500 * 0.18 + 500 * 0.12));
  });

  test('a price-only document has no rate to follow, so charges attract none', () => {
    const t = computeTotals(
      [{ description: 'Preform', qty: null, unit: 'pcs', unit_price: 2, tax_pct: 18 }],
      'igst', 1000, 0,
    );
    assert.equal(t.subtotal, 0);
    assert.equal(t.tax_total, 0, 'inventing a rate here would put a fiction on the document');
    assert.equal(t.grand_total, 1000);
  });

  describe('charge lines', () => {
    test('bill at the price typed, regardless of any quantity on the row', () => {
      const t = computeTotals(
        [{ description: 'Tooling', qty: 7, unit: 'lot', unit_price: 25000, tax_pct: 0, is_charge: 1 }],
        'none',
      );
      assert.equal(t.items[0].amount, 25000, 'not 7 × 25000');
    });

    test('have their packing and loadability cleared, not stored and hidden', () => {
      const t = computeTotals(
        [{
          description: 'Freight', qty: null, unit: 'lot', unit_price: 900, is_charge: 1,
          packs: 12, pcs_per_pack: 100, total_pcs: 1200, color: 'blue', qty_20ft: 5, qty_40ft: 9,
        }],
        'none',
      );
      const it = t.items[0];
      assert.equal(it.packs ?? null, null);
      assert.equal(it.total_pcs ?? null, null);
      assert.equal(it.qty_20ft ?? null, null);
      assert.equal(it.color ?? '', '');
    });
  });

  describe('rounding', () => {
    test('INR grand totals round to the whole rupee', () => {
      const t = computeTotals([goods({ unit_price: 2.337 })], 'igst', 0, 0, 'INR');
      assert.equal(t.grand_total, Math.round(t.grand_total), 'no paise on an INR total');
    });

    test('other currencies keep their minor unit', () => {
      const t = computeTotals([goods({ unit_price: 2.337, tax_pct: 0 })], 'none', 0, 0, 'USD');
      assert.equal(t.grand_total, 2337);
      const odd = computeTotals([goods({ qty: 3, unit_price: 1.115, tax_pct: 0 })], 'none', 0, 0, 'USD');
      assert.equal(odd.grand_total, round2(3 * 1.115));
    });

    test('the round-off a PDF prints is the difference the totals imply', () => {
      const t = computeTotals([goods({ unit_price: 2.337 })], 'igst', 100, 50, 'INR');
      const roundOff = round2(t.grand_total - (t.subtotal + 100 + 50 + t.tax_total));
      assert.ok(Math.abs(roundOff) < 1, `round-off should be under a rupee, got ${roundOff}`);
    });
  });

  test('stored amounts are recomputed, never taken from the caller', () => {
    const t = computeTotals([goods({ amount: 999999 } as never)], 'igst');
    assert.equal(t.items[0].amount, 2000, 'a client-sent amount must never survive');
  });
});

/**
 * How many pieces a line orders. The bug this guards against was found on the
 * live book: a per-1000 line entered as `137.5` with no boxes typed got a job
 * for 137.5 pieces. The SQL twin is what the paged order book reads, and the
 * two are run over the same rows so they cannot quietly disagree.
 */
describe('piecesOrdered', () => {
  const cases: { qty: number | null; unit: string; total_pcs: number | null; want: number }[] = [
    { qty: 137.5, unit: 'per 1000', total_pcs: null, want: 137500 },
    { qty: 137.5, unit: 'per 1000', total_pcs: 120000, want: 120000 },   // the packing count wins
    { qty: 2000, unit: 'unit', total_pcs: null, want: 2000 },
    { qty: 850, unit: 'kg', total_pcs: null, want: 850 },                // not pieces, and not pretended to be
    { qty: 850, unit: 'kg', total_pcs: 4050, want: 4050 },
    { qty: null, unit: 'per 1000', total_pcs: null, want: 0 },
  ];
  test('converts a per-1000 quantity, takes the packing count first', () => {
    for (const c of cases) assert.equal(piecesOrdered(c), c.want, JSON.stringify(c));
  });
  test('the SQL twin agrees on every case', () => {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS po_probe (qty REAL, unit TEXT, total_pcs REAL)');
    for (const c of cases) {
      db.prepare('DELETE FROM po_probe').run();
      db.prepare('INSERT INTO po_probe (qty, unit, total_pcs) VALUES (?, ?, ?)').run(c.qty, c.unit, c.total_pcs);
      const got = (db.prepare(`SELECT ${PIECES_ORDERED_SQL('l')} AS v FROM po_probe l`).get() as { v: number }).v;
      assert.equal(Number(got), c.want, JSON.stringify(c));
    }
  });
});
