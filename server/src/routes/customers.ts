import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { scopeClause, canAccessCustomer } from '../middleware/scope.js';
import { listBody } from '../services/pagination.js';
import { customerSummary } from '../services/customerSummary.js';
import { searchClause } from '../services/search.js';
import { CUSTOMER_IMPORT_FIELDS, buildCustomerImport, mappedColumns,
  type CustomerBuildOptions, type CustomerLookups } from '../services/customerImport.js';
import { decodeUpload } from '../services/productImport.js';

export const customersRouter = Router();

const fields = ['name', 'contact_person', 'email', 'phone', 'address', 'city', 'country', 'gstin', 'currency', 'consignee', 'notify_party', 'notify_party_2', 'notes'];

const listSql = `
  SELECT c.*, u.name AS owner_name
  FROM customers c LEFT JOIN users u ON u.id = c.owner_id`;

customersRouter.get('/', (req: AuthedRequest, res) => {
  const q = String(req.query.q ?? '').trim();
  const exportFilter = req.query.export;
  const where: string[] = [];
  const params: unknown[] = [];

  const scope = scopeClause(req, 'c.id');
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  // The same helper the document lists use. The hand-written clause was
  // already bracketed — which matters, since `scopeClause` shares this WHERE
  // and an unbracketed OR would have been a way straight past data scoping —
  // so what changes is that `%` and `_` are now escaped rather than treated as
  // LIKE's wildcards.
  const search = searchClause(['c.name', 'c.contact_person', 'c.country'], q);
  if (search.sql) { where.push(search.sql); params.push(...search.params); }
  if (exportFilter === '1' || exportFilter === '0') {
    where.push('c.is_export = ?');
    params.push(Number(exportFilter));
  }
  res.json(listBody(req.query, {
    sql: `${listSql}${where.length ? ' WHERE ' + where.join(' AND ') : ''}`,
    order: 'ORDER BY c.name, c.id',
    params,
  }));
});

/* ---------------------------------------------------------------- *
 * Importing the customer book from a spreadsheet.
 *
 * Declared **above `/:id`**, or Express reads "import" as a customer id.
 * `services/customerImport.ts` states what this refuses to do; the one rule
 * that lives here is that a row is written exactly the way `POST /` writes
 * one, including who owns it.
 * ---------------------------------------------------------------- */

customersRouter.get('/import/fields', (_req, res) => {
  res.json(CUSTOMER_IMPORT_FIELDS.map(({ key, label, required }) => ({ key, label, required: !!required })));
});

function importLookups(req: AuthedRequest): CustomerLookups {
  const scope = scopeClause(req, 'id');
  return {
    // Scoped like every other read: a Sales login matches against its own
    // book, which is also the only book it could have created a duplicate in.
    customers: db.prepare(
      `SELECT id, name FROM customers${scope.sql ? ` WHERE ${scope.sql}` : ''}`
    ).all(...(scope.params as never[])) as unknown as CustomerLookups['customers'],
  };
}

function readImport(req: AuthedRequest) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!body.file) throw new Error('No file was uploaded');
  const buf = decodeUpload(String(body.file));
  if (!buf.length) throw new Error('That file appears to be empty');
  return buildCustomerImport(buf, String(body.filename ?? ''), importLookups(req), {
    sheet: body.sheet ? String(body.sheet) : undefined,
    headerRow: body.header_row !== undefined && body.header_row !== null ? Number(body.header_row) : undefined,
    mapping: (body.mapping ?? undefined) as CustomerBuildOptions['mapping'],
    onDuplicate: body.on_duplicate === 'update' ? 'update' : 'skip',
    nearMatch: body.near_match === 'new' ? 'new' : 'same',
  });
}

/** Dry run: every row, what it would do, and why a skipped one is skipped. */
customersRouter.post('/import/preview', (req: AuthedRequest, res) => {
  try {
    res.json(readImport(req));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not read that file' });
  }
});

/** Apply it. The file is re-parsed, so the result is the preview, not a copy. */
customersRouter.post('/import', (req: AuthedRequest, res) => {
  let result;
  try {
    result = readImport(req);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Could not read that file' });
  }
  if (result.mapping.name === undefined || result.mapping.name < 0) {
    return res.status(400).json({ error: 'Choose which column holds the customer name before importing' });
  }
  if (result.summary.create + result.summary.update === 0) {
    return res.status(400).json({ error: 'Nothing to import — every row was skipped' });
  }

  /*
   * An update writes **only the columns the sheet carries**. A list of names
   * with nothing else on it must not blank the addresses, registrations and
   * bank details already on file — the rule `productImport` learned about the
   * photo, applied to every column rather than two, because a customer sheet
   * is partial far more often than a price list is.
   */
  const cols = mappedColumns(result.mapping);
  const insertCols = [...fields, 'is_export'] as const;
  const insert = db.prepare(
    `INSERT INTO customers (${insertCols.join(', ')}, owner_id) VALUES (${insertCols.map(() => '?').join(', ')}, ?)`
  );
  // `is_export` follows the country, so it is rewritten only where the sheet
  // states one; otherwise a name list would make every export buyer domestic.
  const updateCols = [...cols, ...(cols.includes('country') ? ['is_export' as const] : [])];
  const update = updateCols.length
    ? db.prepare(`UPDATE customers SET ${updateCols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
    : null;

  const counts = transaction(() => {
    let created = 0;
    let updated = 0;
    for (const row of result.rows) {
      const c = row.customer as unknown as Record<string, unknown>;
      if (row.action === 'create') {
        // Owned by whoever imported it, exactly as `POST /` hands a customer
        // to whoever created it — without which a Sales login would import a
        // book it cannot then see.
        insert.run(...(insertCols.map((f) => c[f] ?? '') as never[]), req.user!.id);
        created++;
      } else if (row.action === 'update' && row.existingId !== undefined && update) {
        update.run(...(updateCols.map((f) => c[f] ?? '') as never[]), row.existingId);
        updated++;
      }
    }
    return { created, updated };
  });

  res.json({ ...counts, skipped: result.summary.skip, sheet: result.sheet });
});

customersRouter.get('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!canAccessCustomer(req, id)) return res.status(404).json({ error: 'Customer not found' });
  const row = db.prepare(`${listSql} WHERE c.id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'Customer not found' });
  res.json(row);
});

/*
 * Everything about one customer on one screen.
 *
 * The sections it answers with are chosen by the caller's own permissions, in
 * `services/customerSummary.ts` — a Production login holds `customer: view`
 * and `quotation: none`, and must not read a price through a route mounted on
 * the customer function. Scoping is the same 404 every other detail route
 * gives, so an id cannot be probed for.
 */
customersRouter.get('/:id/summary', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!canAccessCustomer(req, id)) return res.status(404).json({ error: 'Customer not found' });
  const exists = db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'Customer not found' });
  res.json(customerSummary(req, id));
});

/** Blank means "the group default" — stored as NULL, resolved when a document is raised. */
const companyId = (v: unknown): number | null => (Number(v) > 0 ? Number(v) : null);

customersRouter.post('/', (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  if (!body.name) return res.status(400).json({ error: 'Customer name is required' });
  // Managers may assign an owner; employees always own what they create.
  const ownerId = req.user!.role === 'manager' && body.owner_id ? Number(body.owner_id) : req.user!.id;
  const companyId = ((v: unknown) => (Number(v) > 0 ? Number(v) : null))(body.company_id);
  const isExport = body.is_export !== undefined
    ? (body.is_export ? 1 : 0)
    : (String(body.country ?? '').trim().toLowerCase() !== 'india' && body.country ? 1 : 0);
  const info = db
    .prepare(`INSERT INTO customers (${fields.join(', ')}, owner_id, is_export, company_id) VALUES (${fields.map(() => '?').join(', ')}, ?, ?, ?)`)
    .run(
      ...(fields.map((f) => String(body[f] ?? (f === 'country' ? 'India' : f === 'currency' ? 'INR' : ''))) as never[]),
      ownerId,
      isExport,
      companyId
    );
  res.status(201).json(db.prepare(`${listSql} WHERE c.id = ?`).get(Number(info.lastInsertRowid)));
});

customersRouter.put('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  if (!canAccessCustomer(req, id)) return res.status(404).json({ error: 'Customer not found' });
  const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return res.status(404).json({ error: 'Customer not found' });
  if (!body.name) return res.status(400).json({ error: 'Customer name is required' });
  const ownerId = req.user!.role === 'manager' && body.owner_id ? Number(body.owner_id) : (existing.owner_id as number | null);
  db.prepare(
    `UPDATE customers SET ${fields.map((f) => `${f} = ?`).join(', ')}, owner_id = ?, is_export = ?, company_id = ? WHERE id = ?`
  ).run(
    ...(fields.map((f) => String(body[f] ?? '')) as never[]),
    ownerId,
    body.is_export !== undefined ? (body.is_export ? 1 : 0) : Number(existing.is_export ?? 0),
    'company_id' in body ? companyId(body.company_id) : (existing.company_id as number | null),
    id
  );
  res.json(db.prepare(`${listSql} WHERE c.id = ?`).get(id));
});

customersRouter.delete('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!canAccessCustomer(req, id)) return res.status(404).json({ error: 'Customer not found' });
  // Anything referencing the customer blocks the delete — including follow-ups,
  // payments and orders, which are foreign keys too and would otherwise fail
  // inside SQLite and reach the user as "Internal server error".
  const used = db.prepare(
    `SELECT (SELECT COUNT(*) FROM quotations WHERE customer_id = ?) +
            (SELECT COUNT(*) FROM orders WHERE customer_id = ?) +
            (SELECT COUNT(*) FROM proforma_invoices WHERE customer_id = ?) +
            (SELECT COUNT(*) FROM commercial_invoices WHERE customer_id = ?) +
            (SELECT COUNT(*) FROM packing_lists WHERE customer_id = ?) +
            (SELECT COUNT(*) FROM credit_notes WHERE customer_id = ?) AS c`
  ).get(id, id, id, id, id, id) as { c: number };
  if (used.c > 0) return res.status(409).json({ error: 'Customer has documents and cannot be deleted' });
  const linked = db.prepare(
    `SELECT (SELECT COUNT(*) FROM followups WHERE customer_id = ?) +
            (SELECT COUNT(*) FROM payments WHERE customer_id = ?) +
            (SELECT COUNT(*) FROM enquiries WHERE customer_id = ?) AS c`
  ).get(id, id, id) as { c: number };
  if (linked.c > 0) return res.status(409).json({ error: 'Customer has follow-ups or payments recorded and cannot be deleted' });
  db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  res.json({ ok: true });
});
