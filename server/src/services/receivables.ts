import { db } from '../db/connection.js';
import { round2 } from './totals.js';

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
const sameCurrency = (payment: string | null | undefined, document: string) =>
  !String(payment ?? '').trim() || String(payment).trim() === String(document).trim();

/** Advances on a proforma, split across the invoices raised from it (earliest first). */
function allocateAdvances(piId: number): Map<number, AppliedPayment[]> {
  const pool = db.prepare(
    'SELECT * FROM payments WHERE pi_id = ? AND invoice_id IS NULL ORDER BY date, id'
  ).all(piId) as unknown as PaymentRow[];
  const invoices = db.prepare(
    'SELECT id, currency, grand_total FROM commercial_invoices WHERE pi_id = ? ORDER BY date, id'
  ).all(piId) as { id: number; currency: string; grand_total: number }[];

  const remaining = pool.map((payment) => ({ payment, left: payment.amount }));
  const byInvoice = new Map<number, AppliedPayment[]>();

  for (const inv of invoices) {
    const direct = db.prepare('SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE invoice_id = ? AND (currency = ? OR TRIM(COALESCE(currency, \'\')) = \'\')')
      .get(inv.id, inv.currency) as { v: number };
    let capacity = round2(Math.max(0, inv.grand_total - direct.v));
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

/** What one invoice has actually been credited with. */
export function invoiceReceivable(invoiceId: number): InvoiceReceivable {
  const inv = db.prepare('SELECT id, pi_id, currency, grand_total FROM commercial_invoices WHERE id = ?').get(invoiceId) as
    | { id: number; pi_id: number | null; currency: string; grand_total: number } | undefined;
  if (!inv) return { payments: [], amount_received: 0, balance_due: 0, advance_applied: 0, currency_mismatch: [] };

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
  return {
    payments: [...direct, ...advances],
    amount_received: received,
    balance_due: round2(inv.grand_total - received),
    advance_applied: advanceApplied,
    currency_mismatch: mismatches([...own, ...pool], inv.currency),
  };
}

/**
 * Amount received for every invoice at once, for the dashboard — same
 * allocation rule, but without re-querying per invoice.
 */
export function receivedByInvoice(): Map<number, number> {
  const invoices = db.prepare('SELECT id, pi_id, currency, grand_total FROM commercial_invoices ORDER BY date, id').all() as
    { id: number; pi_id: number | null; currency: string; grand_total: number }[];
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
    let capacity = round2(Math.max(0, inv.grand_total - direct));
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
