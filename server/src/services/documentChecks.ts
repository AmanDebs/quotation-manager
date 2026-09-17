import { db } from '../db/connection.js';
import { billedQty } from './totals.js';
import { qcBlockError } from './qc.js';
import type { DocTable } from './approval.js';

/**
 * The tables this judges: the four approvable documents, and the sales
 * order — which has no approval workflow (it records the customer's
 * commitment, not an offer), so for it the findings ride the form and gate
 * the PDF and nothing else. Kept apart from `DocTable` so `approval.ts` is
 * never asked to submit an order.
 */
export type CheckedTable = DocTable | 'orders';

/**
 * What a document must carry before it can be approved.
 *
 * Approval is the gate every outgoing document passes through — `approval.ts`
 * owns *who* may open it, this owns *whether the document is finished*. Until
 * now the two were the same question, so a quotation with no line items and a
 * blank date could be approved and sent.
 *
 * **Two levels, and the split is the whole design.** A rule that *blocks* is
 * one nobody could argue with: a document with no lines, no date or a blank
 * description is not a document. A rule that *warns* is one this desk might
 * reasonably break — a GST invoice really ought to carry the buyer's GSTIN and
 * an HSN code per line, but refusing to approve one that does not would stop
 * the business working over a field somebody is about to fill in. Warnings are
 * shown on the form and in the approvals queue and stop nothing.
 *
 * That split exists because **the client's own list of mandatory fields was
 * never supplied** (it is the one open item on their 2026-09-05 checklist).
 * Everything plausible is therefore already computed and on screen, and
 * promoting a warning to a block is a one-word change to its `level` here —
 * which is why every rule is a row in one table rather than an `if` somewhere.
 * Guessing at a blocking rule and being wrong stops a shipment; guessing at a
 * warning and being wrong costs a line of grey text.
 */

export type Level = 'block' | 'warn';

export interface Finding {
  /** Stable id, so a caller can suppress or promote one without matching prose. */
  key: string;
  level: Level;
  /** What is missing, in the words somebody at this desk would use. */
  message: string;
}

export interface CheckedItem {
  description?: string | null;
  color?: string | null;
  hsn_code?: string | null;
  qty?: number | null;
  total_pcs?: number | null;
  unit?: string | null;
  /** `number | boolean` to match `billedQty`'s own parameter; SQLite gives 0/1. */
  is_charge?: number | boolean | null;
}

export interface CheckedDoc {
  table: CheckedTable;
  row: Record<string, unknown>;
  items: CheckedItem[];
  /** The buyer, for the fields that live on them rather than on the document. */
  customer?: { gstin?: string | null } | null;
}

const text = (v: unknown) => String(v ?? '').trim();

/**
 * What this line bills for, asked of `totals.ts` rather than re-derived.
 *
 * The adapter is only about nulls: a row off SQLite gives `null` where
 * `LineItemInput` declares `undefined`. `is_charge` is dropped deliberately —
 * `billedQty` short-circuits a charge to 1, and the caller here wants to know
 * whether the *goods* have a quantity, having already excluded charges itself.
 */
const billed = (it: CheckedItem): number | null => billedQty({
  qty: it.qty ?? null,
  unit: it.unit ?? undefined,
  total_pcs: it.total_pcs ?? null,
});
const goods = (items: CheckedItem[]) => items.filter((it) => !it.is_charge);
const isExport = (d: CheckedDoc) => Number(d.row.is_export) === 1;
const isDomestic = (d: CheckedDoc) => text(d.row.tax_type) !== 'none';

/** The document's own word for itself, for messages that name it. */
const NOUN: Record<CheckedTable, string> = {
  quotations: 'quotation',
  proforma_invoices: 'proforma',
  commercial_invoices: 'invoice',
  credit_notes: 'credit note',
  orders: 'sales order',
};

const ALL: CheckedTable[] = ['quotations', 'proforma_invoices', 'commercial_invoices', 'credit_notes', 'orders'];
/** The three that ask the customer for money, and the order that commits to it. A credit note gives it back. */
const SELLING: CheckedTable[] = ['quotations', 'proforma_invoices', 'commercial_invoices', 'orders'];
/** Where a line with no quantity or a zero total is a fault: a sum is being demanded, or made. */
const MONEY_DUE: CheckedTable[] = ['proforma_invoices', 'commercial_invoices', 'orders'];

interface Rule {
  key: string;
  level: Level;
  tables: CheckedTable[];
  /** Narrows further — export vs domestic, mostly. */
  when?: (d: CheckedDoc) => boolean;
  /** The message when the rule is broken, or null when it is satisfied. */
  check: (d: CheckedDoc) => string | null;
}

/**
 * The rules, as one table.
 *
 * Line numbers are **1-based over every line including charges**, because that
 * is what the editor shows in its first column — the position rule the rest of
 * the chain uses is an internal matter and would name the wrong row here.
 */
const RULES: Rule[] = [
  /* ------------------------------------------------------------- blocking */
  {
    key: 'date', level: 'block', tables: ALL,
    check: (d) => (text(d.row.date) ? null : 'The document has no date.'),
  },
  {
    key: 'items', level: 'block', tables: ALL,
    check: (d) => (d.items.length ? null : 'There are no line items.'),
  },
  {
    // A document of nothing but freight is not a sale. Checked separately from
    // `items` so the message says which of the two is wrong.
    //
    // **Not asked of a credit note**, which is the one document here that may
    // legitimately be nothing but a charge: an overbilled freight line is
    // credited for its money alone, nothing having shipped to come back. A
    // blocking rule that fires wrongly stops a document going out, so this is
    // named rather than inherited from `ALL`.
    key: 'goods', level: 'block', tables: SELLING,
    check: (d) => (d.items.length === 0 || goods(d.items).length
      ? null
      : 'Every line is a charge — there is nothing being sold.'),
  },
  {
    key: 'description', level: 'block', tables: ALL,
    check: (d) => {
      const bad = d.items.map((it, i) => (text(it.description) ? 0 : i + 1)).filter(Boolean);
      return bad.length ? `Line ${bad.join(', ')} has no description.` : null;
    },
  },
  {
    /*
     * Every goods line names its colour (2026-09-17, the client: *"Colour –
     * make it mandatory in all Quotation, PI and SO and CI"*). The four selling
     * documents, and a charge line is not asked — `computeTotals` clears its
     * colour on every save, a fee having none. Numbered as the editor numbers
     * its rows, charges included, the description rule's own convention. The
     * Colour column is forced on all four editors and PDFs for the same
     * reason `amount` is: a mandatory field behind a hidden column is a block
     * nobody can see to clear.
     */
    key: 'color', level: 'block', tables: SELLING,
    check: (d) => {
      const bad = d.items.map((it, i) => (it.is_charge || text(it.color) ? 0 : i + 1)).filter(Boolean);
      return bad.length ? `Line ${bad.join(', ')} has no colour.` : null;
    },
  },
  {
    /*
     * Not applied to a quotation: `billedQty` is allowed to be null there, and
     * deliberately — a price-only quotation states rates against no quantity
     * at all, which `QUOTATION_OMIT` and `billedQty`'s own fallback both exist
     * to support. An advance or a GST invoice is a different matter: it names
     * a sum somebody must pay.
     */
    key: 'quantity', level: 'block', tables: MONEY_DUE,
    check: (d) => {
      const bad = d.items
        .map((it, i) => (it.is_charge || (billed(it) ?? 0) > 0 ? 0 : i + 1))
        .filter(Boolean);
      return bad.length ? `Line ${bad.join(', ')} has no quantity.` : null;
    },
  },
  {
    /*
     * A credit note is asked this and **not** the quantity rule above it: an
     * adjustment credits money without anything moving, so a lump sum against
     * no quantity at all is the ordinary shape of one. What cannot be right is
     * a credit for nothing.
     */
    key: 'total', level: 'block', tables: [...MONEY_DUE, 'credit_notes'],
    check: (d) => (Number(d.row.grand_total) > 0
      ? null
      : d.table === 'credit_notes'
        ? 'The credit note total is zero — there is nothing to credit.'
        : `The ${NOUN[d.table]} total is zero — there is nothing to pay.`),
  },
  {
    /*
     * **Nothing may be invoiced until it has passed QC.**
     *
     * The Hard Stop in the client's ERP specification of 2026-09-10: *"prevent
     * the issuance of a Commercial Invoice or Gate Pass unless the
     * corresponding batch status is marked as QC_PASSED"*. The gate-pass half
     * was already covered, and transitively rather than by a second guard — a
     * challan prints for a despatch, and `POST`/`PUT /despatches` have carried
     * `qcBlockError` since they were written. The invoice half was not covered
     * at all: one could be raised, approved and sent for goods nobody had
     * inspected.
     *
     * **It gates approval, not the save**, which is what *issuance* means here
     * and is the whole reason this table exists. Refusing to create the row
     * would stop the office drafting an invoice while the floor finishes
     * inspecting, which is ordinary work; refusing to *approve* it stops the
     * document going out, `approval.ts` guarding every outgoing status behind
     * exactly that. So it reaches all four routes into `approved` for free,
     * and shows on the form as a finding above a disabled button rather than
     * springing a 422 on a press.
     *
     * `qcBlockError` is **asked** rather than restated — it owns what a pass
     * means, and it is the same rule that already refuses the lorry.
     *
     * Three cases it deliberately does not block, each of which would
     * otherwise refuse a legitimate invoice on the day this shipped.
     *
     * **An invoice with no order behind it.** Nothing was produced against it,
     * so there is no work order to have inspected — the same silence-is-not-
     * failure rule `has_spec: false` states. The order is reached the way
     * `dispatchProgress()` reaches it: the invoice's own `order_id`, or
     * backwards through the proforma's.
     *
     * **A line past the end of the order.** The chain matches by position, and
     * an invoice line with no counterpart has nothing to check — the rule the
     * 10% variance report already follows about the same mismatch.
     *
     * **A product with no specification, and a charge line** — both inside
     * `qcBlockError`, which is the point of asking it rather than rewriting it.
     */
    key: 'qc', level: 'block', tables: ['commercial_invoices'],
    check: (d) => {
      // The invoice's own order, or the one its proforma was booked from —
      // resolved in two steps rather than one COALESCE, because `row` is
      // `Record<string, unknown>` and a bare `?? null` on it is not an
      // `SQLInputValue`.
      let orderId = Number(d.row.order_id) || 0;
      if (!orderId && d.row.pi_id) {
        const pi = db.prepare('SELECT order_id FROM proforma_invoices WHERE id = ?')
          .get(Number(d.row.pi_id)) as { order_id: number | null } | undefined;
        orderId = Number(pi?.order_id) || 0;
      }
      if (!orderId) return null;
      const onOrder = Number(
        (db.prepare('SELECT COUNT(*) AS c FROM order_items WHERE order_id = ?')
          .get(orderId) as { c: number }).c
      );
      const lines = d.items
        .map((_, i) => ({ order_line: i }))
        .filter((l) => l.order_line < onOrder);
      return lines.length ? qcBlockError(orderId, lines, 'invoice') : null;
    },
  },

  /* ------------------------------------------------------------- warnings */
  {
    key: 'gstin', level: 'warn', tables: ['commercial_invoices'], when: isDomestic,
    check: (d) => (text(d.customer?.gstin)
      ? null
      : 'The customer has no GSTIN recorded, which a GST invoice states.'),
  },
  {
    key: 'hsn', level: 'warn', tables: ['commercial_invoices'], when: isDomestic,
    check: (d) => {
      const bad = d.items
        .map((it, i) => (it.is_charge || text(it.hsn_code) ? 0 : i + 1))
        .filter(Boolean);
      return bad.length ? `Line ${bad.join(', ')} has no HSN code.` : null;
    },
  },
  {
    /*
     * The advance is paid against this document, so it has to say where to.
     *
     * A **block** since 2026-09-07, at the client's word — the first warning
     * promoted, and the promotion is the one-word `level` change this table was
     * shaped for. It is the rule with the least room for argument on a
     * proforma: the document exists to collect money, and one that does not say
     * which account cannot do the only job it has.
     *
     * This sentence is the proforma's. The commercial invoice was deliberately
     * not asked until 2026-09-16 — it is raised against goods already made and
     * often settled from the advance banked here — and is asked now under its
     * own name (`ci_bank`, below) since every field on it became mandatory.
     */
    key: 'bank', level: 'block', tables: ['proforma_invoices'],
    check: (d) => (text(d.row.bank_account)
      ? null
      : 'No bank account stated, and the advance is paid against this document.'),
  },
  /*
   * **Every field on the quotation form is mandatory** (the client, 2026-09-12,
   * with the form in front of them: *"make all fields mandatory, if any field
   * is not filled pdf should not be generated"*). The list this table was
   * shaped to wait for, finally supplied — for the quotation. Six fields the
   * form asks and the rules did not: validity, payment terms, delivery
   * timeline, the person who prepared it, the delivery basis, and the printed
   * notes. Customer, date and lines were already blocks; issued-by, currency
   * and tax carry defaults and cannot be blank.
   *
   * Blocks, not warnings, and on the quotation **only**: the proforma and the
   * invoice were not on the screen the instruction was given over, and
   * blocking a field there is a rule that stops a shipment. Each names its
   * own field, so the finding reads as a list of what to fill in rather than
   * one sentence saying "incomplete".
   */
  {
    key: 'validity', level: 'block', tables: ['quotations'],
    check: (d) => (text(d.row.validity_date) ? null : 'Valid Until is blank.'),
  },
  {
    key: 'q_payment_terms', level: 'block', tables: ['quotations'],
    check: (d) => (text(d.row.payment_terms) ? null : 'Payment Terms are blank.'),
  },
  {
    key: 'delivery', level: 'block', tables: ['quotations'],
    check: (d) => (text(d.row.delivery_terms) ? null : 'Delivery Timeline is blank.'),
  },
  {
    key: 'prepared_by', level: 'block', tables: ['quotations'],
    check: (d) => (text(d.row.prepared_by) ? null : 'Prepared By is blank.'),
  },
  {
    key: 'inco', level: 'block', tables: ['quotations'],
    check: (d) => (text(d.row.inco_terms) ? null : 'INCO Terms / Basis is blank.'),
  },
  {
    key: 'notes', level: 'block', tables: ['quotations'],
    check: (d) => (text(d.row.notes) ? null : 'Notes (printed on the quotation) are blank.'),
  },
  {
    // The one field an export quotation carries that a domestic one does not
    // (the client, 2026-09-12, with an export quotation in front of them).
    // Export only: a domestic sale goes on a lorry, and the form does not
    // even offer the box there.
    key: 'containers', level: 'block', tables: ['quotations'], when: isExport,
    check: (d) => (text(d.row.container_count) ? null : 'Containers is blank.'),
  },
  /*
   * **And every field on the proforma form** (the client, 2026-09-12, with a
   * new proforma in front of them: *"make everything mandatory like quotation
   * except Buyer PO, Consignee, Notify 1, 2"*). The same rule one document
   * down, with the four exemptions named by the client — the buyer's PO
   * number and date arrive after the proforma is sent, and the consignee and
   * notify parties are often the buyer's own address, which the PDF already
   * falls back to. The three warnings that used to cover the proforma
   * (`ports`, `origin`, `payment_terms`) covered the invoice alone from here
   * until 2026-09-16, when the invoice took blocks of its own. Customer, date, lines and
   * the bank account were already blocks; issued-by, currency, tax and
   * partial-shipment carry defaults and cannot be blank. Delivery Terms is
   * retired and not asked for. Export-only fields are asked on an export.
   */
  ...([
    ['pi_validity', 'validity_date', 'Valid Until'],
    ['pi_lead_time', 'lead_time', 'Production Lead Time'],
    ['pi_payment_terms', 'payment_terms', 'Payment Terms'],
    ['pi_inco', 'inco_terms', 'INCO Terms'],
    ['pi_method', 'method_of_despatch', 'Method of Dispatch'],
    ['pi_tolerance', 'quantity_tolerance', 'Quantity Tolerance'],
    ['pi_hs_code', 'hs_code', 'HS Code'],
    ['pi_prepared_by', 'prepared_by', 'Prepared By'],
    ['pi_remarks', 'remarks', 'Remarks'],
  ] as const).map(([key, column, label]): Rule => ({
    key, level: 'block', tables: ['proforma_invoices'],
    check: (d) => (text(d.row[column]) ? null : `${label} is blank.`),
  })),
  ...([
    ['pi_origin', 'country_of_origin', 'Country of Origin'],
    ['pi_port_of_loading', 'port_of_loading', 'Port of Loading'],
    ['pi_port_of_discharge', 'port_of_discharge', 'Port of Discharge'],
    ['pi_final_destination', 'final_destination', 'Final Destination'],
    ['pi_containers', 'container_count', 'Number of Containers'],
  ] as const).map(([key, column, label]): Rule => ({
    key, level: 'block', tables: ['proforma_invoices'], when: isExport,
    check: (d) => (text(d.row[column]) ? null : `${label} is blank.`),
  })),

  /*
   * **And every field on the commercial invoice** (2026-09-16, the client with
   * a new invoice in front of them: *"make all fields mandatory"*). The last of
   * the four documents to take the rule, and the three warnings that used to
   * be the invoice's whole opinion about its header — `ports`, `origin`,
   * `payment_terms` — are gone with it, each now a block naming its field.
   *
   * Exempt, and why: the **due date**, whose blank has a meaning of its own
   * (*due on arrival*, the tracker reading the shipment's ETA in its place);
   * the **consignee and both notify parties**, the proforma's own exemptions,
   * since they are usually the buyer's address and the PDF falls back to it;
   * and the **packing list's** fields, which are another document's. Issued-by,
   * currency and tax carry defaults. The ARN is asked on an export because a
   * fresh one is obtained per consignment — the company default in Settings
   * still prints for an invoice raised before this that left it blank.
   */
  ...([
    ['ci_payment_terms', 'payment_terms', 'Payment Terms'],
    ['ci_inco', 'inco_terms', 'INCO Terms'],
    ['ci_method', 'method_of_despatch', 'Method of Dispatch'],
    ['ci_lot_no', 'lot_no', 'Lot No.'],
    ['ci_prepared_by', 'prepared_by', 'Prepared By'],
    ['ci_shipping', 'shipping_details', 'Shipping Details'],
    ['ci_bank', 'bank_account', 'Bank Account'],
  ] as const).map(([key, column, label]): Rule => ({
    key, level: 'block', tables: ['commercial_invoices'],
    check: (d) => (text(d.row[column]) ? null : `${label} is blank.`),
  })),
  ...([
    ['ci_origin', 'country_of_origin', 'Country of Origin'],
    ['ci_port_of_loading', 'port_of_loading', 'Port of Loading'],
    ['ci_port_of_discharge', 'port_of_discharge', 'Port of Discharge'],
    ['ci_final_destination', 'final_destination', 'Final Destination'],
    ['ci_arn', 'arn_ref', 'ARN / LUT Reference'],
  ] as const).map(([key, column, label]): Rule => ({
    key, level: 'block', tables: ['commercial_invoices'], when: isExport,
    check: (d) => (text(d.row[column]) ? null : `${label} is blank.`),
  })),

  /*
   * And every field on the sales order, with five exemptions the client
   * named (2026-09-15: *"Make all fields mandatory in sales order except SPOC,
   * PO Number"*; 2026-09-16: *"customer PO date not mandatory"* — it arrives
   * with the PO, which is often after the order is booked — and *"Remarks
   * also not mandatory"*, an internal note nothing prints — and *"Order received via not
   * mandatory"*, which carries a default anyway). The order has no approval to gate, so these bite on the PDF
   * and are listed on the form — the same words, from the same table.
   *
   * Not asked, and why: the advance figures, which legitimately read zero
   * (credit terms; nothing banked yet) and are read from the proforma once
   * one is linked; issued-by, currency and tax, which carry defaults; and the
   * exemptions. Customer, date and lines were already blocks. The Revised
   * Production Date is here because the Reports page keys on it.
   */
  ...([
    ['so_promised', 'promised_date', 'Original Promised Date'],
    ['so_revised', 'revised_date', 'Revised Production Date'],
    ['so_payment_terms', 'payment_terms', 'Payment Terms'],
  ] as const).map(([key, column, label]): Rule => ({
    key, level: 'block', tables: ['orders'],
    check: (d) => (text(d.row[column]) ? null : `${label} is blank.`),
  })),
  ...([
    ['so_inco', 'inco_terms', 'INCO Terms'],
    ['so_containers', 'container_count', 'Containers'],
    ['so_port', 'port_of_discharge', 'Destination Port'],
  ] as const).map(([key, column, label]): Rule => ({
    key, level: 'block', tables: ['orders'], when: isExport,
    check: (d) => (text(d.row[column]) ? null : `${label} is blank.`),
  })),
];

/** Every rule this document breaks, blocking ones first. */
export function evaluate(d: CheckedDoc): Finding[] {
  const out: Finding[] = [];
  for (const rule of RULES) {
    if (!rule.tables.includes(d.table)) continue;
    if (rule.when && !rule.when(d)) continue;
    const message = rule.check(d);
    if (message) out.push({ key: rule.key, level: rule.level, message });
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'block' ? -1 : 1));
}

const ITEM_TABLE: Record<CheckedTable, string> = {
  quotations: 'quotation_items',
  proforma_invoices: 'pi_items',
  commercial_invoices: 'invoice_items',
  credit_notes: 'credit_note_items',
  orders: 'order_items',
};

const FK: Record<CheckedTable, string> = {
  quotations: 'quotation_id',
  proforma_invoices: 'pi_id',
  commercial_invoices: 'invoice_id',
  credit_notes: 'credit_note_id',
  orders: 'order_id',
};

/** Load a document and judge it. Returns an empty list for one that is gone. */
export function checkDocument(table: CheckedTable, id: number): Finding[] {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return [];
  const items = db.prepare(
    `SELECT * FROM ${ITEM_TABLE[table]} WHERE ${FK[table]} = ? ORDER BY sort_order, id`
  ).all(id) as unknown as CheckedItem[];
  const customer = db.prepare('SELECT gstin FROM customers WHERE id = ?').get(Number(row.customer_id)) as
    { gstin: string } | undefined;
  return evaluate({ table, row, items, customer });
}

/**
 * The sentence to refuse an approval with, or null when it may go ahead.
 *
 * Shaped like `lockError` and `qcBlockError` — a function returning the refusal
 * rather than one that throws or writes, so the rule is testable without the
 * HTTP harness this codebase does not have. **Warnings are not refusals**: only
 * a `block` finding stops anything.
 */
export function incompleteError(table: CheckedTable, id: number): string | null {
  const blocking = checkDocument(table, id).filter((f) => f.level === 'block');
  if (!blocking.length) return null;
  return `This ${NOUN[table]} is not finished: ${blocking.map((f) => f.message).join(' ')}`;
}
