import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { amountInWords } from '../src/services/amountInWords.js';

/**
 * This prints on the invoice, under the total, where a customer reads it. The
 * Indian system groups in lakh and crore rather than in millions, and an
 * export invoice in dollars must not.
 */

describe('rupees', () => {
  const inr = (n: number) => amountInWords(n, 'INR');

  test('the small ones — the currency leads, as on the document', () => {
    assert.equal(inr(1), 'Rupees One Only');
    assert.equal(inr(2), 'Rupees Two Only');
    assert.equal(inr(15), 'Rupees Fifteen Only');
    assert.equal(inr(90), 'Rupees Ninety Only');
  });

  test('groups in lakh, not in hundred thousand', () => {
    assert.match(inr(100000), /Lakh/i);
    assert.match(inr(250000), /Two Lakh Fifty Thousand/i);
  });

  test('and in crore above that', () => {
    assert.match(inr(10000000), /Crore/i);
    assert.match(inr(12500000), /One Crore Twenty Five Lakh/i);
  });

  test('paise are named, not left as a decimal', () => {
    const s = inr(1234.56);
    assert.match(s, /Paise/i);
    assert.match(s, /Fifty Six/i);
  });

  test('a whole amount says so rather than trailing "and zero paise"', () => {
    assert.doesNotMatch(inr(500), /Zero Paise/i);
  });

  test('zero is a word, not an empty string', () => {
    assert.match(inr(0), /Zero/i);
  });

  test('it ends the way a document should', () => {
    assert.match(inr(1500), /Only\.?$/i);
  });
});

describe('other currencies', () => {
  test('dollars are dollars and cents', () => {
    const s = amountInWords(1234.56, 'USD');
    assert.match(s, /Dollar/i);
    assert.match(s, /Cent/i);
    assert.doesNotMatch(s, /Rupee|Paise/i);
  });

  test('and are grouped in the international system, not in lakh', () => {
    const s = amountInWords(250000, 'USD');
    assert.doesNotMatch(s, /Lakh/i, 'an export invoice in dollars must not read in lakh');
    assert.match(s, /Thousand/i);
  });

  test('euros too', () => {
    assert.match(amountInWords(10, 'EUR'), /Euro/i);
  });
});

/**
 * Both of these were found by writing this file, not by anything going wrong
 * in production — which is rather the point of having it.
 */
describe('the edges that used to break it', () => {
  test('a negative amount reads as one instead of overflowing the stack', () => {
    // Math.floor rounds down, so -500 gave -1 crore and the recursion in
    // indianWords never reached zero. Any negative figure took the PDF down.
    assert.equal(amountInWords(-500, 'INR'), 'Minus Rupees Five Hundred Only');
    assert.equal(amountInWords(-1234.56, 'INR'),
      'Minus Rupees One Thousand Two Hundred Thirty Four and Fifty Six Paise Only');
  });

  test('rounding up from .995 carries instead of printing "undefined Paise"', () => {
    // A hundred paise is one rupee, and the lookup table stops at ninety-nine.
    assert.equal(amountInWords(99.999, 'INR'), 'Rupees One Hundred Only');
    assert.equal(amountInWords(1234.999, 'INR'), 'Rupees One Thousand Two Hundred Thirty Five Only');
    assert.doesNotMatch(amountInWords(1234.999, 'INR'), /undefined/);
  });

  test('and nothing in a plausible range throws or says undefined', () => {
    for (const n of [0, 0.005, 1, 99.994, 100, 1e5, 1e7 - 0.01, 1e9]) {
      for (const cur of ['INR', 'USD', 'EUR']) {
        const out = amountInWords(n, cur);
        assert.doesNotMatch(out, /undefined|NaN/, `${cur} ${n} → ${out}`);
      }
    }
  });
});
