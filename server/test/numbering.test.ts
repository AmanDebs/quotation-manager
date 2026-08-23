import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fiscalYearOf, nextNumber, seriesKey, setNextNumber, listSeries } from '../src/services/numbering.js';
import { db } from '../src/db/connection.js';

/**
 * Numbering is the part of the app a customer sees on paper, so a mistake here
 * is a mistake in somebody's books. The fiscal-year rules in particular were
 * got wrong once, in a way that only showed on one day of the year.
 */

describe('the Indian fiscal year', () => {
  test('runs April to March', () => {
    assert.equal(fiscalYearOf('2026-04-01').label, '26-27', 'the first day of the year');
    assert.equal(fiscalYearOf('2027-03-31').label, '26-27', 'and the last');
    assert.equal(fiscalYearOf('2027-04-01').label, '27-28');
  });

  test('a March document belongs to the year that is ending, whoever raises it in April', () => {
    assert.equal(fiscalYearOf('2026-03-31').label, '25-26');
  });

  /**
   * The date is parsed as digits rather than handed to `new Date()`, which
   * reads a bare date as UTC midnight and then answers getMonth() locally. On
   * any server behind UTC a 1 April document fell into the previous year.
   */
  test('1 April is read in the document’s own terms, not the server’s timezone', () => {
    assert.equal(fiscalYearOf('2026-04-01').label, '26-27');
    assert.equal(fiscalYearOf('2026-04-01').start, 2026);
  });

  test('a missing or malformed date falls back to today rather than throwing', () => {
    for (const bad of [null, undefined, '', 'not-a-date', '2026-13-01']) {
      assert.match(fiscalYearOf(bad).label, /^\d\d-\d\d$/, `input ${JSON.stringify(bad)}`);
    }
  });
});

describe('series keys', () => {
  test('export and domestic count separately where a type has both', () => {
    assert.equal(seriesKey('invoice', false), 'invoice');
    assert.equal(seriesKey('invoice', true), 'invoice_export');
  });
});

describe('issuing numbers', () => {
  test('the counter advances, and does not repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      seen.add(nextNumber('quotation', { companyId: 1, date: '2026-08-01' }));
    }
    assert.equal(seen.size, 5, 'five calls, five different numbers');
  });

  /**
   * Aglo's books use both widths. `{SEQ4}` is substituted before `{SEQ}`, or
   * the longer token would match the shorter one and leave a stray 4 behind.
   */
  test('{SEQ4} is four digits and does not decay into {SEQ} plus a 4', () => {
    db.prepare("UPDATE companies SET quote_pattern = 'AP/{SEQ4}/{FY}' WHERE id = 1").run();
    const n = nextNumber('quotation', { companyId: 1, date: '2026-08-01' });
    assert.match(n, /^AP\/\d{4}\/26-27$/, `got ${n}`);
    assert.ok(!n.includes('4/'), 'a stray 4 is the symptom of substituting in the wrong order');
  });

  test('padding is a minimum, so a series past 999 prints in full', () => {
    db.prepare("UPDATE companies SET quote_pattern = 'QT/{FY}/{SEQ}' WHERE id = 1").run();
    setNextNumber(1, 'quotation', 1200, { force: true });
    const n = nextNumber('quotation', { companyId: 1, date: '2026-08-01' });
    assert.equal(n, 'QT/26-27/1200', `got ${n}`);
  });

  /**
   * A back-dated invoice takes the next number in *that* year's series, so it
   * neither mislabels itself nor eats a number from the current year.
   */
  test('a back-dated document draws from its own year’s counter', () => {
    const thisYear = nextNumber('quotation', { companyId: 1, date: '2026-08-01' });
    const lastYear = nextNumber('quotation', { companyId: 1, date: '2026-02-01' });
    assert.match(thisYear, /26-27/);
    assert.match(lastYear, /25-26/);
    assert.notEqual(thisYear.split('/').pop(), undefined);
  });
});

describe('setting the counter by hand', () => {
  test('"next is N" is stored as N-1, so the next issued really is N', () => {
    setNextNumber(1, 'packing_list', 500, { force: true });
    const series = listSeries(1).find((s) => s.key === 'packing_list');
    assert.equal(series?.next_number, 500);
    const issued = nextNumber('packing_list', { companyId: 1, date: '2026-08-01' });
    assert.match(issued, /500$/, `got ${issued}`);
  });

  test('moving a series forward is allowed — taking over a book already in progress', () => {
    setNextNumber(1, 'packing_list', 900);
    assert.equal(listSeries(1).find((s) => s.key === 'packing_list')?.next_number, 900);
  });

  test('moving one backward is refused without force, since the collision surfaces later', () => {
    setNextNumber(1, 'packing_list', 900, { force: true });
    assert.throws(() => setNextNumber(1, 'packing_list', 100),
      /back|lower|already/i,
      'it would collide at save time, for whoever happened to be raising a document');
  });

  test('and allowed with it, because sometimes that is genuinely what you mean', () => {
    setNextNumber(1, 'packing_list', 100, { force: true });
    assert.equal(listSeries(1).find((s) => s.key === 'packing_list')?.next_number, 100);
  });
});
