import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pageRequest, countOf, listBody, type Paged } from '../src/services/pagination.js';
import { db } from '../src/db/connection.js';
import { makeCustomer, makeQuotation } from './helpers/factory.js';

/**
 * The contract is that paging is opt-in, and that the pages are a partition of
 * the list: same rows, same order, none twice, none missing.
 */

const cust = makeCustomer();
for (let i = 0; i < 37; i++) {
  makeQuotation({ customerId: cust, status: i % 3 === 0 ? 'sent' : 'draft' });
}
const SQL = 'SELECT id, number, status FROM quotations';
const ORDER = 'ORDER BY id';
const paged = (query: Record<string, unknown>, sql = SQL, params: unknown[] = []) =>
  listBody(query, { sql, order: ORDER, params }) as Paged<{ id: number }>;

describe('opting in', () => {
  test('no page and no limit means the whole list, as a bare array', () => {
    const body = listBody({}, { sql: SQL, order: ORDER });
    assert.ok(Array.isArray(body), 'a picker needs every row, and must not be handed a page');
    assert.equal(body.length, 37);
  });

  test('either one is enough to ask', () => {
    assert.equal(pageRequest({}), null);
    assert.deepEqual(pageRequest({ page: '2' }), { page: 2, limit: 50 });
    assert.deepEqual(pageRequest({ limit: '10' }), { page: 1, limit: 10 });
  });

  test('nonsense reads as the first page rather than a 400', () => {
    for (const page of ['abc', '-3', '0', '1.7']) {
      assert.equal(pageRequest({ page })?.page, 1, `page=${page}`);
    }
  });

  test('the limit is capped, and never zero', () => {
    assert.equal(pageRequest({ limit: '5000' })?.limit, 200);
    assert.equal(pageRequest({ limit: '0' })?.limit, 50);
    assert.equal(pageRequest({ limit: '-4' })?.limit, 1);
  });
});

describe('the pages partition the list', () => {
  test('walking them returns the same rows in the same order', () => {
    const whole = db.prepare(`${SQL} ${ORDER}`).all() as { id: number }[];
    const first = paged({ page: 1, limit: 10 });
    const walked: { id: number }[] = [...first.rows];
    for (let p = 2; p <= first.pages; p++) walked.push(...paged({ page: p, limit: 10 }).rows);

    assert.equal(walked.length, whole.length);
    assert.deepEqual(walked.map((r) => r.id), whole.map((r) => r.id));
    assert.equal(new Set(walked.map((r) => r.id)).size, walked.length, 'no row on two pages');
  });

  test('total is the whole list and pages follows from it', () => {
    const p = paged({ page: 1, limit: 10 });
    assert.equal(p.total, 37);
    assert.equal(p.pages, 4);
    assert.equal(p.rows.length, 10);
  });

  test('the last page holds the remainder', () => {
    assert.equal(paged({ page: 4, limit: 10 }).rows.length, 7);
  });
});

describe('filters apply before the page is cut', () => {
  test('total counts the filtered list, not the whole one', () => {
    const p = paged({ page: 1, limit: 5 }, `${SQL} WHERE status = ?`, ['sent']);
    const expected = (db.prepare("SELECT COUNT(*) n FROM quotations WHERE status = 'sent'").get() as { n: number }).n;
    assert.equal(p.total, expected);
    assert.ok(p.total < 37, 'counting before filtering is the classic pager bug');
  });
});

describe('a page past the end', () => {
  test('is clamped to the last one rather than served empty', () => {
    const p = paged({ page: 999, limit: 10 });
    assert.equal(p.page, 4, 'and the response says which page it actually gave');
    assert.ok(p.rows.length > 0, 'an empty table reads as a fault, not as an absence');
  });

  test('an empty list still answers coherently', () => {
    const p = paged({ page: 3, limit: 10 }, `${SQL} WHERE status = ?`, ['no-such-status']);
    assert.equal(p.total, 0);
    assert.equal(p.pages, 1);
    assert.deepEqual(p.rows, []);
  });
});

describe('countOf', () => {
  test('counts the query it is given, joins and all', () => {
    assert.equal(countOf(SQL), 37);
    assert.equal(
      countOf(`${SQL} WHERE status = ?`, ['sent']),
      (db.prepare("SELECT COUNT(*) n FROM quotations WHERE status = 'sent'").get() as { n: number }).n,
    );
  });

  /**
   * Two of the bodies it has to cope with are not plain SELECTs: approvals is
   * a UNION ALL of three tables, and the order-lines query opens with a
   * window-function CTE. Wrapping handles both; rewriting the SELECT list by
   * hand would not.
   */
  test('including a UNION ALL', () => {
    const union = `SELECT id FROM quotations UNION ALL SELECT id FROM quotations`;
    assert.equal(countOf(union), 74);
  });

  test('and a query that opens with a CTE', () => {
    const cte = `WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM quotations
    ) SELECT id FROM ranked WHERE rn <= 5`;
    assert.equal(countOf(cte), 5);
  });

  test('and duplicate column names, which a subquery is allowed to have', () => {
    assert.equal(countOf('SELECT q.*, c.* FROM quotations q JOIN customers c ON c.id = q.customer_id'), 37);
  });
});

test('decoration runs on the page, not the whole list', () => {
  let seen = 0;
  listBody({ page: 1, limit: 10 }, { sql: SQL, order: ORDER }, (rows) => {
    seen = rows.length;
    return rows;
  });
  assert.equal(seen, 10, 'the N+1 those lists have is bounded by the page size');
});
