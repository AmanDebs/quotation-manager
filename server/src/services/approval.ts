import { db } from '../db/connection.js';
import type { AuthedRequest, SessionUser } from '../middleware/auth.js';
import { can } from './accessPolicy.js';
import { incompleteError } from './documentChecks.js';

/**
 * Who may approve — including **implicitly**.
 *
 * One capability covers three different acts: submitting your own document,
 * converting an unapproved one, and moving its status. The last two approve as
 * a side effect of something that reads like a guard, so granting this to a
 * second team silently gives that team the power to approve documents it never
 * opened. Named here so that is one decision rather than three.
 */
export const mayApprove = (user: { team_role?: unknown } | undefined) => can(user?.team_role, 'approval', 'full');

export type DocTable = 'quotations' | 'proforma_invoices' | 'commercial_invoices' | 'credit_notes';

/** Statuses that mean "this document has gone to the customer". */
const outgoingStatuses: Record<DocTable, string[]> = {
  quotations: ['sent', 'negotiating', 'accepted'],
  proforma_invoices: ['sent', 'order_confirmed', 'advance_received', 'in_production'],
  commercial_invoices: ['final', 'dispatched', 'paid'],
  /*
   * Empty, and deliberately so: a credit note has **no status ladder**. It is
   * issued once and that is the whole of its life — never sent, negotiated,
   * part shipped or paid — so approval carries the weight a status would
   * elsewhere, and it carries more of it than usual: an approved credit note
   * is what actually reduces the balance owed (`CREDITED_SQL`). Nothing calls
   * `blockUnapprovedTransition` for this table; the entry is here because the
   * map is keyed on the whole union and a silent omission would be a hole.
   */
  credit_notes: [],
};

export const requiresApproval = (table: DocTable, status: string) => outgoingStatuses[table].includes(status);

/** The word each document calls itself, for the sentences below. */
const NOUN: Record<DocTable, string> = {
  quotations: 'quotation',
  proforma_invoices: 'proforma',
  commercial_invoices: 'commercial invoice',
  credit_notes: 'credit note',
};

/**
 * **A domestic document does not go through approval** (2026-09-25, the
 * client: *"Remove approval for domestic"*).
 *
 * The workflow was written for the document that goes abroad, and on this desk
 * that is what it is for: an export offer is checked before it leaves. A
 * domestic sale is quoted, confirmed and invoiced in Tally by the same few
 * people, and asking them to submit a quotation to themselves is a step that
 * only ever produced the state the approvals entry above describes — a queue
 * fed by nobody.
 *
 * **Two of the four tables, and the other two are exceptions with reasons.**
 * The `commercial_invoice` has been **export-only since 2026-09-16**, so a
 * domestic one cannot be raised at all and exempting it would change nothing
 * except the behaviour of the rows already on file — `invoiceStatus.ts` reads
 * this flag to promote an invoice to `paid`, and a legacy domestic invoice
 * settled by a payment would stop being marked paid. And a **credit note's
 * approval is not permission to send it, it is what moves the money**:
 * `CREDITED_SQL`, `returnedQtyByLine` and the finished-goods ledger all count
 * an *approved* note alone, which is why `outgoingStatuses.credit_notes` is
 * empty. Exempting a domestic note would leave one that credits nothing with
 * no way to make it credit — the trap-with-no-way-out this codebase has built
 * once already.
 */
const EXEMPT_WHEN_DOMESTIC: DocTable[] = ['quotations', 'proforma_invoices'];

const exemptRow = (table: DocTable, row: { is_export: number }) =>
  EXEMPT_WHEN_DOMESTIC.includes(table) && Number(row.is_export) === 0;

/**
 * Whether this document answers to the approval workflow at all.
 *
 * Nothing is stored: `approval_status` on an exempt document stays wherever it
 * was and means nothing, the way `expired` is derived on a proforma rather
 * than written. Stamping one `approved` on creation was the other option and
 * is worse — it would put an approval in the audit trail that nobody gave, and
 * name somebody as the approver.
 *
 * A row that is not there is **not** exempt, so the callers' own
 * *Document not found* answers still fire.
 */
export function approvalExempt(table: DocTable, id: number): boolean {
  if (!EXEMPT_WHEN_DOMESTIC.includes(table)) return false;
  const row = db.prepare(`SELECT is_export FROM ${table} WHERE id = ?`).get(id) as { is_export: number } | undefined;
  return !!row && exemptRow(table, row);
}

/**
 * The sentence to refuse a submit or an approve with on a document that needs
 * neither. Refused rather than merely hidden, the rule the domestic commercial
 * invoice's own 409 follows: the screen draws no approval strip, and a request
 * made by hand is told why.
 */
export function exemptApprovalError(table: DocTable, id: number): string | null {
  if (!approvalExempt(table, id)) return null;
  return `A domestic ${NOUN[table]} does not go through approval — set its status directly.`;
}

/**
 * Managers approve implicitly — their own documents go straight to 'approved'
 * when they submit. Employees must wait for a manager.
 */
export function submit(table: DocTable, id: number, user: SessionUser) {
  if (mayApprove(user)) {
    db.prepare(
      `UPDATE ${table} SET approval_status = 'approved', approved_by = ?, approved_at = datetime('now'), approval_note = '' WHERE id = ?`
    ).run(user.id, id);
  } else {
    db.prepare(
      `UPDATE ${table} SET approval_status = 'pending', approved_by = NULL, approved_at = '', approval_note = '' WHERE id = ?`
    ).run(id);
  }
}

export function decide(table: DocTable, id: number, user: SessionUser, approve: boolean, note: string) {
  db.prepare(
    `UPDATE ${table} SET approval_status = ?, approved_by = ?, approved_at = datetime('now'), approval_note = ? WHERE id = ?`
  ).run(approve ? 'approved' : 'rejected', user.id, note, id);
}

/** Any edit invalidates a prior approval — the manager must see the new version. */
export function resetApprovalOnEdit(table: DocTable | 'packing_lists', id: number) {
  if (table === 'packing_lists') return;
  db.prepare(
    `UPDATE ${table} SET approval_status = 'not_submitted', approved_by = NULL, approved_at = '', approval_note = ''
     WHERE id = ? AND approval_status IN ('approved','rejected')`
  ).run(id);
}

/**
 * Guard for a conversion: a document may only be converted once approved.
 *
 * The same rule as `blockUnapprovedTransition`, and deliberately the same
 * behaviour on the manager path — **a manager converting an unapproved
 * document approves it in the same action** rather than being turned away.
 * Without that this gate would obstruct the one person allowed to clear it.
 *
 * It exists because conversion locks the source document. Converting a draft
 * would freeze it as a draft, watermarked PENDING APPROVAL, with no way left
 * to fix it.
 */
export function blockUnapprovedConversion(
  table: DocTable,
  id: number,
  req: AuthedRequest,
  /**
   * Whether a manager's pass-through actually approves the document.
   *
   * The prefill endpoints are GETs and ask with `commit: false`: previewing a
   * conversion must not approve anything as a side effect. They only want the
   * answer a manager would get, which is "allowed".
   */
  commit = true
): string | null {
  const row = db.prepare(`SELECT approval_status, is_export FROM ${table} WHERE id = ?`)
    .get(id) as { approval_status: string; is_export: number } | undefined;
  if (!row) return 'Document not found';
  if (row.approval_status === 'approved') return null;
  /*
   * A domestic document needs no approval — but converting one still **locks**
   * it, so the completeness gate stays and only the approval goes. Without it
   * an unfinished domestic quotation could be frozen unfinished, with nothing
   * left that could print it: the trap this guard's own comment exists to
   * refuse.
   */
  if (exemptRow(table, row)) return incompleteError(table, id);
  if (req.user && mayApprove(req.user)) {
    /*
     * The manager's pass-through is still an approval, so it answers to the
     * completeness gate like any other. Checked *before* `decide`, or the one
     * path that approves as a side effect would be the one way past it.
     */
    const incomplete = incompleteError(table, id);
    if (incomplete) return incomplete;
    if (commit) decide(table, id, req.user, true, '');
    return null;
  }
  const self = table === 'quotations' ? 'quotation' : 'proforma';
  return row.approval_status === 'pending'
    ? `This ${self} is awaiting manager approval and cannot be converted yet`
    : `Submit this ${self} for manager approval before converting it`;
}

/**
 * Guard for status transitions: a document may only move to an outgoing status
 * once approved. Returns an error message, or null when the move is allowed.
 */
export function blockUnapprovedTransition(table: DocTable, id: number, nextStatus: string, req: AuthedRequest): string | null {
  if (!requiresApproval(table, nextStatus)) return null;
  const row = db.prepare(`SELECT approval_status, is_export FROM ${table} WHERE id = ?`)
    .get(id) as { approval_status: string; is_export: number } | undefined;
  if (!row) return 'Document not found';
  if (row.approval_status === 'approved') return null;
  /*
   * Nothing to wait for on a domestic document, and no completeness gate
   * either: a status is a record of what happened and is settable back, where
   * the PDF is the thing that reaches the customer and is gated on its own
   * (`routes/pdf.ts`).
   */
  if (exemptRow(table, row)) return null;
  if (req.user && mayApprove(req.user)) {
    // A manager moving a document forward approves it in the same action — and
    // so has to clear the same completeness gate a submitted one does.
    const incomplete = incompleteError(table, id);
    if (incomplete) return incomplete;
    decide(table, id, req.user, true, '');
    return null;
  }
  return row.approval_status === 'pending'
    ? 'This document is awaiting manager approval'
    : 'Submit this document for manager approval before sending it';
}

export const approvalSelect = `
  approval_status, approved_at, approval_note,
  (SELECT name FROM users WHERE id = approved_by) AS approved_by_name,
  (SELECT name FROM users WHERE id = created_by) AS created_by_name`;
