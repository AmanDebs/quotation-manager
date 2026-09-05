import { db } from '../db/connection.js';
import type { AuthedRequest, SessionUser } from '../middleware/auth.js';
import { can } from './permissions.js';

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

export type DocTable = 'quotations' | 'proforma_invoices' | 'commercial_invoices';

/** Statuses that mean "this document has gone to the customer". */
const outgoingStatuses: Record<DocTable, string[]> = {
  quotations: ['sent', 'negotiating', 'accepted'],
  proforma_invoices: ['sent', 'order_confirmed', 'advance_received', 'in_production'],
  commercial_invoices: ['final', 'dispatched', 'paid'],
};

export const requiresApproval = (table: DocTable, status: string) => outgoingStatuses[table].includes(status);

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
  const row = db.prepare(`SELECT approval_status FROM ${table} WHERE id = ?`).get(id) as { approval_status: string } | undefined;
  if (!row) return 'Document not found';
  if (row.approval_status === 'approved') return null;
  if (req.user && mayApprove(req.user)) {
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
  const row = db.prepare(`SELECT approval_status FROM ${table} WHERE id = ?`).get(id) as { approval_status: string } | undefined;
  if (!row) return 'Document not found';
  if (row.approval_status === 'approved') return null;
  if (req.user && mayApprove(req.user)) {
    // A manager moving a document forward approves it in the same action.
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
