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
  row: { date: '2026-09-01', grand_total: 1000, tax_type: 'none', is_export: 0, payment_terms: '30 days', ...row },
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
  test('an export proforma wants its customs header and a bank account', () => {
    const d = doc('proforma_invoices', { is_export: 1, bank_account: '', payment_terms: '' });
    assert.deepEqual(keys(d, 'warn'), ['bank', 'origin', 'payment_terms', 'ports']);
    assert.deepEqual(keys(d, 'block'), []);
  });

  test('and a domestic one is not asked about ports', () => {
    const d = doc('proforma_invoices', { is_export: 0, tax_type: 'igst', bank_account: 'HDFC 001' });
    assert.deepEqual(keys(d, 'warn'), []);
  });

  test('a quotation is asked for none of it', () => {
    assert.deepEqual(keys(doc('quotations', { is_export: 1, payment_terms: '' })), []);
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
