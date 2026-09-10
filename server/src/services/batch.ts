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
  /**
   * The trips this lot travelled on — §3's last leg, read backwards.
   *
   * Empty is the ordinary state and means nothing beyond "not named on a trip
   * yet": naming lots on a dispatch is optional, so this can never be read as
   * *this lot has not shipped*, only as *nobody recorded it against one*.
   */
  trips: BatchTrip[];
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
  // Where each lot went, on the same one-query-for-the-job rule.
  const trips = tripsForBatches(rows.map((r) => Number(r.id)));

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
      trips: trips.get(id) ?? [],
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

/* ------------------------------------------------------------------ */
/* WHERE A LOT WENT                                                    */
/* ------------------------------------------------------------------ */

/**
 * The last leg of §3's traceability chain.
 *
 * Everything else about a lot is reachable already — a batch names its work
 * order, which names the order line, the order, the customer and the product.
 * The one fact nobody can derive is **which lots somebody actually put on the
 * lorry**, and that is all `despatch_batches` stores.
 *
 * Two things it deliberately does not hold, each for a reason this codebase
 * gives elsewhere. **No order line**: the batch's own job names it, and a
 * second copy is a second answer that can disagree. **No quantity per lot**:
 * the despatch line already records the pieces sent against that line, and
 * splitting them across lots would be a second set of figures with nothing to
 * reconcile them against — the question a split would answer ("how much of
 * this lot is left") is a finished-goods one, and there is no finished-goods
 * ledger here. So this is set membership: *which* lots travelled, which is
 * what a recall and a certificate both actually ask.
 */

/** A lot named on one trip, with what a document needs to print about it. */
export interface DespatchBatch {
  id: number;
  number: string;
  date: string;
  coa_no: string;
  coa_date: string;
  /** Derived from the batch's own job — never stored on the link. */
  order_line: number;
  work_order_id: number;
  work_order_number: string;
  product_name: string;
}

/** A trip one lot travelled on — the reverse question, which a recall asks. */
export interface BatchTrip {
  despatch_id: number;
  order_id: number;
  order_number: string;
  customer_name: string;
  date: string;
  destination: string;
  /** The challan number where the trip has one, else its consignment note. */
  reference: string;
}

/** Integer ids, deduplicated — naming one lot twice on a trip says nothing more. */
function uniqueIds(ids: unknown[]): number[] {
  return [...new Set((ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

const LOT_COLUMNS = `b.id, b.number, b.date, b.coa_no, b.coa_date,
         w.id AS work_order_id, w.number AS work_order_number, w.order_line,
         COALESCE(p.name, '') AS product_name`;

function toLot(r: Record<string, unknown>): DespatchBatch {
  return {
    id: Number(r.id),
    number: String(r.number ?? ''),
    date: String(r.date ?? ''),
    coa_no: String(r.coa_no ?? ''),
    coa_date: String(r.coa_date ?? ''),
    order_line: Number(r.order_line) || 0,
    work_order_id: Number(r.work_order_id),
    work_order_number: String(r.work_order_number ?? ''),
    product_name: String(r.product_name ?? ''),
  };
}

/** The lots named on one trip, in order-line order. */
export function batchesOnDespatch(despatchId: number): DespatchBatch[] {
  const rows = db.prepare(
    `SELECT ${LOT_COLUMNS}
       FROM despatch_batches db
       JOIN batches b ON b.id = db.batch_id
       JOIN work_orders w ON w.id = b.work_order_id
       LEFT JOIN products p ON p.id = w.product_id
      WHERE db.despatch_id = ?
      ORDER BY w.order_line, b.date, b.id`
  ).all(despatchId) as Record<string, unknown>[];
  return rows.map(toLot);
}

/**
 * Rewrite which lots a trip carried, whole.
 *
 * Deletes and reinserts, the shape every child table here is written with — it
 * makes what is saved exactly what was sent, with no diffing to get wrong. The
 * caller has already run `despatchBatchError`, so nothing unverified reaches
 * this.
 */
export function setDespatchBatches(despatchId: number, batchIds: unknown[]): void {
  db.prepare('DELETE FROM despatch_batches WHERE despatch_id = ?').run(despatchId);
  const ins = db.prepare('INSERT INTO despatch_batches (despatch_id, batch_id) VALUES (?, ?)');
  for (const id of uniqueIds(batchIds)) ins.run(despatchId, id);
}

/**
 * Why these lots may not be named on a trip against this order, or null.
 *
 * The fourth guard of its shape here, and **the Hard Stop made exact**. The
 * specification refuses a Gate Pass for a batch that is not QC_PASSED with a
 * valid COA attached; `qcBlockError` could only ever ask the line-level
 * version of that — *some* lot of this line is certified — because nothing
 * recorded which lot was on the lorry. Naming one answers the question
 * exactly, so a named lot is held to exactly the rule.
 *
 * Three refusals, most specific first. A lot that **does not exist**, which is
 * also what a malformed id resolves to. A lot **made against another order**,
 * which is a scoping hole as much as a traceability lie — it would put another
 * customer's certificate on this consignment's paperwork. And a lot with **no
 * certificate**, which is the Hard Stop itself.
 *
 * Naming no lots returns null, and must: every despatch on file names none,
 * and batching is something a floor starts doing rather than something this
 * imposes backwards.
 */
export function despatchBatchError(orderId: number, batchIds: unknown[]): string | null {
  /*
   * Validated over what was **sent**, not over the cleaned list.
   *
   * `uniqueIds` drops anything that is not a positive integer, which is the
   * right thing for the writer below — but reading the guard through it made a
   * malformed id vanish instead of refusing: the trip saved, with the lot
   * somebody meant to name silently absent from it. A traceability record that
   * quietly loses an entry is worse than one that refuses, because nothing on
   * the screen afterwards says anything is missing.
   */
  const raw = (batchIds ?? []) as unknown[];
  if (raw.some((v) => !Number.isInteger(Number(v)) || Number(v) <= 0)) {
    return 'One of the batches named is not on file — it may have been deleted since.';
  }
  for (const id of uniqueIds(raw)) {
    const row = db.prepare(
      `SELECT b.number, b.coa_no, w.order_id
         FROM batches b JOIN work_orders w ON w.id = b.work_order_id
        WHERE b.id = ?`
    ).get(id) as { number: string; coa_no: string; order_id: number } | undefined;
    if (!row) return 'One of the batches named is not on file — it may have been deleted since.';
    if (Number(row.order_id) !== Number(orderId)) {
      return `Batch ${row.number} was made against another order, so it cannot be dispatched on this one.`;
    }
    if (!String(row.coa_no)) {
      return `Batch ${row.number} has no Certificate of Analysis, so it cannot be dispatched. `
        + 'Issue one against it first.';
    }
  }
  return null;
}

/** A lot on the order, as the dispatch form's picker needs it. */
export interface OrderBatch extends DespatchBatch {
  cleared: boolean;
}

/**
 * Every lot on an order, for that picker.
 *
 * Uncertified lots are **returned rather than filtered out**, so the form can
 * show them greyed with the reason: a picker that silently omits the batch
 * somebody is looking for reads as a fault, where one that shows it and says
 * *no COA yet* says what to do about it. `despatchBatchError` is what actually
 * refuses them, so the screen explains the rule the server holds rather than
 * keeping a second copy of it.
 */
export function batchesForOrder(orderId: number): OrderBatch[] {
  const rows = db.prepare(
    `SELECT ${LOT_COLUMNS}
       FROM batches b
       JOIN work_orders w ON w.id = b.work_order_id
       LEFT JOIN products p ON p.id = w.product_id
      WHERE w.order_id = ? AND w.status <> 'cancelled'
      ORDER BY w.order_line, b.date, b.id`
  ).all(orderId) as Record<string, unknown>[];
  return rows.map((r) => ({ ...toLot(r), cleared: String(r.coa_no ?? '') !== '' }));
}

/**
 * Every trip each of these lots travelled on, keyed by batch id.
 *
 * Asked once for a whole job rather than once per lot — the N+1 this codebase
 * keeps bounding, and the same call `batchesFor` makes about its output and
 * its checks.
 */
export function tripsForBatches(batchIds: number[]): Map<number, BatchTrip[]> {
  const out = new Map<number, BatchTrip[]>();
  if (!batchIds.length) return out;
  const rows = db.prepare(
    `SELECT db.batch_id, d.id AS despatch_id, d.date, d.destination, d.challan_no, d.cn_no,
            o.id AS order_id, o.number AS order_number, c.name AS customer_name
       FROM despatch_batches db
       JOIN despatches d ON d.id = db.despatch_id
       JOIN orders o ON o.id = d.order_id
       JOIN customers c ON c.id = o.customer_id
      WHERE db.batch_id IN (${batchIds.map(() => '?').join(',')})
      ORDER BY d.date, d.id`
  ).all(...batchIds) as Record<string, unknown>[];
  for (const r of rows) {
    const key = Number(r.batch_id);
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push({
      despatch_id: Number(r.despatch_id),
      order_id: Number(r.order_id),
      order_number: String(r.order_number ?? ''),
      customer_name: String(r.customer_name ?? ''),
      date: String(r.date ?? ''),
      destination: String(r.destination ?? ''),
      // The challan is the document that travelled; a trip recorded before
      // challans existed has only its consignment note, which is the reference
      // it does have — the rule the challan's own header follows.
      reference: String(r.challan_no || r.cn_no || ''),
    });
  }
  return out;
}
