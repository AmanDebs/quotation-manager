import { useEffect, useState, type ChangeEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Settings, BankAccount } from '../types';
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
          </div>
        </Card>
        <Card title="Branding">
          <div className="grid grid-cols-2 gap-3">
            <ImageUpload label="Company Logo" value={form.logo} onChange={(v) => set({ logo: v })} />
            <ImageUpload label="Signature / Stamp" value={form.signature} onChange={(v) => set({ signature: v })} />
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
        <Card title="Document Numbering Prefixes">
          <div className="grid grid-cols-4 gap-3">
            <Field label="Quotation"><Input value={form.quote_prefix} onChange={(e) => set({ quote_prefix: e.target.value })} /></Field>
            <Field label="Proforma Invoice"><Input value={form.pi_prefix} onChange={(e) => set({ pi_prefix: e.target.value })} /></Field>
            <Field label="Commercial Invoice"><Input value={form.inv_prefix} onChange={(e) => set({ inv_prefix: e.target.value })} /></Field>
            <Field label="Packing List"><Input value={form.pl_prefix} onChange={(e) => set({ pl_prefix: e.target.value })} /></Field>
          </div>
          <p className="mt-2 text-xs text-slate-400">Numbers look like QT-2026-0001 and reset each year.</p>
        </Card>
        <Card title="Default Terms & Conditions">
          <Textarea rows={4} value={form.default_terms} onChange={(e) => set({ default_terms: e.target.value })} placeholder="Printed at the bottom of every document…" />
        </Card>
      </div>
    </div>
  );
}
