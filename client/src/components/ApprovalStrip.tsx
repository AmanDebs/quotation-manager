import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ApprovalStatus } from '../types';
import { useCan } from '../App';
import { Button, Textarea, ErrorText } from './ui';
import { fmtDate } from '../lib/format';

const styles: Record<ApprovalStatus, { bg: string; label: string }> = {
  not_submitted: { bg: 'bg-slate-100 text-slate-700', label: 'Not submitted for approval' },
  pending: { bg: 'bg-amber-50 text-amber-800', label: 'Awaiting manager approval' },
  approved: { bg: 'bg-green-50 text-green-800', label: 'Approved' },
  rejected: { bg: 'bg-red-50 text-red-800', label: 'Rejected by manager' },
};

/**
 * Approval banner + actions shown on quotation / proforma / invoice forms.
 * Employees submit; managers approve or reject inline.
 */
export default function ApprovalStrip({
  docType, docId, status, approvedByName, approvedAt, note, queryKey,
}: {
  docType: 'quotations' | 'proformas' | 'invoices';
  docId: number;
  status: ApprovalStatus;
  approvedByName?: string | null;
  approvedAt?: string;
  note?: string;
  queryKey: string;
}) {
  const can = useCan();
  // Approve vs Submit for Approval
  const isManager = can('approval','full');
  const queryClient = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState('');

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: [queryKey, String(docId)] });
    queryClient.invalidateQueries({ queryKey: ['approvals'] });
    queryClient.invalidateQueries({ queryKey: ['approval-count'] });
  };

  const submit = useMutation({
    mutationFn: () => api.post(`/api/${docType}/${docId}/submit`),
    onSuccess: invalidate,
  });
  const decide = useMutation({
    mutationFn: (vars: { approve: boolean; note: string }) => api.post(`/api/${docType}/${docId}/approve`, vars),
    onSuccess: () => { invalidate(); setRejecting(false); setRejectNote(''); },
  });

  const s = styles[status];

  return (
    <div className={`mb-4 rounded-md px-3 py-2 text-sm ${s.bg}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-medium">{s.label}</span>
          {status === 'approved' && approvedByName && (
            <span className="ml-1 opacity-80">by {approvedByName}{approvedAt ? ` on ${fmtDate(approvedAt.slice(0, 10))}` : ''}</span>
          )}
          {status === 'rejected' && note && <div className="mt-0.5 opacity-90">Reason: {note}</div>}
          {status === 'not_submitted' && (
            <div className="mt-0.5 text-xs opacity-80">
              {isManager
                ? 'Approve it yourself to unlock sending, or just set the status directly.'
                : 'A manager must approve this before it can be marked as sent.'}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          {(status === 'not_submitted' || status === 'rejected') && (
            <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
              {isManager ? 'Approve' : 'Submit for Approval'}
            </Button>
          )}
          {isManager && status === 'pending' && (
            <>
              <Button onClick={() => decide.mutate({ approve: true, note: '' })} disabled={decide.isPending}>Approve</Button>
              <Button variant="danger" onClick={() => setRejecting(true)}>Reject</Button>
            </>
          )}
        </div>
      </div>
      {rejecting && (
        <div className="mt-2 space-y-2">
          <Textarea rows={2} value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} placeholder="Reason for rejection…" />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRejecting(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => decide.mutate({ approve: false, note: rejectNote })} disabled={decide.isPending}>
              Confirm Rejection
            </Button>
          </div>
        </div>
      )}
      <ErrorText error={submit.error ?? decide.error} />
    </div>
  );
}
