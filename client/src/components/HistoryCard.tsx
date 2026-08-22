import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Card } from './ui';
import { fmtDateTime } from '../lib/format';
import { describeChange, splitChanges, ACTION_LABEL, type AuditEntry } from '../lib/audit';

/**
 * What has happened to this record, on the record itself.
 *
 * Collapsed by default. Nobody opens a quotation to read its history — they
 * open it to send it — but when the question does come up ("who dropped the
 * price?") it should be answerable without leaving the document, and by the
 * person who owns the document rather than only by a manager.
 *
 * Fetched only once opened. A closed panel that quietly loads its contents on
 * every document page is a query per page view for something nobody read.
 */
export default function HistoryCard({ entity, id }: { entity: string; id: number | undefined }) {
  const [open, setOpen] = useState(false);

  const { data: entries = [], isPending, error } = useQuery({
    queryKey: ['audit', entity, String(id)],
    queryFn: () => api.get<AuditEntry[]>(`/api/audit/${entity}/${id}`),
    enabled: open && !!id,
  });

  if (!id) return null;

  return (
    <Card className="mt-4">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-sm font-semibold text-slate-700">History</span>
        <span className="text-xs text-slate-400">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <div className="mt-3">
          {error && (
            <p className="text-sm text-slate-400">This record&rsquo;s history is not available to you.</p>
          )}
          {!error && isPending && <p className="text-sm text-slate-400">Loading…</p>}
          {!error && !isPending && entries.length === 0 && (
            <p className="text-sm text-slate-400">
              Nothing recorded. The trail starts when a record is next touched, so anything
              changed before this was added is not in it.
            </p>
          )}
          <ol className="space-y-2.5">
            {entries.map((e) => {
              const { shown, hidden } = splitChanges(e.changes);
              return (
              <li key={e.id} className="border-l-2 border-slate-200 pl-3">
                <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-medium text-slate-700">{ACTION_LABEL[e.action] ?? e.action}</span>
                  <span className="text-slate-500">by {e.user_name || 'someone since removed'}</span>
                  <span className="text-xs text-slate-400">{fmtDateTime(e.at)}</span>
                </div>
                {e.note && <div className="text-xs text-amber-700">{e.note}</div>}
                <ul className="mt-0.5 space-y-0.5">
                  {shown.map((c, i) => (
                    <li key={i} className="text-xs text-slate-500">{describeChange(c)}</li>
                  ))}
                  {hidden > 0 && (
                    <li className="text-xs text-slate-400">and {hidden} more field{hidden === 1 ? '' : 's'}</li>
                  )}
                </ul>
              </li>
              );
            })}
          </ol>
        </div>
      )}
    </Card>
  );
}
