import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sweepQuotationExpiry, syncQuotationExpiry } from '../src/services/quotationExpiry.js';
import { db } from '../src/db/connection.js';
import { makeCustomer, makeQuotation, statusOf } from './helpers/factory.js';

/**
 * Expiry is the one status rule driven by a clock, so every test here passes
 * the date in rather than relying on today. A suite that only tests "now"
 * cannot test a boundary.
 */

const LAST_DAY = '2026-09-15';
const DAY_AFTER = '2026-09-16';
const before = (id: number) =>
  (db.prepare('SELECT status_before_expired FROM quotations WHERE id = ?').get(id) as
    { status_before_expired: string }).status_before_expired;

const cust = makeCustomer();
const quote = (status: string, validity = LAST_DAY, extra = {}) =>
  makeQuotation({ customerId: cust, status, validity, ...extra });

describe('what lapses', () => {
  test('a sent quotation, the day after its validity', () => {
    const q = quote('sent');
    sweepQuotationExpiry(LAST_DAY);
    assert.equal(statusOf('quotations', q), 'sent', 'the last day of validity is a day of validity');
    sweepQuotationExpiry(DAY_AFTER);
    assert.equal(statusOf('quotations', q), 'expired');
  });

  test('and one under negotiation', () => {
    const q = quote('negotiating');
    sweepQuotationExpiry(DAY_AFTER);
    assert.equal(statusOf('quotations', q), 'expired');
  });

  test('each remembering where it came from', () => {
    const q = quote('negotiating');
    sweepQuotationExpiry(DAY_AFTER);
    assert.equal(before(q), 'negotiating');
  });
});

describe('what never does', () => {
  test('a draft — it was never offered', () => {
    const q = quote('draft');
    sweepQuotationExpiry(DAY_AFTER);
    assert.equal(statusOf('quotations', q), 'draft');
  });

  test('an accepted quotation — the calendar does not undo a decision', () => {
    const q = quote('accepted');
    sweepQuotationExpiry(DAY_AFTER);
    assert.equal(statusOf('quotations', q), 'accepted');
  });

  test('a rejected one, for the same reason', () => {
    const q = quote('rejected');
    sweepQuotationExpiry(DAY_AFTER);
    assert.equal(statusOf('quotations', q), 'rejected');
  });

  test('one with no validity date at all', () => {
    const q = quote('sent', '');
    sweepQuotationExpiry('2099-01-01');
    assert.equal(statusOf('quotations', q), 'sent',
      'plenty are raised without one; reading silence as expiry would condemn the lot');
  });

  test('a superseded revision, which nobody can act on anyway', () => {
    const live = quote('sent', '2026-12-31');
    const old = quote('sent', LAST_DAY, { supersededBy: live });
    sweepQuotationExpiry(DAY_AFTER);
    assert.equal(statusOf('quotations', old), 'sent');
    assert.equal(before(old), '', 'and nothing is recorded against it to undo later');
  });
});

describe('extending the date brings it back', () => {
  test('to where it was, when the document may still be there', () => {
    const q = quote('expired', '2026-12-31', { before: 'sent', approval: 'approved' });
    sweepQuotationExpiry(DAY_AFTER);
    assert.equal(statusOf('quotations', q), 'sent');
    assert.equal(before(q), '', 'and the memory is cleared once used');
  });

  /**
   * Editing a document resets its approval, and `sent` is an outgoing status.
   * Putting it straight back would be an automatic path from unapproved to
   * outgoing, which is the one thing the approval gate exists to prevent.
   */
  test('but only as a draft when the approval was reset with it', () => {
    const q = quote('expired', '2026-12-31', { before: 'sent', approval: 'not_submitted' });
    sweepQuotationExpiry(DAY_AFTER);
    assert.equal(statusOf('quotations', q), 'draft');
  });

  test('and likewise while it waits for a manager', () => {
    const q = quote('expired', '2026-12-31', { before: 'negotiating', approval: 'pending' });
    sweepQuotationExpiry(DAY_AFTER);
    assert.equal(statusOf('quotations', q), 'draft');
  });

  test('clearing the date entirely revives it too', () => {
    const q = quote('expired', '', { before: 'sent', approval: 'approved' });
    sweepQuotationExpiry(DAY_AFTER);
    assert.equal(statusOf('quotations', q), 'sent');
  });

  test('one marked expired by hand stays expired', () => {
    const q = quote('expired', '2026-12-31', { before: '', approval: 'approved' });
    sweepQuotationExpiry(DAY_AFTER);
    assert.equal(statusOf('quotations', q), 'expired',
      'only an automatic expiry is automatically undone');
  });
});

test('the sweep is idempotent, which is the common case since it runs on every boot', () => {
  quote('sent');
  const first = sweepQuotationExpiry(DAY_AFTER);
  assert.ok(first.expired >= 1);
  const second = sweepQuotationExpiry(DAY_AFTER);
  assert.deepEqual(second, { expired: 0, revived: 0 });
});

test('one at a time agrees with the sweep about the same row', () => {
  const q = quote('sent');
  syncQuotationExpiry(q, LAST_DAY);
  assert.equal(statusOf('quotations', q), 'sent');
  syncQuotationExpiry(q, DAY_AFTER);
  assert.equal(statusOf('quotations', q), 'expired');
  syncQuotationExpiry(q, LAST_DAY);
  assert.equal(statusOf('quotations', q), 'sent', 'and back again, the same way');
});
