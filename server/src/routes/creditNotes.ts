import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { nextNumber } from '../services/numbering.js';
import { computeTotals, type LineItemInput } from '../services/totals.js';
import { type AuthedRequest } from '../middleware/auth.js';
import { scopeClause, canAccessCustomer } from '../middleware/scope.js';
import { submit, decide, resetApprovalOnEdit, mayApprove } from '../services/approval.js';
import { incompleteError, checkDocument } from '../services/documentChecks.js';
import { syncInvoiceStatus } from '../services/invoiceStatus.js';
import { syncOrderStatus } from '../services/orderStatus.js';
import { listBody } from '../services/pagination.js';
import { searchClause } from '../services/search.js';
import { buildXlsx, attachmentName, type Column } from '../services/xlsx.js';
import {
  CREDIT_KINDS, isCreditKind, returnLimitError, creditTotalError,
} from '../services/creditNotes.js';

/**
 * The credit note: what a buyer is credited, and what came back.
 *
 * Mounted on the **invoice** function rather than a new one. A credit note is
 * the invoice being partly taken back, it is raised by whoever raised the
 * invoice, and inventing a function for it would mean a cell nobody has filled
 * in on the client's own access matrix. So Sales writes them, Logistics reads
 * them, and the three factory teams reach neither.
 */
export const creditNotesRouter = Router();

const listSql = `
  SELECT n.*, c.name AS customer_name, c.country AS customer_country,
         i.number AS invoice_number, i.date AS invoice_date, i.grand_total AS invoice_total,
         co.company_name AS company_name,
         u.name AS created_by_name, a.name AS approved_by_name
  FROM credit_notes n
  JOIN customers c ON c.id = n.customer_id
  JOIN commercial_invoices i ON i.id = n.invoice_id
  -- LEFT, not JOIN: a document must still list if its company row is gone.
  LEFT JOIN companies co ON co.id = n.company_id
  LEFT JOIN users u ON u.id = n.created_by
  LEFT JOIN users a ON a.id = n.approved_by`;

function getFull(id: number) {
  const note = db.prepare(`${listSql} WHERE n.id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!note) return undefined;
  note.items = db.prepare('SELECT * FROM credit_note_items WHERE credit_note_id = ? ORDER BY sort_order, id').all(id);
  note.column_config = JSON.parse(String(note.column_config || '{}'));
  // Shown on the form above a disabled Submit, not sprung on the press — the
  // rule every `checks` key in this codebase follows.
  note.checks = checkDocument('credit_notes', id);
  /*
   * The invoice's lines, so the form can say how much of each is still
   * available to credit and cap the box at it. The server refuses the same
   * figures through `returnLimitError`, so the screen explains a rule that is
   * held here rather than keeping a second copy of it — the call the dispatch
   * dialog records, along with the trap that comes with it: the note being
   * edited must be excluded from "already credited", or re-opening a saved
   * credit note reads every line as fully spent and caps every box at zero.
   */
  note.invoice_lines = creditableLines(Number(note.invoice_id), id);
  return note;
}

/** The invoice's lines and how much of each is still open to a return. */
function creditableLines(invoiceId: number, exceptNoteId: number) {
  return db.prepare(
    `SELECT ii.sort_order, ii.description, ii.qty, ii.unit, ii.is_charge,
            COALESCE((
              SELECT SUM(ci.qty) FROM credit_note_items ci
                JOIN credit_notes cn ON cn.id = ci.credit_note_id
               WHERE cn.invoice_id = ii.invoice_id AND cn.kind = 'return'
                 AND cn.approval_status <> 'rejected' AND cn.id <> ?
                 AND ci.sort_order = ii.sort_order AND ci.is_charge = 0
            ), 0) AS already_credited
       FROM invoice_items ii
      WHERE ii.invoice_id = ?
      ORDER BY ii.sort_order, ii.id`
  ).all(exceptNoteId, invoiceId);
}

/**
 * Everything a credit note moves, brought back into line.
 *
 * A credit note changes two things and neither of them is on its own row: what
 * the invoice still has outstanding, and how much of the order line counts as
 * dispatched. Both are derived, so nothing has to be written — but both are
 * *stored statuses* downstream (`paid` on the invoice, the order's own rung),
 * and a status that contradicts the record is the failure `orderStatus.ts`
 * exists to prevent.
 *
 * Called after **every** route that can move a credit note, approval included:
 * approving one is what makes it count at all, so the transition matters as
 * much as the save. Resolved from the invoice before the row is deleted, or a
 * delete would sync nothing.
 */
function syncAfter(invoiceId: number) {
  if (!invoiceId) return;
  syncInvoiceStatus(invoiceId);
  const row = db.prepare(
    `SELECT COALESCE(order_id, (SELECT order_id FROM proforma_invoices WHERE id = pi_id)) AS o
       FROM commercial_invoices WHERE id = ?`
  ).get(invoiceId) as { o: number | null } | undefined;
  if (row?.o) syncOrderStatus(row.o);
}

/**
 * The invoice being credited, and everything a credit note takes from it.
 *
 * Currency, tax type, export flag, customer and company are **read from the
 * invoice on every save and never from the body**. A credit note that taxed
 * differently from the document it credits would be a second opinion about one
 * supply; and since `exportChangeError` freezes the invoice's own flag once it
 * is numbered, a copy taken this way can never come to disagree with it.
 */
function invoiceFor(id: number) {
  return db.prepare(
    `SELECT id, number, customer_id, company_id, currency, tax_type, is_export, grand_total
       FROM commercial_invoices WHERE id = ?`
  ).get(id) as {
    id: number; number: string; customer_id: number; company_id: number;
    currency: string; tax_type: 'none' | 'cgst_sgst' | 'igst'; is_export: number; grand_total: number;
  } | undefined;
}

function saveItems(noteId: number, items: LineItemInput[], taxType: 'none' | 'cgst_sgst' | 'igst', currency: string) {
  // No freight or insurance: a credit note reverses lines, and a header charge
  // has nowhere to be reversed *from*. Freight overbilled is credited as a
  // charge line, which is the shape `HeaderCharges` moved everything else to.
  const totals = computeTotals(items, taxType, 0, 0, currency);
  db.prepare('DELETE FROM credit_note_items WHERE credit_note_id = ?').run(noteId);
  const ins = db.prepare(
    `INSERT INTO credit_note_items (credit_note_id, product_id, description, hsn_code, qty, unit, unit_price, tax_pct, amount, color, packs, pcs_per_pack, total_pcs, qty_20ft, qty_40ft, is_charge, custom1, custom2, custom3, image, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  totals.items.forEach((it, i) =>
    ins.run(noteId, it.product_id ?? null, it.description, it.hsn_code ?? '', it.qty ?? null, it.unit ?? 'unit', it.unit_price, it.tax_pct ?? 0, it.amount,
      it.color ?? '', it.packs ?? null, it.pcs_per_pack ?? null, it.total_pcs ?? null,
      it.qty_20ft ?? null, it.qty_40ft ?? null, it.is_charge ? 1 : 0,
      it.custom1 ?? '', it.custom2 ?? '', it.custom3 ?? '', it.image ?? '', i)
  );
  db.prepare('UPDATE credit_notes SET subtotal = ?, tax_total = ?, grand_total = ? WHERE id = ?').run(
    totals.subtotal, totals.tax_total, totals.grand_total, noteId
  );
}

/** The list's filters, built once so the list and its export cannot drift. */
function listWhere(req: AuthedRequest): { where: string[]; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const scope = scopeClause(req, 'n.customer_id');
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  // Our number, the invoice it credits, or the customer — what somebody has in
  // hand when they come looking for one.
  const text = searchClause(['n.number', 'i.number', 'c.name'], String(req.query.q ?? '').trim());
  if (text.sql) { where.push(text.sql); params.push(...text.params); }
  if (req.query.kind) { where.push('n.kind = ?'); params.push(String(req.query.kind)); }
  if (req.query.approval) { where.push('n.approval_status = ?'); params.push(String(req.query.approval)); }
  if (req.query.invoice_id) { where.push('n.invoice_id = ?'); params.push(Number(req.query.invoice_id)); }
  if (req.query.export === '1' || req.query.export === '0') { where.push('n.is_export = ?'); params.push(Number(req.query.export)); }
  if (Number(req.query.company) > 0) { where.push('n.company_id = ?'); params.push(Number(req.query.company)); }
  if (req.query.from) { where.push('n.date >= ?'); params.push(String(req.query.from)); }
  if (req.query.to) { where.push('n.date <= ?'); params.push(String(req.query.to)); }
  return { where, params };
}

creditNotesRouter.get('/', (req: AuthedRequest, res) => {
  const { where, params } = listWhere(req);
  res.json(listBody(req.query, {
    sql: `${listSql}${where.length ? ' WHERE ' + where.join(' AND ') : ''}`,
    order: 'ORDER BY n.date DESC, n.id DESC',
    params,
  }));
});

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? '' : String(v));
const num = (v: unknown) => Number(v ?? 0);

const columns: Column<Row>[] = [
  { header: 'Number', value: (r) => str(r.number) },
  { header: 'Date', value: (r) => str(r.date), type: 'date' },
  { header: 'Customer', value: (r) => str(r.customer_name) },
  { header: 'Against invoice', value: (r) => str(r.invoice_number) },
  { header: 'Invoice date', value: (r) => str(r.invoice_date), type: 'date' },
  { header: 'Issued by', value: (r) => str(r.company_name) },
  // The word rather than the stored value, as the QC register writes its
  // verdict: this is the column somebody reconciling would filter on.
  { header: 'Kind', value: (r) => (str(r.kind) === 'return' ? 'Goods returned' : 'Adjustment') },
  { header: 'Reason', value: (r) => str(r.reason) },
  { header: 'Type', value: (r) => (num(r.is_export) ? 'Export' : 'Domestic') },
  { header: 'Currency', value: (r) => str(r.currency) },
  { header: 'Subtotal', value: (r) => num(r.subtotal), type: 'money' },
  { header: 'Tax', value: (r) => num(r.tax_total), type: 'money' },
  { header: 'Total', value: (r) => num(r.grand_total), type: 'money' },
  { header: 'Invoice total', value: (r) => num(r.invoice_total), type: 'money' },
  { header: 'Approval', value: (r) => str(r.approval_status) },
  { header: 'Created by', value: (r) => str(r.created_by_name) },
];

/**
 * The list as a spreadsheet. Declared **above** `/:id`, or Express reads
 * "export" as a document id. Whole filtered set, never a page, through the
 * same filters as the list — scoping included.
 */
creditNotesRouter.get('/export', (req: AuthedRequest, res) => {
  const { where, params } = listWhere(req);
  const rows = db
    .prepare(`${listSql}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY n.date DESC, n.id DESC`)
    .all(...(params as never[])) as Row[];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${attachmentName('Credit notes')}"`);
  res.send(buildXlsx('Credit notes', columns, rows));
});

/**
 * A draft credit note for an invoice: its own lines, ready to be cut down.
 *
 * The carry-forward pattern every conversion in this app follows — a GET that
 * writes nothing, returning a payload the form saves normally. Quantities come
 * across as **what is still available to credit** rather than as what was
 * billed, because a second partial return is the ordinary case and prefilling
 * the whole line would offer a figure the save then refuses.
 *
 * A line with nothing left is returned all the same, at zero: a picker that
 * silently omits the line somebody is looking for reads as a fault, where one
 * showing it empty says it is already accounted for.
 */
creditNotesRouter.get('/prefill/from-invoice/:invoiceId', (req: AuthedRequest, res) => {
  const inv = invoiceFor(Number(req.params.invoiceId));
  if (!inv || !canAccessCustomer(req, inv.customer_id)) return res.status(404).json({ error: 'Invoice not found' });
  const lines = db.prepare(
    `SELECT ii.*, COALESCE((
        SELECT SUM(ci.qty) FROM credit_note_items ci
          JOIN credit_notes cn ON cn.id = ci.credit_note_id
         WHERE cn.invoice_id = ii.invoice_id AND cn.kind = 'return'
           AND cn.approval_status <> 'rejected'
           AND ci.sort_order = ii.sort_order AND ci.is_charge = 0
      ), 0) AS already_credited
     FROM invoice_items ii WHERE ii.invoice_id = ? ORDER BY ii.sort_order, ii.id`
  ).all(inv.id) as Record<string, unknown>[];

  res.json({
    invoice_id: inv.id,
    invoice_number: inv.number,
    customer_id: inv.customer_id,
    company_id: inv.company_id,
    currency: inv.currency,
    tax_type: inv.tax_type,
    is_export: inv.is_export,
    kind: 'return',
    date: new Date().toISOString().slice(0, 10),
    invoice_lines: creditableLines(inv.id, -1),
    items: lines.map((it) => {
      const billed = Number(it.qty) || 0;
      const left = Math.max(0, billed - (Number(it.already_credited) || 0));
      const ratio = billed > 0 ? left / billed : 1;
      return {
        product_id: it.product_id, description: it.description, hsn_code: it.hsn_code,
        // A charge is never part-credited by quantity: it has none, and
        // `billedQty` short-circuits it to 1 so its price is its amount.
        qty: it.is_charge ? it.qty : left,
        unit: it.unit, unit_price: it.unit_price, tax_pct: it.tax_pct,
        color: it.color, pcs_per_pack: it.pcs_per_pack,
        // Packs and pieces are scaled with the quantity rather than carried
        // whole, or a part credit would state the whole shipment's box count.
        packs: it.packs == null ? null : Math.round(Number(it.packs) * ratio * 100) / 100,
        total_pcs: it.total_pcs == null ? null : Math.round(Number(it.total_pcs) * ratio * 100) / 100,
        qty_20ft: it.qty_20ft, qty_40ft: it.qty_40ft,
        is_charge: it.is_charge,
      };
    }),
  });
});

creditNotesRouter.get('/:id', (req: AuthedRequest, res) => {
  const note = getFull(Number(req.params.id));
  if (!note || !canAccessCustomer(req, Number(note.customer_id))) return res.status(404).json({ error: 'Credit note not found' });
  res.json(note);
});

const kindError = (v: unknown): string | null =>
  (isCreditKind(v) ? null : `A credit note is one of ${CREDIT_KINDS.join(' or ')}.`);

creditNotesRouter.post('/', (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  const inv = invoiceFor(Number(body.invoice_id));
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  if (!canAccessCustomer(req, inv.customer_id)) return res.status(404).json({ error: 'Invoice not found' });
  const kind = String(body.kind ?? 'return');
  const bad = kindError(kind);
  if (bad) return res.status(400).json({ error: bad });

  const items = (body.items ?? []) as LineItemInput[];
  const date = String(body.date ?? new Date().toISOString().slice(0, 10));
  /*
   * The totals are computed here as well as inside `saveItems`, because the
   * money ceiling is a rule about the figure `computeTotals` produces and not
   * about the one the client sent — nothing client-computed is ever trusted.
   * It is a pure function over the lines, so asking twice costs an arithmetic
   * pass and keeps the guard where every other guard in this codebase is: in
   * front of the transaction, answering before anything is written.
   */
  const totals = computeTotals(items, inv.tax_type, 0, 0, inv.currency);
  const overLine = returnLimitError(inv.id, kind, items);
  if (overLine) return res.status(400).json({ error: overLine });
  const overAll = creditTotalError(inv.id, totals.grand_total);
  if (overAll) return res.status(400).json({ error: overAll });

  const id = transaction(() => {
    const number = nextNumber('credit_note', { isExport: inv.is_export === 1, companyId: inv.company_id, date });
    const info = db.prepare(
      `INSERT INTO credit_notes (number, date, invoice_id, customer_id, company_id, kind, reason,
                                 currency, tax_type, is_export, notes, prepared_by, created_by, column_config)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      String(body.number || number), date, inv.id, inv.customer_id, inv.company_id,
      kind, String(body.reason ?? ''),
      inv.currency, inv.tax_type, inv.is_export,
      String(body.notes ?? ''), String(body.prepared_by ?? ''),
      req.user!.id, JSON.stringify(body.column_config ?? {})
    );
    const id = Number(info.lastInsertRowid);
    saveItems(id, items, inv.tax_type, inv.currency);
    return id;
  });
  syncAfter(inv.id);
  res.status(201).json(getFull(id));
});

creditNotesRouter.put('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  const existing = db.prepare('SELECT * FROM credit_notes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing || !canAccessCustomer(req, Number(existing.customer_id))) return res.status(404).json({ error: 'Credit note not found' });

  /*
   * Which invoice this credits is fixed once it is numbered.
   *
   * The number was drawn from that invoice's own export or domestic series and
   * is never reissued, so re-pointing the note would leave the two disagreeing
   * — `exportChangeError`'s rule, arrived at from the other side. It would also
   * orphan the balance: the first invoice would silently go back to owing the
   * money, and nothing on either document would say why.
   */
  const asked = body.invoice_id == null ? Number(existing.invoice_id) : Number(body.invoice_id);
  if (asked !== Number(existing.invoice_id)) {
    return res.status(409).json({
      error: 'A credit note is raised against one invoice and numbered from that invoice\'s series, '
        + 'so it cannot be moved to another. Delete it and raise a fresh one.',
    });
  }
  const inv = invoiceFor(Number(existing.invoice_id));
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });

  const kind = String(body.kind ?? existing.kind);
  const bad = kindError(kind);
  if (bad) return res.status(400).json({ error: bad });

  const items = Array.isArray(body.items) ? (body.items as LineItemInput[]) : null;
  if (items) {
    const totals = computeTotals(items, inv.tax_type, 0, 0, inv.currency);
    // `id` excluded from both ceilings: without it, re-saving an unchanged
    // credit note counts itself as already credited and refuses itself.
    const overLine = returnLimitError(inv.id, kind, items, id);
    if (overLine) return res.status(400).json({ error: overLine });
    const overAll = creditTotalError(inv.id, totals.grand_total, id);
    if (overAll) return res.status(400).json({ error: overAll });
  }

  transaction(() => {
    db.prepare(
      `UPDATE credit_notes SET number = ?, date = ?, kind = ?, reason = ?, notes = ?, prepared_by = ?,
              currency = ?, tax_type = ?, is_export = ?, customer_id = ?, company_id = ?, column_config = ?
       WHERE id = ?`
    ).run(
      String(body.number ?? existing.number),
      String(body.date ?? existing.date),
      kind,
      String(body.reason ?? existing.reason ?? ''),
      String(body.notes ?? existing.notes ?? ''),
      String(body.prepared_by ?? existing.prepared_by ?? ''),
      // Re-copied from the invoice on every save rather than kept: if the
      // invoice was corrected, the credit follows it.
      inv.currency, inv.tax_type, inv.is_export, inv.customer_id, inv.company_id,
      JSON.stringify(body.column_config ?? JSON.parse(String(existing.column_config || '{}'))),
      id
    );
    if (items) saveItems(id, items, inv.tax_type, inv.currency);
    // An edited credit note stops crediting anything until it is approved
    // again — which is the behaviour wanted rather than a side effect: what
    // reduces a balance is a figure somebody signed off, not one being typed.
    resetApprovalOnEdit('credit_notes', id);
  });
  syncAfter(inv.id);
  res.json(getFull(id));
});

creditNotesRouter.post('/:id/submit', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT customer_id, invoice_id FROM credit_notes WHERE id = ?').get(id) as
    { customer_id: number; invoice_id: number } | undefined;
  if (!existing || !canAccessCustomer(req, existing.customer_id)) return res.status(404).json({ error: 'Credit note not found' });
  // 422 rather than 409: nothing conflicts, the document is incomplete.
  const incomplete = incompleteError('credit_notes', id);
  if (incomplete) return res.status(422).json({ error: incomplete });
  submit('credit_notes', id, req.user!);
  // A manager submitting approves in the same action, and an approved credit
  // note is one that counts — so the balance and the order move here too.
  syncAfter(existing.invoice_id);
  res.json(getFull(id));
});

creditNotesRouter.post('/:id/approve', (req: AuthedRequest, res) => {
  if (!mayApprove(req.user)) return res.status(403).json({ error: 'Your team cannot approve documents' });
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT invoice_id FROM credit_notes WHERE id = ?').get(id) as { invoice_id: number } | undefined;
  if (!existing) return res.status(404).json({ error: 'Credit note not found' });
  // Only an approval is gated. Rejecting an unfinished one must always be
  // possible, or it is trapped in `pending` with no way out.
  const approving = req.body?.approve !== false;
  const unfinished = approving ? incompleteError('credit_notes', id) : null;
  if (unfinished) return res.status(422).json({ error: unfinished });
  decide('credit_notes', id, req.user!, approving, String(req.body?.note ?? ''));
  syncAfter(existing.invoice_id);
  res.json(getFull(id));
});

creditNotesRouter.delete('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT customer_id, invoice_id FROM credit_notes WHERE id = ?').get(id) as
    { customer_id: number; invoice_id: number } | undefined;
  if (!existing || !canAccessCustomer(req, existing.customer_id)) return res.status(404).json({ error: 'Credit note not found' });
  // Resolved before the delete, or there would be nothing left to sync from.
  const invoiceId = existing.invoice_id;
  transaction(() => {
    db.prepare('DELETE FROM credit_note_items WHERE credit_note_id = ?').run(id);
    db.prepare('DELETE FROM credit_notes WHERE id = ?').run(id);
  });
  syncAfter(invoiceId);
  res.json({ ok: true });
});
