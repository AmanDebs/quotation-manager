import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalExempt, exemptApprovalError, blockUnapprovedTransition, blockUnapprovedConversion,
} from '../src/services/approval.js';
import { incompleteError } from '../src/services/documentChecks.js';
import { db } from '../src/db/connection.js';
import { makeCustomer, makeQuotation, makeProforma, makeInvoice } from './helpers/factory.js';
import type { AuthedRequest } from '../src/middleware/auth.js';

/**
 * A domestic document goes through no approval (2026-09-25, the client:
 * *"Remove approval for domestic"*).
 *
 * Most of these assert what is **not** exempt, for the reason every guard in
 * this codebase is tested that way round: exempting a table by mistake here
 * refuses nothing — it silently stops a rule that money or goods depend on,
 * which is the failure nobody notices.
 */

const cust = makeCustomer();
// Somebody who may not approve, so the guards answer on the rule rather than
// on the manager pass-through.
const floor = { user: { id: 1, team_role: 'production' } } as unknown as AuthedRequest;

const domesticPi = () => makeProforma({ customerId: cust, currency: 'INR', total: 1000 });
const exportPi = () => {
  const id = makeProforma({ customerId: cust, currency: 'EUR', total: 1000 });
  db.prepare('UPDATE proforma_invoices SET is_export = 1 WHERE id = ?').run(id);
  return id;
};

/** A quotation with every mandatory field filled in, asserted rather than assumed. */
function finishedQuotation(isExport = 0): number {
  const id = makeQuotation({ customerId: cust, status: 'draft', approval: 'not_submitted', isExport });
  db.prepare(
    `UPDATE quotations SET validity_date = '2026-12-31', payment_terms = '30 Days Credit',
       delivery_terms = 'Within 2 weeks from order', prepared_by = 'R. Das', inco_terms = 'EX-Works',
       notes = 'Subject to Kolkata jurisdiction.', container_count = '1 X 40FT HC', grand_total = 1000
     WHERE id = ?`
  ).run(id);
  db.prepare(
    `INSERT INTO quotation_items (quotation_id, description, color, qty, unit, unit_price, amount, sort_order)
     VALUES (?, 'A thing', 'Natural', 10, 'unit', 100, 1000, 0)`
  ).run(id);
  assert.equal(incompleteError('quotations', id), null, 'the fixture has to be a finished document');
  return id;
}

describe('which documents answer to approval at all', () => {
  test('a domestic quotation and proforma do not', () => {
    assert.equal(approvalExempt('quotations', makeQuotation({ customerId: cust, status: 'draft' })), true);
    assert.equal(approvalExempt('proforma_invoices', domesticPi()), true);
  });

  test('an export quotation and proforma do', () => {
    assert.equal(approvalExempt('quotations', makeQuotation({ customerId: cust, status: 'draft', isExport: 1 })), false);
    assert.equal(approvalExempt('proforma_invoices', exportPi()), false);
  });

  /**
   * The commercial invoice has been export-only since 2026-09-16, so there is
   * no domestic one to exempt — and `invoiceStatus.ts` reads the approval to
   * promote an invoice to `paid`, so exempting the rows already on file would
   * stop a legacy domestic invoice ever being marked paid.
   */
  test('a commercial invoice never is, whatever its type', () => {
    const id = makeInvoice({ customerId: cust, currency: 'INR', total: 100 });
    assert.equal(approvalExempt('commercial_invoices', id), false);
  });

  /**
   * And a credit note's approval is not permission to send it — it is what
   * moves the money (`CREDITED_SQL`, `returnedQtyByLine`, the finished-goods
   * ledger). A domestic note exempted from approval would credit nothing, with
   * no way left to make it credit.
   */
  test('and neither does a credit note, which is the important one', () => {
    const inv = makeInvoice({ customerId: cust, currency: 'INR', total: 100 });
    const info = db.prepare(
      `INSERT INTO credit_notes (number, date, customer_id, company_id, invoice_id, currency, kind, grand_total)
       VALUES ('CN/1', '2026-09-01', ?, 1, ?, 'INR', 'return', 100)`
    ).run(cust, inv);
    assert.equal(approvalExempt('credit_notes', Number(info.lastInsertRowid)), false);
  });

  test('a document that is not there is not exempt, so the callers still say so', () => {
    assert.equal(approvalExempt('quotations', 999_999), false);
    assert.equal(blockUnapprovedTransition('quotations', 999_999, 'sent', floor), 'Document not found');
  });
});

describe('what an exempt document may do', () => {
  test('a domestic quotation goes out without being approved', () => {
    const q = makeQuotation({ customerId: cust, status: 'draft', approval: 'not_submitted' });
    assert.equal(blockUnapprovedTransition('quotations', q, 'sent', floor), null);
  });

  test('where an export one is still refused by name', () => {
    const q = makeQuotation({ customerId: cust, status: 'draft', approval: 'not_submitted', isExport: 1 });
    assert.equal(
      blockUnapprovedTransition('quotations', q, 'sent', floor),
      'Submit this document for manager approval before sending it'
    );
  });

  test('a domestic proforma reaches its own outgoing statuses too', () => {
    assert.equal(blockUnapprovedTransition('proforma_invoices', domesticPi(), 'sent', floor), null);
    assert.equal(
      blockUnapprovedTransition('proforma_invoices', exportPi(), 'sent', floor),
      'Submit this document for manager approval before sending it'
    );
  });

  test('a status that is not outgoing was never gated on either count', () => {
    assert.equal(blockUnapprovedTransition('quotations', finishedQuotation(1), 'draft', floor), null);
  });
});

/**
 * Conversion is the one place the completeness gate stays, and it has to:
 * raising a proforma **locks** the quotation, so an unfinished one converted
 * would be frozen unfinished with nothing left that could print it.
 */
describe('converting an exempt document', () => {
  test('a finished domestic quotation converts unapproved', () => {
    assert.equal(blockUnapprovedConversion('quotations', finishedQuotation(), floor), null);
  });

  test('an unfinished one is still refused, and names what is missing', () => {
    const q = makeQuotation({ customerId: cust, status: 'draft', approval: 'not_submitted' });
    const msg = blockUnapprovedConversion('quotations', q, floor);
    assert.ok(msg?.startsWith('This quotation is not finished:'), msg ?? '(none)');
    assert.ok(msg?.includes('no line items'), msg ?? '');
  });

  test('where an export one is refused for the approval instead', () => {
    assert.equal(
      blockUnapprovedConversion('quotations', finishedQuotation(1), floor),
      'Submit this quotation for manager approval before converting it'
    );
  });

  test('and asking about an exempt document writes nothing', () => {
    const q = finishedQuotation();
    blockUnapprovedConversion('quotations', q, floor);
    const row = db.prepare('SELECT approval_status, approved_by FROM quotations WHERE id = ?').get(q) as
      { approval_status: string; approved_by: number | null };
    // Nothing is stored: an approval nobody gave has no approver to name.
    assert.equal(row.approval_status, 'not_submitted');
    assert.equal(row.approved_by, null);
  });
});

describe('the refusal the submit and approve routes carry', () => {
  test('names the document in its own word', () => {
    assert.equal(
      exemptApprovalError('quotations', makeQuotation({ customerId: cust, status: 'draft' })),
      'A domestic quotation does not go through approval — set its status directly.'
    );
    assert.ok(exemptApprovalError('proforma_invoices', domesticPi())?.includes('domestic proforma'));
  });

  test('and is silent about a document that does go through it', () => {
    const exportQuote = makeQuotation({ customerId: cust, status: 'draft', isExport: 1 });
    assert.equal(exemptApprovalError('quotations', exportQuote), null);
    assert.equal(exemptApprovalError('commercial_invoices', makeInvoice({ customerId: cust, currency: 'INR', total: 100 })), null);
  });
});
