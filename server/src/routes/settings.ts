import { Router } from 'express';
import { db } from '../db/connection.js';
import { defaultCompany, defaultCompanyId } from '../services/companies.js';
import { listSeries, setNextNumber } from '../services/numbering.js';
import { requirePermission } from '../middleware/auth.js';
import { record } from '../services/audit.js';
import { mailConfigured, sendMail, appLink } from '../services/mail.js';
import type { AuthedRequest } from '../middleware/auth.js';

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
// `settings: full` rather than `requireManager`: the PUT beside this is gated
// by the mount on exactly that, and a System Administrator able to set a
// counter but not read it is incoherent. Still refused to every other role.
settingsRouter.get('/sequences', requirePermission('settings', 'full'), (req, res) => {
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
    const before = listSeries(companyId).find((sq) => sq.key === key)?.next_number ?? null;
    const result = setNextNumber(companyId, key, Number(body.next_number), { force: body.force === true });
    // Recorded here rather than by the audit middleware, which works from a
    // row's id and `sequences` is keyed on (company, series) instead. Moving a
    // counter is worth a line in the log: it decides what the next customer
    // sees on their invoice.
    record({
      user: (req as AuthedRequest).user, entity: 'companies', entity_id: companyId,
      action: 'sequence', label: key,
      changes: [{ field: 'next_number', from: before, to: Number(body.next_number) }],
      note: body.force === true ? 'moved backwards (forced)' : '',
    });
    res.json(result);
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
/**
 * Whether email notifications are switched on, and a way to prove it.
 *
 * The approval notification is the one piece of this app whose failure mode is
 * **silence** — a wrong key, an unverified sending domain or a typo'd
 * `MAIL_FROM` all look exactly like a queue nobody has fed, which is the
 * complaint this was built from (*"Approval – no notification is coming"*). So
 * there is a button that sends one message to the person pressing it, and
 * prints the provider's own refusal where it fails.
 *
 * The key itself is **never read back** — it lives in the service's
 * environment rather than in `settings` precisely because a secret in that
 * table is in every backup download. The page is told only whether one is set.
 *
 * Declared above `/` so neither swallows the other, and guarded explicitly:
 * the mount in `index.ts` lets any GET on `/api/settings` through.
 */
settingsRouter.get('/email', requirePermission('settings', 'full'), (_req, res) => {
  res.json({
    configured: mailConfigured(),
    from: String(process.env.MAIL_FROM ?? ''),
    // Without this an email can describe a document and not link to it.
    app_url: appLink('/'),
  });
});

/**
 * Send one to yourself. `settings: full` through the mount, like the PUT.
 *
 * To the caller's own address and nowhere else: a test that took a recipient
 * would be a way to send mail in the company's name to anybody at all.
 */
settingsRouter.post('/email/test', async (req: AuthedRequest, res) => {
  const to = String(req.user?.email ?? '').trim();
  if (!to) return res.status(400).json({ error: 'Your account has no email address.' });
  const out = await sendMail(
    [to],
    'Test email from the Quotation Manager',
    [
      'This is the test message from Settings.',
      '',
      'If you are reading it, approval notifications will reach this address.',
    ].join('\n'),
  );
  res.json({ ...out, to });
});

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
