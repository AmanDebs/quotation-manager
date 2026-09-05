import { Router } from 'express';
import { db } from '../db/connection.js';
import { requirePermission, type AuthedRequest } from '../middleware/auth.js';
import { listCompanies, getCompany, companyUsage } from '../services/companies.js';
import { defaultPatternsFor, PATTERN_COLUMNS } from '../services/companyPatterns.js';

export const companiesRouter = Router();

/**
 * Reads are open — every document form needs the list to show who is selling,
 * and the profile is on the paperwork anyway. Writes are manager-only: these
 * are the GSTIN, the bank details and the numbering patterns.
 */
const requireManager = requirePermission('settings', 'full');

const FIELDS = [
  'company_name', 'address', 'city', 'state', 'country', 'pincode', 'phone', 'email', 'website',
  'gstin', 'pan', 'iec', 'logo', 'signature', 'default_terms', 'arn_ref', 'theme_color',
  'quote_prefix', 'pi_prefix', 'inv_prefix', 'pl_prefix',
  // Every pattern column, work orders and purchase orders included — they were
  // missing here, so those two series could not be set on creation or edited
  // afterwards, and every company in the group issued WO/26-27/001.
  ...PATTERN_COLUMNS,
];
const JSON_FIELDS = ['bank_accounts', 'note_presets'];

companiesRouter.get('/', (req: AuthedRequest, res) => {
  res.json(listCompanies(req.query.all === '1'));
});

companiesRouter.get('/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM companies WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Company not found' });
  res.json(getCompany(Number(req.params.id)));
});

companiesRouter.post('/', requireManager, (req, res) => {
  const body = req.body ?? {};
  if (!String(body.company_name ?? '').trim()) return res.status(400).json({ error: 'Company name is required' });
  const cols = ['company_name'];
  const values: unknown[] = [String(body.company_name).trim()];
  for (const f of FIELDS.slice(1)) {
    if (f in body) { cols.push(f); values.push(String(body[f] ?? '')); }
  }
  for (const f of JSON_FIELDS) {
    if (f in body) { cols.push(f); values.push(JSON.stringify(body[f] ?? [])); }
  }
  /*
   * A second entity numbers its documents in its own name.
   *
   * The counters were always per company and always restarted at 001; what
   * this fills in is the pattern, which used to come from the `companies`
   * table's defaults — Aglo's own paperwork. Two entities then printed the
   * identical `AGLO/PI/26-27/001`, and nothing refused it, because uniqueness
   * is per company precisely so that both may hold a 001. Anything the caller
   * sent still wins; this only fills what was not asked for.
   *
   * Only ever reached by an *additional* company: company 1 is created by the
   * boot migration in db/connection.ts, never through this route.
   */
  for (const [col, pattern] of Object.entries(defaultPatternsFor(String(body.company_name)))) {
    if (!(col in body)) { cols.push(col); values.push(pattern); }
  }

  const info = db.prepare(
    `INSERT INTO companies (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...(values as never[]));
  res.status(201).json(getCompany(Number(info.lastInsertRowid)));
});

companiesRouter.put('/:id', requireManager, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM companies WHERE id = ?').get(id)) return res.status(404).json({ error: 'Company not found' });
  const body = req.body ?? {};
  const updates: string[] = [];
  const values: unknown[] = [];
  for (const f of FIELDS) {
    if (f in body) { updates.push(`${f} = ?`); values.push(String(body[f] ?? '')); }
  }
  for (const f of JSON_FIELDS) {
    if (f in body) { updates.push(`${f} = ?`); values.push(JSON.stringify(body[f] ?? [])); }
  }
  if ('active' in body) { updates.push('active = ?'); values.push(body.active ? 1 : 0); }
  if (updates.length) {
    db.prepare(`UPDATE companies SET ${updates.join(', ')} WHERE id = ?`).run(...(values as never[]), id);
  }
  // Exactly one default, always — set it here rather than letting a caller
  // clear the last one and leave new documents with nowhere to land.
  if (body.is_default) {
    db.prepare('UPDATE companies SET is_default = 0').run();
    db.prepare('UPDATE companies SET is_default = 1 WHERE id = ?').run(id);
  }
  res.json(getCompany(id));
});

companiesRouter.delete('/:id', requireManager, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT is_default FROM companies WHERE id = ?').get(id) as { is_default: number } | undefined;
  if (!row) return res.status(404).json({ error: 'Company not found' });
  if (row.is_default) return res.status(409).json({ error: 'That is the default company. Make another one the default first.' });

  const used = companyUsage(id);
  if (used.length) {
    const label: Record<string, string> = {
      quotations: 'quotation', orders: 'order', proforma_invoices: 'proforma invoice',
      commercial_invoices: 'invoice', packing_lists: 'packing list', customers: 'customer',
    };
    const parts = used.map((u) => `${u.count} ${label[u.table] ?? u.table}${u.count === 1 ? '' : 's'}`);
    return res.status(409).json({
      error: `This company has ${parts.join(', ')} against it. Deactivate it instead of deleting.`,
    });
  }
  db.prepare('DELETE FROM companies WHERE id = ?').run(id);
  res.json({ ok: true });
});
