import { db } from '../db/connection.js';
import { can } from './accessPolicy.js';
import { userSeesCustomer } from '../middleware/scope.js';
import { sendMail, appLink, mailConfigured } from './mail.js';
import type { DocTable } from './approval.js';

/**
 * Who is told that a document is waiting, and what the message says.
 *
 * Asked for 2026-10-17: *"Approval – no notification is coming. Is it possible
 * to issue notification on email … for viewing and approval."* The first half
 * of that had a cause of its own — `submit()` approves outright for anybody
 * holding `approval: full`, so with Sales holding that cell nothing ever
 * reached `pending` and the badge was right to read zero. This is the second
 * half: once something *does* wait, somebody hears about it away from the app.
 *
 * **Policy here, transport in `mail.ts`.** Who should be told is a question
 * about this app's own access rules; how a message leaves the building is a
 * question about a provider, and keeping them apart is what lets either be
 * changed without reading the other.
 *
 * **Hung off `submit()` and `decide()` rather than the eight routes.** The
 * audit middleware records the reasoning: a trail assembled by adding a call
 * to each route is a trail with holes, and a fifth document added later would
 * silently notify nobody. Those two functions are the only places an approval
 * state is written, so this cannot be forgotten.
 */

/** Where each document lives on the client, so an email can link to it. */
const PATH: Record<DocTable, string> = {
  quotations: '/quotations',
  proforma_invoices: '/proformas',
  commercial_invoices: '/invoices',
  credit_notes: '/credit-notes',
};

const NOUN: Record<DocTable, string> = {
  quotations: 'Quotation',
  proforma_invoices: 'Proforma invoice',
  commercial_invoices: 'Commercial invoice',
  credit_notes: 'Credit note',
};

interface DocRow {
  id: number;
  number: string;
  customer_id: number;
  created_by: number | null;
  currency: string;
  grand_total: number;
  customer_name: string | null;
  author_name: string | null;
  author_email: string | null;
}

function readDoc(table: DocTable, id: number): DocRow | undefined {
  return db.prepare(
    `SELECT d.id, d.number, d.customer_id, d.created_by, d.currency, d.grand_total,
            c.name AS customer_name, u.name AS author_name, u.email AS author_email
       FROM ${table} d
       LEFT JOIN customers c ON c.id = d.customer_id
       LEFT JOIN users u ON u.id = d.created_by
      WHERE d.id = ?`
  ).get(id) as DocRow | undefined;
}

/** Grouped the Indian way, like every other figure this app prints. */
const money = (n: number, currency: string) =>
  `${currency} ${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0)}`;

/**
 * Everybody who could actually act on this document.
 *
 * Two conditions, and the second is the one that is easy to miss. They must
 * **hold `approval: full`** — read through `can`, which is the effective table
 * the client has re-ticked, never the recommended matrix, so unticking the
 * cell stops the email as well as the button. And the document must be **in
 * their book**: the approvals queue is scoped, so mailing every approver would
 * tell a salesperson the number, customer and total of a document they cannot
 * open — the same leak `GET /api/approvals` had until that clause was added.
 *
 * A deactivated account is left out, and so is the person who submitted it:
 * they have just pressed the button.
 */
export function approversFor(customerId: number, exceptUserId?: number | null):
  { id: number; name: string; email: string }[] {
  const users = db.prepare(
    "SELECT id, name, email, team_role FROM users WHERE active = 1 AND email <> '' ORDER BY id"
  ).all() as { id: number; name: string; email: string; team_role: string }[];
  return users
    .filter((u) => u.id !== Number(exceptUserId))
    .filter((u) => can(u, 'approval', 'full'))
    .filter((u) => userSeesCustomer(u, customerId))
    .map((u) => ({ id: u.id, name: u.name, email: u.email }));
}

/** `void` — fired and forgotten, so a provider being down cannot fail a save. */
function fire(to: string[], subject: string, body: string): void {
  if (!to.length || !mailConfigured()) return;
  void sendMail(to, subject, body);
}

/**
 * A document has just gone into the queue.
 *
 * Called from `submit()` on the branch that actually sets `pending` — a
 * submission by somebody who may approve is approved in the same breath, and
 * mailing about a queue entry that does not exist would be the badge's own
 * defect in a new medium.
 */
export function notifySubmitted(table: DocTable, id: number, byId: number | null): void {
  if (!mailConfigured()) return;
  const doc = readDoc(table, id);
  if (!doc) return;
  const people = approversFor(doc.customer_id, byId);
  const link = appLink(`${PATH[table]}/${id}`);
  const noun = NOUN[table];
  const body = [
    `${noun} ${doc.number} is waiting for approval.`,
    '',
    `Customer: ${doc.customer_name ?? '—'}`,
    `Total: ${money(doc.grand_total, doc.currency)}`,
    `Submitted by: ${doc.author_name ?? 'somebody at the desk'}`,
    '',
    link ? `Open it here: ${link}` : 'Open it from the Approvals page in the app.',
    '',
    'You are receiving this because your team holds the Approvals permission.',
  ].join('\n');
  fire(people.map((p) => p.email), `Approval needed: ${noun} ${doc.number}`, body);
}

/**
 * It has been approved or rejected.
 *
 * The author is told, because they are the one waiting — and **only** the
 * author: a second mail to every approver would make the queue noisier for
 * the people who use it most, and they can see the answer on the page they
 * just pressed the button on. Nothing is sent when they decided it themselves.
 */
export function notifyDecided(
  table: DocTable,
  id: number,
  byId: number | null,
  approved: boolean,
  note: string,
): void {
  if (!mailConfigured()) return;
  const doc = readDoc(table, id);
  if (!doc || !doc.author_email || Number(doc.created_by) === Number(byId)) return;
  const decider = db.prepare('SELECT name FROM users WHERE id = ?').get(byId ?? 0) as { name: string } | undefined;
  const noun = NOUN[table];
  const verdict = approved ? 'approved' : 'rejected';
  const link = appLink(`${PATH[table]}/${id}`);
  const body = [
    `${noun} ${doc.number} for ${doc.customer_name ?? '—'} has been ${verdict}`
      + (decider ? ` by ${decider.name}.` : '.'),
    // A rejection without its reason is a message that sends somebody looking
    // for the person who wrote one.
    ...(note.trim() ? ['', `Reason: ${note.trim()}`] : []),
    '',
    approved
      ? 'It can now be sent to the customer.'
      : 'Correct it and submit it again.',
    ...(link ? ['', `Open it here: ${link}`] : []),
  ].join('\n');
  fire([doc.author_email], `${noun} ${doc.number} ${verdict}`, body);
}
