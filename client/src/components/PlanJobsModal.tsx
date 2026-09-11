import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { WorkOrder, Location, Machine, Mould, Process } from '../types';
import { Button, Input, Select, Field, Modal, ErrorText } from './ui';

/**
 * Plan a ticked set of jobs in one press: where, on what, when — and release.
 *
 * The step the order-raised job created a need for: jobs arrive with nothing
 * set, and the job page fills them in one at a time. Everything here is
 * **leave as is unless touched** — a field the person did not change is not
 * sent, so planning the mould on four jobs cannot wipe the machine two of
 * them already had. That is the server's own contract for the body, and the
 * form keeps to it by tracking which fields were touched rather than sending
 * the whole draft.
 */

type Draft = {
  location_id?: string; machine_id?: string; mould_id?: string; process_id?: string;
  planned_start?: string; planned_end?: string;
};

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

  const { data: locations = [] } = useQuery({ queryKey: ['master', 'locations', false], queryFn: () => api.get<Location[]>('/api/locations') });
  const { data: machines = [] } = useQuery({ queryKey: ['master', 'machines', false], queryFn: () => api.get<Machine[]>('/api/machines') });
  const { data: moulds = [] } = useQuery({ queryKey: ['master', 'moulds', false], queryFn: () => api.get<Mould[]>('/api/moulds') });
  const { data: processes = [] } = useQuery({ queryKey: ['master', 'processes', false], queryFn: () => api.get<Process[]>('/api/processes') });

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

  /** A master picker with a "leave as is" head and a "clear" tail. */
  const pick = (key: keyof Draft, label: string, rows: { id: number; name: string }[]) => (
    <Field label={label}>
      <Select value={draft[key] ?? '__keep'} onChange={(e) => (e.target.value === '__keep'
        ? setDraft(({ [key]: _drop, ...rest }) => rest)
        : touch({ [key]: e.target.value }))}>
        <option value="__keep">— leave as is —</option>
        {rows.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        <option value="">(clear)</option>
      </Select>
    </Field>
  );

  return (
    <Modal title={`Plan ${jobs.length} job${jobs.length === 1 ? '' : 's'}`} onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600">
        {jobs.map((j) => j.number).join(' · ')}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {pick('location_id', 'Plant', locations)}
        {pick('machine_id', 'Machine', machines)}
        {pick('mould_id', 'Mould', moulds)}
        {pick('process_id', 'Process', processes)}
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
        A field left as is keeps whatever each job already has; a date not touched is not changed.
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
