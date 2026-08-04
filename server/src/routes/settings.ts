import { Router } from 'express';
import { db } from '../db/connection.js';

export const settingsRouter = Router();

// Readable by everyone (documents need the company profile); writes are manager-only.
settingsRouter.get('/', (_req, res) => {
  const row = db.prepare('SELECT * FROM settings WHERE id = 1').get() as Record<string, unknown>;
  res.json({
    ...row,
    bank_accounts: JSON.parse(String(row.bank_accounts || '[]')),
    note_presets: JSON.parse(String(row.note_presets || '[]')),
  });
});

const fields = [
  'company_name', 'address', 'city', 'state', 'country', 'pincode', 'phone', 'email', 'website',
  'gstin', 'pan', 'iec', 'logo', 'signature', 'default_terms',
  'quote_prefix', 'pi_prefix', 'inv_prefix', 'pl_prefix',
  'arn_ref', 'theme_color',
  'quote_pattern', 'pi_pattern', 'pi_export_pattern', 'inv_pattern', 'inv_export_pattern', 'pl_pattern',
  'order_pattern', 'order_export_pattern',
];

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
    db.prepare(`UPDATE settings SET ${updates.join(', ')} WHERE id = 1`).run(...(values as never[]));
  }
  const row = db.prepare('SELECT * FROM settings WHERE id = 1').get() as Record<string, unknown>;
  res.json({
    ...row,
    bank_accounts: JSON.parse(String(row.bank_accounts || '[]')),
    note_presets: JSON.parse(String(row.note_presets || '[]')),
  });
});
