import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { resultOk, RESULT_FAILED_SQL } from '../src/services/qc.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * The register filters and counts in the database, because it is paged — a
 * verdict computed after the rows were fetched could only ever judge one page.
 * That means `resultOk` exists twice, once in TypeScript and once in SQL, and
 * this file is the reason that is allowed: the two are run over the same
 * matrix and asserted to answer identically.
 */

const orderId = Number(db.prepare(
  "INSERT INTO orders (number, date, customer_id, currency) VALUES ('SO/REG/1', '2026-09-05', ?, 'INR')"
).run(makeCustomer()).lastInsertRowid);
const woId = Number(db.prepare(
  `INSERT INTO work_orders (number, order_id, order_line, description, qty_planned, status)
   VALUES ('WO/REG/1', ?, 0, 'x', 1000, 'released')`
).run(orderId).lastInsertRowid);
const check = Number(db.prepare(
  "INSERT INTO qc_checks (work_order_id, date, shift, inspector) VALUES (?, '2026-09-05', 'A', '')"
).run(woId).lastInsertRowid);

interface Row {
  kind: string; value: number | null; min_value: number | null; max_value: number | null;
  value_max?: number | null; na?: number;
}

/** The SQL half, asked about one row. */
function sqlFailed(r: Row) {
  const id = Number(db.prepare(
    `INSERT INTO qc_results (check_id, name, kind, unit, value, value_max, na, min_value, max_value, sort_order)
     VALUES (?, 'x', ?, '', ?, ?, ?, ?, ?, 0)`
  ).run(check, r.kind, r.value, r.value_max ?? null, r.na ?? 0, r.min_value, r.max_value).lastInsertRowid);
  const row = db.prepare(
    `SELECT CASE WHEN (${RESULT_FAILED_SQL}) THEN 1 ELSE 0 END AS failed
       FROM qc_results r WHERE r.id = ?`
  ).get(id) as { failed: number };
  db.prepare('DELETE FROM qc_results WHERE id = ?').run(id);
  return row.failed === 1;
}

describe('the SQL verdict and resultOk agree', () => {
  test('across kinds, readings and open-ended bounds', () => {
    const kinds = ['numeric', 'boolean'];
    const values: (number | null)[] = [null, 0, 1, 0.29, 0.3, 0.4, 0.5, 0.51, 2, -1];
    // The upper end of a ranged observation. `undefined` is the shape every
    // check already on file has, so the matrix still covers the old rows.
    const uppers: (number | null | undefined)[] = [undefined, null, 0.45, 0.52];
    const bounds: [number | null, number | null][] = [
      [null, null],   // no tolerance recorded at all
      [0.3, 0.5],     // both ends
      [0.3, null],    // a floor and no ceiling — a wall can only be too thin
      [null, 0.5],    // a ceiling and no floor
      [0.4, 0.4],     // exact
    ];

    let cases = 0;
    for (const kind of kinds) {
      for (const value of values) {
        for (const [min_value, max_value] of bounds) {
          for (const value_max of uppers) {
            const r: Row = { kind, value, min_value, max_value, value_max };
            const ok = resultOk(r);
          /*
           * The mapping the register relies on. `resultOk` has three answers
           * and the SQL has two, and this is where they meet: a reading that
           * was never taken is **not** a failure — it is not a pass either,
           * which is why the route counts `measured` separately rather than
           * reading "not failed" as "passed".
           */
            assert.equal(sqlFailed(r), ok === false,
              `${kind} ${value}–${value_max} in [${min_value}, ${max_value}]`);
            cases++;
          }
        }
      }
    }
    assert.equal(cases, 400);
  });

  /**
   * The two answers added on 2026-10-16, from Aglo's own certificates: a
   * characteristic observed as a range across the batch, and *not applicable*
   * as a recorded answer. Both have to mean the same thing to the register as
   * they do to `resultOk`, or a check reads one way on screen and another in
   * the list that filters it.
   */
  test('a ranged observation is judged on both ends', () => {
    const within: Row = { kind: 'numeric', value: 0.35, value_max: 0.45, min_value: 0.3, max_value: 0.5 };
    assert.equal(resultOk(within), true);
    assert.equal(sqlFailed(within), false);

    // The highest piece over the ceiling fails, though the lowest is fine.
    const high: Row = { kind: 'numeric', value: 0.35, value_max: 0.55, min_value: 0.3, max_value: 0.5 };
    assert.equal(resultOk(high), false);
    assert.equal(sqlFailed(high), true);

    // And the lowest under the floor fails, though the highest is fine.
    const low: Row = { kind: 'numeric', value: 0.25, value_max: 0.45, min_value: 0.3, max_value: 0.5 };
    assert.equal(resultOk(low), false);
    assert.equal(sqlFailed(low), true);
  });

  test('not applicable is neither a pass nor a failure', () => {
    const na: Row = { kind: 'numeric', value: null, na: 1, min_value: 0.3, max_value: 0.5 };
    assert.equal(resultOk(na), null, 'it decides nothing');
    assert.equal(sqlFailed(na), false, 'and it is certainly not a failure');

    /*
     * The one that would be a silent wrong answer: a row carrying both a
     * reading **and** the NA flag — which the route cannot produce, but a
     * hand-written row or an older client could. NA wins, in both halves, so
     * the two cannot disagree about it.
     */
    const both: Row = { kind: 'numeric', value: 9.9, na: 1, min_value: 0.3, max_value: 0.5 };
    assert.equal(resultOk(both), null);
    assert.equal(sqlFailed(both), false);
  });

  /** The distinction the whole feature turns on, stated on its own. */
  test('and nothing measured is not a failure, which is not the same as a pass', () => {
    const r = { kind: 'numeric', value: null, min_value: 0.3, max_value: 0.5 };
    assert.equal(resultOk(r), null);
    assert.equal(sqlFailed(r), false);
  });
});
