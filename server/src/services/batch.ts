import { db } from '../db/connection.js';
import { round2 } from './totals.js';
import { checksForWorkOrder, type QcCheck } from './qc.js';

/**
 * A production run, and the certificate that clears it.
 *
 * The client's ERP specification of 2026-09-10 asks for two things this app
 * had no shape for: a **Finished Goods Batch** that an invoice line traces
 * back to, and a **Certificate of Analysis** issued against a passing final
 * check, without which nothing may be invoiced or gate-passed.
 *
 * **A batch hangs off a work order**, which is the only batch this app can
 * honestly hold. The spec uses two framings — a production run, and a
 * finished-goods lot picked from inventory — and only the first is buildable
 * here: there is no finished-goods ledger to pick a free-standing lot out of.
 * Through the job a batch reaches the order line, the order, the customer and
 * the product, which is the whole traceability chain §3 asks for bar the
 * dispatch leg.
 *
 * **Almost nothing is stored**, the rule `production.ts` and `stock.ts` both
 * follow. What a batch made is the sum of the shift entries filed against it,
 * so deleting a mis-keyed shift corrects the lot by construction; whether it
 * passed is read from its final check's own readings through `decorate`, so
 * there is one definition of a pass and the screen and the gate cannot
 * disagree. What *is* stored is the COA, because issuing one is an **act**
 * rather than an observation: somebody cleared this lot, on a date, under a
 * number that may already be with the customer.
 *
 * **This file may import `qc.ts` and `qc.ts` may never import this**, or the
 * two close a circle — the one `documentChain.ts` already has to work around.
 * The question the gate needs answered ("does this order line have a cleared
 * lot?") therefore lives in `qc.ts` beside the rest of that rule.
 */

export type BatchQc = 'none' | 'passed' | 'failed';

export interface Batch {
  id: number;
  number: string;
  work_order_id: number;
  date: string;
  notes: string;
  /** Blank until a COA has been issued. Never re-issued once it is not. */
  coa_no: string;
  coa_date: string;
  coa_issued_by: number | null;
  coa_issued_by_name: string | null;
  /** Derived from the shift entries filed against this lot. */
  made: number;
  rejected: number;
  entries: number;
  /** The checks that name this batch — the *final* ones, in the spec's sense. */
  final_checks: QcCheck[];
  /**
   * The latest **decided** final check's verdict, or `none`.
   *
   * Latest rather than "any passed", which is what `qcBlockError` asks of a
   * job: a job accumulates in-process checks and one pass is evidence the line
   * can be made, while a batch is a thing that is re-tested after rework and
   * the last word about it is the one that counts. A check with nothing
   * measured is not a verdict at all — `decorate`'s rule, not a second one.
   */
  qc: BatchQc;
  /** A COA has been issued. The spec's *QC_PASSED with a valid COA attached*. */
  cleared: boolean;
}

const num = (v: unknown) => round2(Number(v) || 0);

/** Every lot on one job, oldest first, each with its own figures. */
export function batchesFor(workOrderId: number): Batch[] {
  const rows = db.prepare(
    `SELECT b.*, u.name AS coa_issued_by_name
       FROM batches b
       LEFT JOIN users u ON u.id = b.coa_issued_by
      WHERE b.work_order_id = ?
      ORDER BY b.date, b.id`
  ).all(workOrderId) as Record<string, unknown>[];
  if (!rows.length) return [];

  const output = new Map<number, { ok: number; rej: number; n: number }>();
  for (const r of db.prepare(
    `SELECT batch_id, COALESCE(SUM(qty_ok), 0) AS ok, COALESCE(SUM(qty_reject), 0) AS rej,
            COUNT(*) AS n
       FROM production_entries WHERE work_order_id = ? AND batch_id IS NOT NULL
      GROUP BY batch_id`
  ).all(workOrderId) as { batch_id: number; ok: number; rej: number; n: number }[]) {
    output.set(Number(r.batch_id), { ok: Number(r.ok), rej: Number(r.rej), n: Number(r.n) });
  }

  // Asked once for the job rather than once per lot — the N+1 this codebase
  // keeps bounding — and through `checksForWorkOrder`, so a final check is
  // judged by exactly the arithmetic the Quality tab shows.
  const checks = checksForWorkOrder(workOrderId);

  return rows.map((r) => {
    const id = Number(r.id);
    const made = output.get(id) ?? { ok: 0, rej: 0, n: 0 };
    const mine = checks.filter((c) => Number((c as unknown as { batch_id: unknown }).batch_id) === id);
    const decided = mine.filter((c) => c.passed !== null);
    const last = decided[decided.length - 1];
    return {
      id,
      number: String(r.number ?? ''),
      work_order_id: Number(r.work_order_id),
      date: String(r.date ?? ''),
      notes: String(r.notes ?? ''),
      coa_no: String(r.coa_no ?? ''),
      coa_date: String(r.coa_date ?? ''),
      coa_issued_by: r.coa_issued_by == null ? null : Number(r.coa_issued_by),
      coa_issued_by_name: r.coa_issued_by_name == null ? null : String(r.coa_issued_by_name),
      made: num(made.ok),
      rejected: num(made.rej),
      entries: made.n,
      final_checks: mine,
      qc: (!last ? 'none' : last.passed ? 'passed' : 'failed') as BatchQc,
      cleared: String(r.coa_no ?? '') !== '',
    };
  });
}

/** One lot, with the same figures the job's list gives it. */
export function batchById(id: number): Batch | undefined {
  const row = db.prepare('SELECT work_order_id FROM batches WHERE id = ?').get(id) as
    { work_order_id: number } | undefined;
  if (!row) return undefined;
  return batchesFor(Number(row.work_order_id)).find((b) => b.id === id);
}

/**
 * Why a Certificate of Analysis cannot be issued for this lot, or null.
 *
 * Shaped like `qcBlockError`, `lockError` and `incompleteError` — a function
 * returning the sentence to refuse with, so the rule is testable without the
 * HTTP harness this codebase does not have.
 *
 * Four refusals, and the order matters: the most specific reason is the one
 * worth reading. **A lot already certified is never certified again**, the
 * rule every issued number in this app follows — the certificate may be with
 * the customer, and a second one under a new number would make "which COA
 * covers this box" unanswerable. **A lot nothing was booked into** is a number
 * with no goods under it. **A lot never finally checked** is not a failure and
 * is not a pass — the silence-is-not-a-verdict rule this module states about
 * itself — so it is refused with what to do rather than with a verdict. And a
 * lot whose final check **failed** is refused outright: re-testing it is what
 * changes that, and the latest decided check is the one read.
 */
export function coaBlockError(id: number): string | null {
  const b = batchById(id);
  if (!b) return 'Batch not found.';
  if (b.cleared) {
    return `Batch ${b.number} was already certified as ${b.coa_no}. A certificate is issued once.`;
  }
  if (b.entries === 0) {
    return `Nothing has been booked into batch ${b.number} yet, so there is nothing to certify.`;
  }
  if (b.qc === 'none') {
    return `Batch ${b.number} has had no final quality check. `
      + 'Record one against this batch before issuing a certificate.';
  }
  if (b.qc === 'failed') {
    return `The final quality check on batch ${b.number} did not pass, so it cannot be certified.`;
  }
  return null;
}
