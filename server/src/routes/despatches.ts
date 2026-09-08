import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { round2 } from '../services/totals.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { scopeClause, canAccessCustomer } from '../middleware/scope.js';
import { qcBlockError } from '../services/qc.js';
import { despatchLimitError } from '../services/despatchLimits.js';
import { syncOrderStatus } from '../services/orderStatus.js';
import { listBody } from '../services/pagination.js';
import { searchClause } from '../services/search.js';
import { buildXlsx, attachmentName, type Column } from '../services/xlsx.js';

export const despatchesRouter = Router();

/**
 * What actually left the gate.
 *
 * The order desk's Despatch sheet: plant, date, boxes, destination,
 * transporter, CN number. Deliberately **not** derived from invoices — a lorry
 * can leave before the paperwork, which the real sheet shows happening
 * regularly, and a record that cannot describe that is not a record of
 * despatch.
 *
 * It also does not *replace* the invoice walk. `dispatchProgress()` remains the
 * money truth; these rows are the physical one, and the Dispatch tab shows both
 * side by side so a gap between them is visible rather than silently
 * reconciled to whichever number was written last.
 *
 * No document number: the real sheet identifies a despatch by its consignment
 * note or the invoice raised for it, and inventing a third series would give
 * the floor one more number to quote wrongly.
 */

const listSql = `
  SELECT d.*, o.number AS order_number, o.customer_id,
         c.name AS customer_name,
         l.name AS location_name, t.name AS transporter_name,
         i.number AS invoice_number, u.name AS created_by_name
  FROM despatches d
  JOIN orders o ON o.id = d.order_id
  JOIN customers c ON c.id = o.customer_id
  LEFT JOIN locations l ON l.id = d.location_id
  LEFT JOIN transporters t ON t.id = d.transporter_id
  LEFT JOIN commercial_invoices i ON i.id = d.invoice_id
  LEFT JOIN users u ON u.id = d.created_by`;

const numOrNull = (v: unknown) =>
  v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);

function accessible(req: AuthedRequest, id: number) {
  const row = db.prepare(`${listSql} WHERE d.id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row || !canAccessCustomer(req, Number(row.customer_id))) return undefined;
  return row;
}

function withItems(row: Record<string, unknown>) {
  row.items = db.prepare('SELECT * FROM despatch_items WHERE despatch_id = ? ORDER BY sort_order, id')
    .all(Number(row.id));
  return row;
}

interface ItemInput {
  order_line?: number;
  description?: string;
  qty?: number | null;
  packs?: number | null;
  notes?: string;
}

function saveItems(despatchId: number, items: ItemInput[]) {
  db.prepare('DELETE FROM despatch_items WHERE despatch_id = ?').run(despatchId);
  const ins = db.prepare(
    `INSERT INTO despatch_items (despatch_id, order_line, description, qty, packs, notes, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  // A line with neither pieces nor boxes did not go on the lorry.
  items
    .filter((it) => numOrNull(it.qty) !== null || numOrNull(it.packs) !== null)
    .forEach((it, i) =>
      ins.run(despatchId, Number(it.order_line) || 0, String(it.description ?? ''),
        numOrNull(it.qty), numOrNull(it.packs), String(it.notes ?? ''), i));
}

/** Pieces physically sent per order line — the counterpart to the invoice walk. */
export function despatchedByOrder(orderId: number):
  Map<number, { qty: number; packs: number; trips: number; last_date: string }> {
  const rows = db.prepare(
    `SELECT di.order_line,
            COALESCE(SUM(di.qty), 0) AS qty,
            COALESCE(SUM(di.packs), 0) AS packs,
            COUNT(DISTINCT d.id) AS trips,
            -- When this line last moved. MAX rather than MIN: a line shipped
            -- over three trips is best described by the most recent one, which
            -- is what "has this gone yet" is actually asking.
            MAX(d.date) AS last_date
     FROM despatch_items di
     JOIN despatches d ON d.id = di.despatch_id
     WHERE d.order_id = ?
     GROUP BY di.order_line`
  ).all(orderId) as
    { order_line: number; qty: number; packs: number; trips: number; last_date: string | null }[];
  return new Map(rows.map((r) => [r.order_line, {
    qty: round2(r.qty), packs: round2(r.packs), trips: r.trips, last_date: r.last_date ?? '',
  }]));
}

/**
 * What makes a trip a *shipment* rather than a lorry.
 *
 * The documents question only arises on a sea leg: a container cannot be
 * cleared without them, while a lorry to Hazipur carries a consignment note
 * and nothing else. So "documents outstanding" has to be asked of shipments
 * alone — asked of every despatch it answers *every domestic trip ever made*,
 * each of which has a blank `docs_status` and always will.
 *
 * That was a real defect in the `?docs=pending` filter as first written
 * (`docs_status <> 'received'` over the whole register). It is corrected here
 * rather than worked around, and this is the moment to do it: the filter has
 * had no control on the screen until now, so nothing can have come to rely on
 * the old reading.
 *
 * Written twice rather than derived from one string, because the two contexts
 * genuinely differ — the WHERE runs against the joined query and needs the
 * `d.` alias, the summary runs against a CTE of it and must not have one — and
 * a regex that rewrites SQL is a worse thing to maintain than four repeated
 * column names. They are asserted equal, column for column, in the tests.
 */
export const SEA_LEG = "(bl_no <> '' OR container_no <> '' OR etd <> '' OR eta <> '')";
export const SEA_LEG_D = "(d.bl_no <> '' OR d.container_no <> '' OR d.etd <> '' OR d.eta <> '')";

/**
 * Pieces, boxes and unbilled trips over every despatch matching the filters —
 * not just the page on screen. Built from the list's own query so the two can
 * never disagree about which despatches they are describing.
 */
function despatchSummary(sql: string, params: unknown[]) {
  return db.prepare(
    `WITH f AS (${sql})
     SELECT (SELECT COUNT(*) FROM f) AS trips,
            (SELECT COUNT(*) FROM f WHERE invoice_id IS NULL) AS unbilled,
            COALESCE((SELECT SUM(di.qty) FROM despatch_items di
                       WHERE di.despatch_id IN (SELECT id FROM f)), 0) AS pieces,
            COALESCE((SELECT SUM(di.packs) FROM despatch_items di
                       WHERE di.despatch_id IN (SELECT id FROM f)), 0) AS boxes,
            (SELECT COUNT(*) FROM f WHERE eta <> '' OR etd <> '') AS with_eta,
            (SELECT COUNT(*) FROM f WHERE docs_status <> '') AS with_docs,
            (SELECT COUNT(*) FROM f WHERE ${SEA_LEG} AND COALESCE(docs_status, '') <> 'received')
              AS docs_pending`
  ).get(...(params as never[])) as {
    trips: number; unbilled: number; pieces: number; boxes: number;
    with_eta: number; with_docs: number; docs_pending: number;
  };
}

/**
 * The register's filters, built once so the list and its export cannot drift
 * apart — an export that quietly disagreed with the table it sits under is
 * worse than no export, which is the rule `routes/orders.ts` states about its
 * own `orderListWhere`.
 */
/**
 * Where the shipping documents have got to, and how they travelled.
 *
 * Blank is the ordinary state and means *not sent yet* — every despatch already
 * on file reads that way, and a domestic lorry never leaves it. The buyer
 * cannot clear the goods without these, which is why it is tracked apart from
 * the goods themselves: a container can be at the port while the paperwork is
 * still on somebody's desk, and that is precisely the row worth finding.
 *
 * Enforced here rather than by a CHECK, for the reason `products.product_type`
 * gives: SQLite cannot ALTER one, and a list like this expects to grow.
 */
export const DOCS_STATUSES = ['', 'sent', 'received'] as const;

export const DOCS_METHODS = ['', 'telex', 'courier'] as const;

/** How the two read on a spreadsheet, where a code helps nobody. */
const DOCS_LABEL: Record<string, string> = { '': 'Not sent', sent: 'Sent', received: 'Received' };
const DOCS_METHOD_LABEL: Record<string, string> = { '': '', telex: 'Telex release', courier: 'Courier' };

const oneOf = (allowed: readonly string[], v: unknown) => {
  const s = String(v ?? '').trim().toLowerCase();
  return allowed.includes(s) ? s : null;
};

function despatchListWhere(req: AuthedRequest): { where: string[]; params: unknown[] } {
  const scope = scopeClause(req, 'o.customer_id');
  const where: string[] = [];
  const params: unknown[] = [];
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  if (req.query.order_id) { where.push('d.order_id = ?'); params.push(Number(req.query.order_id)); }
  if (req.query.location_id) { where.push('d.location_id = ?'); params.push(Number(req.query.location_id)); }
  if (req.query.customer_id) { where.push('o.customer_id = ?'); params.push(Number(req.query.customer_id)); }
  if (req.query.from) { where.push('d.date >= ?'); params.push(String(req.query.from)); }
  if (req.query.to) { where.push('d.date <= ?'); params.push(String(req.query.to)); }
  /*
   * What somebody actually has in hand when they open this register: a
   * container or BL number off a forwarder's email, a CN or vehicle number off
   * a transporter's, or our own order number and the customer's name from
   * inside. Destination rides along because "everything that went to
   * Mogadishu" is a real question and this list has no other way to ask it.
   *
   * Server-side, like every other register here: the list is paged, so
   * filtering the rows already fetched would search the page in hand rather
   * than the book. Through `searchClause`, so `%` and `_` are escaped and the
   * clause is bracketed — without the brackets `scope AND a LIKE ? OR b LIKE ?`
   * binds as `(scope AND a) OR b`, and the search becomes a way straight past
   * data scoping.
   */
  const search = searchClause(
    ['d.container_no', 'd.bl_no', 'd.cn_no', 'd.vehicle_no', 'o.number', 'c.name', 'd.destination'],
    String(req.query.q ?? ''),
  );
  if (search.sql) { where.push(search.sql); params.push(...search.params); }
  // Gone but not billed — the reason these rows exist at all.
  if (req.query.uninvoiced === '1') where.push('d.invoice_id IS NULL');
  /*
   * Shipments whose documents are still outstanding, which is the question the
   * export sheet's two "Documents Status" columns exist to answer. `pending`
   * is deliberately "not received", not "not sent": documents posted a week ago
   * and still not with the buyer are exactly the case worth chasing.
   */
  if (req.query.docs === 'pending') {
    // Shipments only — see SEA_LEG above. Asked of the whole register this
    // would return every domestic lorry ever recorded.
    where.push(`${SEA_LEG_D} AND COALESCE(d.docs_status, '') <> 'received'`);
  } else if (req.query.docs === 'sent') where.push("d.docs_status = 'sent'");
  else if (req.query.docs === 'received') where.push("d.docs_status = 'received'");
  // Arriving between two dates — an ETA is a real date so it can be asked for.
  if (req.query.eta_from) { where.push("d.eta <> '' AND d.eta >= ?"); params.push(String(req.query.eta_from)); }
  if (req.query.eta_to) { where.push("d.eta <> '' AND d.eta <= ?"); params.push(String(req.query.eta_to)); }
  return { where, params };
}

const whereSql = (where: string[]) => (where.length ? `WHERE ${where.join(' AND ')}` : '');

/**
 * The despatch register as a spreadsheet.
 *
 * Declared **above `/:id`**, or Express reads "export" as a despatch id — the
 * trap every export in this codebase has to step over.
 *
 * The desk's own sheet runs to roughly 465 rows a month and reconciling it
 * against ours is done in Excel, so this is the list people actually need out.
 * Pieces and boxes are summed **in SQL** rather than by loading each trip's
 * items: the list does the latter because it shows the lines, and the export
 * only needs the totals.
 */
const despatchColumns: Column<Record<string, unknown>>[] = [
  { header: 'Date', value: (r) => String(r.date ?? ''), type: 'date' },
  { header: 'Plant', value: (r) => String(r.location_name ?? '') },
  { header: 'Order', value: (r) => String(r.order_number ?? '') },
  { header: 'Customer', value: (r) => String(r.customer_name ?? '') },
  { header: 'Destination', value: (r) => String(r.destination ?? '') },
  { header: 'Transporter', value: (r) => String(r.transporter_name ?? '') },
  { header: 'CN no.', value: (r) => String(r.cn_no ?? '') },
  { header: 'Vehicle', value: (r) => String(r.vehicle_no ?? '') },
  // The sea leg, in the order the export sheet reads them. Blank on a domestic
  // lorry, and `itemsTable`'s rule does not apply here — a spreadsheet column
  // that is empty for half the rows is still the column somebody filters on.
  { header: 'BL no.', value: (r) => String(r.bl_no ?? '') },
  { header: 'Container no.', value: (r) => String(r.container_no ?? '') },
  { header: 'ETD', value: (r) => String(r.etd ?? ''), type: 'date' },
  { header: 'ETA', value: (r) => String(r.eta ?? ''), type: 'date' },
  // As words, not codes: this is the column somebody reconciling filters on,
  // the call the QC register's verdict column already makes.
  { header: 'Documents', value: (r) => DOCS_LABEL[String(r.docs_status ?? '')] ?? '' },
  { header: 'Sent by', value: (r) => DOCS_METHOD_LABEL[String(r.docs_method ?? '')] ?? '' },
  { header: 'Documents date', value: (r) => String(r.docs_date ?? ''), type: 'date' },
  { header: 'Pieces', value: (r) => Number(r.pieces ?? 0), type: 'number' },
  { header: 'Boxes', value: (r) => Number(r.boxes ?? 0), type: 'number' },
  { header: 'Invoice', value: (r) => String(r.invoice_number ?? '') },
  // The column the paper sheet could not have, and the reason to open this one.
  { header: 'Billed', value: (r) => (r.invoice_id ? 'Yes' : 'Not billed') },
  // Free text on the real sheet — "5-6 Days" and the like.
  { header: 'Tentative delivery', value: (r) => String(r.tentative_delivery ?? '') },
  { header: 'Freight terms', value: (r) => String(r.freight_terms ?? '') },
  { header: 'Notes', value: (r) => String(r.notes ?? '') },
];

despatchesRouter.get('/export', (req: AuthedRequest, res) => {
  const { where, params } = despatchListWhere(req);
  const rows = db.prepare(
    `SELECT d.*, o.number AS order_number, o.customer_id, c.name AS customer_name,
            l.name AS location_name, t.name AS transporter_name, i.number AS invoice_number,
            COALESCE((SELECT SUM(di.qty) FROM despatch_items di WHERE di.despatch_id = d.id), 0) AS pieces,
            COALESCE((SELECT SUM(di.packs) FROM despatch_items di WHERE di.despatch_id = d.id), 0) AS boxes
     FROM despatches d
     JOIN orders o ON o.id = d.order_id
     JOIN customers c ON c.id = o.customer_id
     LEFT JOIN locations l ON l.id = d.location_id
     LEFT JOIN transporters t ON t.id = d.transporter_id
     LEFT JOIN commercial_invoices i ON i.id = d.invoice_id
     ${whereSql(where)} ORDER BY d.date DESC, d.id DESC`
  ).all(...(params as never[])) as Record<string, unknown>[];

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${attachmentName('Despatches')}"`);
  res.send(buildXlsx('Despatches', despatchColumns, rows));
});

despatchesRouter.get('/', (req: AuthedRequest, res) => {
  const { where, params } = despatchListWhere(req);

  // This list has always been capped — at 300 rows, silently, with no way to
  // reach the 301st. Paging replaces the cap outright: `?limit=` now means a
  // page size rather than a ceiling, and the rows beyond it are reachable.
  const sql = `${listSql} ${whereSql(where)}`;
  const body = listBody<Record<string, unknown>>(req.query, {
    sql, order: 'ORDER BY d.date DESC, d.id DESC', params,
  }, (rows) => rows.map(withItems));
  // The strip above the table adds up pieces, boxes and what is still
  // unbilled. Adding up one page of rows would answer a different question in
  // the same words, so the figures come from the whole filtered set.
  res.json(Array.isArray(body) ? body : { ...body, summary: despatchSummary(sql, params) });
});

despatchesRouter.get('/:id', (req: AuthedRequest, res) => {
  const row = accessible(req, Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Despatch not found' });
  res.json(withItems(row));
});

despatchesRouter.post('/', (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  const order = db.prepare('SELECT id, customer_id FROM orders WHERE id = ?')
    .get(Number(body.order_id)) as { id: number; customer_id: number } | undefined;
  if (!order || !canAccessCustomer(req, order.customer_id)) {
    return res.status(404).json({ error: 'Order not found' });
  }
  if (!String(body.date ?? '').trim()) return res.status(400).json({ error: 'Date is required' });
  const items = Array.isArray(body.items) ? (body.items as ItemInput[]) : [];
  if (!items.some((it) => numOrNull(it.qty) !== null || numOrNull(it.packs) !== null)) {
    return res.status(400).json({ error: 'Record what went — pieces or boxes on at least one line' });
  }
  // Nothing ships until it has passed QC. See qcBlockError for what "passed"
  // means and for the two things it deliberately does not block.
  const blocked = qcBlockError(order.id, items);
  if (blocked) return res.status(409).json({ error: blocked });
  // A figure below zero, or far past what the line has left to ship. 400 and
  // not 409: nothing conflicts, the number itself is wrong.
  const outOfRange = despatchLimitError(order.id, items);
  if (outOfRange) return res.status(400).json({ error: outOfRange });
  // Answered with the accepted list rather than letting a typo become a status
  // nothing can filter for — the column carries no CHECK to catch it.
  const docsStatus = oneOf(DOCS_STATUSES, body.docs_status);
  if (docsStatus === null) return res.status(400).json({ error: 'Documents status must be one of: sent, received' });
  const docsMethod = oneOf(DOCS_METHODS, body.docs_method);
  if (docsMethod === null) return res.status(400).json({ error: 'Documents method must be one of: telex, courier' });
  // An invoice can be named, but only one belonging to the same customer.
  const invoiceId = numOrNull(body.invoice_id);
  if (invoiceId !== null) {
    const inv = db.prepare('SELECT customer_id FROM commercial_invoices WHERE id = ?')
      .get(invoiceId) as { customer_id: number } | undefined;
    if (!inv || inv.customer_id !== order.customer_id) {
      return res.status(400).json({ error: 'That invoice belongs to another customer' });
    }
  }

  const id = transaction(() => {
    const info = db.prepare(
      `INSERT INTO despatches (order_id, location_id, date, destination, transporter_id, cn_no, vehicle_no,
         tentative_delivery, freight_terms, invoice_id, notes,
         bl_no, container_no, etd, eta, docs_status, docs_method, docs_date, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      order.id, numOrNull(body.location_id), String(body.date), String(body.destination ?? ''),
      numOrNull(body.transporter_id), String(body.cn_no ?? ''), String(body.vehicle_no ?? ''),
      String(body.tentative_delivery ?? ''), String(body.freight_terms ?? ''),
      invoiceId, String(body.notes ?? ''),
      String(body.bl_no ?? ''), String(body.container_no ?? ''),
      String(body.etd ?? ''), String(body.eta ?? ''),
      docsStatus, docsMethod, String(body.docs_date ?? ''),
      req.user!.id
    );
    const despatchId = Number(info.lastInsertRowid);
    saveItems(despatchId, items);
    return despatchId;
  });

  // Goods leaving is the clearest fact there is about an order's progress.
  syncOrderStatus(order.id);
  res.status(201).json(withItems(accessible(req, id)!));
});

despatchesRouter.put('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = accessible(req, id);
  if (!existing) return res.status(404).json({ error: 'Despatch not found' });
  const body = req.body ?? {};
  const v = (f: string, def: unknown = '') => body[f] ?? existing[f] ?? def;
  const invoiceId = numOrNull(v('invoice_id', null));
  if (invoiceId !== null) {
    const inv = db.prepare('SELECT customer_id FROM commercial_invoices WHERE id = ?')
      .get(invoiceId) as { customer_id: number } | undefined;
    if (!inv || inv.customer_id !== Number(existing.customer_id)) {
      return res.status(400).json({ error: 'That invoice belongs to another customer' });
    }
  }
  const docsStatus = oneOf(DOCS_STATUSES, v('docs_status'));
  if (docsStatus === null) return res.status(400).json({ error: 'Documents status must be one of: sent, received' });
  const docsMethod = oneOf(DOCS_METHODS, v('docs_method'));
  if (docsMethod === null) return res.status(400).json({ error: 'Documents method must be one of: telex, courier' });
  if (Array.isArray(body.items)) {
    const stopped = qcBlockError(Number(existing.order_id), body.items as ItemInput[]);
    if (stopped) return res.status(409).json({ error: stopped });
    // This despatch's own lines are already in the register, so they are left
    // out of "already sent" — otherwise re-saving an unchanged trip would read
    // as a second shipment of the same goods and refuse itself.
    const outOfRange = despatchLimitError(Number(existing.order_id), body.items as ItemInput[], id);
    if (outOfRange) return res.status(400).json({ error: outOfRange });
  }
  transaction(() => {
    // order_id is not editable: moving a despatch would move goods onto
    // another customer's order.
    db.prepare(
      `UPDATE despatches SET location_id = ?, date = ?, destination = ?, transporter_id = ?, cn_no = ?,
         vehicle_no = ?, tentative_delivery = ?, freight_terms = ?, invoice_id = ?, notes = ?,
         bl_no = ?, container_no = ?, etd = ?, eta = ?, docs_status = ?, docs_method = ?, docs_date = ?
       WHERE id = ?`
    ).run(
      numOrNull(v('location_id', null)), String(v('date')), String(v('destination')),
      numOrNull(v('transporter_id', null)), String(v('cn_no')), String(v('vehicle_no')),
      String(v('tentative_delivery')), String(v('freight_terms')), invoiceId, String(v('notes')),
      String(v('bl_no')), String(v('container_no')), String(v('etd')), String(v('eta')),
      docsStatus, docsMethod, String(v('docs_date')), id
    );
    if (Array.isArray(body.items)) saveItems(id, body.items);
  });
  res.json(withItems(accessible(req, id)!));
});

despatchesRouter.delete('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = accessible(req, id);
  if (!existing) return res.status(404).json({ error: 'Despatch not found' });
  transaction(() => {
    db.prepare('DELETE FROM despatch_items WHERE despatch_id = ?').run(id);
    db.prepare('DELETE FROM despatches WHERE id = ?').run(id);
  });
  // Goods leaving advanced the order; the trip being withdrawn has to be able
  // to take that back, or deleting the only despatch leaves the order reading
  // *Partially dispatched* over an empty register.
  syncOrderStatus(Number(existing.order_id));
  res.json({ ok: true });
});
