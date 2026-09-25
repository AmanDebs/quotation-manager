import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { materialSchedule } from '../src/services/materialSchedule.js';
import { makeCustomer, makeMaterial, makeLocation } from './helpers/factory.js';

/**
 * Raw material required by start date: the jobs-basis shortfall spread along
 * the calendar. What is left to make, against the recipe the job was raised
 * on, on the day the job starts — and a job with no day in its own bucket.
 */

let seq = 0;

function product(materialId: number, perThousand: number): number {
  const id = Number((db.prepare(
    "INSERT INTO products (name, unit, unit_price) VALUES (?, 'per 1000', 10) RETURNING id"
  ).get(`Cap ${++seq}`) as { id: number }).id);
  db.prepare(
    'INSERT INTO product_materials (product_id, material_id, qty_per_1000, wastage_pct, sort_order) VALUES (?, ?, ?, 0, 0)'
  ).run(id, materialId, perThousand);
  return id;
}

function job(productId: number | null, planned: number, start = '', locationId: number | null = null): number {
  const orderId = Number((db.prepare(
    `INSERT INTO orders (number, date, customer_id, company_id, currency, tax_type, status)
     VALUES (?, '2026-09-01', ?, 1, 'INR', 'igst', 'pending') RETURNING id`
  ).get(`SO/MS-${++seq}`, makeCustomer()) as { id: number }).id);
  return Number((db.prepare(
    `INSERT INTO work_orders (number, order_id, order_line, product_id, qty_planned, status, planned_start, location_id)
     VALUES (?, ?, 0, ?, ?, 'released', ?, ?) RETURNING id`
  ).get(`WO/MS-${seq}`, orderId, productId, planned, start, locationId) as { id: number }).id);
}

const shift = (jobId: number, ok: number) => db.prepare(
  "INSERT INTO production_entries (work_order_id, date, qty_ok, qty_reject) VALUES (?, '2026-09-03', ?, 0)"
).run(jobId, ok);

const rowFor = (s: ReturnType<typeof materialSchedule>, materialId: number) => s.rows.find((r) => r.material_id === materialId)!;

describe('the sheet', () => {
  test('one row per material, a total, and a column per start date', () => {
    const resin = makeMaterial('HDPE 6007L');
    const p = product(resin, 100);                 // 100 kg per 1000
    job(p, 5000, '2026-09-15');
    job(p, 5000, '2026-09-15');
    job(p, 5000, '2026-09-20');
    const s = materialSchedule();
    assert.ok(s.dates.includes('2026-09-15') && s.dates.includes('2026-09-20'));
    const r = rowFor(s, resin);
    assert.equal(r.total, 1500);
    assert.equal(r.by_date['2026-09-15'], 1000);
    assert.equal(r.by_date['2026-09-20'], 500);
    assert.equal(r.unscheduled, 0);
  });

  test('counts what is left to make, not the whole plan', () => {
    const resin = makeMaterial();
    const p = product(resin, 100);
    const j = job(p, 10000, '2026-10-01');
    shift(j, 4000);
    assert.equal(rowFor(materialSchedule(), resin).by_date['2026-10-01'], 600);
  });

  test('a job with no start date lands in its own bucket, not on today', () => {
    const resin = makeMaterial();
    const p = product(resin, 100);
    job(p, 1000, '');
    const s = materialSchedule();
    const r = rowFor(s, resin);
    assert.equal(r.unscheduled, 100);
    assert.equal(r.total, 100);
    assert.equal(Object.keys(r.by_date).length, 0);
    assert.equal(s.has_unscheduled, true);
  });

  test('a job whose product has no recipe is named, never counted as zero', () => {
    const p = Number((db.prepare("INSERT INTO products (name, unit, unit_price) VALUES ('Bare', 'per 1000', 1) RETURNING id").get() as { id: number }).id);
    const j = job(p, 1000, '2026-09-15');
    const s = materialSchedule();
    assert.ok(s.uncosted.some((u) => u.id === j));
  });

  test('a row carries the jobs behind it — product, customer, order — and they add up to it', () => {
    const resin = makeMaterial();
    const p = product(resin, 100);
    const a = job(p, 10000, '2026-09-15');
    shift(a, 4000);                                // 6,000 left → 600 kg
    const b = job(p, 2000, '');                    // 200 kg, unscheduled
    const r = rowFor(materialSchedule(), resin);
    assert.equal(r.jobs.length, 2);
    const ja = r.jobs.find((j) => j.work_order_id === a)!;
    const jb = r.jobs.find((j) => j.work_order_id === b)!;
    assert.equal(ja.qty, 600); assert.equal(ja.pieces, 6000); assert.equal(ja.day, '2026-09-15');
    assert.equal(jb.qty, 200); assert.equal(jb.pieces, 2000); assert.equal(jb.day, '');
    assert.equal(ja.qty + jb.qty, r.total);
    const wo = db.prepare('SELECT w.number, p.name AS product, c.name AS customer, o.number AS order_number FROM work_orders w JOIN products p ON p.id = w.product_id JOIN orders o ON o.id = w.order_id JOIN customers c ON c.id = o.customer_id WHERE w.id = ?').get(a) as { number: string; product: string; customer: string; order_number: string };
    assert.equal(ja.number, wo.number);
    assert.equal(ja.product_name, wo.product);
    assert.equal(ja.customer_name, wo.customer);
    assert.equal(ja.order_number, wo.order_number);
  });

  /*
   * A job whose start was revised is needed on the day it will actually run,
   * not on the day it was first planned for — otherwise the resin is bought
   * for a week nobody is moulding in. The original is not overwritten, so the
   * only way to say this is to read the date that stands.
   */
  test('a revised start moves the material to the day the job will run', () => {
    const resin = makeMaterial();
    const p = product(resin, 100);
    const moved = job(p, 5000, '2026-12-01');
    db.prepare("UPDATE work_orders SET revised_start = '2026-12-18' WHERE id = ?").run(moved);
    const r = rowFor(materialSchedule(), resin);
    assert.equal(r.by_date['2026-12-18'], 500);
    assert.equal(r.by_date['2026-12-01'], undefined);
    // And the original is still on the row — nothing was rewritten to do it.
    assert.equal(
      (db.prepare('SELECT planned_start FROM work_orders WHERE id = ?').get(moved) as { planned_start: string }).planned_start,
      '2026-12-01'
    );
  });

  test('a job with a revised start and nothing planned is on that day, not unscheduled', () => {
    const resin = makeMaterial();
    const p = product(resin, 100);
    const late = job(p, 2000, '');
    db.prepare("UPDATE work_orders SET revised_start = '2026-12-22' WHERE id = ?").run(late);
    const r = rowFor(materialSchedule(), resin);
    assert.equal(r.by_date['2026-12-22'], 200);
    assert.equal(r.unscheduled, 0);
  });

  test('completed and cancelled jobs, and a plant filter', () => {
    const resin = makeMaterial();
    const p = product(resin, 100);
    const a = makeLocation('A'); const b = makeLocation('B');
    job(p, 1000, '2026-11-01', a);
    job(p, 1000, '2026-11-01', b);
    const done = job(p, 1000, '2026-11-01', a);
    db.prepare("UPDATE work_orders SET status = 'done' WHERE id = ?").run(done);
    assert.equal(rowFor(materialSchedule(), resin).by_date['2026-11-01'], 200);
    assert.equal(rowFor(materialSchedule(a), resin).by_date['2026-11-01'], 100);
  });
});
