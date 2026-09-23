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
  /** An advance banked against the sales order, where there is no proforma. */
  order_id: number | null;
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

/**
 * The sales order an invoice bills — its own link, or its proforma's
 * back-pointer, which is `dispatchProgress()`'s walk restated in SQL.
 *
 * It is what lets an advance banked against an **order** reach the invoices
 * raised from it, the way one banked against a proforma reaches the invoices
 * raised from that.
 */
const ORDER_BEHIND_INVOICE = (alias: string) =>
  `COALESCE(${alias}.order_id, (SELECT p2.order_id FROM proforma_invoices p2 WHERE p2.id = ${alias}.pi_id))`;

/**
 * The advance rows an invoice may draw on: those banked against its proforma,
 * and those banked against the order behind it.
 *
 * **A payment row carries exactly one link**, so the two pools never share a
 * row and merging them cannot credit anything twice. In practice an order has
 * one or the other — `POST /payments` from the order page banks against the
 * proforma wherever there is one, so the proforma's own document still states
 * what it took in — and the two-pool case is belt and braces.
 */
function advancePool(piId: number | null, orderId: number | null): PaymentRow[] {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (piId != null) { conds.push('pi_id = ?'); params.push(piId); }
  if (orderId != null) { conds.push('order_id = ?'); params.push(orderId); }
  if (!conds.length) return [];
  return db.prepare(
    `SELECT * FROM payments WHERE invoice_id IS NULL AND (${conds.join(' OR ')}) ORDER BY date, id`
  ).all(...(params as never[])) as unknown as PaymentRow[];
}

/** Advances behind a document, split across the invoices raised from it (earliest first). */
function allocateAdvances(piId: number | null, orderId: number | null): Map<number, AppliedPayment[]> {
  const pool = advancePool(piId, orderId);
  if (!pool.length) return new Map();
  /*
   * `credited` rides along because a credit note reduces what this invoice can
   * absorb, and an advance that would otherwise have been trapped against a
   * credited invoice has to flow on to the next one. Without it the pool sits
   * allocated to a bill nobody owes while the invoice after it reads unpaid.
   */
  const conds: string[] = [];
  const params: unknown[] = [];
  if (piId != null) { conds.push('pi_id = ?'); params.push(piId); }
  if (orderId != null) { conds.push(`${ORDER_BEHIND_INVOICE('commercial_invoices')} = ?`); params.push(orderId); }
  const invoices = db.prepare(
    `SELECT id, currency, grand_total, ${CREDITED_SQL('commercial_invoices.id')} AS credited
       FROM commercial_invoices WHERE ${conds.join(' OR ')} ORDER BY date, id`
  ).all(...(params as never[])) as { id: number; currency: string; grand_total: number; credited: number }[];

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
    `SELECT id, pi_id, ${ORDER_BEHIND_INVOICE('commercial_invoices')} AS advance_order_id,
            currency, grand_total, ${CREDITED_SQL('commercial_invoices.id')} AS credited
       FROM commercial_invoices WHERE id = ?`
  ).get(invoiceId) as
    | { id: number; pi_id: number | null; advance_order_id: number | null; currency: string; grand_total: number; credited: number } | undefined;
  if (!inv) return { payments: [], amount_received: 0, balance_due: 0, credited: 0, advance_applied: 0, currency_mismatch: [] };

  const own = db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY date, id').all(invoiceId) as unknown as PaymentRow[];
  const direct = own
    .filter((p) => sameCurrency(p.currency, inv.currency))
    .map((p) => ({ ...p, applied_amount: p.amount }));
  const advances = allocateAdvances(inv.pi_id, inv.advance_order_id).get(invoiceId) ?? [];

  // Advances behind it — on the proforma, or on the order where there is no
  // proforma — that no invoice in this currency can absorb.
  const pool = advancePool(inv.pi_id, inv.advance_order_id);

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
  return allocateAllInvoices().received;
}

/**
 * The advance each invoice absorbed from its proforma's pool, by the same
 * allocation — the other half of *advance held* (`customerSummary`'s rule:
 * what the proformas hold, less what the invoices raised from them have
 * already been credited with). One walk for both figures, so the dashboard's
 * *received* and its *held* cannot come from two allocations.
 */
export function advanceAppliedByInvoice(): Map<number, number> {
  return allocateAllInvoices().applied;
}

function allocateAllInvoices(): { received: Map<number, number>; applied: Map<number, number> } {
  const invoices = db.prepare(
    `SELECT id, pi_id, ${ORDER_BEHIND_INVOICE('commercial_invoices')} AS advance_order_id,
            currency, grand_total, ${CREDITED_SQL('commercial_invoices.id')} AS credited
       FROM commercial_invoices ORDER BY date, id`
  ).all() as { id: number; pi_id: number | null; advance_order_id: number | null; currency: string; grand_total: number; credited: number }[];
  const payments = db.prepare('SELECT pi_id, order_id, invoice_id, amount, currency, date, id FROM payments ORDER BY date, id').all() as
    { pi_id: number | null; order_id: number | null; invoice_id: number | null; amount: number; currency: string; date: string; id: number }[];

  const directTotal = new Map<number, number>();
  /*
   * Keyed by the document the advance was banked against — `pi:N` or `ord:N` —
   * because there are two kinds now and an invoice may reach either. A row
   * carries exactly one link, so it is filed in exactly one pool and cannot be
   * drawn twice; `advancePool` above states the same rule for one invoice.
   */
  const pools = new Map<string, { amount: number; currency: string; left: number; date: string; id: number }[]>();
  const byId = new Map(invoices.map((i) => [i.id, i]));
  for (const p of payments) {
    if (p.invoice_id != null) {
      // Same rule as invoiceReceivable: a payment only credits an invoice
      // billed in its own currency, so the dashboard and the invoice page
      // cannot disagree about what has been received.
      const inv = byId.get(p.invoice_id);
      if (inv && !sameCurrency(p.currency, inv.currency)) continue;
      directTotal.set(p.invoice_id, round2((directTotal.get(p.invoice_id) ?? 0) + p.amount));
      continue;
    }
    const key = p.pi_id != null ? `pi:${p.pi_id}` : p.order_id != null ? `ord:${p.order_id}` : '';
    if (!key) continue;
    const pool = pools.get(key) ?? [];
    pool.push({ amount: p.amount, currency: p.currency, left: p.amount, date: p.date, id: p.id });
    pools.set(key, pool);
  }

  /** The rows one invoice may draw on, earliest payment first. */
  const reachable = (inv: { pi_id: number | null; advance_order_id: number | null }) => {
    const rows = [
      ...(inv.pi_id != null ? pools.get(`pi:${inv.pi_id}`) ?? [] : []),
      ...(inv.advance_order_id != null ? pools.get(`ord:${inv.advance_order_id}`) ?? [] : []),
    ];
    // The same references, re-ordered — the `left` each carries is shared
    // across every invoice that can reach it, which is what stops one advance
    // being spent twice.
    return rows.length > 1 ? [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id) : rows;
  };

  const received = new Map<number, number>();
  const appliedBy = new Map<number, number>();
  for (const inv of invoices) {
    const direct = directTotal.get(inv.id) ?? 0;
    // The same capacity rule as `allocateAdvances`, or the dashboard and the
    // invoice page would disagree about where an advance ended up.
    let capacity = round2(Math.max(0, inv.grand_total - inv.credited - direct));
    let applied = 0;
    for (const r of reachable(inv)) {
      if (capacity <= 0) break;
      if (r.left <= 0) continue;
      if (!sameCurrency(r.currency, inv.currency)) continue;
      const take = round2(Math.min(r.left, capacity));
      r.left = round2(r.left - take);
      capacity = round2(capacity - take);
      applied = round2(applied + take);
    }
    received.set(inv.id, round2(direct + applied));
    appliedBy.set(inv.id, applied);
  }
  return { received, applied: appliedBy };
}

/** What has been banked as an advance behind an order. */
export interface OrderAdvance {
  /** The proforma the order was booked from, if there is one. */
  pi_id: number | null;
  pi_number: string;
  amount_received: number;
  /** When the most recent matching payment landed, for "Date of Credit". */
  last_date: string;
  /** Payments in another currency, counted by nobody and reported instead. */
  currency_mismatch: { currency: string; amount: number }[];
  /**
   * The rows behind the figure — the proforma's advance and any banked against
   * the order itself — so the order page can list and record them rather than
   * only quote a total.
   *
   * The route **strips this key for a caller without `payment`**, the rule
   * `customerSummary.ts` states: Logistics and Production read the order book
   * and hold `payment: none`, and a bank reference is not theirs.
   */
  payments: PaymentRow[];
  /** The currency the figure is counted in: the proforma's, else the order's. */
  currency: string;
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
  const order = db.prepare('SELECT currency FROM orders WHERE id = ?').get(orderId) as
    | { currency: string } | undefined;
  const pi = db.prepare(
    'SELECT id, number, currency FROM proforma_invoices WHERE order_id = ? ORDER BY id LIMIT 1'
  ).get(orderId) as { id: number; number: string; currency: string } | undefined;

  /*
   * One figure over both pools.
   *
   * The advance is banked against the **proforma** wherever the chain has one,
   * which is why the order page records into that pool and the proforma's own
   * document goes on stating what it took in. An order with no proforma — the
   * whole backlog, and anything booked outside the chain — banks against
   * itself, and both are read here so the order quotes one number either way.
   */
  const rows = pi
    ? db.prepare('SELECT * FROM payments WHERE pi_id = ? OR order_id = ? ORDER BY date, id')
      .all(pi.id, orderId) as unknown as PaymentRow[]
    : db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY date, id')
      .all(orderId) as unknown as PaymentRow[];

  // The proforma's currency decides where there is one — it is the document
  // the money was banked against — and the order's own where there is not.
  const currency = pi ? pi.currency : String(order?.currency ?? 'INR');
  return advanceOver(rows, currency, pi);
}

/** The figure, the date of credit and what was not counted, over one set of rows. */
function advanceOver(
  rows: PaymentRow[], currency: string, pi?: { id: number; number: string }
): OrderAdvance {
  const counted = rows.filter((p) => sameCurrency(p.currency, currency));
  return {
    pi_id: pi?.id ?? null,
    pi_number: pi?.number ?? '',
    amount_received: round2(counted.reduce((sum, p) => sum + p.amount, 0)),
    // The date of credit is the most recent payment that actually counted. A
    // date drawn from a payment in another currency would name money nothing
    // was credited with, so one rule decides both figures.
    last_date: counted.length ? String(counted[counted.length - 1].date ?? '') : '',
    currency_mismatch: mismatches(rows, currency),
    payments: rows,
    currency,
  };
}

const NO_ADVANCE: OrderAdvance = {
  pi_id: null, pi_number: '', amount_received: 0, last_date: '', currency_mismatch: [],
  payments: [], currency: '',
};

/** What an order asks for up front, and what has actually arrived against it. */
export interface AdvanceDue {
  /** The money the order's terms ask for before dispatch; 0 when they ask for none. */
  due: number;
  /** What has been banked — both pools, plus the legacy typed figure. */
  received: number;
  /** `due - received`, floored at zero. */
  outstanding: number;
  currency: string;
  /** The terms the figure was read out of, for the sentence that refuses. */
  terms: string;
}

/**
 * The advance a set of payment terms asks for, in money, or 0 when it asks for
 * none. Reads the leading percentage of a term like "40% Advance and Balance
 * against shipping documents"; a credit term, a `100% CAD` or a bare `30-70`
 * names no percentage and gives **0**, which is the conservative direction —
 * this figure gates a lorry, and guessing one where the terms state none would
 * hold a real shipment over a sentence nobody wrote as a commitment.
 *
 * It was written for the order form's Advance Due box, unused from 2026-09-17
 * when that box was removed (*"the terms already say what is due up front, and
 * a second figure typed there is one that can disagree"*), and kept "for the
 * day the figure is wanted somewhere else". This is that day: deriving it from
 * the terms rather than reinstating the box is what honours both instructions
 * at once — one statement of what is due, in the client's own words, and a
 * gate that reads it.
 */
export function advanceDueFrom(terms: string, total: number): number {
  const m = String(terms ?? '').match(/(\d+(?:\.\d+)?)\s*%\s*advance/i);
  if (!m || !total) return 0;
  return round2((Number(m[1]) / 100) * total);
}

/**
 * What one order asks for up front against what it has taken in.
 *
 * **The commitment is the terms, with the stored column as the more specific
 * answer**: `orders.advance_due` is written only where somebody typed it — and
 * since the box went, that is only orders raised before 2026-09-17 — so a
 * figure explicitly agreed wins over one read out of a sentence.
 *
 * **Received counts the typed column too**, with `orderAdvance`'s recorded
 * figure first, exactly as the order PDF's own *Advance Received* line reads:
 * a legacy order carries its advance in that column and nowhere else, and
 * refusing to see it would hold a lorry for money the record says arrived. It
 * cannot be used to walk the gate — the box is offered only on an order that
 * already carries a figure in it, never on a new one.
 */
export function advanceDue(orderId: number): AdvanceDue {
  const o = db.prepare(
    'SELECT currency, payment_terms, grand_total, advance_due, advance_amount FROM orders WHERE id = ?'
  ).get(orderId) as
    | { currency: string; payment_terms: string; grand_total: number; advance_due: number; advance_amount: number }
    | undefined;
  if (!o) return { due: 0, received: 0, outstanding: 0, currency: '', terms: '' };

  const terms = String(o.payment_terms ?? '');
  const due = Number(o.advance_due) > 0
    ? round2(Number(o.advance_due))
    : advanceDueFrom(terms, Number(o.grand_total) || 0);
  const received = orderAdvance(orderId).amount_received || round2(Number(o.advance_amount) || 0);
  return {
    due,
    received,
    outstanding: Math.max(0, round2(due - received)),
    currency: String(o.currency ?? ''),
    terms,
  };
}

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
  const pi = db.prepare('SELECT id, number, currency FROM proforma_invoices WHERE id = ?').get(piId) as
    | { id: number; number: string; currency: string }
    | undefined;
  if (!pi) return NO_ADVANCE;
  return advanceOver(proformaAdvance(pi.id).payments, pi.currency, pi);
}
