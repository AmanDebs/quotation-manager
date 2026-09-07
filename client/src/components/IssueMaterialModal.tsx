import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Location, Material, WorkOrder } from '../types';
import { Button, ErrorText, Field, Input, Modal, Select } from './ui';
import { today } from '../lib/format';

/** Shared with the work order's own page: issuing is a job-level act either way. */
export function IssueModal({ job, onClose, onSaved }: { job: WorkOrder; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    material_id: '', qty: 0, date: today(), location_id: String(job.location_id ?? ''), note: '',
  });
  const { data: materials = [] } = useQuery({ queryKey: ['master', 'materials', false], queryFn: () => api.get<Material[]>('/api/materials') });
  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });

  const issue = useMutation({
    mutationFn: () => api.post('/api/stock/issue', {
      work_order_id: job.id,
      material_id: Number(form.material_id),
      qty: form.qty,
      date: form.date,
      location_id: form.location_id ? Number(form.location_id) : null,
      note: form.note,
    }),
    onSuccess: () => { onSaved(); onClose(); },
  });

  const unit = materials.find((m) => m.id === Number(form.material_id))?.unit ?? '';

  return (
    <Modal title={`Issue to ${job.number}`} onClose={onClose}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Material *" className="col-span-2">
          <Select value={form.material_id} onChange={(e) => setForm({ ...form, material_id: e.target.value })}>
            <option value="">— choose —</option>
            {materials.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.unit})</option>)}
          </Select>
        </Field>
        <Field label={`Quantity ${unit ? `(${unit})` : ''} *`}>
          <Input type="number" min={0} step="any" value={form.qty || ''} onChange={(e) => setForm({ ...form, qty: Number(e.target.value) })} />
        </Field>
        <Field label="Date"><Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
        <Field label="Out of which plant *" className="col-span-2">
          <Select value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })}>
            <option value="">— choose —</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
        <Field label="Note" className="col-span-2">
          <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
      </div>
      <ErrorText error={issue.error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => issue.mutate()} disabled={issue.isPending || !form.material_id || !form.qty}>
          {issue.isPending ? 'Issuing…' : 'Issue'}
        </Button>
      </div>
    </Modal>
  );
}
