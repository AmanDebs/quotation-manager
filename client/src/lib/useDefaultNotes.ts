import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { defaultNotes, type Settings } from '../types';

/**
 * Write the standard clauses into a new document's notes.
 *
 * The presets were only ever insertable one at a time from a dropdown, which
 * meant the terms that go on nearly every document had to be remembered and
 * clicked in every time. Ticking "use by default" in Settings puts them in the
 * box already written, where they can be edited or deleted like any other text.
 *
 * Three rules keep it from fighting the person typing:
 *
 * - **New documents only.** An existing document's remarks are what was agreed
 *   and sent; nothing here may add to them years later.
 * - **Only into an empty box.** Text carried forward from a quotation or an
 *   order is the more specific answer and always wins.
 * - **Once.** `filled` latches, so clearing the box does not immediately refill
 *   it — deleting a clause has to mean deleting it.
 *
 * Settings arrive after the first render, hence the effect rather than a value
 * folded into the form's initial state.
 */
export function useDefaultNotes(
  isNew: boolean,
  current: string,
  apply: (text: string) => void
) {
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<Settings>('/api/settings'),
  });
  const filled = useRef(false);
  // Read through a ref so the effect does not re-run on every keystroke; it
  // only ever wants to know whether the box was empty at the moment it fires.
  const currentRef = useRef(current);
  currentRef.current = current;
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    if (!isNew || filled.current || !settings) return;
    const text = defaultNotes(settings.note_presets);
    filled.current = true;
    if (text && !currentRef.current.trim()) applyRef.current(text);
  }, [isNew, settings]);
}
