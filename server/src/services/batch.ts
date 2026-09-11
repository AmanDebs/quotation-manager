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

/**
 * What may be decided about a lot that failed.
 *
 * The specification's own two words — *"initiating rework or scrap
 * procedures"* — and deliberately no third. A *quarantined* value was the
 * obvious addition and would have stored something already derivable: a lot
 * that failed and carries no disposition **is** the held one, and `held` says
 * so without a second copy that could drift from it.
 *
 * **Rework needs no machinery of its own.** A lot's verdict is its latest
 * decided final check, so putting a lot back and re-inspecting it already
 * clears it — the loop was closed in `batchesFor` before this existed. What
 * was missing was the *record*: why a failed lot is still open, and who said
 * so. **Scrap is the half that moves figures**, because condemned goods stop
 * existing and everything that counts what a job has made has to agree.
 */
export const DISPOSITIONS = ['rework', 'scrapped'] as const;
export type Disposition = '' | (typeof DISPOSITIONS)[number];

export function isDisposition(v: unknown): v is Disposition {
  return v === '' || (DISPOSITIONS as readonly unknown[]).includes(v);
}

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
   * What was decided about a lot that failed: '' , 'rework' or 'scrapped'.
   * Blank on every lot that never failed, and on one that failed and is still
   * waiting for somebody to decide — which is what `held` reports.
   */
  disposition: Disposition;
  disposition_date: string;
  disposition_by_name: string | null;
  disposition_note: string;
  /**
   * Failed its final check, and nobody has said what to do about it.
   *
   * Derived rather than a fourth stored value: a "quarantined" state would be
   * a second name for the absence of a decision, and two ways of saying one
   * thing is how the two come to disagree. This is the figure the dashboard
   * counts, because a condemned lot nobody has ruled on is exactly the row
   * that sits for a month.
   */
  held: boolean;
  /** Condemned. The goods no longer exist, so no roll-up counts them. */
  scrapped: boolean;
  /**
   * The trips this lot travelled on — §3's last leg, read backwards.
   *
   * Empty is the ordinary state and means nothing beyond "not named on a trip
   * yet": naming lots on a dispatch is optional, so this can never be read as
   * *this lot has not shipped*, only as *nobody recorded it against one*.
   */
  trips: BatchTrip[];
  /**
   * The credit notes this lot was named on as returned — the trips read the
   * other way. Every note naming it whatever its approval, so the screen can
   * say a return is drafted; `returned` below counts only the approved.
   */
  returns: BatchReturn[];
  /**
   * Named on an **approved** return credit note. The one fact that lets a
   * dispatched lot be scrapped: the goods are physically back, so condemning
   * them no longer drops the order's figure for goods the buyer still holds.
   * Only approved, the rule `CREDITED_SQL` states — a drafted return is not
   * yet a return.
   */
  returned: boolean;
}

/** A credit note one lot came back on. */
export interface BatchReturn {
  credit_note_id: number;
  number: string;
  date: string;
  approval_status: string;
  invoice_number: string;
}

const num = (v: unknown) => round2(Number(v) || 0);

/** Every lot on one job, oldest first, each with its own figures. */
export function batchesFor(workOrderId: number): Batch[] {
  const rows = db.prepare(
    `SELECT b.*, u.name AS coa_issued_by_name, du.name AS disposition_by_name
       FROM batches b
       LEFT JOIN users u ON u.id = b.coa_issued_by
       LEFT JOIN users du ON du.id = b.disposition_by
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
  // And whether it came back.
  const returns = returnsForBatches(rows.map((r) => Number(r.id)));

  return rows.map((r) => {
    const id = Number(r.id);
    const made = output.get(id) ?? { ok: 0, rej: 0, n: 0 };
    const mine = checks.filter((c) => Number((c as unknown as { batch_id: unknown }).batch_id) === id);
    const decided = mine.filter((c) => c.passed !== null);
    const last = decided[decided.length - 1];
    const qc: BatchQc = !last ? 'none' : last.passed ? 'passed' : 'failed';
    const disposition = (isDisposition(r.disposition) ? r.disposition : '') as Disposition;
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
      qc: qc as BatchQc,
      cleared: String(r.coa_no ?? '') !== '',
      disposition,
      disposition_date: String(r.disposition_date ?? ''),
      disposition_by_name: r.disposition_by_name == null ? null : String(r.disposition_by_name),
      disposition_note: String(r.disposition_note ?? ''),
      held: qc === 'failed' && disposition === '',
      scrapped: disposition === 'scrapped',
      trips: trips.get(id) ?? [],
      returns: returns.get(id) ?? [],
      returned: (returns.get(id) ?? []).some((n) => n.approval_status === 'approved'),
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
  /*
   * **Condemned is final while it stands.** A scrapped lot may not be
   * certified however its checks later read — which matters, because a lot's
   * verdict is its *latest decided* check, so re-inspecting a scrapped lot
   * would otherwise walk it straight back to a certificate. The way out is to
   * withdraw the scrap decision, which is a thing somebody does on purpose and
   * which the trail records, not a thing a fresh reading does silently.
   */
  if (b.scrapped) {
    return `Batch ${b.number} was scrapped, so it cannot be certified. `
      + 'Withdraw the scrap decision first if that was recorded in error.';
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
      `SELECT b.number, b.coa_no, b.disposition, w.order_id
         FROM batches b JOIN work_orders w ON w.id = b.work_order_id
        WHERE b.id = ?`
    ).get(id) as { number: string; coa_no: string; disposition: string; order_id: number } | undefined;
    if (!row) return 'One of the batches named is not on file — it may have been deleted since.';
    if (Number(row.order_id) !== Number(orderId)) {
      return `Batch ${row.number} was made against another order, so it cannot be dispatched on this one.`;
    }
    /*
     * Asked **before** the certificate, because a lot can be certified and
     * then condemned — dropped in the yard, or found bad after clearance — and
     * it would otherwise walk through on the COA it still holds. That is the
     * one case where a scrapped lot passes every other test here.
     */
    if (String(row.disposition) === 'scrapped') {
      return `Batch ${row.number} was scrapped, so it cannot be dispatched.`;
    }
    if (!String(row.coa_no)) {
      return `Batch ${row.number} has no Certificate of Analysis, so it cannot be dispatched. `
        + 'Issue one against it first.';
    }
  }
  return null;
}

/**
 * Why this lot may not be given this disposition, or null.
 *
 * Deliberately short. Deciding what to do with a failed lot is a judgement
 * somebody on the floor makes, and a guard that second-guesses it would be
 * refusing the very thing this exists to record — so only two things are
 * refused, and both are about goods that are no longer here to decide about.
 *
 * **A lot that has gone to the customer cannot be reworked or scrapped**: the
 * pieces are on their premises, and condemning them here would drop the
 * order's made-figure for goods that physically shipped, which is the reverse
 * of the defect scrap exists to fix. What happens to bad goods already
 * delivered is a return, and this app has no shape for one — so it says so
 * rather than lending the wrong word to it.
 *
 * **Withdrawing a decision is always allowed**, which is what `''` is. Scrap
 * has no artefact out in the world the way an issued COA has, so the rule that
 * makes a certificate final does not apply to it — and a lot condemned by
 * mistake with no way back would be a trap with no way out, which this
 * codebase has built once already and does not intend to build again.
 */
export function dispositionError(id: number, disposition: Disposition): string | null {
  const b = batchById(id);
  if (!b) return 'Batch not found.';
  if (disposition === '') return null;
  /*
   * ...unless it came back. A lot named on an **approved** return credit note
   * is physically here again, and scrapping it is exactly what the return was
   * for. Approved, not merely drafted: the balance moves on approval and so
   * does this, or a lot could be condemned on the strength of a return nobody
   * has signed.
   */
  if (b.trips.length && !b.returned) {
    const where = b.trips.map((t) => t.reference || t.order_number).filter(Boolean).join(', ');
    const drafted = b.returns.length ? ' A return naming it is drafted but not yet approved.' : '';
    return `Batch ${b.number} has already been dispatched${where ? ` on ${where}` : ''}, `
      + 'so it cannot be reworked or scrapped here. If the goods came back, name the lot on the '
      + `credit note for that return and approve it first.${drafted}`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* WHAT CAME BACK                                                      */
/* ------------------------------------------------------------------ */

/** A lot on the order behind an invoice, as the credit note's picker needs it. */
export interface ReturnableBatch extends OrderBatch {
  /** The trips it went out on — a hint, not a gate; naming lots on a trip is optional. */
  trips: BatchTrip[];
}

/** The sales order an invoice bills against, or null — `dispatchProgress`'s own walk. */
export function orderBehindInvoice(invoiceId: number): number | null {
  const row = db.prepare(
    `SELECT COALESCE(order_id, (SELECT order_id FROM proforma_invoices WHERE id = pi_id)) AS o
       FROM commercial_invoices WHERE id = ?`
  ).get(invoiceId) as { o: number | null } | undefined;
  return row?.o ? Number(row.o) : null;
}

/**
 * Every lot on the order behind an invoice, with where each went, for the
 * credit note's picker. Empty for an invoice with no order behind it — such an
 * invoice was produced against nothing, so there is no lot to have come back.
 */
export function batchesForInvoice(invoiceId: number): ReturnableBatch[] {
  const orderId = orderBehindInvoice(invoiceId);
  if (!orderId) return [];
  const lots = batchesForOrder(orderId);
  const trips = tripsForBatches(lots.map((b) => b.id));
  return lots.map((b) => ({ ...b, trips: trips.get(b.id) ?? [] }));
}

/** The lots named on one credit note, in order-line order. */
export function batchesOnCreditNote(creditNoteId: number): DespatchBatch[] {
  const rows = db.prepare(
    `SELECT ${LOT_COLUMNS}
       FROM credit_note_batches cb
       JOIN batches b ON b.id = cb.batch_id
       JOIN work_orders w ON w.id = b.work_order_id
       LEFT JOIN products p ON p.id = w.product_id
      WHERE cb.credit_note_id = ?
      ORDER BY w.order_line, b.date, b.id`
  ).all(creditNoteId) as Record<string, unknown>[];
  return rows.map(toLot);
}

/** Rewrite which lots came back on a credit note, whole — `setDespatchBatches`'s shape. */
export function setCreditNoteBatches(creditNoteId: number, batchIds: unknown[]): void {
  db.prepare('DELETE FROM credit_note_batches WHERE credit_note_id = ?').run(creditNoteId);
  const ins = db.prepare('INSERT INTO credit_note_batches (credit_note_id, batch_id) VALUES (?, ?)');
  for (const id of uniqueIds(batchIds)) ins.run(creditNoteId, id);
}

/**
 * Why these lots may not be named as returned on a credit note, or null.
 *
 * `despatchBatchError` read the other way, with one refusal of its own at the
 * front: an **adjustment** moves no goods, so a lot named on one is a
 * contradiction rather than a record. Then the same two: a lot not on file,
 * and a lot made against another order — the order behind the *invoice*,
 * reached the way `dispatchProgress` reaches it, since a credit note carries
 * no `order_id` of its own. A scrapped lot is refused too: it never left, so
 * it cannot have come back.
 *
 * **Deliberately not required: that the lot was named on a trip.** Naming
 * lots on a dispatch is optional and every trip on file predates it, so
 * refusing a return for a lot nobody recorded going out would refuse the
 * honest case. The picker shows the trips as a hint instead.
 *
 * Naming no lots is always allowed, as everywhere the link exists.
 */
export function returnBatchError(invoiceId: number, kind: string, batchIds: unknown[]): string | null {
  const raw = (batchIds ?? []) as unknown[];
  if (!raw.length) return null;
  if (kind !== 'return') {
    return 'An adjustment credits money and moves no goods, so it cannot name a lot as returned. '
      + 'Record the credit as goods returned if a lot actually came back.';
  }
  if (raw.some((v) => !Number.isInteger(Number(v)) || Number(v) <= 0)) {
    return 'One of the batches named is not on file — it may have been deleted since.';
  }
  const orderId = orderBehindInvoice(invoiceId);
  for (const id of uniqueIds(raw)) {
    const row = db.prepare(
      `SELECT b.number, b.disposition, w.order_id
         FROM batches b JOIN work_orders w ON w.id = b.work_order_id
        WHERE b.id = ?`
    ).get(id) as { number: string; disposition: string; order_id: number } | undefined;
    if (!row) return 'One of the batches named is not on file — it may have been deleted since.';
    if (!orderId || Number(row.order_id) !== orderId) {
      return `Batch ${row.number} was made against another sales order, so it cannot have come back on this invoice.`;
    }
    if (String(row.disposition) === 'scrapped') {
      return `Batch ${row.number} was scrapped and never left, so it cannot have come back.`;
    }
  }
  return null;
}

/** Every credit note each of these lots came back on, keyed by batch id. */
export function returnsForBatches(batchIds: number[]): Map<number, BatchReturn[]> {
  const out = new Map<number, BatchReturn[]>();
  if (!batchIds.length) return out;
  const rows = db.prepare(
    `SELECT cb.batch_id, n.id, n.number, n.date, n.approval_status, i.number AS invoice_number
       FROM credit_note_batches cb
       JOIN credit_notes n ON n.id = cb.credit_note_id
       JOIN commercial_invoices i ON i.id = n.invoice_id
      WHERE cb.batch_id IN (${batchIds.map(() => '?').join(',')})
      ORDER BY n.date, n.id`
  ).all(...batchIds) as Record<string, unknown>[];
  for (const r of rows) {
    const key = Number(r.batch_id);
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push({
      credit_note_id: Number(r.id),
      number: String(r.number ?? ''),
      date: String(r.date ?? ''),
      approval_status: String(r.approval_status ?? ''),
      invoice_number: String(r.invoice_number ?? ''),
    });
  }
  return out;
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
