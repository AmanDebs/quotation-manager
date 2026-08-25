import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { likeTerm, searchClause } from '../src/services/search.js';
import { db } from '../src/db/connection.js';

/**
 * The document lists' search box.
 *
 * Worth a file for one reason: `%` and `_` are LIKE's own wildcards, and the
 * escaping that makes them literal is easy to write in a way that type-checks
 * and still produces wrong SQL — the first attempt at it did exactly that,
 * having lost its backslashes on the way into the file. A unit test on the
 * term alone would not have caught it either, since the term can be perfect
 * while the ESCAPE clause names the wrong character. So the last describe
 * block runs the clause against a real table.
 */

describe('the term handed to LIKE', () => {
  test('an ordinary term is wrapped for a substring match', () => {
    assert.equal(likeTerm('Acme'), '%Acme%');
    assert.equal(likeTerm('003'), '%003%');
  });

  test('the wildcards are escaped, so they match themselves', () => {
    assert.equal(likeTerm('50%'), '%50\\%%');
    assert.equal(likeTerm('a_b'), '%a\\_b%');
  });

  test('and so is the escape character itself', () => {
    // Otherwise a term ending in a backslash escapes the closing wildcard.
    assert.equal(likeTerm('back\\slash'), '%back\\\\slash%');
  });

  test('an empty term is still a valid pattern', () => {
    assert.equal(likeTerm(''), '%%');
  });
});

describe('the clause', () => {
  test('is one OR across the columns given, with a param each', () => {
    const { sql, params } = searchClause(['q.number', 'c.name'], 'Acme');
    assert.match(sql, /q\.number LIKE \?/);
    assert.match(sql, /c\.name LIKE \?/);
    assert.match(sql, / OR /);
    assert.equal(params.length, 2, 'one bound param per column');
    assert.deepEqual(params, ['%Acme%', '%Acme%']);
  });

  test('every LIKE declares the escape character', () => {
    // One ESCAPE per LIKE: SQLite does not carry it across an OR.
    const { sql } = searchClause(['a', 'b'], 'x');
    assert.equal((sql.match(/LIKE \? ESCAPE '\\'/g) ?? []).length, 2);
  });

  test('it is parenthesised, so ANDing another filter cannot break it', () => {
    // Without the brackets, `scope AND a LIKE ? OR b LIKE ?` binds as
    // `(scope AND a) OR b` and the search would escape data scoping.
    const { sql } = searchClause(['a', 'b'], 'x');
    assert.ok(sql.startsWith('(') && sql.endsWith(')'), sql);
  });

  test('a blank term produces nothing, so a caller can push unconditionally', () => {
    for (const blank of ['', '   ']) {
      const { sql, params } = searchClause(['a'], blank);
      assert.equal(sql, '');
      assert.deepEqual(params, []);
    }
  });

  test('a term is trimmed — a trailing space is a typo, not a search', () => {
    assert.deepEqual(searchClause(['a'], '  Acme  ').params, ['%Acme%']);
  });

  test('no columns is not a clause', () => {
    assert.equal(searchClause([], 'Acme').sql, '');
  });
});

/**
 * The part a unit test cannot reach: whether SQLite agrees.
 */
describe('against a real table', () => {
  db.exec(`CREATE TABLE search_probe (name TEXT NOT NULL);
           INSERT INTO search_probe (name) VALUES
             ('Wild_Card 50% Traders'), ('WildXCard Ltd'), ('Acme Maschinenbau'),
             ('back\\slash co');`);

  const find = (term: string): string[] => {
    const { sql, params } = searchClause(['name'], term);
    if (!sql) return [];
    return (db.prepare(`SELECT name FROM search_probe WHERE ${sql} ORDER BY name`)
      .all(...(params as never[])) as { name: string }[]).map((r) => r.name);
  };

  test('an ordinary substring matches', () => {
    assert.deepEqual(find('Acme'), ['Acme Maschinenbau']);
  });

  test('LIKE is case-insensitive for ASCII, which is what a search box wants', () => {
    assert.deepEqual(find('acme'), ['Acme Maschinenbau']);
  });

  test('an underscore matches an underscore, not any character', () => {
    // The bug this file exists for: unescaped, `_` is "any one character" and
    // Wild_Card would have matched WildXCard too.
    assert.deepEqual(find('Wild_Card'), ['Wild_Card 50% Traders']);
    assert.deepEqual(find('WildXCard'), ['WildXCard Ltd']);
  });

  test('a bare underscore finds only the row that contains one', () => {
    assert.deepEqual(find('_'), ['Wild_Card 50% Traders']);
  });

  test('a percent sign matches a percent sign, not everything', () => {
    assert.deepEqual(find('50%'), ['Wild_Card 50% Traders']);
    assert.deepEqual(find('%'), ['Wild_Card 50% Traders']);
  });

  test('and a backslash is just a backslash', () => {
    assert.deepEqual(find('back\\slash'), ['back\\slash co']);
  });

  test('a term matching nothing returns nothing rather than everything', () => {
    assert.deepEqual(find('zzz'), []);
  });
});
