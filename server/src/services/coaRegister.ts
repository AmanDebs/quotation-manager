import { db } from '../db/connection.js';
import { scopeClause } from '../middleware/scope.js';
import { certifiedSql } from './qc.js';
import type { AuthedRequest } from '../middleware/auth.js';

/**
 * Every Certificate of Analysis issued, newest first.
 *
 * The counterpart to the Batches tab on a work order, which answers *has
 * **this** lot been cleared*. This answers *what have we certified*, which is
 * the question somebody chasing a shipment actually has — and which, until
 * this, could only be answered by opening every job in turn.
 *
 * **One row per certificate, not per lot**, because one number may be written
 * to several lots in one act (2026-10-16, Aglo's own cap COA covering five
 * days of two shifts). A register keyed on the lot would list that
 * consignment ten times under one number, which is the opposite of what a
 * certificate register is for. The grouping is `coa_no` **within the
 * company**, numbers being per company like every other series here — the
 * same key `buildCoaPdf` gathers a group by, so the row and the document it
 * prints can never describe different sets.
 *
 * **Nothing is stored and nothing is a second opinion.** The lots, the
 * quantity, the product and the customer are all read back through the job
 * that made them, so correcting a shift or re-pointing an order corrects the
 * register with it.
 */

/** A certificate, with everything a desk reads off a row about it. */
export interface CoaRow {
  coa_no: string;
  coa_date: string;
  /** Any lot it covers — what the PDF route is opened with; the document gathers the rest. */
  batch_id: number;
  lots: number;
  /** The lot numbers, as the certificate's own heading reads them. */
  batch_numbers: string;
  issued_by_name: string;
  approved_by: string;
  /** The buyer's own reference as typed; blank means the document falls back. */
  buyer_order: string;
  order_id: number;
  order_number: string;
  customer_name: string;
  /** Distinct catalogue names across the lots; a group may span two jobs of one order. */
  products: string;
  /** What every lot the certificate covers made — live output, so a scrapped lot counts for nothing. */
  qty: number;
  /** 1 once any lot of it has been named on a trip. */
  shipped: number;
  /**
   * 1 while the certificate has been withdrawn and kept — editable, printable
   * watermarked, and certifying nothing until it is issued again.
   */
  draft: number;
}

/**
 * The statement, grouped.
 *
 * `qty` sums each lot's own output rather than joining the entries in, or the
 * group would multiply: a lot with three shifts would be counted three times
 * over by every other aggregate on the row.
 */
const coaSql = `
  SELECT b.coa_no, MAX(b.coa_date) AS coa_date,
         MIN(b.id) AS batch_id,
         COUNT(*) AS lots,
         GROUP_CONCAT(b.number, ', ') AS batch_numbers,
         COALESCE(MAX(u.name), '') AS issued_by_name,
         COALESCE(MAX(b.coa_approved_by), '') AS approved_by,
         COALESCE(MAX(b.coa_buyer_order), '') AS buyer_order,
         MAX(o.id) AS order_id, MAX(o.number) AS order_number, MAX(c.name) AS customer_name,
         COALESCE(GROUP_CONCAT(DISTINCT COALESCE(NULLIF(p.name, ''), w.description)), '') AS products,
         COALESCE(SUM((SELECT COALESCE(SUM(pe.qty_ok), 0) FROM production_entries pe
                        WHERE pe.batch_id = b.id)), 0) AS qty,
         MAX(CASE WHEN EXISTS (SELECT 1 FROM despatch_batches dbx WHERE dbx.batch_id = b.id)
                  THEN 1 ELSE 0 END) AS shipped,
         MAX(CASE WHEN b.coa_status = 'draft' THEN 1 ELSE 0 END) AS draft
    FROM batches b
    JOIN work_orders w ON w.id = b.work_order_id
    JOIN orders o ON o.id = w.order_id
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN products p ON p.id = w.product_id
    LEFT JOIN users u ON u.id = b.coa_issued_by`;

/**
 * Which certificates, as one description shared by the list, the figure over
 * it and the download — the rule every filtered list in this app follows, so
 * none of the three can come to describe a different set from the others.
 *
 * Scoped on the order's customer like every other read that reaches an order:
 * it costs nothing today, Quality being unscoped, and is correct the day the
 * client gives Sales a cell on it.
 */
export function coaWhere(req: AuthedRequest) {
  const scope = scopeClause(req, 'o.customer_id');
  /*
   * A certificate, not a lot: a batch with no number has never had one drawn.
   *
   * **A withdrawn certificate stays on this list** (2026-10-24) — it is a
   * draft, not a deletion, and the whole point of the state is that the
   * certificate survives here as a unit to be corrected and issued again
   * rather than vanishing off the register and having to be reassembled lot
   * by lot from the Batches tab.
   */
  const where: string[] = ["b.coa_no <> ''"];
  const params: unknown[] = [];
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }

  const eq = (key: string, col: string) => {
    if (req.query[key]) { where.push(`${col} = ?`); params.push(Number(req.query[key])); }
  };
  eq('customer_id', 'o.customer_id');
  eq('product_id', 'w.product_id');
  eq('order_id', 'w.order_id');
  if (req.query.from) { where.push('b.coa_date >= ?'); params.push(String(req.query.from)); }
  if (req.query.to) { where.push('b.coa_date <= ?'); params.push(String(req.query.to)); }
  /*
   * Shipped or not — the one thing about a certificate that changes after it
   * is issued, and the reason somebody opens this list.
   *
   * **A HAVING over the group, never a WHERE on the lot**, and the difference
   * is not pedantry: a certificate covering two lots with one of them loaded
   * would, filtered on the row, be *listed* correctly and then **described
   * wrongly** — the unshipped lot dropped before the grouping, so the row
   * would read one lot and half the quantity. Found by reading the download
   * back, which is what that rule is for: the register said two lots and
   * 80,000 and the file said one and 40,000 for the same certificate.
   *
   * A certificate has gone out when **any** lot under it has, which is what
   * the `shipped` column already computes — so the filter reads that rather
   * than restating it, and the two cannot disagree.
   */
  const gone = String(req.query.shipped ?? '');
  const having = gone === '1' ? 'HAVING shipped = 1' : gone === '0' ? 'HAVING shipped = 0' : '';
  /*
   * Issued or drafted, which is what somebody opening the register to finish a
   * withdrawn certificate is looking for.
   *
   * **A WHERE on the lot is safe here where it would not be for `shipped`**,
   * and the difference is worth stating: a group's state is uniform by
   * construction — withdrawing and issuing both act on every lot under the
   * number, in one transaction — where *shipped* is true of a group when any
   * one lot has gone, so filtering that on the row would describe the group
   * wrongly. That is the defect reading the download back found.
   */
  const state = String(req.query.state ?? '');
  if (state === 'draft') where.push("b.coa_status = 'draft'");
  if (state === 'issued') where.push(certifiedSql());

  return {
    sql: `${coaSql} WHERE ${where.join(' AND ')}
          GROUP BY b.coa_no, w.company_id ${having}`,
    params,
  };
}
