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
    assert.equal(readingText({ kind: 'numeric', value: 1.3, unit: '' }), '1.3');
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
