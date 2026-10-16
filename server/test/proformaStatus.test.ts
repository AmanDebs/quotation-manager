import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { STATUS_SQL, statusSqlFor } from '../src/services/proformaStatus.js';

/**
 * A proforma's status is derived, never stored — and the expression has to
 * give the same answer wherever it is read from.
 *
 * It was written against the alias `p` alone, which was right for every WHERE
 * that reads the table and **wrong the moment the list became a subquery**
 * (2026-10-16, the header funnels: a list has to be wrapped to filter on its
 * own aliases). The statement had selected `p.*` and then `STATUS_SQL AS
 * status`, relying on the later alias winning — true of a bare statement, and
 * false once it is wrapped: `SELECT *` carries both columns and node:sqlite
 * disambiguates them as `status` and `status:1`, with the **stored** one under
 * the plain name. Measured on a scratch instance before this was written: a
 * lapsed offer read `sent` in the list while its own page read `expired`.
 *
 * So the rule takes the alias it is written against, and these cases run it
 * both ways over the same rows. They bite against a fixed `p.`: the wrapped
 * reading then names a table that is not in scope and throws.
 */

const LAPSED = '2020-01-01';
const AHEAD = '2099-01-01';

function seed() {
  db.exec(`CREATE TABLE IF NOT EXISTS pi_rows (
    id INTEGER PRIMARY KEY, number TEXT, status TEXT, validity_date TEXT
  )`);
  db.exec('DELETE FROM pi_rows');
  const add = db.prepare('INSERT INTO pi_rows (number, status, validity_date) VALUES (?, ?, ?)');
  add.run('lapsed-sent', 'sent', LAPSED);
  add.run('lapsed-draft', 'draft', LAPSED);
  add.run('live-sent', 'sent', AHEAD);
  // Past its date, but the buyer has moved on — the validity has nothing left
  // to say, so these never lapse.
  add.run('confirmed', 'order_confirmed', LAPSED);
  add.run('paid', 'advance_received', LAPSED);
  add.run('booked', 'in_production', LAPSED);
  // A blank validity date never lapses: plenty are raised without one.
  add.run('no-date', 'sent', '');
}

/** The status each row reads, with the expression written against `p`. */
function flat(): Record<string, string> {
  const rows = db.prepare(
    `SELECT number, ${STATUS_SQL} AS status FROM pi_rows p`
  ).all() as { number: string; status: string }[];
  return Object.fromEntries(rows.map((r) => [r.number, r.status]));
}

/**
 * The same question asked of the list's own shape: the statement carrying the
 * stored status, wrapped, with the rule derived over the subquery's columns.
 */
function wrapped(): Record<string, string> {
  const inner = 'SELECT p.* FROM pi_rows p';
  const rows = db.prepare(
    `SELECT *, ${statusSqlFor('doc')} AS status FROM (${inner}) doc`
  ).all() as { number: string; status: string }[];
  return Object.fromEntries(rows.map((r) => [r.number, r.status]));
}

describe('the status a proforma reads', () => {
  test('a draft or sent offer past its validity has lapsed', () => {
    seed();
    const s = flat();
    assert.equal(s['lapsed-sent'], 'expired');
    assert.equal(s['lapsed-draft'], 'expired');
  });

  test('and one still inside it has not', () => {
    seed();
    assert.equal(flat()['live-sent'], 'sent');
  });

  test('a blank validity date never lapses', () => {
    seed();
    assert.equal(flat()['no-date'], 'sent');
  });

  /**
   * Once the buyer has confirmed, paid an advance or had an order booked, the
   * date has nothing left to say — so these keep the status they hold however
   * long ago the offer was written.
   */
  test('nothing past Sent is touched by the date', () => {
    seed();
    const s = flat();
    assert.equal(s.confirmed, 'order_confirmed');
    assert.equal(s.paid, 'advance_received');
    assert.equal(s.booked, 'in_production');
  });

  /**
   * The regression this file exists for: the list wraps its own statement to
   * filter on its aliases, and the status it reports must not change because
   * of it.
   */
  test('and the wrapped reading agrees with the flat one, row for row', () => {
    seed();
    assert.deepEqual(wrapped(), flat());
  });

  test('a lapsed offer reads expired through the wrap too, not the stored word', () => {
    seed();
    assert.equal(wrapped()['lapsed-sent'], 'expired');
  });
});
