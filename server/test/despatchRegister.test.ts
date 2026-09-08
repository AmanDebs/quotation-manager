import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { SEA_LEG, SEA_LEG_D } from '../src/routes/despatches.js';
import { searchClause } from '../src/services/search.js';
import { makeCustomer } from './helpers/factory.js';

/**
 * The despatch register's two rules that are expressed in SQL.
 *
 * The register is paged, so both have to be answerable in the query rather
 * than over the rows already fetched — the same reason `qcRegister.test.ts`
 * carries `RESULT_FAILED_SQL` beside `resultOk`. What makes that safe is not
 * assuming the copies agree: `SEA_LEG` and `SEA_LEG_D` are one predicate
 * written for two contexts (a CTE over the list, and the joined list itself),
 * so these run both over the same fixtures and assert they pick the same rows.
 */

const order = (customerId: number, number = `SO/${Math.random().toString(36).slice(2, 7)}`) =>
  (db.prepare(
    `INSERT INTO orders (number, date, customer_id, currency, tax_type, status)
     VALUES (?, '2026-09-01', ?, 'INR', 'igst', 'confirmed') RETURNING id`
  ).get(number, customerId) as { id: number }).id;

interface TripInput {
  bl_no?: string; container_no?: string; etd?: string; eta?: string;
  docs_status?: string; cn_no?: string; vehicle_no?: string; destination?: string;
}

const trip = (orderId: number, t: TripInput = {}) =>
  (db.prepare(
    `INSERT INTO despatches (order_id, date, destination, cn_no, vehicle_no,
                             bl_no, container_no, etd, eta, docs_status)
     VALUES (?, '2026-09-02', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).get(orderId, t.destination ?? '', t.cn_no ?? '', t.vehicle_no ?? '',
    t.bl_no ?? '', t.container_no ?? '', t.etd ?? '', t.eta ?? '', t.docs_status ?? '') as { id: number }).id;

/*
 * Ids matching a WHERE fragment, run the two ways the route runs them: over a
 * CTE of the list (which carries no alias) and over the joined list itself
 * (which does). Both narrow to one order, because `describe` bodies run at
 * collection time and every block in this file shares one database — without
 * that, the second block's fixtures are already on the table when the first
 * block's assertions run.
 */
const viaCte = (where: string, orderId: number) => db.prepare(
  `WITH f AS (SELECT d.* FROM despatches d WHERE d.order_id = ?)
   SELECT id FROM f WHERE ${where} ORDER BY id`
).all(orderId).map((r) => (r as { id: number }).id);

const viaJoin = (where: string, orderId: number, params: unknown[] = []) => db.prepare(
  `SELECT d.id FROM despatches d
     JOIN orders o ON o.id = d.order_id
     JOIN customers c ON c.id = o.customer_id
    WHERE d.order_id = ? AND ${where} ORDER BY d.id`
).all(orderId, ...(params as never[])).map((r) => (r as { id: number }).id);

describe('what counts as a shipment rather than a lorry', () => {
  const cust = makeCustomer('Sea Customer');
  const ord = order(cust);
  const lorry = trip(ord, { cn_no: 'LR-4471', vehicle_no: 'WB11E9648', destination: 'Hazipur' });
  const blOnly = trip(ord, { bl_no: 'MEDUJB634981' });
  const containerOnly = trip(ord, { container_no: 'CII0203549' });
  const etaOnly = trip(ord, { eta: '2026-11-14' });
  const etdOnly = trip(ord, { etd: '2026-10-02' });
  const received = trip(ord, { container_no: 'CII0203550', docs_status: 'received' });
  const sent = trip(ord, { bl_no: 'MEDUJB634982', docs_status: 'sent' });

  test('any one of the four sea columns is enough, and none of them is not', () => {
    const sea = viaCte(SEA_LEG, ord);
    assert.deepEqual(sea, [blOnly, containerOnly, etaOnly, etdOnly, received, sent]);
    assert.ok(!sea.includes(lorry), 'a domestic lorry was counted as a shipment');
  });

  /**
   * The two spellings are one rule. They differ only by the `d.` alias, which
   * the CTE must not have and the joined query must — so the check that keeps
   * them honest is that they answer identically.
   */
  test('the aliased and unaliased spellings pick the same trips', () => {
    assert.deepEqual(viaJoin(SEA_LEG_D, ord), viaCte(SEA_LEG, ord));
  });

  /**
   * The defect this predicate exists to fix. `docs_status <> 'received'` over
   * the whole register answers "every domestic trip ever made", each of which
   * has a blank status and always will.
   */
  test('documents outstanding means shipments outstanding, not every lorry', () => {
    const pending = viaJoin(`${SEA_LEG_D} AND COALESCE(d.docs_status, '') <> 'received'`, ord);
    assert.ok(!pending.includes(lorry), 'the lorry is back in the chase list');
    assert.ok(!pending.includes(received), 'a shipment already cleared is being chased');
    // Sent but not yet with the buyer is exactly the row worth chasing, and so
    // is one whose documents have not gone at all.
    assert.ok(pending.includes(sent), 'a shipment sent but not received should still be pending');
    assert.ok(pending.includes(blOnly), 'a shipment with no documents sent at all should be pending');
    assert.equal(
      pending.length,
      viaCte(`${SEA_LEG} AND COALESCE(docs_status, '') <> 'received'`, ord).length,
      'the count over the table and the rows returned disagree',
    );
  });

  test('the naive version is what would have been wrong', () => {
    assert.ok(viaJoin("COALESCE(d.docs_status, '') <> 'received'", ord).includes(lorry),
      'fixture is not exercising the bug this predicate fixes');
  });
});

describe('what the register can be searched by', () => {
  const COLUMNS = ['d.container_no', 'd.bl_no', 'd.cn_no', 'd.vehicle_no', 'o.number', 'c.name', 'd.destination'];
  const cust = makeCustomer('Emeraude Trading');
  const ord = order(cust, 'SO/26-27/091');
  const sea = trip(ord, { bl_no: 'MEDUJB634981', container_no: 'CII0203549', destination: 'Mogadishu' });
  const road = trip(ord, { cn_no: 'LR-4471', vehicle_no: 'WB11E9648', destination: 'Hazipur' });

  const find = (term: string, orderId = ord) => {
    const s = searchClause(COLUMNS, term);
    return s.sql ? viaJoin(s.sql, orderId, s.params) : [];
  };

  test('every handle somebody might have in hand finds its trip', () => {
    const cases: [string, number][] = [
      ['CII0203549', sea], ['MEDUJB', sea], ['Mogadishu', sea],
      ['LR-4471', road], ['WB11E9648', road], ['Hazipur', road],
    ];
    for (const [term, expected] of cases) {
      assert.ok(find(term).includes(expected), `"${term}" did not find its despatch`);
    }
  });

  test('and our own references find both trips on the order', () => {
    for (const term of ['SO/26-27/091', 'Emeraude']) {
      const hits = find(term);
      assert.ok(hits.includes(sea) && hits.includes(road), `"${term}" missed a trip`);
    }
  });

  /** LIKE's own wildcards, made literal — otherwise either matches everything. */
  test('percent and underscore are characters, not wildcards', () => {
    assert.equal(find('%').length, 0, 'a bare % matched rows instead of the character');
    assert.equal(find('CII_203549').length, 0, 'an underscore matched a character instead of itself');
    assert.ok(find('CII0203549').includes(sea), 'the escaping broke an ordinary term');
  });

  /**
   * The bracket is what keeps a search from being a way past data scoping:
   * `scope AND a LIKE ? OR b LIKE ?` binds as `(scope AND a) OR b`.
   */
  test('the clause is bracketed, so a scope beside it still holds', () => {
    const other = order(makeCustomer('Somebody Else'), 'SO/26-27/092');
    const hidden = trip(other, { destination: 'Mogadishu' });
    const s = searchClause(COLUMNS, 'Mogadishu');
    const scoped = db.prepare(
      `SELECT d.id FROM despatches d
         JOIN orders o ON o.id = d.order_id
         JOIN customers c ON c.id = o.customer_id
        WHERE o.customer_id = ? AND ${s.sql} ORDER BY d.id`
    ).all(cust, ...(s.params as never[])).map((r) => (r as { id: number }).id);
    assert.ok(scoped.includes(sea), 'the search stopped finding its own row');
    assert.ok(!scoped.includes(hidden), 'the search reached another owner’s despatch');
  });
});
