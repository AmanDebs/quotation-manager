import { Router } from 'express';
import { db } from '../db/connection.js';
import { requirePermission } from '../middleware/auth.js';

/**
 * The production masters: locations, suppliers, transporters, materials,
 * machines and moulds.
 *
 * Six lists that differ only in their columns and in what stops them being
 * deleted, so they are described rather than written out six times. The rule
 * they share is the products rule (`routes/products.ts`): **reads are open,
 * writes are manager-only**. Every document form and every shop-floor screen
 * needs the pickers, but changing the master list changes them for everybody.
 *
 * Unlike products, creating is *also* manager-only here. A new material or
 * machine is a decision about the factory, not something met mid-quotation.
 */

type Kind = 'text' | 'num' | 'int' | 'bool';

interface FieldSpec {
  name: string;
  kind: Kind;
  /** Reject the row when this field is blank. */
  required?: boolean;
  /**
   * The values the column's CHECK constraint allows. Repeated here so a bad one
   * is a 400 naming the choices, rather than the constraint firing and reaching
   * the user as "Internal server error" — the same reason the delete guards
   * name what is blocking them instead of leaving it to the foreign key.
   */
  oneOf?: readonly string[];
  /** Used when the field arrives blank, where the column will not accept ''. */
  fallback?: string;
}

interface Guard {
  /** Counts rows referencing this id; must take the id exactly once. */
  sql: string;
  message: string;
}

interface MasterConfig {
  path: string;
  table: string;
  /** Singular, capitalised — used verbatim in error messages. */
  label: string;
  fields: FieldSpec[];
  orderBy?: string;
  guards?: Guard[];
}

/** Mirrors the CHECK on `materials.category` in schema.sql. */
const MATERIAL_CATEGORIES = ['resin', 'masterbatch', 'packing', 'other'] as const;

/** Blank must persist as NULL, not 0 — an unrecorded cavity count is not zero. */
const numOrNull = (v: unknown) =>
  v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);

function read(spec: FieldSpec, body: Record<string, unknown>, existing?: Record<string, unknown>) {
  const raw = body[spec.name] ?? existing?.[spec.name];
  switch (spec.kind) {
    case 'num':
      return Number(raw ?? 0) || 0;
    case 'int':
      return numOrNull(raw);
    case 'bool':
      // Absent means "leave as it was", and a new row defaults to active.
      return raw === undefined || raw === null ? 1 : raw ? 1 : 0;
    default: {
      const text = String(raw ?? '');
      return text.trim() || spec.fallback || text;
    }
  }
}

function masterRouter(cfg: MasterConfig): Router {
  const router = Router();
  const cols = cfg.fields.map((f) => f.name);
  const one = (id: number) => db.prepare(`SELECT * FROM ${cfg.table} WHERE id = ?`).get(id) as
    Record<string, unknown> | undefined;

  const validate = (body: Record<string, unknown>, existing?: Record<string, unknown>) => {
    for (const f of cfg.fields) {
      const value = String(body[f.name] ?? existing?.[f.name] ?? '').trim();
      if (f.required && !value) {
        return `${f.name.replace(/_/g, ' ')} is required`;
      }
      // Blank is allowed through where the column permits it; the CHECK
      // constraints below all include '' or the column is nullable.
      if (f.oneOf && value && !f.oneOf.includes(value)) {
        return `${f.name.replace(/_/g, ' ')} must be one of: ${f.oneOf.join(', ')}`;
      }
    }
    return null;
  };

  // `?all=1` includes retired rows; the default list is what you can still pick.
  router.get('/', (req, res) => {
    const where = req.query.all === '1' ? '' : 'WHERE active = 1';
    res.json(db.prepare(`SELECT * FROM ${cfg.table} ${where} ORDER BY ${cfg.orderBy ?? 'name'}`).all());
  });

  router.get('/:id', (req, res) => {
    const row = one(Number(req.params.id));
    if (!row) return res.status(404).json({ error: `${cfg.label} not found` });
    res.json(row);
  });

  router.post('/', requirePermission('master', 'full'), (req, res) => {
    const body = req.body ?? {};
    const bad = validate(body);
    if (bad) return res.status(400).json({ error: bad });
    const info = db
      .prepare(`INSERT INTO ${cfg.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...(cfg.fields.map((f) => read(f, body)) as never[]));
    res.status(201).json(one(Number(info.lastInsertRowid)));
  });

  router.put('/:id', requirePermission('master', 'full'), (req, res) => {
    const id = Number(req.params.id);
    const existing = one(id);
    if (!existing) return res.status(404).json({ error: `${cfg.label} not found` });
    const body = req.body ?? {};
    const bad = validate(body, existing);
    if (bad) return res.status(400).json({ error: bad });
    db.prepare(`UPDATE ${cfg.table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...(cfg.fields.map((f) => read(f, body, existing)) as never[]), id);
    res.json(one(id));
  });

  /**
   * Deleting is for mistakes only. Anything referenced is 409 with the reason —
   * a missed foreign key reaches the user as "Internal server error", which is
   * the failure this codebase keeps having to fix. Retiring (`active = 0`) is
   * the normal way to take something out of use.
   */
  router.delete('/:id', requirePermission('master', 'full'), (req, res) => {
    const id = Number(req.params.id);
    if (!one(id)) return res.status(404).json({ error: `${cfg.label} not found` });
    for (const guard of cfg.guards ?? []) {
      const { c } = db.prepare(guard.sql).get(id) as { c: number };
      if (c > 0) return res.status(409).json({ error: guard.message });
    }
    db.prepare(`DELETE FROM ${cfg.table} WHERE id = ?`).run(id);
    res.json({ ok: true });
  });

  return router;
}

const activeFlag: FieldSpec = { name: 'active', kind: 'bool' };

export const MASTERS: MasterConfig[] = [
  {
    path: 'locations',
    table: 'locations',
    label: 'Location',
    fields: [
      { name: 'name', kind: 'text', required: true },
      { name: 'code', kind: 'text' },
      { name: 'address', kind: 'text' },
      { name: 'notes', kind: 'text' },
      activeFlag,
    ],
    guards: [
      { sql: 'SELECT COUNT(*) AS c FROM machines WHERE location_id = ?', message: 'Machines belong to this location — move or retire them first' },
      { sql: 'SELECT COUNT(*) AS c FROM work_orders WHERE location_id = ?', message: 'Work orders were run at this location — retire it instead of deleting' },
      { sql: 'SELECT COUNT(*) AS c FROM material_moves WHERE location_id = ?', message: 'Stock has moved at this location — retire it instead of deleting' },
      { sql: 'SELECT COUNT(*) AS c FROM purchase_orders WHERE location_id = ?', message: 'Purchase orders are delivered here — retire it instead of deleting' },
    ],
  },
  {
    path: 'suppliers',
    table: 'suppliers',
    label: 'Supplier',
    fields: [
      { name: 'name', kind: 'text', required: true },
      { name: 'contact_person', kind: 'text' },
      { name: 'phone', kind: 'text' },
      { name: 'email', kind: 'text' },
      { name: 'address', kind: 'text' },
      { name: 'gstin', kind: 'text' },
      { name: 'payment_terms', kind: 'text' },
      { name: 'notes', kind: 'text' },
      activeFlag,
    ],
    guards: [
      { sql: 'SELECT COUNT(*) AS c FROM purchase_orders WHERE supplier_id = ?', message: 'Purchase orders have been raised on this supplier — retire it instead of deleting' },
    ],
  },
  {
    path: 'transporters',
    table: 'transporters',
    label: 'Transporter',
    fields: [
      { name: 'name', kind: 'text', required: true },
      { name: 'phone', kind: 'text' },
      { name: 'notes', kind: 'text' },
      activeFlag,
    ],
    guards: [
      { sql: 'SELECT COUNT(*) AS c FROM despatches WHERE transporter_id = ?', message: 'This transporter has carried despatches — retire it instead of deleting' },
    ],
  },
  {
    path: 'materials',
    table: 'materials',
    label: 'Material',
    fields: [
      { name: 'name', kind: 'text', required: true },
      // The column carries a CHECK; blank is not one of the choices, so an
      // omitted category takes the same default the column declares.
      { name: 'category', kind: 'text', oneOf: MATERIAL_CATEGORIES, fallback: 'resin' },
      { name: 'unit', kind: 'text' },
      { name: 'hsn_code', kind: 'text' },
      { name: 'reorder_level', kind: 'num' },
      { name: 'notes', kind: 'text' },
      activeFlag,
    ],
    orderBy: 'category, name',
    guards: [
      { sql: 'SELECT COUNT(*) AS c FROM product_materials WHERE material_id = ?', message: 'This material is used in a product recipe and cannot be deleted' },
      { sql: 'SELECT COUNT(*) AS c FROM material_moves WHERE material_id = ?', message: 'This material has stock movements against it — retire it instead of deleting' },
      { sql: 'SELECT COUNT(*) AS c FROM po_items WHERE material_id = ?', message: 'This material appears on a purchase order and cannot be deleted' },
    ],
  },
  {
    path: 'machines',
    table: 'machines',
    label: 'Machine',
    fields: [
      { name: 'name', kind: 'text', required: true },
      { name: 'code', kind: 'text' },
      { name: 'location_id', kind: 'int' },
      { name: 'type', kind: 'text' },
      { name: 'notes', kind: 'text' },
      activeFlag,
    ],
    guards: [
      { sql: 'SELECT COUNT(*) AS c FROM work_orders WHERE machine_id = ?', message: 'Jobs have been run on this machine — retire it instead of deleting' },
    ],
  },
  {
    path: 'moulds',
    table: 'moulds',
    label: 'Mould',
    fields: [
      { name: 'name', kind: 'text', required: true },
      { name: 'code', kind: 'text' },
      { name: 'cavities', kind: 'int' },
      { name: 'notes', kind: 'text' },
      activeFlag,
    ],
    guards: [
      { sql: 'SELECT COUNT(*) AS c FROM work_orders WHERE mould_id = ?', message: 'Jobs have been run with this mould — retire it instead of deleting' },
    ],
  },
];

/** Mounts every master under its own path, e.g. /api/materials. */
export function mountMasters(mount: (path: string, router: Router) => void) {
  for (const cfg of MASTERS) mount(`/api/${cfg.path}`, masterRouter(cfg));
}
