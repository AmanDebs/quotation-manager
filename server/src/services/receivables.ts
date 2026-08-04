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

/** Advances on a proforma, split across the invoices raised from it (earliest first). */
function allocateAdvances(piId: number): Map<number, AppliedPayment[]> {
  const pool = db.prepare(
    'SELECT * FROM payments WHERE pi_id = ? AND invoice_id IS NULL ORDER BY date, id'
  ).all(piId) as unknown as PaymentRow[];
  const invoices = db.prepare(
    'SELECT id, grand_total FROM commercial_invoices WHERE pi_id = ? ORDER BY date, id'
  ).all(piId) as { id: number; grand_total: number }[];

  const remaining = pool.map((payment) => ({ payment, left: payment.amount }));
  const byInvoice = new Map<number, AppliedPayment[]>();

  for (const inv of invoices) {
    const direct = db.prepare('SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE invoice_id = ?')
      .get(inv.id) as { v: number };
    let capacity = round2(Math.max(0, inv.grand_total - direct.v));
    const share: AppliedPayment[] = [];
    for (const r of remaining) {
      if (capacity <= 0) break;
      if (r.left <= 0) continue;
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
}

/** What one invoice has actually been credited with. */
export function invoiceReceivable(invoiceId: number): InvoiceReceivable {
  const inv = db.prepare('SELECT id, pi_id, grand_total FROM commercial_invoices WHERE id = ?').get(invoiceId) as
    | { id: number; pi_id: number | null; grand_total: number } | undefined;
  if (!inv) return { payments: [], amount_received: 0, balance_due: 0, advance_applied: 0 };

  const direct = (db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY date, id').all(invoiceId) as unknown as PaymentRow[])
    .map((p) => ({ ...p, applied_amount: p.amount }));
  const advances = inv.pi_id != null ? allocateAdvances(inv.pi_id).get(invoiceId) ?? [] : [];

  const advanceApplied = round2(advances.reduce((s, p) => s + p.applied_amount, 0));
  const received = round2(sumAmounts(direct) + advanceApplied);
  return {
    payments: [...direct, ...advances],
    amount_received: received,
    balance_due: round2(inv.grand_total - received),
    advance_applied: advanceApplied,
  };
}

/**
 * Amount received for every invoice at once, for the dashboard — same
 * allocation rule, but without re-querying per invoice.
 */
export function receivedByInvoice(): Map<number, number> {
  const invoices = db.prepare('SELECT id, pi_id, grand_total FROM commercial_invoices ORDER BY date, id').all() as
    { id: number; pi_id: number | null; grand_total: number }[];
  const payments = db.prepare('SELECT pi_id, invoice_id, amount, date, id FROM payments ORDER BY date, id').all() as
    { pi_id: number | null; invoice_id: number | null; amount: number }[];

  const directTotal = new Map<number, number>();
  const pools = new Map<number, { amount: number; left: number }[]>();
  for (const p of payments) {
    if (p.invoice_id != null) {
      directTotal.set(p.invoice_id, round2((directTotal.get(p.invoice_id) ?? 0) + p.amount));
    } else if (p.pi_id != null) {
      const pool = pools.get(p.pi_id) ?? [];
      pool.push({ amount: p.amount, left: p.amount });
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
      const take = round2(Math.min(r.left, capacity));
      r.left = round2(r.left - take);
      capacity = round2(capacity - take);
      applied = round2(applied + take);
    }
    received.set(inv.id, round2(direct + applied));
  }
  return received;
}
