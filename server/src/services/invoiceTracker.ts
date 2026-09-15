import { db } from '../db/connection.js';
import { invoiceReceivable } from './receivables.js';
import { round2 } from './totals.js';

/**
 * The invoice tracker: one row per commercial invoice, read the way the
 * export desk's own sheet reads — CI number, amount and date, the sea leg
 * (BL / container, ETD, ETA, documents), the advance received, the balance,
 * the due date, and whether it is settled (asked for 2026-09-14 on the
 * Payments page: *"The Columns will be - CI No >> CI Amt >> CI Date >> BL
 * Container Num >> ETD >> ETA >> Document(Telex) >> Advance Received >>
 * Balance Amt >> Due Date >> Status(Pending, Completed)"*).
 *
 * **Nothing here is a second opinion.** The money is `invoiceReceivable`'s
 * — asked, not re-derived, so this page, the invoice page and the dashboard
 * cannot disagree about a balance — and the sea leg is the despatch
 * register's, read through `despatches.invoice_id`, so revising an ETA here
 * revises the trip the challan printed, not a copy of it. The only thing the
 * tracker adds to the record is **`commercial_invoices.due_date`**, additive,
 * because a due date is a commitment somebody agreed rather than a fact the
 * record could derive: the real export file states it on 29 of 40 rows, and
 * on 24 of those it is the ETA itself (*due on arrival*) — so a blank due
 * date **falls back to the shipment's ETA** and says so, and a typed one wins.
 *
 * **Status is derived, never stored**: *Completed* when nothing is owed
 * (`balance_due <= 0`, which nets payments, the advance and approved credit
 * notes), *Pending* otherwise. There is no third value — an invoice that is
 * partly paid is still pending, and the balance beside it says how much.
 *
 * **Advance Received is the advance alone** (`advance_applied`), not every
 * rupee received: on a 30/70 deal the column reads 30% for the life of the
 * invoice and the balance closes when the 70% arrives, which is how the sheet
 * reads and what somebody chasing the balance wants to see. Money paid
 * directly against the invoice is in the balance, and reported beside it.
 *
 * **Paged in memory, not in SQL.** The status filter needs the balance, and
 * the balance is an allocation `receivables.ts` does in TypeScript (an advance
 * is spread across the invoices raised from its proforma). The book is bounded
 * by how many invoices this business raises — dozens a year, not thousands —
 * so decorating every matching row and slicing is the honest answer rather
 * than a fourth SQL copy of the allocation rule.
 */

export interface TrackerShipment {
  despatch_id: number;
  /**
   * True when the trip names this invoice (`despatches.invoice_id`). False
   * when it was found through the **order behind the invoice** and names no
   * invoice at all — the ordinary state of a trip recorded before the bill
   * was raised, and the reason the tracker read blank on a real book
   * (2026-09-14: *"This page should be linked with dispatch and CI"*). Shown
   * as *via sales order*, and the revise dialog offers to link it.
   */
  linked: boolean;
  bl_no: string;
  container_no: string;
  etd: string;
  eta: string;
  docs_status: string;
  docs_method: string;
  docs_date: string;
}

export interface TrackerRow {
  id: number;
  number: string;
  date: string;
  customer_id: number;
  customer_name: string;
  currency: string;
  is_export: number;
  grand_total: number;
  advance_applied: number;
  amount_received: number;
  credited: number;
  balance_due: number;
  /** The typed due date, or the shipment's ETA when none is typed. */
  due_date: string;
  /** True when `due_date` is the ETA standing in for a date nobody typed. */
  due_on_arrival: boolean;
  status: 'pending' | 'completed';
  /**
   * The trips billed under this invoice. Absent, not empty, for a caller
   * without `dispatch` — decided by the route, since a page mounted on the
   * payment function must not carry the despatch register through a back door.
   */
  shipments?: TrackerShipment[];
}

export interface TrackerSummary {
  invoices: number;
  pending: number;
  completed: number;
  /** Per currency, never summed across them. */
  by_currency: { currency: string; invoiced: number; balance: number }[];
}

export type TrackerStatus = 'pending' | 'completed';

/** The status rule, on its own so a test can hold it to its sentence. */
export function trackerStatus(balanceDue: number): TrackerStatus {
  return balanceDue <= 0 ? 'completed' : 'pending';
}

/**
 * The due date shown: the typed one, else the latest ETA among the trips —
 * *latest* because the balance on a consignment shipped in two containers
 * falls due when the goods have all arrived, not when the first box lands.
 */
export function dueDateOf(typed: string, shipments: { eta: string }[]): { due_date: string; due_on_arrival: boolean } {
  const t = String(typed ?? '').trim();
  if (t) return { due_date: t, due_on_arrival: false };
  const eta = shipments.map((s) => String(s.eta ?? '').trim()).filter(Boolean).sort().at(-1) ?? '';
  return { due_date: eta, due_on_arrival: eta !== '' };
}

/**
 * The trips under each invoice, in two queries rather than one per row.
 *
 * First the trips that **name** the invoice. Then, for an invoice none names,
 * the trips on the **order behind it** that name no invoice at all — reached
 * the way `dispatchProgress()` reaches the order, the invoice's own
 * `order_id` or backwards through its proforma's. A trip already billed under
 * *another* invoice is never borrowed: two invoices claiming one lorry is
 * the double count the link exists to prevent. Where a linked trip exists the
 * order's unlinked ones are not shown beside it, since a consignment billed
 * in two invoices would otherwise show every trip on both rows.
 */
export function shipmentsByInvoice(invoiceIds: number[]): Map<number, TrackerShipment[]> {
  const out = new Map<number, TrackerShipment[]>();
  if (!invoiceIds.length) return out;
  const marks = invoiceIds.map(() => '?').join(',');
  const toShipment = (s: Record<string, unknown>, linked: boolean): TrackerShipment => ({
    despatch_id: Number(s.despatch_id), linked,
    bl_no: String(s.bl_no ?? ''), container_no: String(s.container_no ?? ''),
    etd: String(s.etd ?? ''), eta: String(s.eta ?? ''),
    docs_status: String(s.docs_status ?? ''), docs_method: String(s.docs_method ?? ''), docs_date: String(s.docs_date ?? ''),
  });
  const linked = db.prepare(
    `SELECT id AS despatch_id, invoice_id, bl_no, container_no, etd, eta, docs_status, docs_method, docs_date
       FROM despatches WHERE invoice_id IN (${marks})
      ORDER BY date, id`
  ).all(...invoiceIds) as Record<string, unknown>[];
  for (const r of linked) {
    const list = out.get(Number(r.invoice_id)) ?? [];
    list.push(toShipment(r, true));
    out.set(Number(r.invoice_id), list);
  }
  const viaOrder = db.prepare(
    `SELECT i.id AS invoice_id, d.id AS despatch_id, d.bl_no, d.container_no, d.etd, d.eta,
            d.docs_status, d.docs_method, d.docs_date
       FROM commercial_invoices i
       JOIN despatches d
         ON d.order_id = COALESCE(i.order_id, (SELECT order_id FROM proforma_invoices WHERE id = i.pi_id))
        AND d.invoice_id IS NULL
      WHERE i.id IN (${marks})
      ORDER BY d.date, d.id`
  ).all(...invoiceIds) as Record<string, unknown>[];
  // Decided before the loop, not inside it: an invoice with a linked trip
  // takes none of the loose ones, and one without collects every loose one.
  const hasLinked = new Set(out.keys());
  for (const r of viaOrder) {
    const id = Number(r.invoice_id);
    if (hasLinked.has(id)) continue;
    const list = out.get(id) ?? [];
    list.push(toShipment(r, false));
    out.set(id, list);
  }
  return out;
}

export interface InvoiceHead {
  id: number; number: string; date: string; customer_id: number; customer_name: string;
  currency: string; is_export: number; grand_total: number; due_date: string;
}

/**
 * Decorate the invoices the route has already filtered and scoped. The
 * shipments are always read — the due date falls back to them — and the
 * caller decides whether to hand them on.
 */
export function trackerRows(invoices: InvoiceHead[], withShipments: boolean): TrackerRow[] {
  const ships = shipmentsByInvoice(invoices.map((i) => i.id));
  return invoices.map((i) => {
    const r = invoiceReceivable(i.id);
    const shipments = ships.get(i.id) ?? [];
    const due = dueDateOf(i.due_date, shipments);
    const row: TrackerRow = {
      id: i.id, number: i.number, date: i.date, customer_id: i.customer_id, customer_name: i.customer_name,
      currency: i.currency, is_export: Number(i.is_export) ? 1 : 0, grand_total: round2(Number(i.grand_total) || 0),
      advance_applied: r.advance_applied, amount_received: r.amount_received, credited: r.credited,
      balance_due: r.balance_due,
      ...due,
      status: trackerStatus(r.balance_due),
    };
    if (withShipments) row.shipments = shipments;
    return row;
  });
}

/** Figures over the whole filtered set, never the page. */
export function trackerSummary(rows: TrackerRow[]): TrackerSummary {
  const by = new Map<string, { invoiced: number; balance: number }>();
  let pending = 0;
  for (const r of rows) {
    if (r.status === 'pending') pending += 1;
    const c = by.get(r.currency) ?? { invoiced: 0, balance: 0 };
    c.invoiced = round2(c.invoiced + r.grand_total);
    c.balance = round2(c.balance + Math.max(0, r.balance_due));
    by.set(r.currency, c);
  }
  return {
    invoices: rows.length,
    pending,
    completed: rows.length - pending,
    by_currency: [...by].map(([currency, c]) => ({ currency, ...c })).sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}
