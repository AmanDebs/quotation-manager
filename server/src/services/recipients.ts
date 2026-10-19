import { db } from '../db/connection.js';
import { can } from './accessPolicy.js';
import { userSeesCustomer } from '../middleware/scope.js';
import { sendMail, mailConfigured } from './mail.js';
import type { Fn } from './permissions.js';

/**
 * Who to tell, for any step of the chain.
 *
 * Extracted from `approvalMail.ts`'s `approversFor` when the client asked for
 * the rest of the handoffs to be notified too (2026-10-19: *"Notification
 * should [be] triggered to person who is responsible for next step"*). That
 * function answered one question — *who may approve this* — and every new hook
 * asks the same question about a different permission, so the question is
 * asked once here and the hook names the cell.
 *
 * **The permission cell is the address book**, which is the whole reason this
 * is safe to extend. *"Factory"*, *"Sales"*, *"Logistics"* and *"QC"* are not
 * lists anybody maintains; they are whoever can actually perform the next
 * step, read through `can` — the **effective** table the client re-ticks on
 * the User Permissions page, never the recommended matrix. So moving a cell
 * moves the notification with it, and a team that is given a job starts
 * hearing about it without anybody remembering to edit this file. A list of
 * names here would be a second access policy, and it would drift.
 *
 * **Scoped, even where it binds on nobody today.** The document and order
 * books are scoped by customer for Sales, so mailing every holder of a cell
 * would hand a salesperson the number, customer and total of something they
 * cannot open — the leak `GET /api/approvals` carried until its own scope
 * clause was added. The factory teams are unscoped, so this filter is a no-op
 * for them; it is written for the reason `exportOnlyInvoice` is kept, that the
 * rule lives where the answer is decided and narrowing a cell later narrows
 * this with it.
 */

export interface Recipient {
  id: number;
  name: string;
  email: string;
  /** Their desk name, where the Team page has one — the SPOC rule reads it. */
  desk_name: string;
}

/**
 * Everybody who could actually take the next step on this customer's work.
 *
 * A deactivated account is left out, an account with **no email address** is
 * left out — the one failure that otherwise looks exactly like nothing having
 * happened — and so is the person whose own action triggered this, who has
 * just pressed the button and does not need telling about it.
 */
export function peopleWhoCan(
  fn: Fn,
  // 'none' is not a level anybody can act at, so it is not askable here.
  level: 'view' | 'full',
  customerId: number | null | undefined,
  exceptUserId?: number | null,
): Recipient[] {
  const users = db.prepare(
    "SELECT id, name, email, team_role, desk_name FROM users WHERE active = 1 AND email <> '' ORDER BY id"
  ).all() as { id: number; name: string; email: string; team_role: string; desk_name: string }[];
  return users
    .filter((u) => u.id !== Number(exceptUserId))
    .filter((u) => can(u, fn, level))
    .filter((u) => userSeesCustomer(u, customerId))
    .map((u) => ({ id: u.id, name: u.name, email: u.email, desk_name: String(u.desk_name ?? '') }));
}

/**
 * The order's own SPOC where an account answers to that name, everybody
 * otherwise.
 *
 * `deskApprovalError`'s rule read for an outgoing message rather than an
 * incoming request, and deliberately the same shape: `users.desk_name` is the
 * link between an account and one of the six names on the desk, because
 * `orders.spoc` is a desk name and an account is a full name. An order naming
 * no SPOC, or naming one nobody answers to, is **nobody's in particular** and
 * goes to everyone who could act on it — which is every imported order and
 * every account until the Team page's Desk name column is filled in, so the
 * change tightens itself one person at a time rather than stranding anybody.
 */
export function narrowToSpoc(people: Recipient[], spoc: string | null | undefined): Recipient[] {
  const want = String(spoc ?? '').trim().toLowerCase();
  if (!want) return people;
  const mine = people.filter((p) => p.desk_name.trim().toLowerCase() === want);
  return mine.length ? mine : people;
}

/**
 * `void` — fired and forgotten, the way the audit middleware records after the
 * response: a provider being down loses a notification, never a sales order.
 * Silent when nothing is configured, which is what keeps the suite offline.
 */
export function fire(to: string[], subject: string, body: string): void {
  if (!to.length || !mailConfigured()) return;
  void sendMail(to, subject, body);
}
