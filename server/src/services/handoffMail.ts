import { db } from '../db/connection.js';
import { appLink, mailConfigured } from './mail.js';
import { peopleWhoCan, narrowToSpoc, fire } from './recipients.js';

/**
 * Telling the next desk that it is their turn.
 *
 * Asked for 2026-10-19: *"Notification should [be] triggered to person who is
 * responsible for next step"*, with the chain written out — quote and PI to
 * the manager, the sales order to the factory, the production log back to
 * sales, the release on to logistics, and QC before the goods go. The first
 * of those already existed (`approvalMail.ts`); this is the other four.
 *
 * **The permission cell is the address book**, which is the rule that makes
 * this extensible rather than a pile of hard-coded teams — see
 * `recipients.ts`. Each hook below names the cell the *next* step needs, so
 * the email and the button that acts on it can never come apart.
 *
 * **Three things every one of these inherits.** It can never fail a save:
 * fired and forgotten after the write, the audit middleware's own shape.
 * It is silent when mail is unconfigured, so nothing here is reachable in the
 * test suite or on a deployment that has not signed up for anything. And
 * nobody is told about their own action.
 *
 * **What is deliberately not here: a reminder.** This notifies on the event —
 * batched into two shifts since 2026-10-28, which changes when a message
 * leaves rather than what sets one off. A
 * nightly *"3 orders still unplanned"* is a scheduler with its own proof, and
 * the sidebar badges already answer that question whenever somebody opens the
 * app — which is the honest version of the same promise.
 */

interface OrderRow {
  id: number;
  number: string;
  customer_id: number;
  spoc: string | null;
  customer_name: string | null;
}

function readOrder(orderId: number): OrderRow | undefined {
  return db.prepare(
    `SELECT o.id, o.number, o.customer_id, o.spoc, c.name AS customer_name
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.id = ?`
  ).get(orderId) as OrderRow | undefined;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Grouped the Indian way, like every other quantity this app prints. */
const pcs = (n: number) => new Intl.NumberFormat('en-IN').format(Math.round(n || 0));

/**
 * Step 2 — a sales order has been booked, so the floor has jobs to plan.
 *
 * **Not "submit a work order", which is a step this app does not have.** The
 * sales order has raised its own jobs since 2026-09-11, inside the create
 * transaction — so by the time anybody could be told, the jobs exist. What
 * the floor actually has to do next is give them dates and release them,
 * which is the Work Orders planning grid, and that is what the message says.
 *
 * `work_order: full` is the cell that grid is behind — Production and the
 * super admin under the current matrix. Sales, which booked the order, holds
 * `view` and is correctly not told.
 *
 * Silent where the order raised **no** jobs: a bought-in line raises none by
 * design, and an order wholly of charge lines has nothing to make, so there
 * would be nothing for the floor to do.
 */
export function notifyJobsRaised(orderId: number, byId: number | null): void {
  if (!mailConfigured()) return;
  const order = readOrder(orderId);
  if (!order) return;
  const jobs = db.prepare(
    `SELECT number FROM work_orders
      WHERE order_id = ? AND status <> 'cancelled' ORDER BY order_line, id`
  ).all(orderId) as { number: string }[];
  if (!jobs.length) return;
  const people = peopleWhoCan('work_order', 'full', order.customer_id, byId);
  const link = appLink('/work-orders');
  const body = [
    `${order.number} has been booked for ${order.customer_name ?? '—'},`
      + ` and ${plural(jobs.length, 'work order has', 'work orders have')} been raised against it:`,
    '',
    ...jobs.map((j) => `  ${j.number}`),
    '',
    'They have no dates yet. Set a start and finish on each and release them,',
    'which is what moves them to Scheduled.',
    ...(link ? ['', `Plan them here: ${link}`] : []),
  ].join('\n');
  fire(people.map((p) => p.email), `Jobs to plan: ${order.number}`, body, 'Work Orders');
}

/**
 * Step 3 — something has been made, and the desk has to release it.
 *
 * **Once per line, not once per shift**, which is the client's own choice
 * (2026-10-19) and the difference between a notification and a nuisance: a
 * line is booked against several times a day, and an email per entry would be
 * dozens about the same order to the same people. The caller passes what the
 * line was awaiting **before** the write, and this sends only where that was
 * zero — so the desk hears when a line *joins* their queue and not again
 * until they clear it and the floor books more.
 *
 * `order: full` is the cell the release button is behind, **narrowed to the
 * order's own SPOC** where an account answers to that name — the rule
 * `deskApprovalError` already enforces on the button itself, so the person
 * emailed is the person who may act.
 */
export function notifyAwaitingRelease(
  orderId: number,
  orderLine: number,
  item: string,
  awaiting: number,
  byId: number | null,
): void {
  if (!mailConfigured() || awaiting <= 0) return;
  const order = readOrder(orderId);
  if (!order) return;
  const people = narrowToSpoc(
    peopleWhoCan('order', 'full', order.customer_id, byId),
    order.spoc,
  );
  const link = appLink('/despatches?view=approve');
  const body = [
    `${pcs(awaiting)} pcs of ${item} are made and waiting for your release.`,
    '',
    `Sales order: ${order.number}`,
    `Customer: ${order.customer_name ?? '—'}`,
    ...(order.spoc ? [`Handled by: ${order.spoc}`] : []),
    '',
    'Nothing can be loaded until the line is released, so this is the step',
    'between the floor finishing and logistics planning a lorry.',
    ...(link ? ['', `Release it here: ${link}`] : []),
  ].join('\n');
  fire(people.map((p) => p.email), `Ready to release: ${order.number}`, body, 'Sales Orders');
}

/**
 * Steps 3b and 4 — released, so the lorry and the paperwork can be arranged.
 *
 * One event, two audiences, and the second is conditional:
 *
 * - **Logistics** (`dispatch: full`) plan the trip *and* raise the commercial
 *   invoice and packing list, which is the client's own answer of 2026-10-19
 *   when asked who should be told about the documents. That choice is why
 *   `logistics.invoice` moved `view → full` in the same change — an email
 *   asking somebody to raise a document the app refuses them is worse than no
 *   email at all.
 * - **Quality** (`qc: full`) only where a released line is **actually held**
 *   by the QC gate. Telling Quality about every release would be noise about
 *   lines that have already passed; telling them about a held one is the
 *   specification's own pre-dispatch step, and the sentence shown is
 *   `qcBlockError`'s own rather than a second description of the rule.
 *
 * One mail per audience rather than per line: a release is ordinarily several
 * lines of one order, and three emails about one order read as three orders.
 */
export function notifyReleased(
  orderId: number,
  released: { item: string; qty: number }[],
  held: { item: string; reason: string }[],
  byId: number | null,
): void {
  if (!mailConfigured()) return;
  const order = readOrder(orderId);
  if (!order || !released.length) return;

  const lines = released.map((r) => `  ${pcs(r.qty)} pcs — ${r.item}`);
  const logistics = peopleWhoCan('dispatch', 'full', order.customer_id, byId);
  const dispatchLink = appLink('/despatches?view=ready');
  fire(
    logistics.map((p) => p.email),
    `Released for dispatch: ${order.number}`,
    [
      `${plural(released.length, 'line has', 'lines have')} been released on ${order.number}`
        + ` for ${order.customer_name ?? '—'}:`,
      '',
      ...lines,
      '',
      'Next: plan the dispatch, and raise the commercial invoice and packing list.',
      ...(dispatchLink ? ['', `Ready to dispatch: ${dispatchLink}`] : []),
    ].join('\n'),
    'Dispatches',
  );

  if (!held.length) return;
  const quality = peopleWhoCan('qc', 'full', order.customer_id, byId);
  const qcLink = appLink('/quality');
  fire(
    quality.map((p) => p.email),
    `Quality needed before dispatch: ${order.number}`,
    [
      `${order.number} for ${order.customer_name ?? '—'} has been released,`,
      `but ${plural(held.length, 'line')} cannot ship until quality has signed it off:`,
      '',
      ...held.map((h) => `  ${h.item}\n    ${h.reason}`),
      '',
      ...(qcLink ? ['', `Record a check here: ${qcLink}`] : []),
    ].join('\n'),
    'Quality',
  );
}
