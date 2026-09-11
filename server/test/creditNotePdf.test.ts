import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildCreditNotePdf } from '../src/services/pdf.js';
import { db } from '../src/db/connection.js';
import { makeCustomer, makeInvoice } from './helpers/factory.js';

/**
 * The credit note on paper. Built and read rather than rendered, like the
 * invoice's own tests: what has to be true is which words are on the page.
 */

type Node = Record<string, any>;

const flatten = (n: any, out: string[] = []): string[] => {
  if (n == null) return out;
  if (typeof n === 'string') { out.push(n); return out; }
  if (Array.isArray(n)) { n.forEach((x) => flatten(x, out)); return out; }
  if (typeof n === 'object') {
    for (const k of ['text', 'stack', 'ul', 'columns', 'table', 'body', 'content']) if (k in n) flatten(n[k], out);
  }
  return out;
};

function creditNote(o: { notes?: string; reason?: string; defaultTerms?: string }) {
  const c = makeCustomer();
  const inv = makeInvoice({ customerId: c, currency: 'INR', total: 1000, date: '2026-08-20' });
  db.prepare("UPDATE companies SET default_terms = ? WHERE id = 1").run(o.defaultTerms ?? '');
  const id = Number((db.prepare(
    `INSERT INTO credit_notes (number, date, invoice_id, customer_id, company_id, kind, reason, notes,
                               currency, tax_type, subtotal, tax_total, grand_total, approval_status)
     VALUES ('CN/26-27/001', '2026-09-10', ?, ?, 1, 'return', ?, ?, 'INR', 'igst', 500, 90, 590, 'approved') RETURNING id`
  ).get(inv, c, o.reason ?? '', o.notes ?? '') as { id: number }).id);
  db.prepare(
    `INSERT INTO credit_note_items (credit_note_id, description, qty, unit, unit_price, tax_pct, amount, sort_order)
     VALUES (?, '28mm Cap', 500, 'unit', 1, 18, 500, 0)`
  ).run(id);
  return { id, inv };
}

describe('the credit note states what GST requires', () => {
  test('its own number and date, the invoice it is against with its date, and the goods', () => {
    const { id } = creditNote({ reason: 'Short-shot caps, 500 pcs rejected' });
    const words = flatten((buildCreditNotePdf(id) as Node).content).join('\n');
    assert.match(words, /CREDIT NOTE/);
    assert.match(words, /CN\/26-27\/001/);
    assert.match(words, /INV\/\d+\s+dt\. 20-08-2026/, 'the original invoice and its date are not stated');
    assert.match(words, /Goods returned/);
    assert.match(words, /Qty Returned/);
    assert.match(words, /Short-shot caps, 500 pcs rejected/);
    assert.match(words, /TOTAL CREDIT/);
  });

  /**
   * The company's default terms are the terms of an *offer* — the clauses the
   * invoice stopped printing on 2026-09-08. A credit note offers nothing, so
   * they must not reach it from the company row; only its own notes print.
   */
  test('it prints its own notes and never the company default terms', () => {
    const { id } = creditNote({ notes: 'Replacement to follow on next consignment.', defaultTerms: 'Prices are ex-works.\nSubject to Kolkata jurisdiction.' });
    const words = flatten((buildCreditNotePdf(id) as Node).content).join('\n');
    assert.match(words, /Replacement to follow/);
    assert.doesNotMatch(words, /ex-works/);
    assert.doesNotMatch(words, /jurisdiction/);
  });

  test('with nothing to say, there is no NOTES heading over nothing', () => {
    const { id } = creditNote({ defaultTerms: 'Prices are ex-works.' });
    const words = flatten((buildCreditNotePdf(id) as Node).content).join('\n');
    assert.doesNotMatch(words, /NOTES:/);
    assert.doesNotMatch(words, /REASON FOR CREDIT/);
  });
});
