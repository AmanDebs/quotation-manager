import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, incompleteError, type CheckedDoc, type CheckedItem } from '../src/services/documentChecks.js';
import { db } from '../src/db/connection.js';
import { makeCustomer, makeInvoice } from './helpers/factory.js';

/**
 * Approval now asks two questions — may you, and is the document finished —
 * and this covers the second. The risk being managed is asymmetric: a blocking
 * rule that fires wrongly stops a shipment, while a warning that fires wrongly
 * costs a line of grey text. So most of these assert what is **not** blocked.
 */

const line = (over: Partial<CheckedItem> = {}): CheckedItem => ({
  description: 'A thing', qty: 100, unit: 'unit', total_pcs: null, hsn_code: '3923', is_charge: 0, ...over,
});

const doc = (table: CheckedDoc['table'], row: Record<string, unknown> = {}, items = [line()]): CheckedDoc => ({
  table,
  // A finished document, so each test fails only in the respect it names.
  // `bank_account` joined this list when it became a blocking rule.
  row: {
    date: '2026-09-01', grand_total: 1000, tax_type: 'none', is_export: 0,
    payment_terms: '30 days', bank_account: 'HDFC 50200012345678',
    // The quotation's own mandatory fields (2026-09-12), for the same reason.
    validity_date: '2026-09-30', delivery_terms: '4-6 weeks', prepared_by: 'R. Das',
    inco_terms: 'EX-Works', notes: 'Subject to Kolkata jurisdiction.',
    ...row,
  },
  items,
  customer: { gstin: '19AAAAA0000A1Z5' },
});

const keys = (d: CheckedDoc, level?: 'block' | 'warn') =>
  evaluate(d).filter((f) => !level || f.level === level).map((f) => f.key).sort();

describe('what stops an approval', () => {
  test('a document with nothing on it', () => {
    assert.deepEqual(keys(doc('quotations', {}, []), 'block'), ['items']);
  });

  test('a blank date', () => {
    assert.ok(keys(doc('quotations', { date: '' }), 'block').includes('date'));
    assert.ok(keys(doc('quotations', { date: '   ' }), 'block').includes('date'));
  });

  test('a line with no description, named by the number the editor shows', () => {
    const d = doc('quotations', {}, [line(), line({ description: '' }), line({ description: '  ' })]);
    const found = evaluate(d).find((f) => f.key === 'description');
    // 1-based and counting every line, charges included — the editor's own
    // numbering, not the internal position rule.
    assert.equal(found?.message, 'Line 2, 3 has no description.');
  });

  test('a document that is nothing but charges', () => {
    const d = doc('quotations', {}, [line({ is_charge: 1, description: 'Freight' })]);
    assert.ok(keys(d, 'block').includes('goods'));
  });

  test('a proforma or invoice with no quantity, or a zero total', () => {
    for (const table of ['proforma_invoices', 'commercial_invoices'] as const) {
      const noQty = doc(table, {}, [line({ qty: null, total_pcs: null })]);
      assert.ok(keys(noQty, 'block').includes('quantity'), table);
      assert.ok(keys(doc(table, { grand_total: 0 }), 'block').includes('total'), table);
    }
  });
});

describe('what deliberately does not stop one', () => {
  /**
   * The rule this codebase already states about itself: a quotation may carry
   * rates against no quantity at all. Blocking that would have refused every
   * price list on the day this shipped.
   */
  test('a price-only quotation, which is a documented shape', () => {
    const d = doc('quotations', {}, [line({ qty: null, total_pcs: null })]);
    assert.deepEqual(keys(d, 'block'), []);
  });

  test('a quotation with no total — it is an offer, not a demand', () => {
    assert.deepEqual(keys(doc('quotations', { grand_total: 0 }), 'block'), []);
  });

  test('a charge line needs no quantity of its own', () => {
    const d = doc('proforma_invoices', {}, [line(), line({ is_charge: 1, description: 'Freight', qty: null })]);
    assert.deepEqual(keys(d, 'block'), []);
  });

  test('a missing GSTIN or HSN warns and does not block', () => {
    const d: CheckedDoc = {
      ...doc('commercial_invoices', { tax_type: 'igst' }, [line({ hsn_code: '' })]),
      customer: { gstin: '' },
    };
    assert.deepEqual(keys(d, 'block'), []);
    assert.deepEqual(keys(d, 'warn'), ['gstin', 'hsn']);
  });

  test('and an export document says nothing about GSTIN or HSN at all', () => {
    const d: CheckedDoc = {
      ...doc('commercial_invoices', { tax_type: 'none', is_export: 1, port_of_loading: 'Kolkata',
        port_of_discharge: 'Hamburg', country_of_origin: 'India' }, [line({ hsn_code: '' })]),
      customer: { gstin: '' },
    };
    assert.deepEqual(keys(d), [], 'a zero-rated export has no GST to state');
  });
});

describe('the warnings each document type carries', () => {
  test('an export proforma wants its customs header, and refuses without a bank account', () => {
    const d = doc('proforma_invoices', { is_export: 1, bank_account: '', payment_terms: '' });
    assert.deepEqual(keys(d, 'warn'), ['origin', 'payment_terms', 'ports']);
    // Promoted from a warning 2026-09-07 at the client's word: a proforma that
    // does not say which account to pay cannot do the one job it has.
    assert.deepEqual(keys(d, 'block'), ['bank']);
  });

  test('and stating one satisfies it, leaving only the warnings', () => {
    const d = doc('proforma_invoices', { is_export: 1, bank_account: 'HDFC 50200012345678' });
    assert.deepEqual(keys(d, 'block'), []);
  });

  test('the commercial invoice is deliberately not asked for one', () => {
    const d = doc('commercial_invoices', { bank_account: '', tax_type: 'igst' });
    assert.equal(keys(d).includes('bank'), false);
  });

  test('and a domestic one is not asked about ports', () => {
    const d = doc('proforma_invoices', { is_export: 0, tax_type: 'igst', bank_account: 'HDFC 001' });
    assert.deepEqual(keys(d, 'warn'), []);
  });

  test('a quotation is asked for none of it', () => {
    assert.deepEqual(keys(doc('quotations', { is_export: 1, gstin: '', container_count: '1 X 40ft HQ' })), []);
  });

  test('the ports message names only the one that is missing', () => {
    const d = doc('commercial_invoices', { is_export: 1, port_of_loading: 'Kolkata', country_of_origin: 'India' });
    const found = evaluate(d).find((f) => f.key === 'ports');
    assert.equal(found?.message, 'No port of discharge stated.');
  });
});

describe('the refusal itself', () => {
  test('names the document and lists every blocking reason', () => {
    const c = makeCustomer();
    const id = makeInvoice({ customerId: c, currency: 'INR', total: 0 });
    // No items at all, and a zero total.
    const msg = incompleteError('commercial_invoices', id);
    assert.ok(msg?.startsWith('This invoice is not finished:'), msg ?? '(none)');
    assert.ok(msg?.includes('no line items'), msg ?? '');
    assert.ok(msg?.includes('total is zero'), msg ?? '');
  });

  test('is null once the document is finished, warnings notwithstanding', () => {
    const c = makeCustomer();
    const id = makeInvoice({ customerId: c, currency: 'INR', total: 500 });
    db.prepare(
      `INSERT INTO invoice_items (invoice_id, description, qty, unit, unit_price, amount, sort_order)
       VALUES (?, 'A thing', 10, 'unit', 50, 500, 0)`
    ).run(id);
    // The customer has no GSTIN and the line no HSN — both warnings, and the
    // invoice is domestic, so both fire. Neither may refuse the approval.
    db.prepare("UPDATE commercial_invoices SET tax_type = 'igst' WHERE id = ?").run(id);
    assert.equal(incompleteError('commercial_invoices', id), null);
  });

  test('and a document that no longer exists refuses nothing', () => {
    assert.equal(incompleteError('quotations', 999_999), null);
  });
});

/**
 * The Hard Stop: no commercial invoice for goods nobody inspected.
 *
 * The only rule in this table that reaches outside the document it is checking
 * — everything else reads the row and its lines, while this walks back to the
 * order and asks `qcBlockError` what it already tells the despatch register.
 * So these build real orders, jobs and checks rather than a synthetic
 * `CheckedDoc`, and most of them assert what is **not** blocked: this is a
 * blocking rule, and a blocking rule that fires wrongly stops a shipment.
 */
describe('nothing is invoiced until it has passed QC', () => {
  let seq = 0;

  const product = (spec: boolean) => {
    const id = Number((db.prepare(
      "INSERT INTO products (name, unit, unit_price) VALUES (?, 'per 1000', 10) RETURNING id"
    ).get(`28mm PCO ${++seq}`) as { id: number }).id);
    if (spec) {
      db.prepare(
        `INSERT INTO product_qc_params (product_id, name, kind, unit, min_value, max_value)
         VALUES (?, 'Neck diameter', 'numeric', 'mm', 27.9, 28.1)`
      ).run(id);
    }
    return id;
  };

  /** An order whose lines are the products given, in that order. */
  const order = (productIds: (number | null)[], charge = false) => {
    const id = Number((db.prepare(
      `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status)
       VALUES (?, '2026-09-01', ?, 1, 'INR', 'igst', 'confirmed') RETURNING id`
    ).get(`SO/QC-${++seq}`, makeCustomer()) as { id: number }).id);
    productIds.forEach((pid, i) => db.prepare(
      `INSERT INTO order_items (order_id, product_id, description, qty, unit, unit_price, amount,
                                total_pcs, is_charge, sort_order)
       VALUES (?, ?, ?, 100, 'per 1000', 10, 1000, 100000, ?, ?)`
    ).run(id, pid, pid ? 'Preform' : 'Freight', charge && i === 0 ? 1 : 0, i));
    return id;
  };

  const job = (orderId: number, pos = 0) => Number((db.prepare(
    `INSERT INTO work_orders (number, order_id, order_line, qty_planned, status)
     VALUES (?, ?, ?, 100000, 'released') RETURNING id`
  ).get(`WO/QC-${++seq}`, orderId, pos) as { id: number }).id);

  /** A check whose single reading is inside the tolerance, or outside it. */
  const check = (jobId: number, reading: number) => {
    const cid = Number((db.prepare(
      "INSERT INTO qc_checks (work_order_id, date) VALUES (?, '2026-09-02') RETURNING id"
    ).get(jobId) as { id: number }).id);
    db.prepare(
      `INSERT INTO qc_results (check_id, name, kind, unit, value, min_value, max_value)
       VALUES (?, 'Neck diameter', 'numeric', 'mm', ?, 27.9, 28.1)`
    ).run(cid, reading);
    return cid;
  };

  /** The invoice as this table sees it, pointing at an order. */
  const invoiceFor = (orderId: number, lines = 1) =>
    doc('commercial_invoices', { order_id: orderId },
      Array.from({ length: lines }, () => line({ description: 'Preform' })));

  const blocked = (d: CheckedDoc) => keys(d, 'block').includes('qc');

  test('a spec-carrying line with no work order at all is blocked', () => {
    assert.ok(blocked(invoiceFor(order([product(true)]))));
  });

  test('and a job that has been inspected and failed is still blocked', () => {
    const o = order([product(true)]);
    check(job(o), 30.5);   // outside 27.9–28.1
    assert.ok(blocked(invoiceFor(o)));
  });

  test('a passing check opens it', () => {
    const o = order([product(true)]);
    check(job(o), 28.0);
    assert.ok(!blocked(invoiceFor(o)));
  });

  /** The refusal names the line and says what to do, not merely that it failed. */
  test('the refusal says which line and what to record', () => {
    const o = order([product(true)]);
    const msg = incompleteError('commercial_invoices', 0);
    assert.equal(msg, null, 'an invoice that does not exist has nothing to refuse');
    const found = evaluate(invoiceFor(o)).find((f) => f.key === 'qc');
    assert.ok(found, 'no finding at all');
    assert.match(found.message, /has not passed QC yet, so it cannot be invoiced/);
    assert.match(found.message, /Record a passing quality check/);
  });

  /* ------------------------------------------------- what is NOT blocked */

  test('a product nobody has written a specification for', () => {
    assert.ok(!blocked(invoiceFor(order([product(false)]))));
  });

  test('an invoice with no order behind it', () => {
    const d = doc('commercial_invoices', {}, [line()]);
    assert.ok(!blocked(d), 'an invoice outside the order flow was refused');
  });

  test('a line past the end of the order, which has no counterpart to check', () => {
    const o = order([product(true)]);
    check(job(o), 28.0);
    // Two invoice lines against a one-line order: the second matches nothing,
    // and the chain skips such a line rather than refusing it.
    assert.ok(!blocked(invoiceFor(o, 2)));
  });

  test('a charge line, which is a fee and not goods', () => {
    // Freight first, so the goods line sits at position 1 — the index rule
    // counts charges, and numbering after filtering would gate the wrong line.
    const o = order([null, product(true)], true);
    check(job(o, 1), 28.0);
    assert.ok(!blocked(invoiceFor(o, 2)));
  });

  /**
   * The proforma is raised before anything is made, so gating it on QC would
   * refuse every advance this business collects.
   */
  test('and a proforma is never asked the question at all', () => {
    const o = order([product(true)]);
    assert.ok(!keys(doc('proforma_invoices', { order_id: o }), 'block').includes('qc'));
  });
});

/**
 * Every field on the quotation form is mandatory (the client, 2026-09-12), and
 * each blank is named on its own so the finding reads as a list of what to
 * fill in. On the quotation only: the proforma and the invoice were not on
 * the screen the instruction was given over.
 */
describe('the quotation mandatory fields', () => {
  const blanks: [string, string][] = [
    ['validity_date', 'validity'], ['payment_terms', 'q_payment_terms'], ['delivery_terms', 'delivery'],
    ['prepared_by', 'prepared_by'], ['inco_terms', 'inco'], ['notes', 'notes'],
  ];
  test('each blank field blocks the quotation by name', () => {
    for (const [field, key] of blanks) {
      assert.deepEqual(keys(doc('quotations', { [field]: '' }), 'block'), [key], `blank ${field}`);
    }
  });
  test('all six blank names all six, and a finished quotation names none', () => {
    const all = Object.fromEntries(blanks.map(([f]) => [f, '']));
    assert.deepEqual(keys(doc('quotations', all), 'block'), blanks.map(([, k]) => k).sort());
    assert.deepEqual(keys(doc('quotations'), 'block'), []);
  });
  test('containers on an export quotation only', () => {
    assert.deepEqual(keys(doc('quotations', { is_export: 1, container_count: '' }), 'block'), ['containers']);
    assert.deepEqual(keys(doc('quotations', { is_export: 1, container_count: '2 X 40ft HQ' }), 'block'), []);
    assert.deepEqual(keys(doc('quotations', { is_export: 0, container_count: '' }), 'block'), [], 'a domestic quotation was asked for containers');
  });

  test('the proforma and the invoice are not held to them', () => {
    for (const table of ['proforma_invoices', 'commercial_invoices'] as const) {
      const d = doc(table, { validity_date: '', delivery_terms: '', prepared_by: '', inco_terms: '', notes: '' });
      assert.deepEqual(keys(d, 'block'), [], table);
    }
  });
});
