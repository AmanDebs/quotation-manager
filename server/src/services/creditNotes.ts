import { db } from '../db/connection.js';
import { round2, billedQty, type LineItemInput } from './totals.js';

/**
 * What comes back, and what the buyer is credited for it.
 *
 * Scrap gave a condemned lot a decision to record and immediately exposed the
 * hole beside it: `dispositionError` refuses to rule on a lot that has gone to
 * the customer and says in as many words that bad goods already delivered are
 * a **return**, which this app had no shape for. This is that shape, and it is
 * a money document rather than a goods-inward register because recording that
 * 5,000 pieces came back while the invoice goes on demanding the money for
 * them is exactly the silent under-reporting refused everywhere else here —
 * and because under GST a sales return *is* a credit note (s.34), raised
 * against the original invoice.
 *
 * **This file must never import `receivables.ts`**, which imports it: the
 * balance owed is that file's question and the credit against it is this one's.
 * The same one-way rule `qc.ts` and `batch.ts` keep between them.
 */

/**
 * Why there is a credit — and the only thing on the row that changes what the
 * rest of the app does with it.
 *
 * Two values, and the whole design is in the difference. A **return** means
 * goods physically came back, so its quantities come off what the order line
 * counts as dispatched; an **adjustment** is money alone — a rate agreed down
 * after the fact, a short shipment settled, a discount — and must not touch a
 * physical figure, because nothing physical moved.
 *
 * No CHECK constraint, the rule `products.product_type` states: SQLite cannot
 * ALTER one and this list expects to grow. The route answers 400 naming what
 * it accepts.
 */
export const CREDIT_KINDS = ['return', 'adjustment'] as const;
export type CreditKind = (typeof CREDIT_KINDS)[number];

export const isCreditKind = (v: unknown): v is CreditKind =>
  (CREDIT_KINDS as readonly string[]).includes(String(v));

/**
 * What an invoice has been credited, as SQL, so the three readers of a balance
 * can subtract it inside their own statements rather than each asking again.
 *
 * **Only an approved credit note credits anything**, and that is the load-
 * bearing rule of this whole file. A draft that reduced a balance would let
 * anybody quietly write a debt off by typing one — which is precisely what
 * approval exists to prevent, and why a credit note has an approval workflow
 * and no status ladder. `resetApprovalOnEdit` therefore un-credits a note the
 * moment somebody edits it, which is the behaviour wanted rather than a
 * side effect to work around.
 *
 * There is **no currency rule here**, unlike everywhere else money is added up
 * in this codebase, and that is a fact about the data rather than an omission:
 * a credit note copies its currency from the invoice it credits on every save
 * and never reads one from the body, so the two cannot disagree.
 */
export const CREDITED_SQL = (invoiceIdExpr: string) =>
  `COALESCE((SELECT SUM(cn.grand_total) FROM credit_notes cn`
  + ` WHERE cn.invoice_id = ${invoiceIdExpr} AND cn.approval_status = 'approved'), 0)`;

/** What one invoice has been credited, in its own currency. */
export function creditedForInvoice(invoiceId: number): number {
  const row = db.prepare(`SELECT ${CREDITED_SQL('?')} AS v`).get(invoiceId) as { v: number };
  return round2(Number(row?.v) || 0);
}

/** The same figure for every invoice at once, for the readers that page. */
export function creditedByInvoice(): Map<number, number> {
  const rows = db.prepare(
    `SELECT invoice_id, SUM(grand_total) AS v FROM credit_notes
      WHERE approval_status = 'approved' GROUP BY invoice_id`
  ).all() as { invoice_id: number; v: number }[];
  return new Map(rows.map((r) => [Number(r.invoice_id), round2(Number(r.v) || 0)]));
}

/**
 * How much of each invoice line has been **returned** — by position, the index
 * rule the whole chain uses.
 *
 * Adjustments are excluded outright rather than filtered by the caller: an
 * adjustment credits money against a line without anything coming back, and
 * counting it here would re-open an order line for goods still with the buyer.
 */
export function returnedQtyByLine(invoiceId: number): Map<number, number> {
  const rows = db.prepare(
    `SELECT ci.sort_order, ci.id, ci.qty, ci.is_charge, cn.id AS note_id
       FROM credit_note_items ci
       JOIN credit_notes cn ON cn.id = ci.credit_note_id
      WHERE cn.invoice_id = ? AND cn.kind = 'return' AND cn.approval_status = 'approved'
      ORDER BY cn.id, ci.sort_order, ci.id`
  ).all(invoiceId) as { qty: number | null; is_charge: number; note_id: number }[];

  // Position is per credit note, so the rows are re-indexed within each one.
  const out = new Map<number, number>();
  let note = -1;
  let i = -1;
  for (const r of rows) {
    if (r.note_id !== note) { note = r.note_id; i = -1; }
    i += 1;
    if (r.is_charge) continue;                       // a charge ships nothing back
    if (r.qty == null) continue;
    out.set(i, round2((out.get(i) ?? 0) + Number(r.qty)));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* THE TWO GUARDS                                                      */
/* ------------------------------------------------------------------ */

/** The invoice's own lines, as the guards need to see them. */
function invoiceLines(invoiceId: number) {
  return db.prepare(
    'SELECT qty, unit, total_pcs, is_charge, description FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id'
  ).all(invoiceId) as { qty: number | null; unit: string; total_pcs: number | null; is_charge: number; description: string }[];
}

/**
 * Nothing may be returned that was not billed, and nothing twice.
 *
 * Shaped like `despatchLimitError`, `qcBlockError` and the rest — a function
 * returning the sentence to refuse with, testable without the HTTP harness
 * this codebase does not have — but the ceiling is **hard where the despatch
 * one is generous**, and the asymmetry is the point. A despatch line is
 * allowed Aglo's own ±10% over what is outstanding, because a small over-
 * shipment is expected and the rule is there to catch a slipped digit.
 * Returning more than was billed is never right at any tolerance: the goods
 * were not sent, so they cannot come back.
 *
 * Three things carry no ceiling, each for its own reason. A **charge line**
 * never shipped, so there is nothing physical to return — an overbilled
 * freight charge is credited for its money alone. An **adjustment** states
 * quantities only descriptively, nothing having moved. And a line the invoice
 * does not have is refused rather than bounded, since a position with no
 * counterpart names goods nobody was billed for.
 *
 * `exceptNoteId` excludes the note being edited, without which re-saving an
 * unchanged credit note would count itself and refuse itself — the defect the
 * dispatch dialog shipped with and which is worth not building twice.
 * Everything **not rejected** counts, drafts included: two drafts each
 * crediting the whole line, then both approved, is the double credit this
 * exists to stop, and a rejected note is a decision that it does not stand.
 */
export function returnLimitError(
  invoiceId: number,
  kind: string,
  items: LineItemInput[],
  exceptNoteId?: number | null
): string | null {
  if (kind !== 'return') return null;
  const lines = invoiceLines(invoiceId);

  const already = new Map<number, number>();
  const rows = db.prepare(
    `SELECT ci.qty, ci.is_charge, cn.id AS note_id
       FROM credit_note_items ci
       JOIN credit_notes cn ON cn.id = ci.credit_note_id
      WHERE cn.invoice_id = ? AND cn.kind = 'return'
        AND cn.approval_status <> 'rejected' AND cn.id <> ?
      ORDER BY cn.id, ci.sort_order, ci.id`
  ).all(invoiceId, exceptNoteId ?? -1) as { qty: number | null; is_charge: number; note_id: number }[];
  let note = -1;
  let idx = -1;
  for (const r of rows) {
    if (r.note_id !== note) { note = r.note_id; idx = -1; }
    idx += 1;
    if (r.is_charge || r.qty == null) continue;
    already.set(idx, round2((already.get(idx) ?? 0) + Number(r.qty)));
  }

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.is_charge) continue;
    const asked = billedQty(it) ?? 0;
    if (asked === 0) continue;                       // nothing claimed on this line
    if (asked < 0) {
      return `Line ${i + 1} returns a negative quantity. A credit note records goods coming back, `
        + 'so the figure is how many, never how many fewer.';
    }
    const line = lines[i];
    if (!line) {
      return `Line ${i + 1} has no counterpart on the invoice, so there is nothing there to return. `
        + 'A credit note credits lines that were billed.';
    }
    const billed = Number(line.qty) || 0;
    const left = round2(billed - (already.get(i) ?? 0));
    if (asked > left) {
      const what = String(line.description || '').trim() || `line ${i + 1}`;
      const spent = round2(already.get(i) ?? 0);
      return `Line ${i + 1} returns ${asked.toLocaleString('en-IN')} of ${what}, but the invoice billed `
        + `${billed.toLocaleString('en-IN')}`
        + (spent ? ` and ${spent.toLocaleString('en-IN')} has already been credited` : '')
        + `, leaving ${left.toLocaleString('en-IN')}.`;
    }
  }
  return null;
}

/**
 * Nothing may be credited beyond what the invoice billed.
 *
 * The document-level counterpart to the line rule above, and the only ceiling
 * an **adjustment** has — quantities mean nothing there, but the money still
 * cannot exceed the bill it reduces. Checked against the total `computeTotals`
 * has just produced rather than against the body's own figures, the rule that
 * no client-computed amount is ever trusted.
 *
 * Answered **400** like its sibling, not 409: nothing conflicts, the figure is
 * simply wrong.
 */
export function creditTotalError(
  invoiceId: number,
  grandTotal: number,
  exceptNoteId?: number | null
): string | null {
  const inv = db.prepare('SELECT number, currency, grand_total FROM commercial_invoices WHERE id = ?')
    .get(invoiceId) as { number: string; currency: string; grand_total: number } | undefined;
  if (!inv) return null;                             // the link guard answers this one
  const row = db.prepare(
    `SELECT COALESCE(SUM(grand_total), 0) AS v FROM credit_notes
      WHERE invoice_id = ? AND approval_status <> 'rejected' AND id <> ?`
  ).get(invoiceId, exceptNoteId ?? -1) as { v: number };

  const already = round2(Number(row?.v) || 0);
  const left = round2(Number(inv.grand_total) - already);
  if (round2(grandTotal) > left) {
    const money = (n: number) => `${inv.currency} ${n.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    return `This credit note comes to ${money(round2(grandTotal))}, but invoice ${inv.number} was raised for `
      + `${money(round2(Number(inv.grand_total)))}`
      + (already ? ` and ${money(already)} of it has already been credited` : '')
      + `, leaving ${money(Math.max(0, left))}.`;
  }
  return null;
}
