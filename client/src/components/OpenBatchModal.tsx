import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { WorkOrder } from '../types';
import { Button, Input, Field, Modal, ErrorText, FIELD_GRID, Textarea } from './ui';
import { today } from '../lib/format';

/**
 * Open a lot on this job.
 *
 * Deliberately two fields. A batch is identified, not described — its number
 * comes from the company's own series, its quantity is whatever output is
 * booked into it afterwards, and whether it passed is read from its final
 * check. Asking for a quantity here would invite a figure that could disagree
 * with the shift entries underneath it, which is the whole reason nothing
 * derivable is stored in this app.
 *
 * The number field is offered because every other document in this app lets
 * its number be set by hand, and a lot already written on a box in the shed is
 * exactly the case for it.
 */
export default function OpenBatchModal({ job, onClose, onSaved }: {
  job: WorkOrder; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({ date: today(), number: '', notes: '' });
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () => api.post(`/api/work-orders/${job.id}/batches`, {
      date: form.date,
      // Blank means "take the next one from the series", which is the ordinary
      // case — the server decides, so two people opening a lot at once cannot
      // claim the same number.
      number: form.number.trim(),
      notes: form.notes,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['work-order', String(job.id)] });
      onSaved();
      onClose();
    },
  });

  return (
    <Modal title="Open a batch" onClose={onClose}>
      <div className={FIELD_GRID}>
        <Field label="Started">
          <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        </Field>
        <Field label="Batch number">
          <Input
            value={form.number}
            placeholder="next in the series"
            onChange={(e) => setForm({ ...form, number: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Notes" className="mt-3">
        <Textarea
          rows={2}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          placeholder="e.g. Machine 3, mould A — anything that identifies the run"
        />
      </Field>
      <p className="mt-2 text-xs text-slate-400">
        The quantity is whatever output is booked into this batch, so there is nothing to type here.
      </p>
      <ErrorText error={create.error} />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => create.mutate()} disabled={create.isPending || !form.date}>
          {create.isPending ? 'Opening…' : 'Open batch'}
        </Button>
      </div>
    </Modal>
  );
}
