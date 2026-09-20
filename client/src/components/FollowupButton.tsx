import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Button, Field, Input, Textarea, Modal, ErrorText } from './ui';
import { today } from '../lib/format';

interface FollowupTarget { docType: string; docId: number; customerId?: number | null }

/**
 * The dialog on its own, so the quotations list can open it from a bell on
 * the row (2026-09-20) without a second copy of the form. `['followups']` is
 * invalidated by prefix, which also refreshes the sidebar's due count
 * (`['followups', 'count']`); `onCreated` is for the caller's own list.
 */
export function FollowupDialog({ docType, docId, customerId, onClose, onCreated }: FollowupTarget & { onClose: () => void; onCreated?: () => void }) {
  const queryClient = useQueryClient();
  const [dueDate, setDueDate] = useState(today());
  const [note, setNote] = useState('');

  const create = useMutation({
    mutationFn: () => api.post('/api/followups', { doc_type: docType, doc_id: docId, customer_id: customerId, due_date: dueDate, note }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['followups'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onCreated?.();
      onClose();
    },
  });

  return (
    <Modal title="Schedule Follow-up" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Due Date">
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label="Note">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Call to confirm prices, check advance payment…" />
        </Field>
        <ErrorText error={create.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending || !dueDate}>Schedule</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Schedule a follow-up reminder attached to any document. */
export default function FollowupButton(target: FollowupTarget) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>🔔 Follow-up</Button>
      {open && <FollowupDialog {...target} onClose={() => setOpen(false)} />}
    </>
  );
}
