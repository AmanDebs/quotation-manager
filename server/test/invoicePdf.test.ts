import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildPackingListPdf, buildInvoicePdf, buildProformaPdf } from '../src/services/pdf.js';
import { db } from '../src/db/connection.js';
import { makeCustomer, makeInvoice, makePayment, makeProforma } from './helpers/factory.js';

/**
 * The invoice's money rides *inside* the items table, as it does on the
 * proforma, rather than in floating bands below it. Those bands are taller
 * than a table row and each carried its own margin, which cost about a third
 * of an inch on every invoice.
 *
 * A layout change like that regresses silently — nothing throws, the figures
 * stay right, the page just grows again — so it is worth a test. These build
 * the document definition and read it; they do not render, which keeps them
 * as fast as the rest.
 */

type Node = Record<string, any>;

interface ItemInput {
  description: string; hsn_code?: string; qty?: number | null; unit?: string;
  unit_price?: number; tax_pct?: number; amount?: number;
  packs?: number | null; total_pcs?: number | null; is_charge?: number; sort_order?: number;
}

const addItem = (invoiceId: number, it: ItemInput) => {
  db.prepare(
    `INSERT INTO invoice_items (invoice_id, description, hsn_code, qty, unit, unit_price, tax_pct,
                                amount, packs, total_pcs, is_charge, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(invoiceId, it.description, it.hsn_code ?? '', it.qty ?? null, it.unit ?? 'pcs',
    it.unit_price ?? 0, it.tax_pct ?? 0, it.amount ?? 0, it.packs ?? null,
    it.total_pcs ?? null, it.is_charge ?? 0, it.sort_order ?? 0);
};

const cellText = (c: any): string => {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (typeof c.text === 'string') return c.text;
  if (Array.isArray(c.text)) return c.text.map(cellText).join('');
  return '';
};

/**
 * The rows of the items table, found by its header rather than by its size.
 *
 * "The biggest table" was the first attempt and it picked the boxed customs
 * grid instead, which on an export invoice has about as many rows and whose
 * cells hold nested stacks rather than text — so the test read six blank rows
 * and failed on the wrong thing.
 */
function itemsTableRows(id: number): string[][] {
  const content = buildInvoicePdf(id).content as Node[];
  const tables = content.filter((n) => n && typeof n === 'object' && n.table);
  const items = tables.find((t) =>
    t.table.body.some((row: any[]) => row.some((c) => /Description of Goods/.test(cellText(c)))));
  assert.ok(items, 'no items table in the document');
  return items.table.body.map((row: any[]) => row.map(cellText).filter(Boolean));
}

/** Right-hand coloured blocks floating outside the table. There should be none. */
function floatingBands(id: number): number {
  const content = buildInvoicePdf(id).content as Node[];
  return content.filter((n) => n && n.columns && JSON.stringify(n).includes('fillColor')).length;
}

const cust = makeCustomer('PDF Customer');

function exportInvoice(): number {
  const id = makeInvoice({ customerId: cust, currency: 'USD', total: 78500 });
  db.prepare("UPDATE commercial_invoices SET freight = 3600, is_export = 1, inco_terms = 'FOB', port_of_discharge = 'XYZ', subtotal = 74900, tax_total = 0 WHERE id = ?").run(id);
  addItem(id, { description: '20 LTR Threaded Cap', qty: 300000, unit: 'per 1000', unit_price: 10, amount: 3000, packs: 300, total_pcs: 300000 });
  addItem(id, { description: '28mm PCO 1810', qty: 1650000, unit: 'per 1000', unit_price: 6, amount: 9900, packs: 300, total_pcs: 1650000, sort_order: 1 });
  return id;
}

describe('the columns run description, colour, HSN, boxes, quantity, rate, amount', () => {
  // The client's order (2026-09-20): what the goods are, then how they are
  // packed, then what they cost.
  test('on an export invoice carrying every one of them', () => {
    const id = makeInvoice({ customerId: cust, currency: 'USD', total: 3000 });
    db.prepare("UPDATE commercial_invoices SET is_export = 1 WHERE id = ?").run(id);
    addItem(id, { description: 'Cap', hsn_code: '3923', qty: 300000, unit: 'per 1000', unit_price: 10, amount: 3000, packs: 300, total_pcs: 300000 });
    db.prepare("UPDATE invoice_items SET color = 'Natural' WHERE invoice_id = ?").run(id);
    const header = itemsTableRows(id)[0].map((c) => c.replace(/\s+/g, ' '));
    assert.deepEqual(header, ['SL', 'Description of Goods', 'Color', 'HSN Code', 'Boxes', 'Quantity', 'USD/1000 Pcs', 'Amount USD']);
  });
});

describe('the packing list runs description, colour, HSN, boxes, quantity, thousands, then the weights', () => {
  // The client's order (2026-09-20). Colour and the piece count are the
  // invoice line's, read by index; a `342 per 1000` line is 3,42,000 pieces
  // and 342 thousand, where it used to print "342 per 1000" and no thousands.
  function packingList(): number {
    const invId = makeInvoice({ customerId: cust, currency: 'USD', total: 7069 });
    db.prepare("UPDATE commercial_invoices SET is_export = 1 WHERE id = ?").run(invId);
    addItem(invId, { description: '29/21 CTC Preforms - 10 gms', hsn_code: '3923', qty: 342, unit: 'per 1000', unit_price: 20.67, amount: 7069.14, packs: 114, total_pcs: null });
    db.prepare("UPDATE invoice_items SET color = 'Natural' WHERE invoice_id = ?").run(invId);
    const pl = Number((db.prepare(
      `INSERT INTO packing_lists (number, date, invoice_id, customer_id, company_id) VALUES ('PL/26-27/003', '2026-09-17', ?, ?, 1) RETURNING id`
    ).get(invId, cust) as { id: number }).id);
    db.prepare(`INSERT INTO packing_list_items (packing_list_id, description, hsn_code, qty, unit, packages, net_weight, gross_weight, sort_order)
                VALUES (?, '29/21 CTC Preforms - 10 gms', '3923', 342, 'per 1000', '114 CTN', 3420, 3648, 0)`).run(pl);
    return pl;
  }
  function rows(pl: number): string[][] {
    const content = buildPackingListPdf(pl).content as Node[];
    const t = content.filter((n) => n && typeof n === 'object' && n.table)
      .find((t) => t.table.body.some((row: any[]) => row.some((c) => /Description of Goods/.test(cellText(c)))));
    assert.ok(t, 'no items table');
    return t.table.body.map((row: any[]) => row.map(cellText));
  }
  const pl = packingList();
  test('the header, in that order', () => {
    const [header] = rows(pl);
    assert.deepEqual(header.map((c) => c.replace(/\s+/g, ' ')),
      ['SL', 'Description of Goods', 'Color', 'HSN Code', 'Boxes', 'Quantity', "Qty in Thousand Pcs", 'Net Wt (kg)', 'Gross Wt (kg)']);
  });
  test('a per-1000 line states its pieces, its thousands and the invoice line’s colour', () => {
    const [, line, total] = rows(pl);
    assert.deepEqual(line.slice(2, 7), ['Natural', '3923', '114 CTN', '3,42,000 Pcs', '342']);
    assert.equal(total[5], '3,42,000');
    assert.equal(total[6], '342');
  });
  test('the boxes add up per word, and a cell with no number is skipped', () => {
    db.prepare(`INSERT INTO packing_list_items (packing_list_id, description, qty, unit, packages, sort_order)
                VALUES (?, 'Caps', 100, 'per 1000', '63 ctn', 1), (?, 'Handles', 50, 'per 1000', '2 PALLETS', 2), (?, 'Loose', 1, 'per 1000', 'loose', 3)`).run(pl, pl, pl);
    const total = rows(pl).at(-1)!;
    assert.equal(total[4], '177 CTN\n2 PALLETS');
  });
});

describe('the money sits in the items table', () => {
  test('every money line is a row of the table', () => {
    const id = exportInvoice();
    const rows = itemsTableRows(id).map((r) => r.join(' | '));
    const joined = rows.join('\n');
    for (const label of ['TOTAL PRICE', 'Add Freight', 'AMOUNT IN FOB XYZ']) {
      assert.ok(joined.includes(label), `"${label}" should be a table row:\n${joined}`);
    }
  });

  test('and nothing is left floating beside it', () => {
    assert.equal(floatingBands(exportInvoice()), 0,
      'a separate band costs its own margin and taller rows than the table');
  });

  test('the payment lines come after the total, and are in the table too', () => {
    const id = exportInvoice();
    makePayment({ customerId: cust, invoiceId: id, amount: 13500, currency: 'USD' });
    const rows = itemsTableRows(id).map((r) => r.join(' | '));
    const total = rows.findIndex((r) => r.includes('AMOUNT IN FOB'));
    const received = rows.findIndex((r) => r.includes('Amount Received'));
    const balance = rows.findIndex((r) => r.includes('Balance Due'));
    assert.ok(total >= 0 && received > total && balance > received,
      `expected total → received → balance, got:\n${rows.join('\n')}`);
  });

  test('with no payment there are no payment rows at all', () => {
    const rows = itemsTableRows(exportInvoice()).join('\n');
    assert.ok(!rows.includes('Amount Received'));
    assert.ok(!rows.includes('Balance Due'));
  });
});

describe('a domestic invoice, which carries the most lines', () => {
  const domestic = () => {
    const id = makeInvoice({ customerId: cust, currency: 'INR', total: 720425 });
    db.prepare(`UPDATE commercial_invoices
                SET freight = 4500, insurance = 1200, tax_type = 'cgst_sgst',
                    subtotal = 604830, tax_total = 109895.4 WHERE id = ?`).run(id);
    addItem(id, { description: 'Preform', qty: 240000, unit: 'pcs', unit_price: 2.137, amount: 512880, tax_pct: 18, packs: 200, total_pcs: 240000 });
    return id;
  };

  test('shows the taxable value, both halves of GST and the round off', () => {
    const rows = itemsTableRows(domestic()).map((r) => r.join(' | ')).join('\n');
    for (const label of ['TOTAL PRICE', 'Indicative Freight & Insurance', 'Add CGST', 'Add SGST', 'Round off', 'GRAND TOTAL']) {
      assert.ok(rows.includes(label), `"${label}" missing:\n${rows}`);
    }
  });

  /**
   * The proforma drops its subtotal, since its amount column is summed. An
   * invoice must not: CGST and SGST are charged on the taxable value, and a
   * reader has to be able to see the figure they were charged on.
   */
  test('the subtotal is kept, unlike on the proforma', () => {
    const rows = itemsTableRows(domestic()).map((r) => r.join(' | ')).join('\n');
    assert.ok(/TOTAL PRICE \| ₹6,04,830/.test(rows), `taxable value should be printed:\n${rows}`);
  });

  test('and nothing floats beside the table here either', () => {
    assert.equal(floatingBands(domestic()), 0);
  });
});

/**
 * The advance is adjusted on the invoice, and named.
 *
 * `invoiceReceivable` has always credited this invoice's share of the source
 * proforma's advance, so the balance was right — but it printed as one
 * "Amount Received" line, which left the buyer no way to see that the money
 * they paid against the proforma had been set against this bill. These assert
 * the split, and — the half that matters more — that an invoice with no
 * advance still prints exactly what it always did.
 */
describe('the advance carried from the proforma', () => {
  /** An invoice raised from a proforma carrying `advance`, plus `own` paid here. */
  function billedFromProforma(total: number, advance: number, own = 0, cur = 'USD'): number {
    const pi = makeProforma({ customerId: cust, currency: cur, total });
    const id = makeInvoice({ customerId: cust, currency: cur, total, piId: pi });
    db.prepare('UPDATE commercial_invoices SET is_export = 1, subtotal = ?, tax_total = 0 WHERE id = ?')
      .run(total, id);
    addItem(id, { description: '28mm PCO 1810', qty: 1650000, unit: 'per 1000', unit_price: 6, amount: total, packs: 300, total_pcs: 1650000 });
    if (advance) makePayment({ customerId: cust, piId: pi, amount: advance, currency: cur });
    if (own) makePayment({ customerId: cust, invoiceId: id, amount: own, currency: cur });
    return id;
  }

  const joinRows = (id: number) => itemsTableRows(id).map((r) => r.join(' | ')).join('\n');

  test('is stated as its own line, above the payments made on this invoice', () => {
    const rows = itemsTableRows(billedFromProforma(10000, 3000, 2000)).map((r) => r.join(' | '));
    const advance = rows.findIndex((r) => r.includes('Advance Received'));
    const received = rows.findIndex((r) => r.includes('Amount Received'));
    const balance = rows.findIndex((r) => r.includes('Balance Due'));
    const joined = rows.join('\n');
    assert.ok(advance >= 0 && received > advance && balance > received,
      `expected advance -> received -> balance, got:\n${joined}`);
    // 3,000 advance + 2,000 paid here = 5,000 received, so 5,000 is still due.
    assert.ok(/Advance Received[^\n]*3,000/.test(joined), joined);
    assert.ok(/Amount Received[^\n]*2,000/.test(joined), joined);
    assert.ok(/Balance Due[^\n]*5,000/.test(joined), joined);
  });

  test('names the proforma it was banked against', () => {
    const id = billedFromProforma(10000, 3000);
    const number = String((db.prepare(
      'SELECT p.number FROM proforma_invoices p JOIN commercial_invoices i ON i.pi_id = p.id WHERE i.id = ?'
    ).get(id) as { number: string }).number);
    const joined = joinRows(id);
    assert.ok(joined.includes(`Advance Received (${number})`), `${number} not named:\n${joined}`);
  });

  /** Settled entirely by advance: no "Amount Received" line rather than a zero. */
  test('an invoice with no payment of its own shows no second line', () => {
    const joined = joinRows(billedFromProforma(10000, 4000));
    assert.ok(joined.includes('Advance Received'), joined);
    assert.ok(!joined.includes('Amount Received'), `a zero line was printed:\n${joined}`);
    assert.ok(/Balance Due[^\n]*6,000/.test(joined), joined);
  });

  /**
   * The half that protects every invoice already raised: with no advance the
   * document is what it was — one "Amount Received" line and no mention of a
   * proforma.
   */
  test('an invoice with no advance prints what it always did', () => {
    const id = exportInvoice();
    makePayment({ customerId: cust, invoiceId: id, amount: 13500, currency: 'USD' });
    const joined = joinRows(id);
    assert.ok(joined.includes('Amount Received'), joined);
    assert.ok(!joined.includes('Advance Received'), `an advance row appeared from nowhere:\n${joined}`);
  });

  /**
   * Money only adds up within one currency, the rule `receivables.ts` owns —
   * so an advance in another currency is credited to nothing and there is
   * nothing to adjust for.
   */
  test('an advance in another currency is not adjusted for', () => {
    const pi = makeProforma({ customerId: cust, currency: 'USD', total: 10000 });
    const id = makeInvoice({ customerId: cust, currency: 'USD', total: 10000, piId: pi });
    db.prepare('UPDATE commercial_invoices SET is_export = 1, subtotal = 10000 WHERE id = ?').run(id);
    addItem(id, { description: '28mm PCO 1810', qty: 1650000, unit: 'per 1000', unit_price: 6, amount: 10000, packs: 300, total_pcs: 1650000 });
    makePayment({ customerId: cust, piId: pi, amount: 3000, currency: 'INR' });
    const joined = joinRows(id);
    assert.ok(!joined.includes('Advance Received'), `an INR advance was credited to a USD invoice:\n${joined}`);
  });

  /**
   * The payment rows close the table and carry nothing but their own figure.
   *
   * `itemsTable` puts the column totals on the row marked `sums`, and inserting
   * a row between the grand total and the balance is exactly the change that
   * would slide them down onto it — the boxes shipped have nothing to do with
   * the advance banked. The commercial invoice happens to sum no column today,
   * so this asserts the shape rather than a figure: the money rows sit after
   * the total, in order, each holding one value.
   */
  test('the payment rows close the table and carry no column totals', () => {
    const rows = itemsTableRows(billedFromProforma(10000, 3000, 2000));
    const at = (label: string) => rows.findIndex((r) => r.some((c) => c.startsWith(label)));
    const total = Math.max(at('AMOUNT IN'), at('GRAND TOTAL'));
    assert.ok(total >= 0, 'no grand total row');
    const after = rows.slice(total + 1);
    const shown = after.map((r) => r.join(' | ')).join('\n');
    assert.equal(after.length, 3, `unexpected rows after the total:\n${shown}`);
    assert.match(after[0][0], /^Advance Received \(/, shown);
    assert.equal(after[1][0], 'Amount Received', shown);
    assert.equal(after[2][0], 'Balance Due', shown);
    // Each is a label and one figure — nothing in the columns between them.
    for (const r of after) assert.equal(r.length, 2, `${r.join(' | ')} carried extra cells`);
  });
});

/**
 * The commercial invoice prints no TERMS & CONDITIONS block.
 *
 * Removed 2026-09-08: those clauses are the terms of the *offer*, which the
 * quotation and the proforma print, and Aglo's own AP/EX-101 sample carries
 * no such block — its footer is the origin certificate, Incoterms and ARN.
 * Two ways it could come back without anyone noticing, so both are asserted:
 * from the document's own remarks, and from the company's default terms.
 */
describe('the invoice prints no terms block', () => {
  const bothSources = () => {
    db.prepare("UPDATE companies SET default_terms = ? WHERE id = 1")
      .run('1. Prices are ex-works. 2. Subject to Kolkata jurisdiction.');
    const id = exportInvoice();
    db.prepare("UPDATE commercial_invoices SET remarks = ? WHERE id = ?")
      .run('Quantity Tolerance: 10% in value and quantity.', id);
    return id;
  };

  test('neither the document remarks nor the company defaults reach it', () => {
    const joined = JSON.stringify(buildInvoicePdf(bothSources()).content);
    assert.ok(!joined.includes('TERMS & CONDITIONS'), 'the terms heading is back');
    assert.ok(!joined.includes('Quantity Tolerance'), "the document's own remarks printed");
    assert.ok(!joined.includes('Kolkata jurisdiction'), "the company's default terms printed");
  });

  /** What the footer keeps: the AP/EX-101 sample's own three facts. */
  test('the certifications below it are untouched', () => {
    const joined = JSON.stringify(buildInvoicePdf(bothSources()).content);
    assert.ok(joined.includes('is of Indian Origin'), 'the origin certificate went with it');
    assert.ok(joined.includes('Incoterms'), 'the Incoterms line went with it');
  });

  /** The proforma still carries them — it is the document that made the offer. */
  test('but the proforma still does', () => {
    db.prepare("UPDATE companies SET default_terms = 'Subject to Kolkata jurisdiction.' WHERE id = 1").run();
    const pi = makeProforma({ customerId: cust, currency: 'USD', total: 1000 });
    db.prepare(
      `INSERT INTO pi_items (pi_id, description, qty, unit, unit_price, amount, total_pcs, sort_order)
       VALUES (?, 'Cap', 100, 'per 1000', 10, 1000, 100000, 0)`
    ).run(pi);
    const joined = JSON.stringify(buildProformaPdf(pi).content);
    assert.ok(joined.includes('TERMS & CONDITIONS'), 'the proforma lost its terms too');
  });
});

/**
 * A blank notify party is not printed (2026-09-17, the client with the page in
 * front of them: *"Do not print notify if they are empty"*). The consignee
 * takes the width the missing party leaves; both stated prints as it always did.
 */
describe('the notify cells on an export invoice', () => {
  const grid = (notify1: string, notify2: string) => {
    const cust = makeCustomer();
    const id = makeInvoice({ customerId: cust, currency: 'USD', total: 100 });
    db.prepare('UPDATE commercial_invoices SET is_export = 1, consignee = ?, notify_party = ?, notify_party_2 = ? WHERE id = ?')
      .run('Africa Industrias LDA', notify1, notify2, id);
    addItem(id, { description: 'Preform', qty: 1, unit: 'unit', unit_price: 100, amount: 100 });
    const joined = JSON.stringify(buildInvoicePdf(id).content);
    // Labels print uppercased (`lv`).
    return { n1: joined.includes('NOTIFY 1'), n2: joined.includes('NOTIFY 2') };
  };
  test('neither stated: no notify cell at all', () => {
    const g = grid('', '');
    assert.equal(g.n1, false); assert.equal(g.n2, false);
  });
  test('one stated: that one alone', () => {
    const g = grid('Global Freight, Hamburg', '');
    assert.equal(g.n1, true); assert.equal(g.n2, false);
    const h = grid('', 'Nordbank, Mauritius');
    assert.equal(h.n1, false); assert.equal(h.n2, true);
  });
  test('both stated: both, as before', () => {
    const g = grid('Global Freight, Hamburg', 'Nordbank, Mauritius');
    assert.equal(g.n1, true); assert.equal(g.n2, true);
  });
});

/**
 * Quantity in pieces and the rate per 1000, the proforma's own words
 * (2026-09-17, the client with the two side by side: *"Some error in
 * Quantity. Rate format is also different from PI"*). A line entered as
 * `342 per 1000` with no packing figure had printed *342 per 1000* — a
 * figure a buyer reads as 342 pieces — beside *20.67/1000*, where the
 * proforma had said 3,42,000 and 20.67 under USD/1000 Pcs.
 */
describe('the invoice states pieces and a per-1000 rate, as the proforma does', () => {
  test('a per-1000 line with no packing figure prints its pieces and the derived rate', () => {
    const id = makeInvoice({ customerId: cust, currency: 'USD', total: 7069.14 });
    addItem(id, { description: '29/21 CTC Preforms', qty: 342, unit: 'per 1000', unit_price: 20.67, amount: 7069.14, packs: 114 });
    const rows = itemsTableRows(id).map((r) => r.join(' | ')).join('\n');
    assert.match(rows, /USD\/1000 Pcs/, 'the rate column is not labelled as the proforma labels it');
    assert.match(rows, /3,42,000 Pcs \| 20\.67/, rows);
    assert.doesNotMatch(rows, /342 per 1000/, 'the billing quantity leaked onto the page');
  });
  test('a weight-billed line still states its kilos and its own price', () => {
    const id = makeInvoice({ customerId: cust, currency: 'USD', total: 1200 });
    addItem(id, { description: 'Regrind', qty: 600, unit: 'kg', unit_price: 2, amount: 1200 });
    const rows = itemsTableRows(id).map((r) => r.join(' | ')).join('\n');
    assert.match(rows, /Price USD/);
    assert.match(rows, /600 kg \| 2 \/kg/, rows);
  });
});
