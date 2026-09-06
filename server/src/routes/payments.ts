import { Router } from 'express';
import { db } from '../db/connection.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { canAccessCustomer, scopeClause } from '../middleware/scope.js';
import { syncInvoicesForPayment } from '../services/invoiceStatus.js';
import { currencyMismatchSql } from '../services/receivables.js';
import { listBody } from '../services/pagination.js';
import { searchClause } from '../services/search.js';

export const paymentsRouter = Router();

/**
 * Money in, as a register.
 *
 * Payments could only ever be seen on the one document they were banked
 * against — this router had a POST and a DELETE and no way to read anything —
 * so "what came in this week" and "which of these is credited to nothing" had
 * no answer outside the dashboard's Cash Collected bar.
 *
 * It is deliberately **not** an allocation report. Where an advance ends up is
 * `services/receivables.ts`'s question and is answered on the invoice and on
 * the customer's page; this says what arrived, from whom, and against which
 * document. A second opinion about allocation is the one thing this must not
 * grow into.
 */
const listSql = `
  SELECT p.*,
         c.name AS customer_name,
         COALESCE(i.number, pi.number) AS against_number,
         CASE WHEN p.invoice_id IS NOT NULL THEN 'invoice'
              WHEN p.pi_id IS NOT NULL THEN 'proforma' ELSE '' END AS against_type,
         COALESCE(i.currency, pi.currency) AS doc_currency,
         ${currencyMismatchSql('p.currency', 'COALESCE(i.currency, pi.currency)')} AS mismatched
  FROM payments p
  LEFT JOIN customers c ON c.id = p.customer_id
  LEFT JOIN commercial_invoices i ON i.id = p.invoice_id
  LEFT JOIN proforma_invoices pi ON pi.id = p.pi_id`;

/** Built once so the list and anything derived from it cannot drift apart. */
function registerWhere(req: AuthedRequest): { where: string[]; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const scope = scopeClause(req, 'p.customer_id');
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  if (req.query.from) { where.push('p.date >= ?'); params.push(String(req.query.from)); }
  if (req.query.to) { where.push('p.date <= ?'); params.push(String(req.query.to)); }
  if (Number(req.query.customer_id) > 0) { where.push('p.customer_id = ?'); params.push(Number(req.query.customer_id)); }
  if (req.query.currency) { where.push('p.currency = ?'); params.push(String(req.query.currency)); }
  if (req.query.method) { where.push('p.method = ?'); params.push(String(req.query.method)); }
  // An advance is banked against a proforma, a settlement against an invoice.
  // They are different things to look at, so they can be asked for separately.
  if (req.query.against === 'proforma') where.push('p.pi_id IS NOT NULL AND p.invoice_id IS NULL');
  if (req.query.against === 'invoice') where.push('p.invoice_id IS NOT NULL');
  /*
   * The filter this register largely exists for: money in a currency the
   * document it sits against is not billed in, which `receivables.ts` refuses
   * to allocate and reports instead. Until now that report appeared on one
   * document at a time, so nobody could ask how many there were.
   */
  if (req.query.mismatched === '1') {
    where.push(currencyMismatchSql('p.currency', 'COALESCE(i.currency, pi.currency)'));
  }
  // Bank reference first: "did we get SWIFT REF 8842544" is the lookup this
  // page will actually be opened for.
  const search = searchClause(
    ['p.reference', 'p.method', 'p.notes', 'c.name', 'i.number', 'pi.number'],
    String(req.query.q ?? ''),
  );
  if (search.sql) { where.push(search.sql); params.push(...search.params); }
  return { where, params };
}

/**
 * The figures over the strip, measured over the **whole filtered set** rather
 * than the page — a page total wearing the words of a register total is worse
 * than no total, the rule `routes/despatches.ts` states about its own.
 *
 * Money is grouped by currency and never added across them, for
 * `receivables.ts`'s reason: there is no rate stored anywhere, and inventing
 * one would put a fiction on a ledger.
 */
function registerSummary(sql: string, params: unknown[]) {
  const rows = db.prepare(
    `SELECT currency, COUNT(*) AS count, SUM(amount) AS amount FROM (${sql})
     GROUP BY currency ORDER BY currency`
  ).all(...(params as never[])) as { currency: string; count: number; amount: number }[];
  const mismatched = db.prepare(
    `SELECT COUNT(*) AS c FROM (${sql}) WHERE mismatched = 1`
  ).get(...(params as never[])) as { c: number };
  return {
    payments: rows.reduce((n, r) => n + r.count, 0),
    by_currency: rows.map((r) => ({ ...r, amount: Math.round(r.amount * 100) / 100 })),
    mismatched: mismatched.c,
  };
}

paymentsRouter.get('/', (req: AuthedRequest, res) => {
  const { where, params } = registerWhere(req);
  const sql = `${listSql}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
  const body = listBody<Record<string, unknown>>(req.query, {
    // Ends in an id, because `date` alone is not a total ordering and which of
    // two payments banked on one day lands on which page would otherwise be
    // undefined — `services/pagination.ts` states the rule.
    sql, order: 'ORDER BY p.date DESC, p.id DESC', params,
  });
  res.json(Array.isArray(body) ? body : { ...body, summary: registerSummary(sql, params) });
});

/** The distinct methods actually used, so the filter offers what is on file. */
paymentsRouter.get('/methods', (req: AuthedRequest, res) => {
  const scope = scopeClause(req, 'p.customer_id');
  const rows = db.prepare(
    `SELECT DISTINCT p.method FROM payments p
     ${scope.sql ? `WHERE ${scope.sql} AND` : 'WHERE'} TRIM(p.method) <> ''
     ORDER BY p.method`
  ).all(...(scope.params as never[])) as { method: string }[];
  res.json(rows.map((r) => r.method));
});

paymentsRouter.post('/', (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  const amount = Number(body.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero' });
  if (!body.pi_id && !body.invoice_id) return res.status(400).json({ error: 'Payment must be linked to a proforma or an invoice' });

  // Inherit customer/currency from the linked document. A payment is only
  // recordable by someone who may see that document, so out-of-scope ids read
  // as "not found" exactly like the document routes.
  let customerId: number | null = null;
  let currency = 'INR';
  if (body.invoice_id) {
    const inv = db.prepare('SELECT customer_id, currency FROM commercial_invoices WHERE id = ?').get(Number(body.invoice_id)) as
      | { customer_id: number; currency: string } | undefined;
    if (!inv || !canAccessCustomer(req, inv.customer_id)) return res.status(404).json({ error: 'Invoice not found' });
    customerId = inv.customer_id;
    currency = inv.currency;
  } else if (body.pi_id) {
    const pi = db.prepare('SELECT customer_id, currency FROM proforma_invoices WHERE id = ?').get(Number(body.pi_id)) as
      | { customer_id: number; currency: string } | undefined;
    if (!pi || !canAccessCustomer(req, pi.customer_id)) return res.status(404).json({ error: 'Proforma invoice not found' });
    customerId = pi.customer_id;
    currency = pi.currency;
  }

  const info = db.prepare(
    `INSERT INTO payments (pi_id, invoice_id, customer_id, date, amount, currency, method, reference, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    body.pi_id ? Number(body.pi_id) : null,
    body.invoice_id ? Number(body.invoice_id) : null,
    customerId,
    String(body.date ?? new Date().toISOString().slice(0, 10)),
    amount,
    currency,
    String(body.method ?? ''),
    String(body.reference ?? ''),
    String(body.notes ?? '')
  );
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(info.lastInsertRowid)) as
    { invoice_id: number | null; pi_id: number | null };
  // Being paid is a fact about the invoice, so its status follows it. An
  // advance moves every invoice raised from that proforma, not just one.
  syncInvoicesForPayment(payment);
  res.status(201).json(payment);
});

paymentsRouter.delete('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const payment = db.prepare('SELECT customer_id, invoice_id, pi_id FROM payments WHERE id = ?').get(id) as
    | { customer_id: number | null; invoice_id: number | null; pi_id: number | null } | undefined;
  if (!payment || !canAccessCustomer(req, payment.customer_id)) return res.status(404).json({ error: 'Payment not found' });
  db.prepare('DELETE FROM payments WHERE id = ?').run(id);
  // Deleting a mis-keyed payment reopens the balance, so anything it had marked
  // paid goes back to what it was. Read the links before the row is gone.
  syncInvoicesForPayment(payment);
  res.json({ ok: true });
});
