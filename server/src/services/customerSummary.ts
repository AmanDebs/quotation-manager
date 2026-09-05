import { db } from '../db/connection.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { allows } from '../middleware/auth.js';
import { round2 } from './totals.js';
import { invoiceReceivable, proformaAdvance, sameCurrency } from './receivables.js';

/**
 * Everything about one customer, on one screen.
 *
 * Every document in this app hangs off `customer_id`, and until now there was
 * no way to ask the obvious question — *show me this customer* — without
 * opening five lists and filtering each by hand. This is that question.
 *
 * **A section the caller may not read is absent, not empty.** The whole map is
 * assembled here against `allows()`, so the client renders what it is given
 * rather than holding a second copy of the access table — the rule
 * `/auth/me` already follows by handing over a computed capability map. It
 * also means the gate cannot be got past by calling the endpoint directly:
 * a Production login holds `customer: view` and `quotation: none`, and the
 * prices simply never leave the process. That is the hole `ENTITY_FN` closed
 * on the audit trail, in the one other place a record's own function differs
 * from the route serving it.
 *
 * **Nothing here is a new rule.** The money comes from `receivables.ts`, which
 * owns "how much has this been credited"; the counts are the same WHERE
 * clauses the lists use. A second opinion about a balance is exactly how the
 * page and the invoice come to disagree.
 */

/** How many of each kind of document to show before saying "and N more". */
const RECENT = 6;

/** A row in the money table — one per currency, never summed across them. */
export interface CustomerMoneyRow {
  currency: string;
  invoiced: number;
  received: number;
  outstanding: number;
  /** Invoices still unpaid more than 60 days after their date — the dashboard's rule. */
  overdue: number;
  /**
   * Advance banked against a proforma that no invoice has absorbed yet.
   *
   * Derived, like everything else here: what the proformas hold, less what the
   * invoices raised from them have already been credited with. Floored at zero,
   * since an over-allocation is not a debt owed back.
   */
  advance_held: number;
}

export interface DocRow {
  id: number;
  number: string;
  date: string;
  status: string;
  currency: string;
  grand_total: number;
}

/** A list the page shows the head of: how many there are, and the newest few. */
export interface Section<T> {
  total: number;
  rows: T[];
}

/** A payment as this page lists it: the record, plus the document it was banked against. */
export interface PaymentLine {
  id: number; date: string; amount: number; currency: string;
  method: string; reference: string; against: string;
}

export interface CustomerSummary {
  money?: {
    rows: CustomerMoneyRow[];
    /**
     * Money sitting against this customer's documents in a currency they are
     * not billed in, and therefore credited to nothing. Surfaced rather than
     * dropped, for `receivables.ts`'s reason: silently under-reporting what a
     * customer has paid is worse than an awkward figure.
     */
    currency_mismatch: { currency: string; amount: number }[];
  };
  enquiries?: Section<{ id: number; date: string; status: string; notes: string }>;
  quotations?: Section<DocRow & { revision: number; superseded: boolean }>;
  proformas?: Section<DocRow>;
  orders?: Section<DocRow & { po_number: string }>;
  invoices?: Section<DocRow & { balance_due: number }>;
  followups?: Section<{ id: number; due_date: string; note: string; done: number; overdue: boolean }>;
  payments?: Section<PaymentLine>;
  /** Products this customer is measured differently on — see `product_qc_params.customer_id`. */
  qc?: { products: { product_id: number; product_name: string; params: number }[] };
}

const count = (sql: string, id: number): number =>
  (db.prepare(sql).get(id) as { c: number }).c;

/**
 * One document section: the total, and the newest `RECENT` of them.
 *
 * `ORDER BY date DESC, id DESC` for the reason `pagination.ts` states about
 * every list here — a date alone is not a total ordering, and which of two
 * documents raised on one day comes first would otherwise be undefined.
 */
function section<T>(table: string, columns: string, customerId: number, extra = ''): Section<T> {
  const where = `WHERE customer_id = ?${extra ? ` AND ${extra}` : ''}`;
  return {
    total: count(`SELECT COUNT(*) AS c FROM ${table} ${where}`, customerId),
    rows: db.prepare(
      `SELECT ${columns} FROM ${table} ${where} ORDER BY date DESC, id DESC LIMIT ${RECENT}`
    ).all(customerId) as T[],
  };
}

const DOC_COLUMNS = 'id, number, date, status, currency, grand_total';

export function customerSummary(req: AuthedRequest, customerId: number): CustomerSummary {
  const out: CustomerSummary = {};
  const today = (db.prepare("SELECT date('now') AS d").get() as { d: string }).d;

  /* ------------------------------------------------------------------ money */
  if (allows(req, 'invoice')) {
    const invoices = db.prepare(
      'SELECT id, pi_id, currency, grand_total, date FROM commercial_invoices WHERE customer_id = ? ORDER BY date, id'
    ).all(customerId) as { id: number; pi_id: number | null; currency: string; grand_total: number; date: string }[];

    const rows = new Map<string, CustomerMoneyRow>();
    const row = (currency: string): CustomerMoneyRow => {
      const existing = rows.get(currency);
      if (existing) return existing;
      const fresh: CustomerMoneyRow = {
        currency, invoiced: 0, received: 0, outstanding: 0, overdue: 0, advance_held: 0,
      };
      rows.set(currency, fresh);
      return fresh;
    };

    const todayMs = Date.parse(today);
    /* Advance already absorbed by an invoice, per currency — the other half of
     * `advance_held`. Counting the whole advance as "held" would state money
     * twice: once here and once inside `received` below. */
    const advanceApplied = new Map<string, number>();

    for (const inv of invoices) {
      /* `invoiceReceivable` rather than a balance derived here. It is the rule's
       * owner, it is what the invoice page and the invoice PDF both ask, and it
       * is bounded by this one customer's invoices — the same call
       * `routes/invoices.ts` `getFull` makes for a single document. */
      const rec = invoiceReceivable(inv.id);
      const r = row(inv.currency);
      r.invoiced += inv.grand_total;
      r.received += Math.min(rec.amount_received, inv.grand_total);
      const outstanding = Math.max(0, inv.grand_total - rec.amount_received);
      r.outstanding += outstanding;
      if (outstanding > 0.005) {
        const days = Math.max(0, Math.floor((todayMs - Date.parse(inv.date)) / 86_400_000));
        if (days > 60) r.overdue += 1;
      }
      advanceApplied.set(inv.currency, (advanceApplied.get(inv.currency) ?? 0) + rec.advance_applied);
    }

    const proformas = db.prepare(
      'SELECT id, currency FROM proforma_invoices WHERE customer_id = ?'
    ).all(customerId) as { id: number; currency: string }[];
    for (const pi of proformas) {
      const adv = proformaAdvance(pi.id);
      if (adv.amount_received > 0) row(pi.currency).advance_held += adv.amount_received;
    }
    for (const r of rows.values()) {
      r.advance_held = Math.max(0, round2(r.advance_held - (advanceApplied.get(r.currency) ?? 0)));
      r.invoiced = round2(r.invoiced);
      r.received = round2(r.received);
      r.outstanding = round2(r.outstanding);
    }

    /*
     * The mismatch is measured over the payments themselves rather than merged
     * out of the per-document reports: an advance on a proforma is reported by
     * `proformaAdvance` *and* by `invoiceReceivable` for every invoice raised
     * from it, so adding those up would count one wrong payment several times.
     * One pass over this customer's payments, each compared against the
     * currency of the document it was banked against, cannot do that.
     */
    const mismatch = new Map<string, number>();
    const paid = db.prepare(
      `SELECT p.amount, p.currency AS pay_currency,
              COALESCE(i.currency, pi.currency) AS doc_currency
       FROM payments p
       LEFT JOIN commercial_invoices i ON i.id = p.invoice_id
       LEFT JOIN proforma_invoices pi ON pi.id = p.pi_id
       WHERE p.customer_id = ?`
    ).all(customerId) as { amount: number; pay_currency: string; doc_currency: string | null }[];
    for (const p of paid) {
      if (!p.doc_currency || sameCurrency(p.pay_currency, p.doc_currency)) continue;
      const key = String(p.pay_currency ?? '').trim();
      mismatch.set(key, round2((mismatch.get(key) ?? 0) + p.amount));
    }

    out.money = {
      rows: [...rows.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
      currency_mismatch: [...mismatch].map(([currency, amount]) => ({ currency, amount })),
    };
  }

  /* -------------------------------------------------------------- the chain */
  if (allows(req, 'enquiry')) {
    out.enquiries = section('enquiries', 'id, date, status, notes', customerId);
  }
  if (allows(req, 'quotation')) {
    const s = section<DocRow & { revision: number; superseded_by: number | null }>(
      'quotations', `${DOC_COLUMNS}, revision, superseded_by`, customerId
    );
    out.quotations = {
      total: s.total,
      rows: s.rows.map(({ superseded_by, ...q }) => ({ ...q, superseded: superseded_by != null })),
    };
  }
  if (allows(req, 'proforma')) {
    out.proformas = section('proforma_invoices', DOC_COLUMNS, customerId);
  }
  if (allows(req, 'order')) {
    out.orders = section('orders', `${DOC_COLUMNS}, po_number`, customerId);
  }
  if (allows(req, 'invoice')) {
    const s = section<DocRow>('commercial_invoices', DOC_COLUMNS, customerId);
    out.invoices = {
      total: s.total,
      // Asked of the same owner as the money table above, so a row and the
      // total over it can never state different balances.
      rows: s.rows.map((i) => ({ ...i, balance_due: round2(invoiceReceivable(i.id).balance_due) })),
    };
  }

  /* ------------------------------------------------------- chases and money in */
  if (allows(req, 'followup')) {
    const rows = db.prepare(
      `SELECT id, due_date, note, done FROM followups WHERE customer_id = ?
       ORDER BY done, due_date, id LIMIT ${RECENT}`
    ).all(customerId) as { id: number; due_date: string; note: string; done: number }[];
    out.followups = {
      total: count('SELECT COUNT(*) AS c FROM followups WHERE customer_id = ?', customerId),
      rows: rows.map((f) => ({ ...f, overdue: !f.done && !!f.due_date && f.due_date < today })),
    };
  }
  if (allows(req, 'payment')) {
    out.payments = {
      total: count('SELECT COUNT(*) AS c FROM payments WHERE customer_id = ?', customerId),
      rows: db.prepare(
        `SELECT p.id, p.date, p.amount, p.currency, p.method, p.reference,
                COALESCE(i.number, pi.number, '') AS against
         FROM payments p
         LEFT JOIN commercial_invoices i ON i.id = p.invoice_id
         LEFT JOIN proforma_invoices pi ON pi.id = p.pi_id
         WHERE p.customer_id = ? ORDER BY p.date DESC, p.id DESC LIMIT ${RECENT}`
      ).all(customerId) as unknown as PaymentLine[],
    };
  }

  /* ----------------------------------------------------- their own tolerances */
  if (allows(req, 'qc')) {
    out.qc = {
      products: db.prepare(
        `SELECT p.id AS product_id, p.name AS product_name, COUNT(*) AS params
         FROM product_qc_params q JOIN products p ON p.id = q.product_id
         WHERE q.customer_id = ?
         GROUP BY p.id, p.name ORDER BY p.name, p.id`
      ).all(customerId) as { product_id: number; product_name: string; params: number }[],
    };
  }

  return out;
}
