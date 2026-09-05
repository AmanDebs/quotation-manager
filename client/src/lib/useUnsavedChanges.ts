import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker, type BlockerFunction } from 'react-router-dom';

/**
 * Warn before leaving a document form with edits that were never saved.
 *
 * Covers the three ways work actually gets lost: clicking away in the sidebar,
 * the browser Back button, and closing or reloading the tab. The first two go
 * through react-router's `useBlocker` — which is why `main.tsx` mounts a data
 * router — and the third through `beforeunload`, whose message the browser
 * writes itself and cannot be customised.
 *
 * **What counts as a change is the whole difficulty.** Every one of these
 * forms fills its own draft in after mount: the prefill fetch, the customer's
 * currency and consignee, the note presets written into a new document. A
 * plain "the draft is no longer empty" test calls all of that an unsaved
 * change, and a prompt that fires when nobody has typed anything is the reason
 * these things get hated and clicked through.
 *
 * So a change is **an interaction that moved the draft**, both halves
 * required:
 *
 * - Until the first real `input` or `change` event, the baseline simply
 *   follows the draft, so everything the form does to itself on the way in
 *   passes through silently.
 * - After it, the draft is compared against whatever was on screen the moment
 *   before that first keystroke.
 *
 * ANDing the two also settles what would otherwise need a DOM scope. Internal
 * notes, the payments dialog and the approval note are inputs on the same page
 * that save themselves through their own endpoints; typing in one arms the
 * comparison but moves nothing in the draft, so it stays quiet. The converse
 * miss — adding a line item and leaving without typing into it — loses
 * nothing, which is the right way round for this to fail.
 *
 * `markSaved()` must be called by any mutation that navigates on success, and
 * called *before* it navigates: the guard would otherwise block the redirect a
 * successful save does itself. It sets the flag synchronously rather than
 * through state, because `navigate()` runs in the same handler and the blocker
 * is consulted there and then.
 *
 * Deliberately not called by Revise or Duplicate. Both start from the document
 * as the *server* holds it, so unsaved edits really are about to be dropped
 * and the prompt is the correct thing to see.
 *
 * **`isDirty` exists because there is a fourth way out and neither mechanism
 * above can see it.** A PDF link is an `<a target="_blank">`: `useBlocker`
 * only hears in-app navigation, `beforeunload` only fires for the tab being
 * left, and a new tab is neither. So opening a PDF with edits on screen
 * printed the **last saved** version, silently — and that is the copy that
 * goes to the customer. `components/PdfLink.tsx` asks this and says so; see
 * there for why the sentence it shows is not the one above.
 */
export function useUnsavedChanges(draft: unknown): {
  markSaved: () => void;
  isDirty: () => boolean;
} {
  const serialized = JSON.stringify(draft);

  const touched = useRef(false);
  const baseline = useRef(serialized);
  const latest = useRef(serialized);
  latest.current = serialized;

  // Held as state as well as a ref because `beforeunload` is added and removed
  // by an effect, while the blocker reads the ref so `markSaved` can clear it
  // without waiting for a render.
  const dirtyRef = useRef(false);
  const [dirty, setDirty] = useState(false);

  const setDirtyBoth = (next: boolean) => {
    if (next === dirtyRef.current) return;
    dirtyRef.current = next;
    setDirty(next);
  };

  const markSaved = useCallback(() => {
    touched.current = false;
    baseline.current = latest.current;
    dirtyRef.current = false;
    setDirty(false);
  }, []);

  // Capture phase, on the document: these forms are hundreds of controls over
  // a dozen components, and a listener per input is a listener somebody adds a
  // field without. Noise is harmless — an event that moved nothing in the
  // draft cannot make it dirty.
  useEffect(() => {
    const touch = () => { touched.current = true; };
    document.addEventListener('input', touch, true);
    document.addEventListener('change', touch, true);
    return () => {
      document.removeEventListener('input', touch, true);
      document.removeEventListener('change', touch, true);
    };
  }, []);

  useEffect(() => {
    if (!touched.current) {
      baseline.current = serialized;
      setDirtyBoth(false);
      return;
    }
    setDirtyBoth(serialized !== baseline.current);
  }, [serialized]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Reading the ref rather than the state keeps this callback stable, so the
  // blocker is registered once instead of re-registered on every keystroke.
  const blocker = useBlocker(
    useCallback<BlockerFunction>(
      ({ currentLocation, nextLocation }) =>
        dirtyRef.current && currentLocation.pathname !== nextLocation.pathname,
      []
    )
  );

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    // `confirm` rather than a Modal, matching the seventeen other confirmations
    // in this app — and it is the one dialog that has to be answered before the
    // navigation it is holding up can continue.
    if (confirm('This form has changes that have not been saved. Leave the page and lose them?')) {
      blocker.proceed();
    } else {
      blocker.reset();
    }
  }, [blocker]);

  // The ref, not the state, for the same reason the blocker reads it: this has
  // to be callable from a click handler and be right *now*, and it must stay
  // stable so a link holding it does not re-render on every keystroke.
  const isDirty = useCallback(() => dirtyRef.current, []);

  return { markSaved, isDirty };
}
