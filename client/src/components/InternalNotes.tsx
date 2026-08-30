import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Textarea, ErrorText } from './ui';

/**
 * The team's private note on a document.
 *
 * The document already has printed remarks — the NOTES & TERMS bullets, or the
 * proforma's Remarks — which the customer reads. This is the other kind: what
 * was asked for, what was conceded, when to call back. The label says so
 * plainly, because the only real hazard here is typing one into the other.
 *
 * It saves on blur through its own endpoint rather than the form's Save, so an
 * approved document stays approved and no line item is touched.
 *
 * Written against a doc type rather than a quotation id: proformas gained the
 * same field, and a second near-identical copy of this is how the two would
 * drift apart.
 */
const ENDPOINT = {
  quotation: { path: 'quotations', list: 'quotations', detail: 'quotation' },
  proforma: { path: 'proformas', list: 'proformas', detail: 'proforma' },
} as const;

export default function InternalNotes({
  docType, docId, value, rows = 3, autoFocus,
}: {
  docType: keyof typeof ENDPOINT;
  docId: number;
  value: string;
  rows?: number;
  autoFocus?: boolean;
}) {
  const target = ENDPOINT[docType];
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
      api.patch<{ id: number }>(`/api/${target.path}/${docId}/internal-notes`, { internal_notes }),
    onSuccess: (doc) => {
      queryClient.invalidateQueries({ queryKey: [target.list] });
      queryClient.setQueryData([target.detail, String(doc.id)], doc);
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
