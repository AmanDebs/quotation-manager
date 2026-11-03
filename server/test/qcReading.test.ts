import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readingText } from '../src/services/pdf.js';

/**
 * How a result prints, on the certificate and on the quality report — one
 * formatter, so the two documents cannot describe the same reading
 * differently.
 *
 * Three shapes since 2026-10-16, and they come from Aglo's own certificates
 * rather than from a guess: a single reading (their preform COA), a **range**
 * observed across the batch (their cap COA records every dimension that way),
 * and **N/A**, which their preform COA states against acetaldehyde, overall
 * migration and colour migration.
 */
describe('what a quality result prints as', () => {
  test('a single reading carries its unit', () => {
    assert.equal(readingText({ kind: 'numeric', value: 170.05, unit: 'mm' }), '170.05 mm');
    assert.equal(readingText({ kind: 'numeric', value: 1.3, unit: '' }), '1.30');
  });

  test('a measurement carries two decimals, and keeps a third where it has one', () => {
    /* 2026-11-03, the client with the COA's dimensional block in front of
       them: *"All measurement - two decimals places"*. The Specification and
       the Actual columns of one row have to read as the same kind of number,
       so the reading pads exactly as the window beside it does. Three stays
       the maximum: a figure genuinely measured to a third decimal is not
       rounded away to meet a minimum. */
    assert.equal(readingText({ kind: 'numeric', value: 37.5, unit: 'mm' }), '37.50 mm');
    assert.equal(readingText({ kind: 'numeric', value: 22, unit: 'mm' }), '22.00 mm');
    assert.equal(readingText({ kind: 'numeric', value: 2.017, unit: 'gm' }), '2.017 gm');
    assert.equal(
      readingText({ kind: 'numeric', value: 50.2, value_max: 50.45, unit: 'mm' }),
      '50.20 – 50.45 mm'
    );
  });

  test('a range prints both ends, with the unit once', () => {
    assert.equal(
      readingText({ kind: 'numeric', value: 50.26, value_max: 50.45, unit: 'mm' }),
      '50.26 – 50.45 mm'
    );
    assert.equal(
      readingText({ kind: 'numeric', value: 4.12, value_max: 4.28, unit: 'gm' }),
      '4.12 – 4.28 gm'
    );
  });

  /**
   * The distinction the whole change turns on. Until 2026-10-16 a parameter
   * that did not apply was simply dropped before the insert, so the
   * certificate printed twelve lines where the paper prints fifteen — and
   * nothing could tell it from the rows nobody reached.
   */
  test('not applicable says so, and is not a dash', () => {
    assert.equal(readingText({ kind: 'numeric', value: null, na: 1, unit: 'ppm' }), 'N/A');
    // It wins over a reading, so a row carrying both cannot read as measured.
    assert.equal(readingText({ kind: 'numeric', value: 9.9, na: 1, unit: 'ppm' }), 'N/A');
  });

  test('nothing measured is a dash, which is a different claim', () => {
    assert.equal(readingText({ kind: 'numeric', value: null, unit: 'mm' }), '—');
  });

  test('a visual check is its own verdict', () => {
    assert.equal(readingText({ kind: 'boolean', value: 1 }), 'Pass');
    assert.equal(readingText({ kind: 'boolean', value: 0 }), 'Fail');
    // A range makes no sense on one, and is not printed if it somehow arrives.
    assert.equal(readingText({ kind: 'boolean', value: 1, value_max: 3 }), 'Pass');
  });
});
