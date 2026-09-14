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

/** The trips billed under each invoice, in one query rather than one per row. */
export function shipmentsByInvoice(invoiceIds: number[]): Map<number, TrackerShipment[]> {
  const out = new Map<number, TrackerShipment[]>();
  if (!invoiceIds.length) return out;
  const rows = db.prepare(
    `SELECT id AS despatch_id, invoice_id, bl_no, container_no, etd, eta, docs_status, docs_method, docs_date
       FROM despatches WHERE invoice_id IN (${invoiceIds.map(() => '?').join(',')})
      ORDER BY date, id`
  ).all(...invoiceIds) as unknown as (TrackerShipment & { invoice_id: number })[];
  for (const r of rows) {
    const { invoice_id, ...s } = r;
    const list = out.get(invoice_id) ?? [];
    list.push({
      despatch_id: Number(s.despatch_id),
      bl_no: String(s.bl_no ?? ''), container_no: String(s.container_no ?? ''),
      etd: String(s.etd ?? ''), eta: String(s.eta ?? ''),
      docs_status: String(s.docs_status ?? ''), docs_method: String(s.docs_method ?? ''), docs_date: String(s.docs_date ?? ''),
    });
    out.set(invoice_id, list);
  }
  return out;
}

interface InvoiceHead {
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
