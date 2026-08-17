import { Router } from 'express';
import { db } from '../db/connection.js';
import { defaultCompany, defaultCompanyId } from '../services/companies.js';
import { listSeries, setNextNumber } from '../services/numbering.js';
import { requireManager } from '../middleware/auth.js';

export const settingsRouter = Router();

/**
 * Where each numbering series has got to, and what the next document will be
 * called. Declared above `/` so neither swallows the other.
 *
 * `?company=` narrows to one entity; each counts its own series, so the default
 * company is the only sensible fallback.
 *
 * Guarded explicitly rather than riding the mount in index.ts, which lets any
 * GET on /api/settings through: how many invoices the group has raised is
 * administrative, and an employee who can see two customers should not learn
 * the whole book's volume from it.
 */
settingsRouter.get('/sequences', requireManager, (req, res) => {
  const companyId = Number(req.query.company) > 0 ? Number(req.query.company) : defaultCompanyId();
  if (!db.prepare('SELECT id FROM companies WHERE id = ?').get(companyId)) {
    return res.status(404).json({ error: 'Company not found' });
  }
  res.json({ company_id: companyId, series: listSeries(companyId) });
});

/**
 * Set the number the next document in a series will take — the way to carry a
 * book that already runs to AP/0262 into the app without re-issuing numbers.
 *
 * Manager-only by the mount in index.ts, which sends every non-GET here through
 * `requireManager`.
 */
settingsRouter.put('/sequences', (req, res) => {
  const body = req.body ?? {};
  const companyId = Number(body.company_id) > 0 ? Number(body.company_id) : defaultCompanyId();
  if (!db.prepare('SELECT id FROM companies WHERE id = ?').get(companyId)) {
    return res.status(404).json({ error: 'Company not found' });
  }
  const key = String(body.key ?? '');
  if (!listSeries(companyId).some((s) => s.key === key)) {
    return res.status(400).json({ error: 'Unknown numbering series' });
  }
  try {
    res.json(setNextNumber(companyId, key, Number(body.next_number), { force: body.force === true }));
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    if (status === 500) throw err;
    res.status(status).json({ error: (err as Error).message });
  }
});

/**
 * The company profile moved to `companies` when the group gained a second
 * entity. This route stays as the view of the *default* company, so the parts
 * of the app that only ever mean "us" — note presets, the theme, a new
 * document's starting point — did not all have to change at once. Anything
 * that needs a specific company uses /api/companies.
 */
settingsRouter.get('/', (_req, res) => {
  res.json(defaultCompany());
});

const fields = [
  'company_name', 'address', 'city', 'state', 'country', 'pincode', 'phone', 'email', 'website',
  'gstin', 'pan', 'iec', 'logo', 'signature', 'default_terms',
  'quote_prefix', 'pi_prefix', 'inv_prefix', 'pl_prefix',
  'arn_ref', 'theme_color',
  'quote_pattern', 'pi_pattern', 'pi_export_pattern', 'inv_pattern', 'inv_export_pattern', 'pl_pattern',
  'order_pattern', 'order_export_pattern',
];

/** Edits the default company, for the same backwards-compatible reason. */
settingsRouter.put('/', (req, res) => {
  const body = req.body ?? {};
  const updates: string[] = [];
  const values: unknown[] = [];
  for (const f of fields) {
    if (f in body) {
      updates.push(`${f} = ?`);
      values.push(String(body[f] ?? ''));
    }
  }
  for (const jsonField of ['bank_accounts', 'note_presets']) {
    if (jsonField in body) {
      updates.push(`${jsonField} = ?`);
      values.push(JSON.stringify(body[jsonField] ?? []));
    }
  }
  if (updates.length) {
    db.prepare(`UPDATE companies SET ${updates.join(', ')} WHERE id = ?`).run(
      ...(values as never[]), defaultCompanyId()
    );
  }
  res.json(defaultCompany());
});
