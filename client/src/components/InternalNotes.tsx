import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Quotation } from '../types';
import { Textarea, ErrorText } from './ui';

/**
 * The team's private note on a quotation.
 *
 * A quotation already has `notes`, but those are printed — they become the
 * NOTES & TERMS bullets the customer reads. This is the other kind: what was
 * asked for, what was conceded, when to call back. The label says so plainly,
 * because the only real hazard here is typing one into the other.
 *
 * It saves on blur through its own endpoint rather than the form's Save, so
 * that an approved quotation stays approved and no line item is touched.
 */
export default function InternalNotes({
  quotationId, value, rows = 3, autoFocus,
}: {
  quotationId: number;
  value: string;
  rows?: number;
  autoFocus?: boolean;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(value);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>();

  // Adopt the server's copy when it changes underneath us (another revision
  // loaded, or a save elsewhere), but never while the user is mid-sentence.
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);

  useEffect(() => () => clearTimeout(savedTimer.current), []);

  const save = useMutation({
    mutationFn: (internal_notes: string) =>
      api.patch<Quotation>(`/api/quotations/${quotationId}/internal-notes`, { internal_notes }),
    onSuccess: (q) => {
      queryClient.invalidateQueries({ queryKey: ['quotations'] });
      queryClient.setQueryData(['quotation', String(q.id)], q);
      setSaved(true);
      savedTimer.current = setTimeout(() => setSaved(false), 2000);
    },
  });

  const commit = () => {
    focused.current = false;
    if (text === value) return;
    save.reset();
    save.mutate(text);
  };

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Internal note
        </span>
        <span className="text-xs text-slate-400">
          {save.isPending ? 'Saving…' : saved ? 'Saved' : 'Not shown to the customer'}
        </span>
      </div>
      <Textarea
        rows={rows}
        value={text}
        autoFocus={autoFocus}
        onFocus={() => { focused.current = true; }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        placeholder="What the customer asked for, what was agreed, when to follow up…"
      />
      <ErrorText error={save.error} />
    </div>
  );
}
