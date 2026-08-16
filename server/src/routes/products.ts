import { Router } from 'express';
import { db, transaction } from '../db/connection.js';
import { requireManager } from '../middleware/auth.js';
import { IMPORT_FIELDS, buildImport, decodeUpload, identityKey, type BuildOptions } from '../services/productImport.js';
import { recipeFor } from '../services/recipe.js';

export const productsRouter = Router();

/**
 * The catalogue is shared, so changing an existing product changes everyone's
 * prices — that is a manager's call. Creating one is not: an employee who meets
 * a new product mid-quotation must not have to wait for someone. Reading is
 * open because every document form needs the picker.
 */

const fields = ['name', 'description', 'hsn_code', 'unit', 'unit_price', 'country_of_origin', 'image', 'color'];
/** Numeric packing fields — kept separate because blank must persist as NULL, not 0. */
const packingFields = ['pcs_per_pack', 'qty_20ft', 'qty_40ft'] as const;
const numOrNull = (v: unknown) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

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
productsRouter.post('/import/preview', requireManager, (req, res) => {
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
productsRouter.post('/import', requireManager, (req, res) => {
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
  const importCols = ['name', 'description', 'hsn_code', 'unit', 'unit_price', 'country_of_origin', 'color', ...packingFields] as const;
  const insert = db.prepare(
    `INSERT INTO products (${importCols.join(', ')}) VALUES (${importCols.map(() => '?').join(', ')})`
  );
  const update = db.prepare(
    `UPDATE products SET ${importCols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`
  );
  const values = (p: Record<string, unknown>) => importCols.map((c) => p[c] ?? (packingFields.includes(c as never) ? null : '')) as never[];

  const counts = transaction(() => {
    let created = 0;
    let updated = 0;
    for (const row of result.rows) {
      if (row.action === 'create') {
        insert.run(...values(row.product as unknown as Record<string, unknown>));
        created++;
      } else if (row.action === 'update' && row.existingId !== undefined) {
        update.run(...values(row.product as unknown as Record<string, unknown>), row.existingId);
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
productsRouter.get('/:id/materials', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM products WHERE id = ?').get(id)) {
    return res.status(404).json({ error: 'Product not found' });
  }
  res.json(recipeFor(id));
});

productsRouter.put('/:id/materials', requireManager, (req, res) => {
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
  const rows = q
    ? db.prepare('SELECT * FROM products WHERE name LIKE ? OR hsn_code LIKE ? ORDER BY name').all(`%${q}%`, `%${q}%`)
    : db.prepare('SELECT * FROM products ORDER BY name').all();
  res.json(rows);
});

productsRouter.post('/', (req, res) => {
  const body = req.body ?? {};
  if (!body.name) return res.status(400).json({ error: 'Product name is required' });
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
      ...(packingFields.map((f) => numOrNull(body[f])) as never[])
    );
  res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(Number(info.lastInsertRowid)));
});

productsRouter.put('/:id', requireManager, (req, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  if (!db.prepare('SELECT id FROM products WHERE id = ?').get(id)) return res.status(404).json({ error: 'Product not found' });
  if (!body.name) return res.status(400).json({ error: 'Product name is required' });
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
    ...(packingFields.map((f) => numOrNull(body[f])) as never[]),
    id
  );
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
});

productsRouter.delete('/:id', requireManager, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM products WHERE id = ?').get(id)) {
    return res.status(404).json({ error: 'Product not found' });
  }
  // Line items reference products, so a used product cannot simply vanish.
  const used = db.prepare(
    `SELECT (SELECT COUNT(*) FROM quotation_items WHERE product_id = ?) +
            (SELECT COUNT(*) FROM order_items WHERE product_id = ?) +
            (SELECT COUNT(*) FROM pi_items WHERE product_id = ?) +
            (SELECT COUNT(*) FROM invoice_items WHERE product_id = ?) AS c`
  ).get(id, id, id, id) as { c: number };
  if (used.c > 0) {
    return res.status(409).json({ error: 'This product is used on existing documents and cannot be deleted' });
  }
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  res.json({ ok: true });
});
