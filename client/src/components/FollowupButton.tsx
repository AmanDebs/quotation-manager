import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Button, Field, Input, Textarea, Modal, ErrorText } from './ui';
import { today } from '../lib/format';

/** Schedule a follow-up reminder attached to any document. */
export default function FollowupButton({ docType, docId, customerId }: { docType: string; docId: number; customerId?: number | null }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [dueDate, setDueDate] = useState(today());
  const [note, setNote] = useState('');

  const create = useMutation({
    mutationFn: () => api.post('/api/followups', { doc_type: docType, doc_id: docId, customer_id: customerId, due_date: dueDate, note }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['followups'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setOpen(false);
      setNote('');
    },
  });

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>🔔 Follow-up</Button>
      {open && (
        <Modal title="Schedule Follow-up" onClose={() => setOpen(false)}>
          <div className="space-y-3">
            <Field label="Due Date">
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
            <Field label="Note">
              <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Call to confirm prices, check advance payment…" />
            </Field>
            <ErrorText error={create.error} />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={() => create.mutate()} disabled={create.isPending || !dueDate}>Schedule</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
