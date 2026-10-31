import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import {
  COA_FIELDS, coaHeaderFields, coaHeaderError, parseCoaHeader, cleanCoaHeader,
  buyerOrderFrom, printedCoaFields, type CoaField,
} from '../src/services/coaHeader.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * The certificate's header as one list — what is derived, what may be typed
 * over, and which cells print (2026-10-31, the client with their own COA
 * beside the app's).
 *
 * Most of these are about what must **not** happen: a stored row must never
 * take a PDF route down, a cell nobody may type over must never carry a typed
 * value, and the certificate must always state its own number.
 */

/* ------------------------------------------------------------------ */
/* What is stored                                                      */
/* ------------------------------------------------------------------ */

describe('reading the stored header back', () => {
  test('never throws, whatever is in the column', () => {
    for (const junk of ['', '   ', 'not json', '[]', '"a string"', '42', 'null', '{"hidden":"nope"}']) {
      const cfg = parseCoaHeader(junk);
      assert.deepEqual(cfg.hidden, [], junk);
      assert.deepEqual(cfg.values, {}, junk);
    }
    assert.deepEqual(parseCoaHeader(null), { hidden: [], values: {} });
    assert.deepEqual(parseCoaHeader(undefined), { hidden: [], values: {} });
  });

  test('a key this build does not know is passed over rather than trusted', () => {
    const cfg = parseCoaHeader('{"hidden":["colour","made_up"],"values":{"resin":"HDPE","nonsense":"x"}}');
    assert.deepEqual(cfg.hidden, ['colour']);
    assert.deepEqual(cfg.values, { resin: 'HDPE' });
  });

  /*
   * The double rail this codebase puts on anything a route refuses: the
   * loader ignores it however the row got here — hand-written, an older
   * client, a restored backup — so no stored row can produce a certificate
   * that does not say which certificate it is.
   */
  test('the certificate’s own number is never ticked off, however the row got here', () => {
    const cfg = parseCoaHeader({ hidden: ['certificate', 'resin'] });
    assert.deepEqual(cfg.hidden, ['resin']);
  });

  test('and a cell nobody may type over never carries a typed value', () => {
    const cfg = parseCoaHeader({ values: { customer: 'Somebody Else Ltd', product: 'Not this', resin: 'PET' } });
    assert.deepEqual(cfg.values, { resin: 'PET' });
  });

  test('it is idempotent, so a reader need not know which shape it holds', () => {
    const once = parseCoaHeader('{"hidden":["resin"],"values":{"lot_no":"L-9"}}');
    assert.deepEqual(parseCoaHeader(once), once);
  });

  test('a blank or whitespace value is no override at all', () => {
    assert.deepEqual(parseCoaHeader({ values: { resin: '   ', lot_no: ' L-9 ' } }).values, { lot_no: 'L-9' });
  });
});

describe('what the guard refuses', () => {
  test('nothing, where there is nothing to refuse', () => {
    assert.equal(coaHeaderError(null), null);
    assert.equal(coaHeaderError(undefined), null);
    assert.equal(coaHeaderError({}), null);
    assert.equal(coaHeaderError({ hidden: ['resin', 'period'], values: { lot_no: 'L-9' } }), null);
  });

  test('a shape that is not a header', () => {
    assert.match(String(coaHeaderError([])), /list of ticks/);
    assert.match(String(coaHeaderError('x')), /list of ticks/);
    assert.match(String(coaHeaderError({ hidden: 'resin' })), /must be a list/);
    assert.match(String(coaHeaderError({ values: [] })), /list of fields/);
  });

  /*
   * Refused here and ignored on read, which is not a contradiction: a request
   * naming a cell this build has never heard of is a mistake worth telling
   * somebody about, where a **stored** row naming one is a release that has
   * moved on and must not take a certificate down with it.
   */
  test('a field that is not on the certificate', () => {
    assert.match(String(coaHeaderError({ hidden: ['made_up'] })), /not a field on the certificate/);
    assert.match(String(coaHeaderError({ values: { made_up: 'x' } })), /not a field on the certificate/);
  });

  test('ticking off the number it is issued under', () => {
    assert.match(String(coaHeaderError({ hidden: ['certificate'] })), /has to state its own number/);
  });

  test('typing over a cell that is read from the record', () => {
    assert.match(String(coaHeaderError({ values: { customer: 'Somebody Else' } })), /cannot be typed over/);
  });

  test('and a value too long for one cell of a grid', () => {
    assert.match(String(coaHeaderError({ values: { resin: 'x'.repeat(201) } })), /too long/);
  });
});

describe('what gets written', () => {
  test('only the differences, so an untouched header stores nothing', () => {
    assert.equal(cleanCoaHeader({ hidden: [], values: {} }), '');
    assert.equal(cleanCoaHeader({}), '');
    assert.equal(cleanCoaHeader(null), '');
  });

  /*
   * `coa_buyer_order` predates this list and three routes write it, so the
   * map never keeps a second copy of that one cell — the route lifts it back
   * out through `buyerOrderFrom`.
   */
  test('and never a second copy of the one cell with a column of its own', () => {
    const json = cleanCoaHeader({ hidden: ['resin'], values: { buyer_order: 'PO-1', lot_no: 'L-9' } });
    assert.deepEqual(JSON.parse(json), { hidden: ['resin'], values: { lot_no: 'L-9' } });
    assert.equal(cleanCoaHeader({ values: { buyer_order: 'PO-1' } }), '');
  });

  test('the buyer’s reference is lifted out, and clearing it is a real answer', () => {
    // The header is sent whole or not at all, so a `values` map without the
    // key means somebody cleared the box rather than left it alone.
    assert.equal(buyerOrderFrom(undefined), null);
    assert.equal(buyerOrderFrom({ values: { lot_no: 'L-9' } }), '');
    assert.equal(buyerOrderFrom({ values: { buyer_order: ' PO-1 ' } }), 'PO-1');
  });
});

/* ------------------------------------------------------------------ */
/* What the header says                                                */
/* ------------------------------------------------------------------ */

const customerId = makeCustomer('Emeraude Polymers FZCO');
db.prepare("UPDATE customers SET address = 'Jebel Ali, Dubai' WHERE id = ?").run(customerId);
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
   VALUES ('SO-EX/HDR/1', '2026-03-01', ?, 1, 'USD', 'none', 'pending') RETURNING id`
).get(customerId) as { id: number }).id);
db.prepare(
  `INSERT INTO order_items (order_id, product_id, description, color, qty, unit, unit_price, amount,
                            total_pcs, is_charge, sort_order)
   VALUES (?, ?, '48MM SEAL CAP', 'RED', 340, 'per 1000', 10, 3400, 340000, 0, 0)`
).run(orderId, productId);
const woId = Number((db.prepare(
  `INSERT INTO work_orders (number, order_id, order_line, product_id, description, qty_planned, status, company_id)
   VALUES ('WO/HDR/1', ?, 0, ?, '48MM SEAL CAP', 340000, 'running', 1) RETURNING id`
).get(orderId, productId) as { id: number }).id);

function lot(number: string, date: string): number {
  const id = Number((db.prepare(
    'INSERT INTO batches (number, work_order_id, date) VALUES (?, ?, ?) RETURNING id'
  ).get(number, woId, date) as { id: number }).id);
  db.prepare(
    `INSERT INTO production_entries (work_order_id, batch_id, date, shift, qty_ok, qty_reject)
     VALUES (?, ?, ?, 'A', 1000, 0)`
  ).run(woId, id, date);
  return id;
}

const by = (fields: CoaField[], key: string) => fields.find((f) => f.key === key)!;

describe('the header of a certificate', () => {
  const one = lot('05032026A', '2026-03-05');
  db.prepare("UPDATE batches SET coa_no = 'COA/25-26/001', coa_date = '2026-03-19' WHERE id = ?").run(one);

  test('is one ordered list, and the page and the paper read it together', () => {
    const fields = coaHeaderFields({ batchId: one });
    assert.deepEqual(fields.map((f) => f.key), COA_FIELDS.map((f) => f.key));
  });

  test('derives what the record already answers', () => {
    const fields = coaHeaderFields({ batchId: one });
    assert.equal(by(fields, 'certificate').value, 'COA/25-26/001   19-03-2026');
    assert.equal(by(fields, 'batch').value, '05032026A');
    assert.equal(by(fields, 'product').value, '48MM Seal Cap');
    // The order line's colour, not the catalogue's.
    assert.equal(by(fields, 'colour').value, 'RED');
    assert.equal(by(fields, 'resin').value, 'HDPE Resin');
    assert.equal(by(fields, 'period').value, '05-03-2026');
    assert.equal(by(fields, 'customer').value, 'Emeraude Polymers FZCO\nJebel Ali, Dubai');
  });

  test('and says nothing about a consignment that has not gone', () => {
    const fields = coaHeaderFields({ batchId: one });
    for (const key of ['lot_no', 'invoice', 'consignee', 'boxes', 'dispatched']) {
      assert.equal(by(fields, key).value, '', key);
    }
    // Which is the whole point of `optional`: those cells leave the page
    // rather than printing an em-dash apiece.
    const printed = printedCoaFields(fields).map((f) => String(f.key));
    for (const key of ['lot_no', 'invoice', 'consignee', 'boxes', 'dispatched']) {
      assert.ok(!printed.includes(key), key);
    }
    assert.ok(printed.includes('customer'), 'a cell that always prints was dropped');
  });

  /*
   * A COA is required **before** dispatch, so the consignee, the invoice, the
   * lot number and the boxes do not exist when it is issued — and their own
   * paper states all four. Typed wins, blank falls back, which is
   * `coa_buyer_order`'s rule one field wider.
   */
  test('a typed value beats the record, and clearing it falls back again', () => {
    db.prepare("UPDATE batches SET coa_header = ? WHERE id = ?")
      .run(JSON.stringify({ hidden: [], values: { resin: 'PET', lot_no: 'LOT-77' } }), one);
    const fields = coaHeaderFields({ batchId: one });
    assert.equal(by(fields, 'resin').typed, 'PET');
    assert.equal(by(fields, 'resin').derived, 'HDPE Resin', 'the record is still reported beside it');
    assert.equal(by(fields, 'resin').value, 'PET');
    assert.equal(by(fields, 'lot_no').value, 'LOT-77');
    assert.ok(printedCoaFields(fields).some((f) => f.key === 'lot_no'), 'a typed optional cell does not print');

    db.prepare("UPDATE batches SET coa_header = '' WHERE id = ?").run(one);
    assert.equal(by(coaHeaderFields({ batchId: one }), 'resin').value, 'HDPE Resin');
  });

  test('a ticked-off cell keeps its value and leaves the page', () => {
    db.prepare("UPDATE batches SET coa_header = ? WHERE id = ?")
      .run(JSON.stringify({ hidden: ['resin', 'colour'] }), one);
    const fields = coaHeaderFields({ batchId: one });
    assert.equal(by(fields, 'resin').hidden, true);
    assert.equal(by(fields, 'resin').value, 'HDPE Resin', 'the record is not rewritten by a tick');
    const printed = printedCoaFields(fields).map((f) => String(f.key));
    assert.ok(!printed.includes('resin') && !printed.includes('colour'));
    assert.ok(printed.includes('certificate'), 'the number went with them');
    db.prepare("UPDATE batches SET coa_header = '' WHERE id = ?").run(one);
  });

  test('the buyer’s own reference keeps its own column', () => {
    db.prepare("UPDATE batches SET coa_buyer_order = 'PO-9981/B' WHERE id = ?").run(one);
    assert.equal(by(coaHeaderFields({ batchId: one }), 'buyer_order').value, 'PO-9981/B');
    db.prepare("UPDATE batches SET coa_buyer_order = '' WHERE id = ?").run(one);
    // Blank falls back to the proforma behind the order, never to our own
    // sales order number.
    db.prepare(
      `INSERT INTO proforma_invoices (number, date, customer_id, company_id, order_id, currency, tax_type)
       VALUES ('AGLO/EX/25-26/150', '2026-02-01', ?, 1, ?, 'USD', 'none')`
    ).run(customerId, orderId);
    assert.equal(by(coaHeaderFields({ batchId: one }), 'buyer_order').value, 'AGLO/EX/25-26/150');
  });

  /*
   * `despatch_batches` says which lots travelled and the trip names the
   * invoice — the only way this app can reach a consignee, an invoice number
   * or a lot number from a batch.
   */
  test('and fills in from the trip once the goods have gone', () => {
    const invoiceId = Number((db.prepare(
      `INSERT INTO commercial_invoices (number, date, customer_id, company_id, currency, consignee, lot_no, is_export)
       VALUES ('AP/EX/189/25-26', '2026-03-19', ?, 1, 'USD', 'AFRICA INDUSTRIAS LDA', 'L/2026/03', 1) RETURNING id`
    ).get(customerId) as { id: number }).id);
    const dId = Number((db.prepare(
      `INSERT INTO despatches (order_id, invoice_id, date, destination)
       VALUES (?, ?, '2026-03-19', 'Nacala') RETURNING id`
    ).get(orderId, invoiceId) as { id: number }).id);
    db.prepare('INSERT INTO despatch_items (despatch_id, order_line, qty, packs) VALUES (?, 0, 340000, 136)')
      .run(dId);
    db.prepare('INSERT INTO despatch_batches (despatch_id, batch_id) VALUES (?, ?)').run(dId, one);

    const fields = coaHeaderFields({ batchId: one });
    assert.equal(by(fields, 'invoice').value, 'AP/EX/189/25-26   19-03-2026');
    assert.equal(by(fields, 'consignee').value, 'AFRICA INDUSTRIAS LDA');
    assert.equal(by(fields, 'lot_no').value, 'L/2026/03', 'the lot number is not read off the invoice');
    assert.equal(by(fields, 'boxes').value, '136 boxes');
    assert.equal(by(fields, 'dispatched').value, '3,40,000 pcs');
  });
});

describe('the header of a certificate that does not exist yet', () => {
  /*
   * The one-press `certify` shape, where the page has to show what it is
   * about to issue: the lots are the shifts nobody has certified, so the
   * period is their span and there is no trip behind goods that have not
   * gone.
   */
  const woTwo = Number((db.prepare(
    `INSERT INTO work_orders (number, order_id, order_line, product_id, description, qty_planned, status, company_id)
     VALUES ('WO/HDR/2', ?, 0, ?, '48MM SEAL CAP', 100000, 'running', 1) RETURNING id`
  ).get(orderId, productId) as { id: number }).id);
  for (const d of ['2026-04-02', '2026-04-06']) {
    db.prepare(
      `INSERT INTO production_entries (work_order_id, batch_id, date, shift, qty_ok, qty_reject)
       VALUES (?, NULL, ?, 'A', 5000, 0)`
    ).run(woTwo, d);
  }

  test('previews the shifts the press is about to sweep up', () => {
    const fields = coaHeaderFields({ workOrderId: woTwo, batchNumber: '06042026A' });
    assert.equal(by(fields, 'period').value, '02-04-2026 – 06-04-2026');
    assert.equal(by(fields, 'batch').value, '06042026A', 'the number being typed is not previewed');
    assert.equal(by(fields, 'product').value, '48MM Seal Cap');
    assert.equal(by(fields, 'certificate').value, '', 'a number is claimed at issue, not before');
  });

  test('and states no consignment, there being no trip behind goods that have not gone', () => {
    const fields = coaHeaderFields({ workOrderId: woTwo });
    for (const key of ['invoice', 'consignee', 'boxes', 'dispatched', 'lot_no']) {
      assert.equal(by(fields, key).value, '', key);
    }
  });

  test('a job that is not on file answers with nothing rather than throwing', () => {
    assert.deepEqual(coaHeaderFields({ workOrderId: 999999 }), []);
    assert.deepEqual(coaHeaderFields({ batchId: 999999 }), []);
  });
});
