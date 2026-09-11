import { useMemo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useBlocker, useNavigate, type BlockerFunction } from 'react-router-dom';
import { Button, Modal, ErrorText } from '../components/ui';

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
/** What a PDF link needs from the form it sits in. */
export interface PdfGuard {
  isDirty: () => boolean;
  /** Open the dialog for this PDF; called only when the form is dirty. */
  ask: (href: string) => void;
}

export function useUnsavedChanges(
  draft: unknown,
  /**
   * How this form saves, if it wants the dialog to offer it. Anything `run`
   * rejects with — a validation refusal, a 409, a dropped connection — keeps
   * the dialog open with the reason on it, and the navigation stays blocked.
   * Omitted, the dialog simply has two buttons.
   *
   * `can` is the same condition the page's own Save button is disabled on. A
   * document with no customer or no lines cannot be saved at all, so the
   * dialog says why rather than offering a button that only produces a 400.
   */
  saver?: { run: () => Promise<unknown>; can?: boolean },
): {
  markSaved: () => void;
  isDirty: () => boolean;
  /** For `PdfLink`: the dirty check, and the dialog a dirty form's PDF click opens. */
  pdf: PdfGuard;
  /**
   * The dialog. Renders nothing until a navigation is actually blocked or a
   * PDF has been asked for mid-edit, so a form can put it anywhere; every
   * one of them puts it last.
   */
  prompt: ReactNode;
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

  /**
   * The dialog, and the reason it is not `confirm()`.
   *
   * A two-button confirm can only ask "leave and lose them?", which offers the
   * destructive answer as the positive one and leaves the useful answer —
   * save, then go — to be done by cancelling, saving by hand and clicking the
   * link again. Excel's Save / Don't Save / Cancel is the shape that fits, so
   * this is a real modal: `confirm` cannot show three buttons.
   *
   * Only this one. The seventeen other confirmations in the app are all a
   * single yes-or-no about something that has already been decided.
   */
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const navigate = useNavigate();

  const leave = useCallback(() => { blocker.proceed?.(); }, [blocker]);

  const stay = useCallback(() => {
    setSaveError('');
    blocker.reset?.();
  }, [blocker]);

  const saveThenLeave = async () => {
    if (!saver) return;
    // Read the destination *before* saving. Saving a new document clears the
    // dirty flag and then navigates to its own id from the mutation's success
    // handler — which passes the blocker, because it is no longer dirty — so
    // by the time the save resolves the block we were holding may be gone and
    // `proceed` with it. Going to the remembered location covers both cases,
    // and is what the person asked for either way.
    const to = blocker.location;
    setSaving(true);
    setSaveError('');
    try {
      await saver.run();
    } catch (err) {
      // Stay exactly where we are, with the reason on screen. Proceeding here
      // would lose the edits the button exists to keep.
      setSaveError(err instanceof Error ? err.message : 'Could not save.');
      return;
    } finally {
      setSaving(false);
    }
    blocker.reset?.();
    if (to) setTimeout(() => navigate(to.pathname + to.search + to.hash), 0);
  };

  /*
   * The PDF question, in the same modal.
   *
   * A different sentence from the navigation one, deliberately: leaving loses
   * the edits, opening a PDF loses nothing — the form is still there in the
   * tab behind — so the hazard is a *stale document*, and a prompt saying
   * "lose them?" about an action that loses nothing is how people learn these
   * dialogs are wrong. The buttons are the navigation dialog's three, read for
   * this case: save and then open the current version, open the saved one as
   * it stands, or do nothing.
   *
   * `window.open` runs inside the button's own click, which is a user gesture
   * and therefore not a popup as far as the browser is concerned.
   */
  const [pdfHref, setPdfHref] = useState<string | null>(null);
  const askPdf = useCallback((href: string) => { setSaveError(''); setPdfHref(href); }, []);
  const openPdf = (href: string) => window.open(href, '_blank', 'noopener');
  const saveThenOpen = async () => {
    if (!saver || !pdfHref) return;
    setSaving(true);
    setSaveError('');
    try {
      await saver.run();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save.');
      return;
    } finally {
      setSaving(false);
    }
    openPdf(pdfHref);
    setPdfHref(null);
  };
  const pdf: PdfGuard = useMemo(() => ({ isDirty: () => dirtyRef.current, ask: askPdf }), [askPdf]);

  const prompt = pdfHref ? (
    <Modal title="Open the saved version?" onClose={() => setPdfHref(null)}>
      <p className="text-sm text-slate-700">
        This document has changes that have not been saved. The PDF is built from the saved version, so it will not show them.
      </p>
      {saver && saver.can === false && (
        <p className="mt-1 text-sm text-slate-500">
          It cannot be saved yet — it needs a customer and at least one line.
        </p>
      )}
      {saveError && <ErrorText error={saveError} />}
      <div className="mt-4 flex justify-end gap-2">
        {saver && (
          <Button onClick={saveThenOpen} disabled={saving || saver.can === false}>
            {saving ? 'Saving…' : 'Save & open'}
          </Button>
        )}
        <Button variant="secondary" onClick={() => { openPdf(pdfHref); setPdfHref(null); }} disabled={saving}>Open saved version</Button>
        <Button variant="secondary" onClick={() => setPdfHref(null)} disabled={saving}>Cancel</Button>
      </div>
    </Modal>
  ) : blocker.state === 'blocked' ? (
    <Modal title="Save changes?" onClose={stay}>
      <p className="text-sm text-slate-700">
        This document has changes that have not been saved.
      </p>
      {saver && saver.can === false && (
        <p className="mt-1 text-sm text-slate-500">
          It cannot be saved yet — it needs a customer and at least one line.
        </p>
      )}
      {saveError && <ErrorText error={saveError} />}
      <div className="mt-4 flex justify-end gap-2">
        {saver && (
          <Button onClick={saveThenLeave} disabled={saving || saver.can === false}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        )}
        <Button variant="secondary" onClick={leave} disabled={saving}>Don&rsquo;t save</Button>
        <Button variant="secondary" onClick={stay} disabled={saving}>Cancel</Button>
      </div>
    </Modal>
  ) : null;

  // The ref, not the state, for the same reason the blocker reads it: this has
  // to be callable from a click handler and be right *now*, and it must stay
  // stable so a link holding it does not re-render on every keystroke.
  const isDirty = useCallback(() => dirtyRef.current, []);

  return { markSaved, isDirty, pdf, prompt };
}
