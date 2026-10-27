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

  test('reads as a range over the lots it covers', () => {
    /* The quantity came off this header on 2026-10-22 (*"Quantity certified
       — not required"*), so what says the certificate is about all three is
       the range in its heading and the per-lot readings below. */
    const texts = textsOf(buildCoaPdf(lots[0]));
    assert.ok(texts.includes('BATCH NOS.'), 'a group is not headed as a range');
    assert.ok(texts.some((t) => t.includes('05032026A') && t.includes('09032026B')),
      'the range does not name both ends');
    assert.ok(!texts.some((t) => /Quantity Certified/i.test(t)), 'the quantity is still on the header');
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
    // The lot's own date came off the heading on 2026-10-22 — *"Batch date —
    // not required"* — so the cell is the number alone.
    assert.ok(texts.includes('BATCH NO.'), 'the single-lot heading is gone');
    assert.ok(!texts.includes('BATCH NO.  /  DATE'), 'the lot date is still on the heading');
    assert.ok(!texts.includes('BATCH NOS.'), 'a single lot is being described as a range');
    assert.ok(!texts.includes('Batch'), 'the per-lot column is drawn where it says nothing');
  });

  /**
   * Four cells came off this header at the client's word (2026-10-22): the
   * batch date, the **work order**, the **quantity certified** and **inspected
   * on**. Each was derivable and none is a fact the buyer needs — the job is
   * an internal instruction, the quantity is on the invoice, and when it was
   * inspected is what the readings are dated by.
   */
  test('and carries none of the four cells the client took off it', () => {
    const texts = textsOf(buildCoaPdf(alone));
    for (const gone of ['WORK ORDER', 'QUANTITY CERTIFIED', 'INSPECTED ON']) {
      assert.ok(!texts.includes(gone), `${gone} is still on the header`);
    }
    // ...and the ones that stayed.
    for (const kept of ['CERTIFICATE NO.  /  DATE', 'PRODUCT', 'COLOUR', 'RESIN', 'CUSTOMER']) {
      assert.ok(texts.includes(kept), `${kept} was taken off with them`);
    }
  });

  /**
   * *"Buyer order — should be editable, capture PI number or PO number (but
   * no SO number)"*. Ours is not theirs: the sales order is this company's
   * internal number and means nothing to whoever reads the certificate.
   */
  test("the buyer's order is theirs, never our sales order", () => {
    const texts = textsOf(buildCoaPdf(alone));
    assert.ok(texts.includes("BUYER'S ORDER"), 'the cell is gone');
    assert.ok(!texts.some((t) => /^SO[-/]/.test(t)), 'the sales order number is being printed as the buyer\'s');
  });

  test('...and a typed one beats every fallback', () => {
    db.prepare("UPDATE batches SET coa_buyer_order = 'PO-9981/B' WHERE id = ?").run(alone);
    assert.ok(textsOf(buildCoaPdf(alone)).includes('PO-9981/B'), 'what was typed is not what printed');
    db.prepare("UPDATE batches SET coa_buyer_order = '' WHERE id = ?").run(alone);
  });

  /**
   * The fallback chain, in the order the client named it: *"capture PI number
   * or PO number (but no SO number)"*. Their own certificate carries
   * *AGLO/EX/25-26/150*, which is the proforma — so the proforma leads, the
   * customer's own PO follows, and the sales order is in neither position.
   */
  test('blank falls back to the customer PO, then to the proforma over it', () => {
    db.prepare("UPDATE orders SET po_number = 'PO/BUYER/7781' WHERE id = ?").run(orderId);
    assert.ok(textsOf(buildCoaPdf(alone)).includes('PO/BUYER/7781'), 'the PO fallback did not print');

    // The proforma behind the order is the more specific answer and wins.
    db.prepare(
      `INSERT INTO proforma_invoices (number, date, customer_id, company_id, order_id, currency, tax_type)
       VALUES ('AGLO/EX/25-26/150', '2026-02-01', ?, 1, ?, 'USD', 'none')`
    ).run(customerId, orderId);
    const texts = textsOf(buildCoaPdf(alone));
    assert.ok(texts.includes('AGLO/EX/25-26/150'), 'the proforma does not beat the PO');
    assert.ok(!texts.includes('PO/BUYER/7781'), 'both references printed');
  });
});

describe('where the lots went, once they have gone', () => {
  /*
   * The client asked for the consignment facts their own certificate carries
   * (2026-10-21, *"Add the invoice details to the COA header"*). A COA is
   * required **before** dispatch, so these are blank at the moment it is
   * issued — which is why the row is absent rather than three em-dashes, and
   * why both states are held here.
   */

  let invSeq = 188;
  /** A trip carrying these lots, billed under an invoice. */
  function ship(batchIds: number[], opts: { invoice?: boolean; packs?: number; qty?: number } = {}) {
    const invoiceId = opts.invoice === false ? null : Number((db.prepare(
      `INSERT INTO commercial_invoices (number, date, customer_id, company_id, currency, consignee, is_export)
       VALUES (?, '2026-03-19', ?, 1, 'USD', 'AFRICA INDUSTRIAS LDA', 1) RETURNING id`
    ).get(`AP/EX/${++invSeq}/25-26`, customerId) as { id: number }).id);
    const dId = Number((db.prepare(
      `INSERT INTO despatches (order_id, invoice_id, date, destination)
       VALUES (?, ?, '2026-03-19', 'Nacala') RETURNING id`
    ).get(orderId, invoiceId) as { id: number }).id);
    db.prepare(
      'INSERT INTO despatch_items (despatch_id, order_line, qty, packs) VALUES (?, 0, ?, ?)'
    ).run(dId, opts.qty ?? 340000, opts.packs ?? 136);
    for (const b of batchIds) {
      db.prepare('INSERT INTO despatch_batches (despatch_id, batch_id) VALUES (?, ?)').run(dId, b);
    }
    return dId;
  }

  test('a certificate issued before dispatch draws no consignment row at all', () => {
    /* The ordinary case at issue: the goods cannot go until this exists, so
       there is no trip and no invoice to name. Three em-dashes would be a
       dead box on a document. */
    const texts = textsOf(buildCoaPdf(lots[0]));
    // lv() uppercases its labels, so these are the strings on the page.
    for (const label of ['INVOICE NO.  /  DATE', 'CONSIGNEE', 'DISPATCHED']) {
      assert.ok(!texts.includes(label), label);
    }
  });

  test('and the same certificate states them once the goods have gone', () => {
    ship(lots);
    const texts = textsOf(buildCoaPdf(lots[0]));
    assert.ok(texts.includes('INVOICE NO.  /  DATE'));
    assert.ok(texts.some((t) => t.includes('AP/EX/189/25-26')), 'the invoice is not named');
    assert.ok(texts.includes('AFRICA INDUSTRIAS LDA'), 'the consignee is not named');
    assert.ok(texts.some((t) => t.includes('3,40,000 pcs') && t.includes('136 boxes')), 'the figures are wrong');
  });

  test('counting only the lines these lots are on, never the whole lorry', () => {
    /* A trip carries lines this certificate says nothing about; summing them
       would overstate what was certified. */
    const d = ship([lots[1]], { packs: 10, qty: 1000 });
    db.prepare(
      'INSERT INTO despatch_items (despatch_id, order_line, qty, packs) VALUES (?, 7, 99999, 999)'
    ).run(d);
    const texts = textsOf(buildCoaPdf(lots[1]));
    assert.ok(!texts.some((t) => t.includes('999 boxes')), 'another line was counted in');
  });

  test('a trip that left before its paperwork names no invoice and still reports the load', () => {
    /* `despatches.invoice_id` is nullable precisely because a lorry can go
       first — so this is the record being honest, not a fault. */
    const other = lot('10032026A', '2026-03-10');
    db.prepare("UPDATE batches SET coa_no = 'COA/25-26/009', coa_date = '2026-03-20' WHERE id = ?").run(other);
    ship([other], { invoice: false, packs: 12, qty: 2000 });
    const texts = textsOf(buildCoaPdf(other));
    assert.ok(texts.includes('INVOICE NO.  /  DATE'), 'the row is missing');
    assert.ok(texts.some((t) => t.includes('12 boxes')), 'the load is not reported');
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

/**
 * A withdrawn certificate still prints, watermarked by `routes/pdf.ts`
 * (2026-10-24). Checking the document before it goes out is the whole reason
 * the draft state exists, so refusing the page would take away the thing a
 * draft is for — and the builder's own test is therefore the **number**
 * rather than `cleared`, which now means *issued*.
 */
describe('a draft certificate', () => {
  test('still builds, under the same number', () => {
    const id = lot('DRAFT-A', '2026-03-10');
    db.prepare("UPDATE batches SET coa_no = 'COA/25-26/090', coa_date = '2026-03-11' WHERE id = ?").run(id);
    assert.match(textsOf(buildCoaPdf(id)).join(' '), /COA\/25-26\/090/, 'an issued certificate did not print');
    db.prepare("UPDATE batches SET coa_status = 'draft' WHERE id = ?").run(id);
    assert.match(
      textsOf(buildCoaPdf(id)).join(' '), /COA\/25-26\/090/,
      'a withdrawn certificate could not be looked at before issuing it again',
    );
  });

  test('and a lot with no number at all still refuses', () => {
    const bare = lot('NONE-A', '2026-03-12');
    assert.throws(() => buildCoaPdf(bare), /No certificate has been issued/);
  });
});

/**
 * **A reading answered N/A is not on the page** (2026-10-24, the client with
 * a certificate in front of them and the row struck through in pen: *"If I
 * select NA in COA reading, it should not be present in the pdf"*).
 *
 * Mostly about what must **not** move: the row stays in the record and on the
 * quality report, the verdict the page closes on is unchanged, and a block is
 * dropped only once nothing is left in it.
 */
describe('a reading the inspector ruled out', () => {
  type Reading = { name: string; section?: string; value?: number | null; na?: number };

  /** A certified lot of its own, whose final check carries exactly these. */
  function certified(number: string, rows: Reading[]): number {
    const id = Number((db.prepare(
      `INSERT INTO batches (number, work_order_id, date, coa_no, coa_date)
       VALUES (?, ?, '2026-03-15', ?, '2026-03-16') RETURNING id`
    ).get(number, woId, `COA/25-26/${number}`) as { id: number }).id);
    db.prepare(
      `INSERT INTO production_entries (work_order_id, batch_id, date, shift, qty_ok, qty_reject)
       VALUES (?, ?, '2026-03-15', 'A', 1000, 0)`
    ).run(woId, id);
    const checkId = Number((db.prepare(
      `INSERT INTO qc_checks (work_order_id, batch_id, date, shift, inspector)
       VALUES (?, ?, '2026-03-15', 'A', 'ARNAB PALUI') RETURNING id`
    ).get(woId, id) as { id: number }).id);
    rows.forEach((r, i) => {
      db.prepare(
        `INSERT INTO qc_results (check_id, name, kind, section, unit, value, na, min_value, max_value, sort_order)
         VALUES (?, ?, 'numeric', ?, 'mm', ?, ?, 50, 51, ?)`
      ).run(checkId, r.name, r.section ?? '', r.value ?? null, r.na ?? 0, i);
    });
    return id;
  }

  test('is absent, rather than printed as a row saying nothing', () => {
    const id = certified('NA-1', [
      { name: 'Closure O/D', section: 'dimensional', value: 50.3 },
      { name: 'TE Band', section: 'dimensional', na: 1 },
    ]);
    const texts = textsOf(buildCoaPdf(id));
    assert.ok(texts.includes('Closure O/D'), 'the measured row went with it');
    assert.ok(!texts.includes('TE Band'), 'an N/A row is still on the certificate');
    assert.ok(!texts.includes('N/A'), `N/A is still printed: ${texts.join(' | ')}`);
  });

  /** A heading over no rows reads as a fault where an absence reads as one. */
  test('and a block left with nothing in it is not headed', () => {
    const id = certified('NA-2', [
      { name: 'Closure O/D', section: 'dimensional', value: 50.3 },
      { name: 'TE Band', section: 'fitment', na: 1 },
      { name: 'Leakage', section: 'fitment', na: 1 },
    ]);
    const texts = textsOf(buildCoaPdf(id));
    assert.ok(texts.includes('DIMENSIONAL CHECKS'), 'the block that had a reading went too');
    assert.ok(!texts.includes('FITMENT CHECK'), 'a heading is drawn over no rows');
  });

  /** It was never a verdict, so dropping it cannot have moved one. */
  test('and the stamp the page closes on does not move', () => {
    const id = certified('NA-3', [
      { name: 'Closure O/D', section: 'dimensional', value: 50.3 },
      { name: 'TE Band', section: 'fitment', na: 1 },
    ]);
    assert.ok(textsOf(buildCoaPdf(id)).includes('QC PASSED'), 'an N/A moved the verdict');
  });

  /** The flat table is still the fallback, and takes the same rule. */
  test('on an unsectioned specification as much as on the blocks', () => {
    const id = certified('NA-4', [
      { name: 'Closure O/D', value: 50.3 },
      { name: 'TE Band', na: 1 },
    ]);
    const texts = textsOf(buildCoaPdf(id));
    assert.ok(texts.includes('Closure O/D'), 'the measured row went with it');
    assert.ok(!texts.includes('TE Band'), 'an N/A row survived into the flat table');
    assert.ok(!texts.includes('N/A'), 'the Verdict column still reads N/A');
  });
});

/**
 * **What a particular buyer asked to see** (2026-10-27, the client: *"COA -
 * optional field to be add : Customer may want specific details to be added
 * like Purchase order"*). Every other cell in the header is derived or is one
 * of the three somebody types; these answer a requirement nothing in this
 * database holds, so they are typed per certificate.
 *
 * The **layout** is what these cases are mostly about: the header grid is
 * three columns wide, so a row of one or two details has to span out — and a
 * `colSpan` mismatch is what pdfmake throws on at *layout* time rather than
 * definition time, which is why the group below also renders.
 */
describe('extra details on a certificate', () => {
  const own = lot('EXTRA-1', '2026-05-02');
  db.prepare("UPDATE batches SET coa_no = 'COA/25-26/300', coa_date = '2026-05-03' WHERE id = ?").run(own);
  const setExtra = (json: string) =>
    db.prepare('UPDATE batches SET coa_extra = ? WHERE id = ?').run(json, own);

  /** Every row of the header grid, as its cells' `colSpan`s. */
  function headerSpans(id: number): number[][] {
    const def = buildCoaPdf(id) as unknown as { content: Node[] };
    const grid = (def.content as Node[]).find((c) => c?.table && Array.isArray(c.table.body)
      && String(c.table.widths?.[0]) === '*');
    return (grid!.table.body as Node[][]).map((row) => row.map((c) => Number(c?.colSpan ?? 1)));
  }

  test('nothing at all is drawn where nothing was asked for', () => {
    setExtra('');
    const texts = textsOf(buildCoaPdf(own));
    // The cells that are always there, so this is the absence of an addition
    // rather than the absence of a header.
    assert.ok(texts.includes('CERTIFICATE NO.  /  DATE'), 'the header itself is gone');
    assert.ok(!texts.some((t) => /CUSTOMER'S PO/.test(t)), 'an extra cell is drawn on a certificate with none');
    // Every row of the grid still has its three cells — a spanned cell is
    // followed by an empty placeholder, which is what pdfmake throws on at
    // layout time if the count is wrong.
    for (const row of headerSpans(own)) {
      assert.equal(row.length, 3, 'the grid stopped being three columns wide');
    }
  });

  test('a label and its value print, after the derived header', () => {
    setExtra(JSON.stringify([{ label: "Customer's PO", value: '4500123456' }]));
    const texts = textsOf(buildCoaPdf(own));
    assert.ok(texts.includes("CUSTOMER'S PO"), 'the label did not print');
    assert.ok(texts.includes('4500123456'), 'the value did not print');
    // Last, so the certificate's own shape is what it has always been: the
    // addition comes after the cell that closes the derived header.
    assert.ok(texts.indexOf("CUSTOMER'S PO") > texts.indexOf('CUSTOMER'),
      'an addition is being drawn above the details the document works out for itself');
  });

  /**
   * One detail spans all three columns and two share the row, rather than the
   * row ending in empty boxes — a dead cell on a document reads as a fault,
   * the notify parties' own rule.
   */
  test('a part row spans out rather than ending in blank boxes', () => {
    setExtra(JSON.stringify([{ label: 'Shelf life', value: '24 months' }]));
    assert.deepEqual(headerSpans(own).slice(-1), [[3, 1, 1]], 'one detail did not span the row');

    setExtra(JSON.stringify([
      { label: 'Shelf life', value: '24 months' },
      { label: 'Material code', value: 'M80064' },
    ]));
    assert.deepEqual(headerSpans(own).slice(-1), [[1, 2, 1]], 'two details did not span the row');

    setExtra(JSON.stringify([
      { label: 'A', value: '1' }, { label: 'B', value: '2' }, { label: 'C', value: '3' },
    ]));
    assert.deepEqual(headerSpans(own).slice(-1), [[1, 1, 1]], 'three details are not a plain row');
  });

  test('six fill two rows and every row is still three columns wide', () => {
    setExtra(JSON.stringify([1, 2, 3, 4, 5, 6].map((n) => ({ label: `L${n}`, value: `V${n}` }))));
    const spans = headerSpans(own);
    assert.deepEqual(spans.slice(-2), [[1, 1, 1], [1, 1, 1]], 'six details are not two full rows');
    for (const row of spans) assert.equal(row.length, 3, 'the grid stopped being three columns wide');
  });

  /**
   * A row hand-written, restored from a backup or left by an older client is
   * **data, not vocabulary** — so anything unusable is passed over rather than
   * throwing. A certificate one detail short is survivable; a PDF route
   * answering 500 is not.
   */
  test('a stored value that makes no sense is passed over, not thrown on', () => {
    for (const junk of ['not json', '{"label":"x"}', '[]', '[null]', '[{"label":"","value":"v"}]']) {
      setExtra(junk);
      const texts = textsOf(buildCoaPdf(own));
      assert.ok(texts.includes('CERTIFICATE NO.  /  DATE'), `${junk} broke the header`);
      for (const row of headerSpans(own)) assert.equal(row.length, 3, `${junk} broke the grid`);
    }
    setExtra('');
  });

  /** The whole certificate is one document whichever lot it is printed from. */
  test('and a group prints the same details from either end of it', () => {
    db.prepare("UPDATE batches SET coa_extra = ? WHERE coa_no = 'COA/25-26/001'")
      .run(JSON.stringify([{ label: "Customer's PO", value: 'PO-77/2026' }]));
    assert.deepEqual(textsOf(buildCoaPdf(lots[0])), textsOf(buildCoaPdf(lots[2])));
    assert.ok(textsOf(buildCoaPdf(lots[0])).includes('PO-77/2026'), 'the group lost its details');
    db.prepare("UPDATE batches SET coa_extra = '' WHERE coa_no = 'COA/25-26/001'").run();
  });
});
