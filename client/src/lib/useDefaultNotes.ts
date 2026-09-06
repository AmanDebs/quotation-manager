import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { defaultNotes, type Settings } from '../types';
import { useDefaultOnce } from './useDefaultOnce';

/**
 * Write the standard clauses into a new document's notes.
 *
 * The presets were only ever insertable one at a time from a dropdown, which
 * meant the terms that go on nearly every document had to be remembered and
 * clicked in every time. Ticking "use by default" in Settings puts them in the
 * box already written, where they can be edited or deleted like any other text.
 *
 * The rules that keep it from fighting the person typing — new documents only,
 * only into an empty box, and once — belong to `useDefaultOnce`, which the
 * prepared-by default follows too.
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
  useDefaultOnce(isNew, settings ? defaultNotes(settings.note_presets) : '', current, apply);
}
