import { useEffect, useRef } from 'react';

/**
 * Fill a new document's field in, once, if nobody has typed there.
 *
 * The three rules a default has to follow on these forms, in one place now
 * that two of them want it — the standard note clauses and the name of
 * whoever is preparing the document:
 *
 * - **New documents only.** What an existing document says is what was agreed
 *   and sent; nothing here may rewrite it later.
 * - **Only into an empty box.** Anything already there — carried forward from
 *   a quotation, or typed — is the more specific answer and always wins.
 * - **Once.** `filled` latches, so clearing the box does not immediately
 *   refill it. Deleting something has to mean deleting it.
 *
 * `value` is read rather than waited for: it is often not known on the first
 * render (settings arrive over the network, the signed-in user comes from a
 * context that fills in after mount), so the effect simply does nothing until
 * there is something to write. That is also why the latch is set **after** the
 * empty check rather than before it — latching on a blank value would spend
 * the one chance to fill before the value ever arrived.
 *
 * The current text and the setter are read through refs so the effect does not
 * re-run on every keystroke; it only ever wants to know whether the box was
 * empty at the moment it fired.
 */
export function useDefaultOnce(
  enabled: boolean,
  value: string,
  current: string,
  apply: (value: string) => void,
) {
  const filled = useRef(false);
  const currentRef = useRef(current);
  currentRef.current = current;
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    if (!enabled || filled.current || !value) return;
    filled.current = true;
    if (!currentRef.current.trim()) applyRef.current(value);
  }, [enabled, value]);
}
