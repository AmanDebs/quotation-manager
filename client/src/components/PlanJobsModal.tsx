import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { WorkOrder } from '../types';
import { Button, Input, Field, Modal, ErrorText } from './ui';

/**
 * Plan a ticked set of jobs in one press: when — and release.
 *
 * The step the order-raised job created a need for: jobs arrive with nothing
 * set, and the job page fills them in one at a time. Everything here is
 * **leave as is unless touched** — a field the person did not change is not
 * sent, so dating four jobs cannot disturb anything else two of them already
 * had. That is the server's own contract for the body, and the form keeps to
 * it by tracking which fields were touched rather than sending the whole
 * draft.
 *
 * Plant, machine, mould and process left this dialog on 2026-09-25 with the
 * job page's own four, at the client's word. `POST /work-orders/plan` still
 * accepts them — nothing on screen sends them.
 */

type Draft = { planned_start?: string; planned_end?: string };

export default function PlanJobsModal({ jobs, onClose, onPlanned }: {
  jobs: WorkOrder[];
  onClose: () => void;
  onPlanned: () => void;
}) {
  const queryClient = useQueryClient();
  // Only keys that were touched are present — an untouched field is left alone.
  const [draft, setDraft] = useState<Draft>({});
  const [release, setRelease] = useState(true);
  const touch = (patch: Draft) => setDraft((d) => ({ ...d, ...patch }));

  const plan = useMutation({
    mutationFn: () => api.post('/api/work-orders/plan', { ids: jobs.map((j) => j.id), ...draft, release }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['work-orders'] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onPlanned();
    },
  });

  const nothing = Object.keys(draft).length === 0 && !release;
  const stillPlanned = jobs.filter((j) => j.status === 'planned').length;

  return (
    <Modal title={`Plan ${jobs.length} job${jobs.length === 1 ? '' : 's'}`} onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600">
        {jobs.map((j) => j.number).join(' · ')}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Planned start">
          <Input type="date" value={draft.planned_start ?? ''} onChange={(e) => touch({ planned_start: e.target.value })} />
        </Field>
        <Field label="Planned finish">
          <Input type="date" value={draft.planned_end ?? ''} onChange={(e) => touch({ planned_end: e.target.value })} />
        </Field>
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={release} onChange={(e) => setRelease(e.target.checked)} />
        <span>
          Release to the floor — <span className="text-slate-500">Not planned → Scheduled</span>
          {stillPlanned < jobs.length && (
            <span className="text-slate-400"> ({jobs.length - stillPlanned} already past that and left where {jobs.length - stillPlanned === 1 ? 'it is' : 'they are'})</span>
          )}
        </span>
      </label>
      <p className="mt-2 text-xs text-slate-400">
        A date not touched is not changed.
      </p>
      <ErrorText error={plan.error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => plan.mutate()} disabled={plan.isPending || nothing}>
          {plan.isPending ? 'Planning…' : `Plan ${jobs.length} job${jobs.length === 1 ? '' : 's'}`}
        </Button>
      </div>
    </Modal>
  );
}
