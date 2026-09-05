import { db } from '../../src/db/connection.js';
import type { TeamRole } from '../../src/services/permissions.js';

/**
 * Rows to test against.
 *
 * Deliberately raw inserts rather than calls through the routes: these
 * exercise the *services*, and going through HTTP would mean a test of
 * `receivables.ts` could fail because something changed about approval, or
 * scoping, or numbering. The route layer has its own tests.
 *
 * Everything takes explicit values. A factory that quietly supplies a currency
 * or a date is a factory that makes it possible to write a passing test about
 * the wrong thing.
 */

let n = 0;
const next = () => ++n;

export function makeCustomer(name = `Customer ${next()}`, ownerId: number | null = null): number {
  const info = db.prepare(
    "INSERT INTO customers (name, country, currency, owner_id) VALUES (?, 'India', 'INR', ?)"
  ).run(name, ownerId);
  return Number(info.lastInsertRowid);
}

/**
 * A user on one of the five teams.
 *
 * Takes a **team role**; the legacy `role` column is written in step with it,
 * as every other writer does, so a fixture cannot end up in the disagreeing
 * state the app itself cannot reach.
 */
export function makeUser(teamRole: TeamRole = 'super_admin', name = `User ${next()}`): number {
  const info = db.prepare(
    "INSERT INTO users (name, email, password_hash, role, team_role) VALUES (?, ?, 'x', ?, ?)"
  ).run(name, `u${next()}@test.local`, teamRole === 'super_admin' ? 'manager' : 'employee', teamRole);
  return Number(info.lastInsertRowid);
}

export function makeProforma(o: {
  customerId: number; currency: string; total: number; orderId?: number | null; date?: string;
}): number {
  const info = db.prepare(
    `INSERT INTO proforma_invoices (number, date, customer_id, company_id, currency, order_id, grand_total)
     VALUES (?, ?, ?, 1, ?, ?, ?)`
  ).run(`PI/${next()}`, o.date ?? '2026-08-01', o.customerId, o.currency, o.orderId ?? null, o.total);
  return Number(info.lastInsertRowid);
}

export function makeInvoice(o: {
  customerId: number; currency: string; total: number; piId?: number | null;
  date?: string; status?: string; approval?: string;
}): number {
  const info = db.prepare(
    `INSERT INTO commercial_invoices (number, date, customer_id, company_id, currency, pi_id,
                                      grand_total, status, approval_status)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`
  ).run(`INV/${next()}`, o.date ?? '2026-08-01', o.customerId, o.currency, o.piId ?? null,
    o.total, o.status ?? 'final', o.approval ?? 'approved');
  return Number(info.lastInsertRowid);
}

export function makePayment(o: {
  customerId: number; amount: number; currency: string;
  piId?: number | null; invoiceId?: number | null; date?: string;
}): number {
  const info = db.prepare(
    `INSERT INTO payments (customer_id, pi_id, invoice_id, amount, currency, date, method)
     VALUES (?, ?, ?, ?, ?, ?, 'bank')`
  ).run(o.customerId, o.piId ?? null, o.invoiceId ?? null, o.amount, o.currency, o.date ?? '2026-08-02');
  return Number(info.lastInsertRowid);
}

export function makeQuotation(o: {
  customerId: number; status: string; validity?: string;
  approval?: string; before?: string; supersededBy?: number | null;
}): number {
  const info = db.prepare(
    `INSERT INTO quotations (number, revision, date, customer_id, company_id, currency, status,
                             status_before_expired, validity_date, approval_status, superseded_by)
     VALUES (?, 0, '2026-08-01', ?, 1, 'INR', ?, ?, ?, ?, ?)`
  ).run(`QT/${next()}`, o.customerId, o.status, o.before ?? '', o.validity ?? '',
    o.approval ?? 'approved', o.supersededBy ?? null);
  return Number(info.lastInsertRowid);
}

export function makeMaterial(name = `Material ${next()}`): number {
  const info = db.prepare(
    "INSERT INTO materials (name, unit, category) VALUES (?, 'kg', 'resin')"
  ).run(name);
  return Number(info.lastInsertRowid);
}

export function makeLocation(name = `Plant ${next()}`): number {
  const info = db.prepare('INSERT INTO locations (name) VALUES (?)').run(name);
  return Number(info.lastInsertRowid);
}

/** One row of the signed ledger: positive in, negative out. */
export function makeMove(o: {
  materialId: number; locationId: number; qty: number; date: string;
  rate?: number | null; source?: string;
}): number {
  const info = db.prepare(
    `INSERT INTO material_moves (material_id, location_id, qty, rate, date, source)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(o.materialId, o.locationId, o.qty, o.rate ?? null, o.date,
    o.source ?? (o.qty > 0 ? 'po_receipt' : 'issue'));
  return Number(info.lastInsertRowid);
}

export const statusOf = (table: string, id: number) =>
  (db.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id) as { status: string }).status;
