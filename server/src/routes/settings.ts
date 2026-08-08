import { Router } from 'express';
import { db } from '../db/connection.js';
import { defaultCompany, defaultCompanyId } from '../services/companies.js';

export const settingsRouter = Router();

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
