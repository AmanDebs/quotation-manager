import { db } from '../db/connection.js';
import { round2 } from './totals.js';
import { CREDITED_SQL } from './creditNotes.js';

/**
 * Single source of truth for "how much has been received against this invoice".
 *
 * A payment recorded on a commercial invoice belongs to that invoice alone.
 * A payment recorded on a proforma is an *advance*: it belongs to the order as
 * a whole, and has to be spread across however many invoices are raised from
 * that proforma. Partial shipments are normal here, so an advance is allocated
 * to the earliest invoice first, capped at what that invoice still owes, and
 * whatever is left flows to the next one. Counting the whole advance against
 * every invoice (the old behaviour) credited the customer several times over.
 *
 * Nothing here is stored — the allocation is derived on every read, the same
 * rule the dispatch progress and packing list follow.
 */

export interface PaymentRow {
  id: number;
  pi_id: number | null;
  invoice_id: number | null;
  customer_id: number | null;
  date: string;
  amount: number;
  currency: string;
  method: string;
  reference: string;
  notes: string;
}

/** A payment as it appears on one invoice: the full record plus the slice applied here. */
export interface AppliedPayment extends PaymentRow {
  /** Portion of `amount` credited to this invoice — differs from `amount` only for shared advances. */
  applied_amount: number;
}

const sumAmounts = (rows: { amount: number }[]) => round2(rows.reduce((s, r) => s + r.amount, 0));

/**
 * Can this payment be counted against a document billed in `currency`?
 *
 * Money only adds up within one currency. A €10,000 advance is not ₹10,000, and
 * treating it as such once marked a ₹5,000 invoice paid in full — the customer
 * credited more than a hundred times what they sent. There is no exchange rate
 * stored anywhere, and inventing one would put a fictional figure on a ledger,
 * so a payment in another currency is simply not allocated here; the caller
 * reports it separately instead.
 *
 * A blank currency is treated as matching. Payments inherit their currency from
 * the document they are recorded against (`routes/payments.ts`), so an empty one
 * can only be a row that predates that rule — excluding it would quietly reduce
 * a balance that has been right for months.
 */
export const sameCurrency = (payment: string | null | undefined, document: string) =>
  !String(payment ?? '').trim() || String(payment).trim() === String(document).trim();

/**
 * `sameCurrency` restated in SQL.
 *
 * A second copy of a rule is what this codebase normally refuses, and the
 * precedent for allowing it is `RESULT_FAILED_SQL` in `services/qc.ts`: the
 * payments register is **paged**, so a verdict derived after the fetch could
 * only filter and count the page in hand rather than the register. What makes
 * it safe is that the two are not assumed to agree — `paymentsRegister.test.ts`
 * runs both over every combination of blank, padded and differing currency and
 * asserts they answer identically.
 *
 * Read it beside `sameCurrency` above, which it must mirror exactly: a payment
 * mismatches only when it names a currency of its own **and** that currency
 * differs from the document's. A blank counts as matching, so it is not a
 * mismatch; and a payment against no document at all cannot mismatch, there
 * being nothing to disagree with.
 */
export const currencyMismatchSql = (payment: string, document: string) =>
  `(${document} IS NOT NULL AND TRIM(COALESCE(${payment}, '')) <> ''`
  + ` AND TRIM(${payment}) <> TRIM(${document}))`;

/** Advances on a proforma, split across the invoices raised from it (earliest first). */
function allocateAdvances(piId: number): Map<number, AppliedPayment[]> {
  const pool = db.prepare(
    'SELECT * FROM payments WHERE pi_id = ? AND invoice_id IS NULL ORDER BY date, id'
  ).all(piId) as unknown as PaymentRow[];
  /*
   * `credited` rides along because a credit note reduces what this invoice can
   * absorb, and an advance that would otherwise have been trapped against a
   * credited invoice has to flow on to the next one. Without it the pool sits
   * allocated to a bill nobody owes while the invoice after it reads unpaid.
   */
  const invoices = db.prepare(
    `SELECT id, currency, grand_total, ${CREDITED_SQL('commercial_invoices.id')} AS credited
       FROM commercial_invoices WHERE pi_id = ? ORDER BY date, id`
  ).all(piId) as { id: number; currency: string; grand_total: number; credited: number }[];

  const remaining = pool.map((payment) => ({ payment, left: payment.amount }));
  const byInvoice = new Map<number, AppliedPayment[]>();

  for (const inv of invoices) {
    const direct = db.prepare('SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE invoice_id = ? AND (currency = ? OR TRIM(COALESCE(currency, \'\')) = \'\')')
      .get(inv.id, inv.currency) as { v: number };
    let capacity = round2(Math.max(0, inv.grand_total - inv.credited - direct.v));
    const share: AppliedPayment[] = [];
    for (const r of remaining) {
      if (capacity <= 0) break;
      if (r.left <= 0) continue;
      // Skipped, not consumed: an advance in another currency stays whole and
      // available to an invoice that is actually billed in it.
      if (!sameCurrency(r.payment.currency, inv.currency)) continue;
      const take = round2(Math.min(r.left, capacity));
      r.left = round2(r.left - take);
      capacity = round2(capacity - take);
      share.push({ ...r.payment, applied_amount: take });
    }
    byInvoice.set(inv.id, share);
  }
  return byInvoice;
}

export interface InvoiceReceivable {
  /** Payments to show on the invoice: its own, then any advance applied to it. */
  payments: AppliedPayment[];
  amount_received: number;
  balance_due: number;
  /**
   * What approved credit notes have taken off this bill — goods returned, or
   * a rate settled down after the fact.
   *
   * It is **not** money received and is deliberately reported beside it rather
   * than folded into it: an invoice settled by a credit note has been paid by
   * nobody, and a page that adds the two would say the customer had sent money
   * they never sent. Only `balance_due` nets them, because what is still owed
   * is one figure however it got there.
   *
   * Only **approved** notes count — a draft that moved a balance would be a way
   * to write a debt off by typing one, which is what approval exists to stop.
   */
  credited: number;
  /** How much of the total received came from advances on the source proforma. */
  advance_applied: number;
  /**
   * Money sitting against this invoice or its proforma in a *different*
   * currency, which is therefore credited to nothing. Reported so it can be
   * shown and corrected rather than disappearing — the usual cause is a
   * document whose currency was changed after the payment was recorded.
   */
  currency_mismatch: { currency: string; amount: number }[];
}

/** Payments in a currency the document is not billed in, grouped for reporting. */
function mismatches(rows: PaymentRow[], currency: string): { currency: string; amount: number }[] {
  const byCurrency = new Map<string, number>();
  for (const p of rows) {
    if (sameCurrency(p.currency, currency)) continue;
    const key = String(p.currency ?? '').trim();
    byCurrency.set(key, round2((byCurrency.get(key) ?? 0) + p.amount));
  }
  return [...byCurrency].map(([c, amount]) => ({ currency: c, amount }));
}

export interface ProformaAdvance {
  /** Every payment banked against the proforma, in date order. */
  payments: PaymentRow[];
  /** What the customer has actually paid, in the proforma's own currency. */
  amount_received: number;
  /** grand_total − amount_received, floored at zero. */
  balance_payable: number;
  /** Money in another currency, credited to nothing and reported instead. */
  currency_mismatch: { currency: string; amount: number }[];
}

/**
 * What has been banked against one proforma.
 *
 * The same currency rule as everything else here — a payment credits a
 * document only when the two agree, and a blank currency counts as matching,
 * since payments inherit theirs from the document and an empty one can only be
 * a legacy row.
 *
 * It lives here rather than in the route because it now has two readers: the
 * proforma page and the proforma **PDF**. The list keeps its own correlated
 * subquery — asking once per row is the N+1 this codebase keeps bounding — and
 * the invariant between the two is that they apply one rule, so the paper and
 * the screen can never state different advances.
 */
export function proformaAdvance(piId: number): ProformaAdvance {
  const pi = db.prepare('SELECT id, currency, grand_total FROM proforma_invoices WHERE id = ?').get(piId) as
    | { id: number; currency: string; grand_total: number }
    | undefined;
  if (!pi) return { payments: [], amount_received: 0, balance_payable: 0, currency_mismatch: [] };

  const payments = db.prepare(
    'SELECT * FROM payments WHERE pi_id = ? ORDER BY date, id'
  ).all(piId) as unknown as PaymentRow[];

  const received = round2(
    payments.filter((p) => sameCurrency(p.currency, pi.currency)).reduce((s, p) => s + p.amount, 0)
  );
  return {
    payments,
    amount_received: received,
    // A subtraction, not a third opinion: `amount_received` stays the single
    // source, and an overpayment is not a negative balance.
    balance_payable: Math.max(0, round2(Number(pi.grand_total) - received)),
    currency_mismatch: mismatches(payments, pi.currency),
  };
}

/** What one invoice has actually been credited with. */
export function invoiceReceivable(invoiceId: number): InvoiceReceivable {
  const inv = db.prepare(
    `SELECT id, pi_id, currency, grand_total, ${CREDITED_SQL('commercial_invoices.id')} AS credited
       FROM commercial_invoices WHERE id = ?`
  ).get(invoiceId) as
    | { id: number; pi_id: number | null; currency: string; grand_total: number; credited: number } | undefined;
  if (!inv) return { payments: [], amount_received: 0, balance_due: 0, credited: 0, advance_applied: 0, currency_mismatch: [] };

  const own = db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY date, id').all(invoiceId) as unknown as PaymentRow[];
  const direct = own
    .filter((p) => sameCurrency(p.currency, inv.currency))
    .map((p) => ({ ...p, applied_amount: p.amount }));
  const advances = inv.pi_id != null ? allocateAdvances(inv.pi_id).get(invoiceId) ?? [] : [];

  // Advances on the proforma that no invoice in this currency can absorb.
  const pool = inv.pi_id != null
    ? db.prepare('SELECT * FROM payments WHERE pi_id = ? AND invoice_id IS NULL ORDER BY date, id').all(inv.pi_id) as unknown as PaymentRow[]
    : [];

  const advanceApplied = round2(advances.reduce((s, p) => s + p.applied_amount, 0));
  const received = round2(sumAmounts(direct) + advanceApplied);
  const credited = round2(Number(inv.credited) || 0);
  return {
    payments: [...direct, ...advances],
    amount_received: received,
    // A subtraction, not a third opinion: what was billed, less what was
    // credited back, less what has actually been banked.
    balance_due: round2(inv.grand_total - credited - received),
    credited,
    advance_applied: advanceApplied,
    currency_mismatch: mismatches([...own, ...pool], inv.currency),
  };
}

/**
 * Amount received for every invoice at once, for the dashboard — same
 * allocation rule, but without re-querying per invoice.
 */
export function receivedByInvoice(): Map<number, number> {
  const invoices = db.prepare(
    `SELECT id, pi_id, currency, grand_total, ${CREDITED_SQL('commercial_invoices.id')} AS credited
       FROM commercial_invoices ORDER BY date, id`
  ).all() as { id: number; pi_id: number | null; currency: string; grand_total: number; credited: number }[];
  const payments = db.prepare('SELECT pi_id, invoice_id, amount, currency, date, id FROM payments ORDER BY date, id').all() as
    { pi_id: number | null; invoice_id: number | null; amount: number; currency: string }[];

  const directTotal = new Map<number, number>();
  const pools = new Map<number, { amount: number; currency: string; left: number }[]>();
  const byId = new Map(invoices.map((i) => [i.id, i]));
  for (const p of payments) {
    if (p.invoice_id != null) {
      // Same rule as invoiceReceivable: a payment only credits an invoice
      // billed in its own currency, so the dashboard and the invoice page
      // cannot disagree about what has been received.
      const inv = byId.get(p.invoice_id);
      if (inv && !sameCurrency(p.currency, inv.currency)) continue;
      directTotal.set(p.invoice_id, round2((directTotal.get(p.invoice_id) ?? 0) + p.amount));
    } else if (p.pi_id != null) {
      const pool = pools.get(p.pi_id) ?? [];
      pool.push({ amount: p.amount, currency: p.currency, left: p.amount });
      pools.set(p.pi_id, pool);
    }
  }

  const received = new Map<number, number>();
  for (const inv of invoices) {
    const direct = directTotal.get(inv.id) ?? 0;
    // The same capacity rule as `allocateAdvances`, or the dashboard and the
    // invoice page would disagree about where an advance ended up.
    let capacity = round2(Math.max(0, inv.grand_total - inv.credited - direct));
    let applied = 0;
    for (const r of (inv.pi_id != null ? pools.get(inv.pi_id) ?? [] : [])) {
      if (capacity <= 0) break;
      if (r.left <= 0) continue;
      if (!sameCurrency(r.currency, inv.currency)) continue;
      const take = round2(Math.min(r.left, capacity));
      r.left = round2(r.left - take);
      capacity = round2(capacity - take);
      applied = round2(applied + take);
    }
    received.set(inv.id, round2(direct + applied));
  }
  return received;
}

/** What an order's proforma has actually taken in. */
export interface OrderAdvance {
  /** The proforma the order was booked from, if there is one. */
  pi_id: number | null;
  pi_number: string;
  amount_received: number;
  /** When the most recent matching payment landed, for "Date of Credit". */
  last_date: string;
  /** Payments in another currency, counted by nobody and reported instead. */
  currency_mismatch: { currency: string; amount: number }[];
}

/**
 * The advance behind an order, derived rather than stored.
 *
 * An order has no `pi_id` — the link lives on `proforma_invoices.order_id`, the
 * back-pointer `dispatchProgress` walks — so this resolves it the same way and
 * then asks `proformaAdvance`, which owns the currency rule. Nothing here is a
 * second opinion about money: the order page, the proforma page and the order
 * PDF all end up quoting one figure.
 *
 * **Derived, because the timing is against a copy.** The advance is normally
 * banked against the proforma *after* the order is booked, which is the whole
 * point of an advance and the reason `lockError` deliberately leaves payments
 * alone on a locked proforma — so a figure copied onto the order at booking
 * would be zero on almost every order, and stale on the rest.
 *
 * The first proforma wins where two somehow point at one order, the rule
 * `quotationLockedBy` follows; `POST /orders` refuses to claim a proforma that
 * already carries an `order_id`, so that is a belt-and-braces case.
 */
export function orderAdvance(orderId: number): OrderAdvance {
  const pi = db.prepare(
    'SELECT id FROM proforma_invoices WHERE order_id = ? ORDER BY id LIMIT 1'
  ).get(orderId) as { id: number } | undefined;
  return pi ? advanceForProforma(pi.id) : NO_ADVANCE;
}

const NO_ADVANCE: OrderAdvance = {
  pi_id: null, pi_number: '', amount_received: 0, last_date: '', currency_mismatch: [],
};

/**
 * The same block, asked of a proforma directly.
 *
 * Split out for the **order being booked**: the form is filled from
 * `prefill/from-proforma` before any order row exists, so there is no id for
 * `orderAdvance` to resolve backwards from — and an advance banked before the
 * order is raised is exactly the case that must not read as zero on the screen
 * where the order is being created.
 */
export function advanceForProforma(piId: number): OrderAdvance {
  const pi = db.prepare('SELECT id, number FROM proforma_invoices WHERE id = ?').get(piId) as
    | { id: number; number: string }
    | undefined;
  if (!pi) return NO_ADVANCE;

  const advance = proformaAdvance(pi.id);
  // The date of credit is the most recent payment that actually counted. A
  // date drawn from a payment in another currency would name money nothing
  // was credited with, so the same `sameCurrency` rule decides both figures.
  const cur = String(
    (db.prepare('SELECT currency FROM proforma_invoices WHERE id = ?').get(pi.id) as { currency: string }).currency
  );
  const counted = advance.payments.filter((p) => sameCurrency(p.currency, cur));
  const last = counted.length ? String(counted[counted.length - 1].date ?? '') : '';
  return {
    pi_id: pi.id,
    pi_number: pi.number,
    amount_received: advance.amount_received,
    last_date: last,
    currency_mismatch: advance.currency_mismatch,
  };
}
