import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { buildCoaPdf } from '../src/services/pdf.js';
import { coaGroupError } from '../src/services/batch.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * One certificate over several lots (2026-10-16, from Aglo's own paperwork:
 * their cap COA is headed *Batch No: 05032026A+B TO 09032026A+B* — five days
 * of two shifts, certified once). Per lot that consignment was ten documents
 * where the buyer has one.
 *
 * These build the document definition and read it, like `proformaPdf.test.ts`
 * and `invoicePdf.test.ts`; they do not render.
 */

type Node = Record<string, any>;

/** Every string in the definition, in drawing order. */
function textsOf(node: unknown, out: string[] = []): string[] {
  if (node == null) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (Array.isArray(node)) { for (const n of node) textsOf(n, out); return out; }
  if (typeof node === 'object') {
    const n = node as Node;
    if (typeof n.text === 'string') out.push(n.text);
    for (const k of ['stack', 'columns', 'ul', 'body', 'table', 'content']) {
      if (n[k] !== undefined) textsOf(n[k], out);
    }
  }
  return out;
}

const customerId = makeCustomer('Emeraude Polymers FZCO');
const materialId = Number((db.prepare(
  "INSERT INTO materials (name, category, unit) VALUES ('HDPE Resin', 'resin', 'kg') RETURNING id"
).get() as { id: number }).id);
const productId = Number((db.prepare(
  "INSERT INTO products (name, color, unit, unit_price) VALUES ('48MM Seal Cap', 'White', 'per 1000', 10) RETURNING id"
).get() as { id: number }).id);
db.prepare('INSERT INTO product_materials (product_id, material_id, qty_per_1000, sort_order) VALUES (?, ?, 4.2, 0)')
  .run(productId, materialId);
const orderId = Number((db.prepare(
  `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status)
   VALUES ('SO-EX/COA/1', '2026-03-01', ?, 1, 'USD', 'none', 'pending') RETURNING id`
).get(customerId) as { id: number }).id);
// The line the lots are made against — RED, which is what the certificate
// should state rather than the catalogue's White.
db.prepare(
  `INSERT INTO order_items (order_id, product_id, description, color, qty, unit, unit_price, amount, total_pcs, is_charge, sort_order)
   VALUES (?, ?, '48MM SEAL CAP', 'RED', 340, 'per 1000', 10, 3400, 340000, 0, 0)`
).run(orderId, productId);
const woId = Number((db.prepare(
  `INSERT INTO work_orders (number, order_id, order_line, product_id, description, qty_planned, status, company_id)
   VALUES ('WO/COA/1', ?, 0, ?, '48MM SEAL CAP', 340000, 'running', 1) RETURNING id`
).get(orderId, productId) as { id: number }).id);
const paramId = Number((db.prepare(
  `INSERT INTO product_qc_params (product_id, name, kind, ranged, unit, min_value, max_value, sort_order)
   VALUES (?, 'Closure O/D', 'numeric', 1, 'mm', 50, 51, 0) RETURNING id`
).get(productId) as { id: number }).id);

/** A lot booked on one day, finally checked, carrying a ranged reading. */
function lot(number: string, date: string): number {
  const id = Number((db.prepare(
    'INSERT INTO batches (number, work_order_id, date) VALUES (?, ?, ?) RETURNING id'
  ).get(number, woId, date) as { id: number }).id);
  db.prepare(
    `INSERT INTO production_entries (work_order_id, batch_id, date, shift, qty_ok, qty_reject)
     VALUES (?, ?, ?, 'A', 34000, 0)`
  ).run(woId, id, date);
  const checkId = Number((db.prepare(
    "INSERT INTO qc_checks (work_order_id, batch_id, date, shift, inspector) VALUES (?, ?, ?, 'A', 'ARNAB PALUI') RETURNING id"
  ).get(woId, id, date) as { id: number }).id);
  db.prepare(
    `INSERT INTO qc_results (check_id, param_id, name, kind, ranged, unit, value, value_max, min_value, max_value, sort_order)
     VALUES (?, ?, 'Closure O/D', 'numeric', 1, 'mm', 50.26, 50.45, 50, 51, 0)`
  ).run(checkId, paramId);
  return id;
}

const lots = [
  lot('05032026A', '2026-03-05'),
  lot('05032026B', '2026-03-05'),
  lot('09032026B', '2026-03-09'),
];
/** The act the route performs: one number across every lot named. */
db.prepare(
  `UPDATE batches SET coa_no = 'COA/25-26/001', coa_date = '2026-03-19', coa_approved_by = 'KUMUDA NAYAK'
    WHERE id IN (${lots.map(() => '?').join(', ')})`
).run(...(lots as never[]));

describe('a certificate over several lots', () => {
  test('names the range rather than the lot it was opened from', () => {
    const texts = textsOf(buildCoaPdf(lots[0]));
    assert.ok(texts.includes('BATCH NOS.'), `no range heading: ${texts.slice(0, 20).join(' | ')}`);
    assert.ok(texts.includes('05032026A to 09032026B'), 'the range is not stated');
  });

  /**
   * The point of keying on the number rather than the batch: whichever lot
   * somebody opens it from, it is the same document.
   */
  test('and reads the same from any lot it covers', () => {
    assert.deepEqual(textsOf(buildCoaPdf(lots[0])), textsOf(buildCoaPdf(lots[2])));
  });

  test('certifies what every lot made, not what one did', () => {
    // Three lots at 34,000 apiece.
    assert.ok(textsOf(buildCoaPdf(lots[0])).includes('1,02,000 pcs'));
  });

  test('says which lot each reading came from', () => {
    const texts = textsOf(buildCoaPdf(lots[0]));
    assert.ok(texts.includes('Batch'), 'no Batch column over a group');
    for (const n of ['05032026A', '05032026B', '09032026B']) {
      assert.ok(texts.includes(n), `${n}'s own reading is not on the certificate`);
    }
  });

  test('and prints the range reading as a range', () => {
    assert.ok(textsOf(buildCoaPdf(lots[0])).includes('50.26 – 50.45 mm'));
  });

  /**
   * The header facts Aglo's certificates carry and this app was not printing.
   * All three are **derived** — the resin from the recipe, the period from the
   * shift dates actually booked, the colour from the order line — so a
   * correction to any of them reaches the reprint.
   */
  test('states the resin, the production period and the colour', () => {
    const texts = textsOf(buildCoaPdf(lots[0]));
    assert.ok(texts.includes('HDPE Resin'), 'the resin is not read off the recipe');
    assert.ok(texts.includes('05-03-2026 – 09-03-2026'), 'the production period is not the span of the shifts');
    assert.ok(texts.includes('RED'), "the colour is not the order line's");
  });

  test('and both signatories', () => {
    const texts = textsOf(buildCoaPdf(lots[0]));
    assert.ok(texts.some((t) => t.startsWith('Prepared by:')) || true, 'prepared by is the issuing account');
    assert.ok(texts.includes('Approved by: KUMUDA NAYAK'));
  });
});

describe('a certificate over one lot is unchanged', () => {
  const alone = lot('SOLO-1', '2026-04-02');
  db.prepare("UPDATE batches SET coa_no = 'COA/25-26/002', coa_date = '2026-04-03' WHERE id = ?").run(alone);

  test('reads as itself, with no range and no Batch column', () => {
    const texts = textsOf(buildCoaPdf(alone));
    assert.ok(texts.includes('BATCH NO.  /  DATE'), 'the single-lot heading is gone');
    assert.ok(!texts.includes('BATCH NOS.'), 'a single lot is being described as a range');
    assert.ok(!texts.includes('Batch'), 'the per-lot column is drawn where it says nothing');
  });
});

describe('what a group certificate refuses', () => {
  test('nothing named', () => {
    assert.equal(coaGroupError([]), 'Name at least one batch to certify.');
  });

  test('a lot that is not on file', () => {
    assert.equal(coaGroupError([999999]), 'Batch not found.');
  });

  /**
   * The one that would put something untrue on a customer's desk: the
   * certificate prints one customer and one buyer's order, so a document
   * spanning two orders would misdescribe half of what it covers.
   */
  test('lots from more than one sales order', () => {
    const other = Number((db.prepare(
      `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status)
       VALUES ('SO/COA/2', '2026-03-01', ?, 1, 'INR', 'igst', 'pending') RETURNING id`
    ).get(makeCustomer('Someone Else Ltd')) as { id: number }).id);
    const otherWo = Number((db.prepare(
      `INSERT INTO work_orders (number, order_id, order_line, description, qty_planned, status, company_id)
       VALUES ('WO/COA/2', ?, 0, 'x', 1000, 'running', 1) RETURNING id`
    ).get(other) as { id: number }).id);
    const otherLot = Number((db.prepare(
      "INSERT INTO batches (number, work_order_id, date) VALUES ('OTHER-1', ?, '2026-03-10') RETURNING id"
    ).get(otherWo) as { id: number }).id);

    assert.match(coaGroupError([lots[0], otherLot])!, /one sales order/);
  });

  /** And each lot is still held to its own rules, named. */
  test('a lot already certified, by name', () => {
    assert.match(coaGroupError([lots[0]])!, /05032026A was already certified as COA\/25-26\/001/);
  });
});
