import { db } from '../db/connection.js';
import { billedQty } from './totals.js';
import type { DocTable } from './approval.js';

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
  hsn_code?: string | null;
  qty?: number | null;
  total_pcs?: number | null;
  unit?: string | null;
  /** `number | boolean` to match `billedQty`'s own parameter; SQLite gives 0/1. */
  is_charge?: number | boolean | null;
}

export interface CheckedDoc {
  table: DocTable;
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
const NOUN: Record<DocTable, string> = {
  quotations: 'quotation',
  proforma_invoices: 'proforma',
  commercial_invoices: 'invoice',
};

const ALL: DocTable[] = ['quotations', 'proforma_invoices', 'commercial_invoices'];
const MONEY_DUE: DocTable[] = ['proforma_invoices', 'commercial_invoices'];

interface Rule {
  key: string;
  level: Level;
  tables: DocTable[];
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
    key: 'goods', level: 'block', tables: ALL,
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
    key: 'total', level: 'block', tables: MONEY_DUE,
    check: (d) => (Number(d.row.grand_total) > 0
      ? null
      : `The ${NOUN[d.table]} total is zero — there is nothing to pay.`),
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
    // The boxed customs header on the export invoice and its packing list.
    key: 'ports', level: 'warn', tables: MONEY_DUE, when: isExport,
    check: (d) => {
      const missing = [
        !text(d.row.port_of_loading) && 'port of loading',
        !text(d.row.port_of_discharge) && 'port of discharge',
      ].filter(Boolean);
      return missing.length ? `No ${missing.join(' or ')} stated.` : null;
    },
  },
  {
    key: 'origin', level: 'warn', tables: MONEY_DUE, when: isExport,
    check: (d) => (text(d.row.country_of_origin) ? null : 'No country of origin stated.'),
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
     * Note it blocks on the proforma alone. A commercial invoice states an
     * account too, but it is raised against goods already made and often
     * settled from the advance banked here, so refusing to approve one over a
     * blank account would stop a shipment for a field the proforma upstream has
     * already carried.
     */
    key: 'bank', level: 'block', tables: ['proforma_invoices'],
    check: (d) => (text(d.row.bank_account)
      ? null
      : 'No bank account stated, and the advance is paid against this document.'),
  },
  {
    key: 'payment_terms', level: 'warn', tables: MONEY_DUE,
    check: (d) => (text(d.row.payment_terms) ? null : 'No payment terms stated.'),
  },
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

const ITEM_TABLE: Record<DocTable, string> = {
  quotations: 'quotation_items',
  proforma_invoices: 'pi_items',
  commercial_invoices: 'invoice_items',
};

const FK: Record<DocTable, string> = {
  quotations: 'quotation_id',
  proforma_invoices: 'pi_id',
  commercial_invoices: 'invoice_id',
};

/** Load a document and judge it. Returns an empty list for one that is gone. */
export function checkDocument(table: DocTable, id: number): Finding[] {
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
export function incompleteError(table: DocTable, id: number): string | null {
  const blocking = checkDocument(table, id).filter((f) => f.level === 'block');
  if (!blocking.length) return null;
  return `This ${NOUN[table]} is not finished: ${blocking.map((f) => f.message).join(' ')}`;
}
