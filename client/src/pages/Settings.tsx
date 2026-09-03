import { useEffect, useState, type ChangeEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Company, BankAccount, NotePreset } from '../types';
import { Button, Input, Textarea, Field, Card, PageHeader, ErrorText } from '../components/ui';
import { shrinkImage } from '../lib/image';

/**
 * The logo and signature print on every document, so they go through the same
 * canvas re-encode as line-item photos: the browser must decode the file to
 * draw it, which means a corrupt or mislabelled image is caught here instead
 * of reaching the PDF printer. PNG at 600px keeps edges and transparency
 * crisp — these are artwork, not photographs.
 */
function ImageUpload({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [busy, setBusy] = useState(false);

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      alert('Please use an image under 5 MB');
      return;
    }
    setBusy(true);
    try {
      onChange(await shrinkImage(file, 600, 0.92, 'image/png'));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not use that image');
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };

  return (
    <Field label={label}>
      <div className="flex items-center gap-3">
        {value ? (
          <img src={value} alt={label} className="h-14 max-w-32 rounded border border-slate-200 object-contain p-1" />
        ) : (
          <div className="flex h-14 w-24 items-center justify-center rounded border border-dashed border-slate-300 text-xs text-slate-400">
            {busy ? '…' : 'None'}
          </div>
        )}
        <input type="file" accept="image/*" onChange={handleFile} disabled={busy} className="text-xs" />
        {value && <Button type="button" variant="danger" onClick={() => onChange('')}>Remove</Button>}
      </div>
    </Field>
  );
}

/**
 * The server snapshots the database daily, but a backup nobody can reach is not
 * a backup — this puts a copy in the manager's hands on demand.
 */
function BackupCard() {
  const { data } = useQuery({
    queryKey: ['backups'],
    queryFn: () => api.get<{ snapshots: { name: string; size: number; modified: string }[] }>('/api/backup'),
  });
  const latest = data?.snapshots?.[0];
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

  return (
    <Card
      title="Backup"
      actions={
        // A plain link, not fetch(): the browser handles the file download.
        <a
          href="/api/backup/download"
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          ⬇ Download backup now
        </a>
      }
    >
      <p className="text-sm text-slate-500">
        A snapshot of the whole database — every customer, document and payment — as a single file you can keep
        somewhere safe. The server also takes one automatically each day and keeps the last 14.
      </p>
      {latest ? (
        <p className="mt-2 text-xs text-slate-400">
          Most recent automatic snapshot: <span className="font-medium text-slate-600">{latest.name}</span> ·{' '}
          {mb(latest.size)} · {new Date(latest.modified).toLocaleString()}
          {data && data.snapshots.length > 1 && ` · ${data.snapshots.length} kept`}
        </p>
      ) : (
        <p className="mt-2 text-xs text-slate-400">No automatic snapshot yet — one is taken when the server starts.</p>
      )}
    </Card>
  );
}

interface SeriesState {
  doc_type: string;
  is_export: boolean;
  key: string;
  fy: string;
  pattern: string;
  next_number: number;
  preview: string;
}

const SERIES_LABEL: Record<string, string> = {
  quotation: 'Quotation',
  order: 'Order',
  proforma: 'Proforma Invoice',
  invoice: 'Commercial Invoice',
  packing_list: 'Packing List',
  work_order: 'Work Order',
  purchase_order: 'Purchase Order',
};

/**
 * Where each series has got to, and a way to move it on.
 *
 * The reason this exists: a book that already runs to AP/0262 elsewhere has to
 * carry into the app without re-issuing numbers a customer already holds. The
 * server refuses to move a series backwards unless told twice, so the confirm
 * below is the second telling rather than decoration.
 */
function SequenceCard({ companyId }: { companyId: number }) {
  const queryClient = useQueryClient();
  const [edits, setEdits] = useState<Record<string, string>>({});

  const { data } = useQuery({
    queryKey: ['sequences', companyId],
    queryFn: () => api.get<{ series: SeriesState[] }>(`/api/settings/sequences?company=${companyId}`),
  });

  const save = useMutation({
    mutationFn: (body: { key: string; next_number: number; force?: boolean }) =>
      api.put('/api/settings/sequences', { ...body, company_id: companyId }),
    onSuccess: (_r, body) => {
      setEdits((e) => { const { [body.key]: _drop, ...rest } = e; return rest; });
      queryClient.invalidateQueries({ queryKey: ['sequences', companyId] });
    },
  });

  const apply = (s: SeriesState) => {
    const next = Number(edits[s.key]);
    if (!Number.isInteger(next) || next < 1) return;
    save.reset();
    if (next < s.next_number) {
      const ok = confirm(
        `${SERIES_LABEL[s.doc_type] ?? s.doc_type} is already at ${s.next_number}.\n\n` +
        `Going back to ${next} will re-issue numbers that have been used, and the next document will be refused ` +
        `if that number already exists.\n\nSet it anyway?`
      );
      if (!ok) return;
      save.mutate({ key: s.key, next_number: next, force: true });
      return;
    }
    save.mutate({ key: s.key, next_number: next });
  };

  return (
    <Card title="Next Document Number">
      <p className="mb-3 text-sm text-slate-500">
        What the next document of each kind will be called. Set these when moving an existing book into the app,
        so the app carries on from where your own numbering had got to instead of starting at 1.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
              <th className="pb-2 pr-3">Series</th>
              <th className="pb-2 pr-3">Pattern</th>
              <th className="pb-2 pr-3 text-right">Next no.</th>
              <th className="pb-2 pr-3">Will be</th>
              <th className="pb-2 w-24" />
            </tr>
          </thead>
          <tbody>
            {(data?.series ?? []).map((s) => {
              const typed = edits[s.key];
              const dirty = typed !== undefined && Number(typed) !== s.next_number && typed !== '';
              return (
                <tr key={s.key} className="border-b border-slate-100 last:border-0">
                  <td className="py-2 pr-3">
                    {SERIES_LABEL[s.doc_type] ?? s.doc_type}
                    {s.is_export && <span className="ml-1 text-xs text-slate-400">export</span>}
                  </td>
                  <td className="py-2 pr-3"><code className="rounded bg-slate-100 px-1 text-xs">{s.pattern}</code></td>
                  <td className="py-2 pr-3 text-right">
                    <Input
                      type="number"
                      min={1}
                      className="w-24 text-right"
                      value={typed ?? String(s.next_number)}
                      onChange={(e) => setEdits((prev) => ({ ...prev, [s.key]: e.target.value }))}
                    />
                  </td>
                  <td className="py-2 pr-3 tabular-nums text-slate-500">
                    {dirty ? s.pattern
                      .replaceAll('{FY}', s.fy)
                      .replaceAll('{SEQ4}', String(Number(typed)).padStart(4, '0'))
                      .replaceAll('{SEQ}', String(Number(typed)).padStart(3, '0'))
                      : s.preview}
                  </td>
                  <td className="py-2 text-right">
                    {dirty && (
                      <Button variant="secondary" onClick={() => apply(s)} disabled={save.isPending}>Set</Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ErrorText error={save.error} />
      <p className="mt-2 text-xs text-slate-400">
        Counters run per company and per fiscal year ({data?.series?.[0]?.fy ?? '—'}), and export series count
        separately from domestic. Changing a number here never touches a document already issued.
      </p>
    </Card>
  );
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const { data: companies = [] } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.get<Company[]>('/api/companies?all=1'),
  });
  // Which entity's profile is on screen. Defaults to the group's main one.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [form, setForm] = useState<Company | null>(null);
  const [saved, setSaved] = useState(false);

  const current = companies.find((c) => c.id === selectedId)
    ?? companies.find((c) => c.is_default)
    ?? companies[0];

  useEffect(() => {
    if (current && current.id !== form?.id) {
      setSelectedId(current.id);
      setForm(current);
    }
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = (c: Company) => {
    queryClient.invalidateQueries({ queryKey: ['companies'] });
    queryClient.invalidateQueries({ queryKey: ['settings'] });
    setSelectedId(c.id);
    setForm(c);
  };

  const save = useMutation({
    mutationFn: (s: Company) => api.put<Company>(`/api/companies/${s.id}`, s),
    onSuccess: (s) => {
      refresh(s);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  const addCompany = useMutation({
    mutationFn: (name: string) => api.post<Company>('/api/companies', { company_name: name }),
    onSuccess: refresh,
  });

  const makeDefault = useMutation({
    mutationFn: (id: number) => api.put<Company>(`/api/companies/${id}`, { is_default: true }),
    onSuccess: refresh,
  });

  if (!form) return <div className="text-slate-400">Loading…</div>;

  const set = (patch: Partial<Company>) => setForm({ ...form, ...patch });
  const setBank = (i: number, patch: Partial<BankAccount>) => {
    const accounts = form.bank_accounts.map((b, idx) => (idx === i ? { ...b, ...patch } : b));
    set({ bank_accounts: accounts });
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Settings"
        subtitle={companies.length > 1
          ? 'Each company in the group has its own profile, numbering and bank details'
          : 'Company profile shown on all documents'}
        actions={
          <div className="flex items-center gap-2">
            {saved && <span className="text-sm text-green-600">Saved ✓</span>}
            <Button onClick={() => save.mutate(form)} disabled={save.isPending}>Save Settings</Button>
          </div>
        }
      />
      <ErrorText error={save.error ?? addCompany.error ?? makeDefault.error} />

      {/* Which entity is being edited. A document keeps the company it was
          issued under, so switching here never rewrites existing paperwork. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {companies.map((c) => (
          <button
            key={c.id}
            onClick={() => { setSelectedId(c.id); setForm(c); }}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              c.id === form.id ? 'border-brand-600 bg-brand-50 font-medium text-brand-700' : 'border-slate-300 bg-white hover:border-brand-600'
            }`}
          >
            {c.company_name || 'Untitled company'}
            {c.is_default ? <span className="ml-1.5 text-xs text-slate-400">· default</span> : null}
          </button>
        ))}
        <Button
          variant="secondary"
          disabled={addCompany.isPending}
          onClick={() => {
            const name = prompt('Name of the company to add');
            if (name?.trim()) addCompany.mutate(name.trim());
          }}
        >+ Add company</Button>
        {!form.is_default && (
          <Button variant="secondary" disabled={makeDefault.isPending} onClick={() => makeDefault.mutate(form.id)}>
            Make default
          </Button>
        )}
      </div>

      <div className="space-y-4">
        <Card title="Company Details">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Company Name" className="col-span-2">
              <Input value={form.company_name} onChange={(e) => set({ company_name: e.target.value })} />
            </Field>
            <Field label="Address" className="col-span-2">
              <Textarea rows={2} value={form.address} onChange={(e) => set({ address: e.target.value })} />
            </Field>
            <Field label="City"><Input value={form.city} onChange={(e) => set({ city: e.target.value })} /></Field>
            <Field label="State"><Input value={form.state} onChange={(e) => set({ state: e.target.value })} /></Field>
            <Field label="Country"><Input value={form.country} onChange={(e) => set({ country: e.target.value })} /></Field>
            <Field label="PIN Code"><Input value={form.pincode} onChange={(e) => set({ pincode: e.target.value })} /></Field>
            <Field label="Phone"><Input value={form.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
            <Field label="Email"><Input value={form.email} onChange={(e) => set({ email: e.target.value })} /></Field>
            <Field label="Website"><Input value={form.website} onChange={(e) => set({ website: e.target.value })} /></Field>
          </div>
        </Card>
        <Card title="Tax & Trade Registration">
          {/* PAN is gone: it was never asked for on any of these documents. The
              column stays, so nothing already stored is lost. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="GSTIN (printed on domestic documents only)">
              <Input value={form.gstin} onChange={(e) => set({ gstin: e.target.value })} />
            </Field>
            <Field label="IEC (printed on export commercial invoices only)">
              <Input value={form.iec} onChange={(e) => set({ iec: e.target.value })} />
            </Field>
            <Field label="Default ARN / LUT Reference" className="sm:col-span-2">
              <Input value={form.arn_ref} onChange={(e) => set({ arn_ref: e.target.value })} placeholder="e.g. AD1904250005855 DT. 01.04.25" />
              <p className="mt-1 text-xs text-slate-500">
                A starting point only. Each export consignment has its own reference, entered on the
                commercial invoice itself; this is what prints when that field is left blank.
              </p>
            </Field>
          </div>
        </Card>
        <Card title="Branding">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ImageUpload label="Company Logo" value={form.logo} onChange={(v) => set({ logo: v })} />
            <ImageUpload label="Signature / Stamp" value={form.signature} onChange={(v) => set({ signature: v })} />
            <Field label="Document Theme Colour (headers & bands on PDFs)">
              <div className="flex items-center gap-2">
                <input type="color" value={form.theme_color || '#8b1a1a'} onChange={(e) => set({ theme_color: e.target.value })} className="h-8 w-14 cursor-pointer rounded border border-slate-300" />
                <Input value={form.theme_color || ''} onChange={(e) => set({ theme_color: e.target.value })} className="max-w-28" />
              </div>
            </Field>
          </div>
        </Card>
        <Card
          title="Bank Accounts"
          actions={<Button variant="secondary" onClick={() => set({ bank_accounts: [...form.bank_accounts, { label: '', details: '' }] })}>+ Add Account</Button>}
        >
          {form.bank_accounts.length === 0 && <p className="text-sm text-slate-400">No bank accounts yet. These appear on proforma and commercial invoices.</p>}
          <div className="space-y-3">
            {form.bank_accounts.map((b, i) => (
              <div key={i} className="rounded-md border border-slate-200 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <Input placeholder="Label (e.g. HDFC INR Account)" value={b.label} onChange={(e) => setBank(i, { label: e.target.value })} className="max-w-xs" />
                  <Button variant="danger" onClick={() => set({ bank_accounts: form.bank_accounts.filter((_, idx) => idx !== i) })}>Remove</Button>
                </div>
                <Textarea
                  rows={3}
                  placeholder={'Bank name, A/C number, IFSC, SWIFT, branch…'}
                  value={b.details}
                  onChange={(e) => setBank(i, { details: e.target.value })}
                />
              </div>
            ))}
          </div>
        </Card>
        <Card title="Document Numbering Patterns">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Quotation"><Input value={form.quote_pattern} onChange={(e) => set({ quote_pattern: e.target.value })} /></Field>
            <Field label="Packing List"><Input value={form.pl_pattern} onChange={(e) => set({ pl_pattern: e.target.value })} /></Field>
            <Field label="Order (domestic)"><Input value={form.order_pattern} onChange={(e) => set({ order_pattern: e.target.value })} /></Field>
            <Field label="Order (export)"><Input value={form.order_export_pattern} onChange={(e) => set({ order_export_pattern: e.target.value })} /></Field>
            <Field label="Proforma Invoice (domestic)"><Input value={form.pi_pattern} onChange={(e) => set({ pi_pattern: e.target.value })} /></Field>
            <Field label="Proforma Invoice (export)"><Input value={form.pi_export_pattern} onChange={(e) => set({ pi_export_pattern: e.target.value })} /></Field>
            <Field label="Commercial Invoice (domestic)"><Input value={form.inv_pattern} onChange={(e) => set({ inv_pattern: e.target.value })} /></Field>
            <Field label="Commercial Invoice (export)"><Input value={form.inv_export_pattern} onChange={(e) => set({ inv_export_pattern: e.target.value })} /></Field>
          </div>
          <p className="mt-2 text-xs text-slate-400">
            Tokens: <code className="rounded bg-slate-100 px-1">{'{FY}'}</code> = fiscal year (Apr–Mar, e.g. 26-27), <code className="rounded bg-slate-100 px-1">{'{SEQ}'}</code> = sequence (001, 002…).
            Also <code className="rounded bg-slate-100 px-1">{'{SEQ4}'}</code> for a four-digit sequence (0001, 0002…).
            Example: <code className="rounded bg-slate-100 px-1">AGLO/EX/{'{FY}'}/{'{SEQ}'}</code> → AGLO/EX/26-27/001. Export and domestic series count separately; you can also edit any document's number manually on its page.
          </p>
        </Card>

        <SequenceCard companyId={form.id} />
        <Card title="Default Terms & Conditions">
          <Textarea rows={4} value={form.default_terms} onChange={(e) => set({ default_terms: e.target.value })} placeholder="Printed at the bottom of every document…" />
          <p className="mt-2 text-xs text-slate-400">One clause per line — each line prints as a bullet.</p>
        </Card>

        <BackupCard />

        <Card
          title="Note & Term Presets"
          actions={
            <Button variant="secondary" onClick={() => set({ note_presets: [...(form.note_presets ?? []), { label: '', body: '' }] })}>
              + Add Preset
            </Button>
          }
        >
          <p className="mb-3 text-sm text-slate-500">
            Reusable clauses your team can insert into any document's notes or remarks with one click, then edit freely on that document.
            Tick <span className="font-medium">Use by default</span> and the clause is already written in when a new document is created —
            still editable, and still removable on that document alone.
          </p>
          {(form.note_presets ?? []).length === 0 && <p className="text-sm text-slate-400">No presets yet.</p>}
          <div className="space-y-3">
            {(form.note_presets ?? []).map((p: NotePreset, i: number) => (
              <div key={i} className="rounded-md border border-slate-200 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <Input
                    placeholder="Preset name (e.g. Quantity tolerance)"
                    value={p.label}
                    onChange={(e) => set({ note_presets: form.note_presets.map((x, idx) => (idx === i ? { ...x, label: e.target.value } : x)) })}
                    className="max-w-xs"
                  />
                  <div className="flex items-center gap-3">
                    <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-sm text-slate-600">
                      <input
                        type="checkbox"
                        checked={!!p.use_by_default}
                        onChange={(e) => set({ note_presets: form.note_presets.map((x, idx) => (idx === i ? { ...x, use_by_default: e.target.checked } : x)) })}
                      />
                      Use by default
                    </label>
                    <Button variant="danger" onClick={() => set({ note_presets: form.note_presets.filter((_, idx) => idx !== i) })}>Remove</Button>
                  </div>
                </div>
                <Textarea
                  rows={2}
                  placeholder="The text that gets inserted…"
                  value={p.body}
                  onChange={(e) => set({ note_presets: form.note_presets.map((x, idx) => (idx === i ? { ...x, body: e.target.value } : x)) })}
                />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
