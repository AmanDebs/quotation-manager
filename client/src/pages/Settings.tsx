import { useEffect, useState, type ChangeEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Settings, BankAccount, NotePreset } from '../types';
import { Button, Input, Textarea, Field, Card, PageHeader, ErrorText } from '../components/ui';

function ImageUpload({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 500 * 1024) {
      alert('Please use an image under 500 KB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => onChange(String(reader.result));
    reader.readAsDataURL(file);
  };
  return (
    <Field label={label}>
      <div className="flex items-center gap-3">
        {value ? (
          <img src={value} alt={label} className="h-14 max-w-32 rounded border border-slate-200 object-contain p-1" />
        ) : (
          <div className="flex h-14 w-24 items-center justify-center rounded border border-dashed border-slate-300 text-xs text-slate-400">None</div>
        )}
        <input type="file" accept="image/*" onChange={handleFile} className="text-xs" />
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

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/api/settings') });
  const [form, setForm] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data && !form) setForm(data);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: (s: Settings) => api.put<Settings>('/api/settings', s),
    onSuccess: (s) => {
      queryClient.setQueryData(['settings'], s);
      setForm(s);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  if (!form) return <div className="text-slate-400">Loading…</div>;

  const set = (patch: Partial<Settings>) => setForm({ ...form, ...patch });
  const setBank = (i: number, patch: Partial<BankAccount>) => {
    const accounts = form.bank_accounts.map((b, idx) => (idx === i ? { ...b, ...patch } : b));
    set({ bank_accounts: accounts });
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Settings"
        subtitle="Company profile shown on all documents"
        actions={
          <div className="flex items-center gap-2">
            {saved && <span className="text-sm text-green-600">Saved ✓</span>}
            <Button onClick={() => save.mutate(form)} disabled={save.isPending}>Save Settings</Button>
          </div>
        }
      />
      <ErrorText error={save.error} />
      <div className="space-y-4">
        <Card title="Company Details">
          <div className="grid grid-cols-2 gap-3">
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
          <div className="grid grid-cols-3 gap-3">
            <Field label="GSTIN"><Input value={form.gstin} onChange={(e) => set({ gstin: e.target.value })} /></Field>
            <Field label="PAN"><Input value={form.pan} onChange={(e) => set({ pan: e.target.value })} /></Field>
            <Field label="IEC (Import-Export Code)"><Input value={form.iec} onChange={(e) => set({ iec: e.target.value })} /></Field>
            <Field label="ARN / LUT Reference (printed on export invoices)" className="col-span-3">
              <Input value={form.arn_ref} onChange={(e) => set({ arn_ref: e.target.value })} placeholder="e.g. AD1904250005855 DT. 01.04.25" />
            </Field>
          </div>
        </Card>
        <Card title="Branding">
          <div className="grid grid-cols-2 gap-3">
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
          <div className="grid grid-cols-2 gap-3">
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
            Example: <code className="rounded bg-slate-100 px-1">AGLO/EX/{'{FY}'}/{'{SEQ}'}</code> → AGLO/EX/26-27/001. Export and domestic series count separately; you can also edit any document's number manually on its page.
          </p>
        </Card>
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
                  <Button variant="danger" onClick={() => set({ note_presets: form.note_presets.filter((_, idx) => idx !== i) })}>Remove</Button>
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
