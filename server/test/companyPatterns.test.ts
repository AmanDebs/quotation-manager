import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  nameTokens, defaultPatternsFor, PATTERN_COLUMNS, SCHEMA_DEFAULT_PATTERNS,
} from '../src/services/companyPatterns.js';

/**
 * No `helpers/scratch.js` import here, and that is the point of the module:
 * it touches no database, so `db/connection.ts` can use it for a boot
 * migration without closing an import circle.
 *
 * What is worth testing is the one thing that cannot be checked by reading:
 * that a derived pattern looks like something a person would have written,
 * and that the schema defaults this file carries a copy of have not drifted
 * away from the schema itself.
 */

describe('reading a company name', () => {
  /**
   * The only real patterns we have are Aglo's, and they were written by hand
   * long before this code. That the derivation reproduces them is the whole
   * evidence that it follows the convention rather than inventing one.
   */
  test('Aglo’s own name yields Aglo’s own tokens', () => {
    assert.deepEqual(nameTokens('Aglo Polymers Pvt Ltd'), { slug: 'AGLO', initials: 'AP' });
  });

  test('legal form is dropped, wherever it sits', () => {
    assert.equal(nameTokens('The Shakti Fabricators Private Limited').slug, 'SHAKTI');
    assert.equal(nameTokens('Emeraude Trading FZE').initials, 'ET');
  });

  test('a long first word is cut to six, so a series stays readable', () => {
    assert.equal(nameTokens('Internationale Kunststoff GmbH').slug, 'INTERN');
  });

  test('a one-letter first word falls back to the initials', () => {
    // "A/{FY}/{SEQ}" is a series nobody can read at a glance.
    assert.equal(nameTokens('A P Traders').slug, 'APT');
  });

  test('one significant word gives two-letter initials rather than one', () => {
    assert.deepEqual(nameTokens('Sanya Ltd'), { slug: 'SANYA', initials: 'SA' });
  });

  test('a name with nothing usable in it still numbers', () => {
    for (const bad of ['', '   ', '---', 'Pvt Ltd']) {
      assert.deepEqual(nameTokens(bad), { slug: 'CO', initials: 'CO' }, JSON.stringify(bad));
    }
  });
});

describe('the patterns a new company gets', () => {
  test('every series carries the company’s own token', () => {
    const p = defaultPatternsFor('Second Entity Pvt Ltd');
    assert.equal(p.pi_pattern, 'SECOND/PI/{FY}/{SEQ}');
    assert.equal(p.pi_export_pattern, 'SECOND/EX/{FY}/{SEQ}');
    assert.equal(p.inv_pattern, 'SE/{SEQ4}/{FY}');
    assert.equal(p.inv_export_pattern, 'SE/EX/{SEQ}/{FY}');
  });

  test('one is produced for every pattern column, and each carries a sequence', () => {
    const p = defaultPatternsFor('Bharat Engineering Works');
    for (const col of PATTERN_COLUMNS) {
      assert.ok(p[col], `${col} has no pattern`);
      assert.match(p[col], /\{SEQ4?\}/, `${col} would never advance`);
      assert.match(p[col], /\{FY\}/, `${col} would collide across fiscal years`);
    }
  });

  /**
   * Two companies sharing a pattern is the defect this exists to remove, so
   * two different names must not produce the same series.
   */
  test('two companies do not land on the same series', () => {
    const a = defaultPatternsFor('Aglo Polymers Pvt Ltd');
    const b = defaultPatternsFor('Second Entity Pvt Ltd');
    for (const col of PATTERN_COLUMNS) assert.notEqual(a[col], b[col], col);
  });

  /**
   * Names that genuinely read the same *will* collide — "Aglo Polymers" and
   * "Aglo Packaging" both give AGLO. That is not something a derivation can
   * solve, which is why Settings warns about a shared pattern rather than
   * this pretending it cannot happen.
   */
  test('and two names that read the same are left to the warning in Settings', () => {
    assert.equal(
      defaultPatternsFor('Aglo Polymers Pvt Ltd').pi_pattern,
      defaultPatternsFor('Aglo Packaging Pvt Ltd').pi_pattern
    );
  });
});

/**
 * The backfill decides whether a company was ever configured by comparing its
 * columns against these strings. If schema.sql moves and this copy does not,
 * the comparison silently stops matching and the migration quietly does
 * nothing — the worst kind of failure, because it looks like success.
 */
test('the copy of the schema defaults is still the schema', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schema = readFileSync(path.join(here, '..', 'src', 'db', 'schema.sql'), 'utf8');
  // The companies table only — `settings` carries the same column names.
  const table = /CREATE TABLE IF NOT EXISTS companies\s*\(([\s\S]*?)\n\);/.exec(schema);
  assert.ok(table, 'could not find the companies table in schema.sql');
  const declared = table[1].split(/\r?\n/).map((l) => l.trim());
  for (const col of PATTERN_COLUMNS) {
    // The line reads: col TEXT NOT NULL DEFAULT 'value',
    // Split on the quotes rather than matching, so the assertion cannot
    // itself be the thing that is wrong.
    const line = declared.find((l) => l.startsWith(col + ' '));
    assert.ok(line, col + ' is not declared in the companies table');
    assert.equal(line.split("'")[1], SCHEMA_DEFAULT_PATTERNS[col], col + ' has drifted from schema.sql');
  }
});
