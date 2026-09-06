import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { sameCurrency, currencyMismatchSql } from '../src/services/receivables.js';

/**
 * The register restates one rule in SQL — whether a payment counts against the
 * document it sits on — because the list is paged and a verdict derived after
 * the fetch could only judge the page in hand. Two copies of a rule is what
 * this codebase normally refuses, and the price of the exception is this file:
 * the two are run over the same values and asserted to answer identically,
 * exactly as `qcRegister.test.ts` does for `resultOk` and its SQL twin.
 */

db.exec('CREATE TABLE parity (pay TEXT, doc TEXT)');

const CURRENCIES = ['INR', 'EUR', 'USD', '', '  ', ' INR ', 'inr'];

const sqlMismatch = (pay: string | null, doc: string | null): boolean => {
  db.prepare('DELETE FROM parity').run();
  db.prepare('INSERT INTO parity (pay, doc) VALUES (?, ?)').run(pay, doc);
  const row = db.prepare(
    `SELECT ${currencyMismatchSql('pay', 'doc')} AS mismatched FROM parity`
  ).get() as { mismatched: number };
  return row.mismatched === 1;
};

describe('the SQL twin of sameCurrency', () => {
  test('answers identically over every combination', () => {
    let cases = 0;
    for (const pay of CURRENCIES) {
      for (const doc of CURRENCIES) {
        // `sameCurrency` is only ever asked about a document that exists, and
        // a document always has a currency — the blank ones here stand for a
        // legacy row, which is the case the rule is careful about.
        assert.equal(
          sqlMismatch(pay, doc),
          !sameCurrency(pay, doc),
          `pay ${JSON.stringify(pay)} against doc ${JSON.stringify(doc)}`,
        );
        cases += 1;
      }
    }
    assert.equal(cases, CURRENCIES.length ** 2);
  });

  test('a blank payment currency is not a mismatch', () => {
    // Payments inherit their currency from the document, so an empty one can
    // only be a row predating that rule — calling it a mismatch would report
    // months of correct history as broken.
    assert.equal(sqlMismatch('', 'EUR'), false);
    assert.equal(sqlMismatch(null, 'EUR'), false);
    assert.equal(sameCurrency('', 'EUR'), true);
  });

  test('a payment against no document at all cannot mismatch', () => {
    // Nothing to disagree with. The POST refuses such a payment, but a NULL
    // reaching a CASE and quietly reading as true is how a report comes to
    // flag every row it cannot classify.
    assert.equal(sqlMismatch('INR', null), false);
  });

  test('and a differing currency is one, whitespace notwithstanding', () => {
    assert.equal(sqlMismatch('INR', 'EUR'), true);
    assert.equal(sqlMismatch(' INR ', 'INR'), false, 'padding is trimmed on both sides');
    assert.equal(sqlMismatch('inr', 'INR'), true, 'and the codes are compared as written');
  });
});
