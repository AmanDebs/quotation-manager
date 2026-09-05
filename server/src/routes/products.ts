import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { requirePermission } from '../middleware/auth.js';
import { paramsFor, specOwner } from '../services/qc.js';
import { IMPORT_FIELDS, buildImport, decodeUpload, identityKey, type BuildOptions } from '../services/productImport.js';
import { recipeFor } from '../services/recipe.js';
import { PRODUCT_TYPES, isProductType, guessProductType } from '../services/productType.js';
import { listBody } from '../services/pagination.js';
import { searchClause } from '../services/search.js';

export const productsRouter = Router();

/**
 * The catalogue is shared, so changing an existing product changes everyone's
 * prices — that is a manager's call. Creating one is not: an employee who meets
 * a new product mid-quotation must not have to wait for someone. Reading is
 * open because every document form needs the picker.
 */

const fields = ['name', 'description', 'hsn_code', 'unit', 'unit_price', 'country_of_origin', 'image', 'color', 'product_type'];
/**
 * Numeric fields — kept separate because blank must persist as NULL, not 0.
 * `weight_grams` belongs here for that reason and for one more: the import's
 * `values()` below picks a row's blank fallback purely by membership in this
 * list, so a numeric column left out of it would be written as `''`.
 */
const packingFields = ['pcs_per_pack', 'qty_20ft', 'qty_40ft', 'weight_grams'] as const;
const numOrNull = (v: unknown) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

/**
 * The column carries no CHECK — SQLite cannot ALTER one and this vocabulary
 * expects to grow — so the enum is enforced here, in the shape `masters.ts`
 * uses: a sentence naming what is accepted, rather than a constraint failure
 * arriving as a 500.
 */
function typeError(body: Record<string, unknown>): string | null {
  const t = body.product_type;
  if (t === undefined || t === null || t === '') return null;
  return isProductType(t) ? null : `Product type must be one of: ${PRODUCT_TYPES.join(', ')}`;
}

/** Existing catalogue keyed by product identity — how an import spots duplicates. */
function existingByIdentity(): Map<string, number> {
  const rows = db.prepare('SELECT id, name, color, pcs_per_pack FROM products').all() as
    { id: number; name: string; color: string; pcs_per_pack: number | null }[];
  return new Map(rows.map((r) => [identityKey(r), r.id]));
}

function readOptions(body: Record<string, unknown>): BuildOptions {
  return {
    sheet: body.sheet ? String(body.sheet) : undefined,
    headerRow: body.header_row !== undefined && body.header_row !== null ? Number(body.header_row) : undefined,
    mapping: (body.mapping ?? undefined) as BuildOptions['mapping'],
    onDuplicate: body.on_duplicate === 'skip' ? 'skip' : 'update',
  };
}

/** The fields an import can fill, so the client can render the mapping UI. */
productsRouter.get('/import/fields', (_req, res) => {
  res.json(IMPORT_FIELDS.map(({ key, label, required }) => ({ key, label, required: !!required })));
});

/**
 * Dry run: parse the uploaded sheet and report exactly what would happen to
 * every row. Writes nothing — the client shows this for confirmation and then
 * posts the same file and options to /import.
 */
productsRouter.post('/import/preview', requirePermission('product', 'full'), (req, res) => {
  const body = req.body ?? {};
  if (!body.file) return res.status(400).json({ error: 'No file was uploaded' });
  try {
    const buf = decodeUpload(String(body.file));
    if (!buf.length) return res.status(400).json({ error: 'That file appears to be empty' });
    res.json(buildImport(buf, String(body.filename ?? ''), existingByIdentity(), readOptions(body)));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not read that file' });
  }
});

/** Apply the import. Re-parses the file so the result matches the preview exactly. */
productsRouter.post('/import', requirePermission('product', 'full'), (req, res) => {
  const body = req.body ?? {};
  if (!body.file) return res.status(400).json({ error: 'No file was uploaded' });

  let result;
  try {
    const buf = decodeUpload(String(body.file));
    result = buildImport(buf, String(body.filename ?? ''), existingByIdentity(), readOptions(body));
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Could not read that file' });
  }
  if (result.mapping.name === undefined || result.mapping.name < 0) {
    return res.status(400).json({ error: 'Choose which column holds the product name before importing' });
  }
  if (result.summary.create + result.summary.update === 0) {
    return res.status(400).json({ error: 'Nothing to import — every row was skipped' });
  }

  // Columns an import writes: everything except the photo, which a spreadsheet
  // never carries and an update must therefore leave alone.
  const importCols = ['name', 'description', 'hsn_code', 'unit', 'unit_price', 'country_of_origin', 'color', 'product_type', ...packingFields] as const;
  /*
   * The same reasoning as the photo, one step further. A row being *updated*
   * keeps its type and its weight when the sheet has no such column: those two
   * are filled in by hand or by the boot pass, and a price list — which is what
   * most of these sheets are — would otherwise blank every one of them on the
   * next import. Every other column stays unconditional, as it always was: the
   * sheet is the catalogue's own record of them.
   */
  const mapped = (c: string) => {
    const idx = result.mapping[c as keyof typeof result.mapping];
    return idx !== undefined && idx >= 0;
  };
  const updateCols = importCols.filter((c) =>
    (c !== 'product_type' && c !== 'weight_grams') || mapped(c));
  const insert = db.prepare(
    `INSERT INTO products (${importCols.join(', ')}) VALUES (${importCols.map(() => '?').join(', ')})`
  );
  const update = db.prepare(
    `UPDATE products SET ${updateCols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`
  );
  // A numeric column's blank must persist as NULL: '' is stored as TEXT, is not
  // NULL, and sorts above every number, so `weight_grams > 0` would be true of
  // a product that has no weight at all.
  const valuesFor = (cols: readonly string[]) => (p: Record<string, unknown>) =>
    cols.map((c) => p[c] ?? (packingFields.includes(c as never) ? null : '')) as never[];
  const values = valuesFor(importCols);
  const updateValues = valuesFor(updateCols);

  const counts = transaction(() => {
    let created = 0;
    let updated = 0;
    for (const row of result.rows) {
      if (row.action === 'create') {
        insert.run(...values(row.product as unknown as Record<string, unknown>));
        created++;
      } else if (row.action === 'update' && row.existingId !== undefined) {
        update.run(...updateValues(row.product as unknown as Record<string, unknown>), row.existingId);
        updated++;
      }
    }
    return { created, updated };
  });

  res.json({ ...counts, skipped: result.summary.skip, sheet: result.sheet });
});

/**
 * The recipe for one product — what it consumes per 1000 pieces.
 *
 * Read openly (the production screens need it), rewritten manager-only and
 * whole: a recipe is a short list, so delete-and-reinsert inside a transaction
 * is simpler and safer than diffing, and it is how every item list in this
 * codebase is saved.
 */
/**
 * The QC specification for one product: what to measure, and what passes.
 *
 * Read openly and rewritten manager-only and whole, exactly like the recipe
 * above it — a spec is a short list, so delete-and-reinsert in a transaction
 * beats diffing. Editing it does **not** disturb checks already recorded:
 * those carry their own copy of the tolerance they were judged against.
 */
/**
 * The specification for a product, optionally as one customer sees it.
 *
 * `?customer_id=` returns that customer's own list if they have one and the
 * product's default if they do not — and says which, because "these are the
 * tolerances" and "these are *your* tolerances" are different sentences.
 */
productsRouter.get('/:id/qc-params', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM products WHERE id = ?').get(id)) {
    return res.status(404).json({ error: 'Product not found' });
  }
  const customerId = numOrNull(req.query.customer_id);
  res.json({
    items: paramsFor(id, customerId),
    owner: specOwner(id, customerId),
    customer_id: customerId,
  });
});

productsRouter.put('/:id/qc-params', requirePermission('qc', 'full'), (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM products WHERE id = ?').get(id)) {
    return res.status(404).json({ error: 'Product not found' });
  }
  const rows = Array.isArray(req.body?.items) ? (req.body.items as Record<string, unknown>[]) : [];
  // A row with no name is an empty line in the editor, not an error.
  const lines = rows.filter((r) => String(r.name ?? '').trim());
  for (const line of lines) {
    const kind = String(line.kind ?? 'numeric');
    if (kind !== 'numeric' && kind !== 'boolean') {
      return res.status(400).json({ error: 'A check is either a measurement or a pass/fail' });
    }
    const min = numOrNull(line.min_value);
    const max = numOrNull(line.max_value);
    // Caught here rather than left to produce a spec nothing can ever satisfy.
    if (kind === 'numeric' && min !== null && max !== null && min > max) {
      return res.status(400).json({ error: `${String(line.name)}: the minimum is above the maximum` });
    }
  }

  /*
   * Written into whichever list was named, so saving a customer's spec never
   * disturbs the default and vice versa. Sending an empty list for a customer
   * therefore *removes* their override and puts them back on the default —
   * which is the only way to undo one, and the reason the DELETE is scoped the
   * same way as the INSERT.
   */
  const customerId = numOrNull(req.body?.customer_id);
  if (customerId && !db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)) {
    return res.status(400).json({ error: 'That customer no longer exists' });
  }
  transaction(() => {
    db.prepare(
      customerId
        ? 'DELETE FROM product_qc_params WHERE product_id = ? AND customer_id = ?'
        : 'DELETE FROM product_qc_params WHERE product_id = ? AND customer_id IS NULL'
    ).run(...(customerId ? [id, customerId] : [id]) as never[]);
    const ins = db.prepare(
      `INSERT INTO product_qc_params (product_id, customer_id, name, kind, unit, min_value, max_value, notes, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    lines.forEach((r, i) => {
      const kind = String(r.kind ?? 'numeric');
      ins.run(
        id, customerId, String(r.name).trim(), kind, String(r.unit ?? ''),
        // A pass/fail check has no tolerance to hold.
        kind === 'boolean' ? null : numOrNull(r.min_value),
        kind === 'boolean' ? null : numOrNull(r.max_value),
        String(r.notes ?? ''), i
      );
    });
  });
  res.json({ items: paramsFor(id, customerId), owner: specOwner(id, customerId), customer_id: customerId });
});

productsRouter.get('/:id/materials', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM products WHERE id = ?').get(id)) {
    return res.status(404).json({ error: 'Product not found' });
  }
  res.json(recipeFor(id));
});

productsRouter.put('/:id/materials', requirePermission('product', 'full'), (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM products WHERE id = ?').get(id)) {
    return res.status(404).json({ error: 'Product not found' });
  }
  const rows = Array.isArray(req.body?.items) ? (req.body.items as Record<string, unknown>[]) : [];
  // A line naming no material is an empty row in the editor, not an error.
  const lines = rows.filter((r) => Number(r.material_id) > 0);
  const known = new Set(
    (db.prepare('SELECT id FROM materials').all() as { id: number }[]).map((m) => m.id)
  );
  const unknown = lines.find((r) => !known.has(Number(r.material_id)));
  if (unknown) return res.status(400).json({ error: 'That material no longer exists' });

  transaction(() => {
    db.prepare('DELETE FROM product_materials WHERE product_id = ?').run(id);
    const ins = db.prepare(
      `INSERT INTO product_materials (product_id, material_id, qty_per_1000, wastage_pct, sort_order)
       VALUES (?, ?, ?, ?, ?)`
    );
    lines.forEach((r, i) =>
      ins.run(id, Number(r.material_id), Number(r.qty_per_1000) || 0, Number(r.wastage_pct) || 0, i));
  });
  res.json(recipeFor(id));
});

productsRouter.get('/', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const type = String(req.query.type ?? '').trim();
  const missing = String(req.query.missing ?? '').trim();

  const where: string[] = [];
  const params: unknown[] = [];
  // Through `searchClause` like the document lists. The bracketing this used
  // to spell out by hand was already right; what it did not do was escape `%`
  // and `_`, which are LIKE's own wildcards — typing either matched every
  // product instead of the character. A catalogue name carrying an underscore
  // is exactly the case, so this one is a real fix rather than tidying.
  const search = searchClause(['name', 'hsn_code'], q);
  if (search.sql) { where.push(search.sql); params.push(...search.params); }
  if (isProductType(type)) {
    where.push('product_type = ?');
    params.push(type);
  }
  if (missing === 'weight') where.push('weight_grams IS NULL');
  const sql = `SELECT * FROM products${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;

  const body = listBody(req.query, { sql, order: 'ORDER BY name, id', params });
  /*
   * How many of these have no weight recorded — the answer to "weight is
   * mandatory" that does not refuse anybody's save. Measured over the whole
   * filtered set rather than the page, because a page total wearing the words
   * of a list total is worse than no total (routes/despatches.ts makes the same
   * call in the same shape). An unpaged request keeps returning a bare array:
   * /api/products with no page is the line-item picker, and a picker handed an
   * object instead of a list would show nothing.
   */
  if (Array.isArray(body)) return res.json(body);
  const gaps = db.prepare(
    `SELECT COUNT(*) AS c FROM (${sql}) WHERE weight_grams IS NULL`
  ).get(...(params as never[])) as { c: number };
  res.json({ ...body, summary: { missing_weight: Number(gaps.c) } });
});

productsRouter.post('/', (req, res) => {
  const body = req.body ?? {};
  if (!body.name) return res.status(400).json({ error: 'Product name is required' });
  const badType = typeError(body);
  if (badType) return res.status(400).json({ error: badType });
  const info = db
    .prepare(
      `INSERT INTO products (${fields.join(', ')}, ${packingFields.join(', ')})
       VALUES (${[...fields, ...packingFields].map(() => '?').join(', ')})`
    )
    .run(
      String(body.name),
      String(body.description ?? ''),
      String(body.hsn_code ?? ''),
      String(body.unit ?? 'unit'),
      Number(body.unit_price ?? 0),
      String(body.country_of_origin ?? 'India'),
      String(body.image ?? ''),
      String(body.color ?? ''),
      // Weight is deliberately not required: the catalogue on file has ninety
      // rows without one, and refusing to save would make every edit wait on a
      // figure nobody has to hand. The list reports the gap instead.
      //
      // A type that was *not sent* is read off the name — the form always sends
      // one, so a person's choice always wins, and it is only silence that gets
      // guessed. Same helper as the boot pass and the import.
      String(body.product_type || guessProductType(String(body.name))),
      ...(packingFields.map((f) => numOrNull(body[f])) as never[])
    );
  res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(Number(info.lastInsertRowid)));
});

productsRouter.put('/:id', requirePermission('product', 'full'), (req, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  if (!db.prepare('SELECT id FROM products WHERE id = ?').get(id)) return res.status(404).json({ error: 'Product not found' });
  if (!body.name) return res.status(400).json({ error: 'Product name is required' });
  const badType = typeError(body);
  if (badType) return res.status(400).json({ error: badType });
  db.prepare(
    `UPDATE products SET ${[...fields, ...packingFields].map((f) => `${f} = ?`).join(', ')} WHERE id = ?`
  ).run(
    String(body.name),
    String(body.description ?? ''),
    String(body.hsn_code ?? ''),
    String(body.unit ?? 'unit'),
    Number(body.unit_price ?? 0),
    String(body.country_of_origin ?? 'India'),
    String(body.image ?? ''),
    String(body.color ?? ''),
    String(body.product_type || guessProductType(String(body.name))),
    ...(packingFields.map((f) => numOrNull(body[f])) as never[]),
    id
  );
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
});

productsRouter.delete('/:id', requirePermission('product', 'full'), (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM products WHERE id = ?').get(id)) {
    return res.status(404).json({ error: 'Product not found' });
  }
  // Line items reference products, so a used product cannot simply vanish.
  const used = db.prepare(
    `SELECT (SELECT COUNT(*) FROM quotation_items WHERE product_id = ?) +
            (SELECT COUNT(*) FROM order_items WHERE product_id = ?) +
            (SELECT COUNT(*) FROM pi_items WHERE product_id = ?) +
            (SELECT COUNT(*) FROM invoice_items WHERE product_id = ?) +
            -- A purchase order line can name a product too, since Aglo buys
            -- finished and semi-finished goods in as well as resin. Without
            -- this the delete orphans the line and reaches the user as a 500.
            (SELECT COUNT(*) FROM po_items WHERE product_id = ?) AS c`
  ).get(id, id, id, id, id) as { c: number };
  if (used.c > 0) {
    return res.status(409).json({ error: 'This product is used on existing documents and cannot be deleted' });
  }
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  res.json({ ok: true });
});
