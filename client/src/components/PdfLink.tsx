import type { ReactNode } from 'react';

/**
 * A link to a document's PDF that knows whether the form behind it holds edits
 * the server has not seen.
 *
 * **The gap this closes.** `useUnsavedChanges` covers the three ways work gets
 * lost — the sidebar, Back, and closing the tab — through `useBlocker` and
 * `beforeunload`. A PDF link is none of them: it is an `<a target="_blank">`,
 * so the router never sees the click and the current tab is never left.
 * Editing a quotation and clicking 📄 therefore opened the **last saved**
 * version with nothing said, and that is the copy that reaches the customer.
 * It would have stayed unreported, too, because the PDF that opens looks
 * entirely normal — it is a real document, just not the one on screen.
 *
 * **The sentence is deliberately not the navigation one.** Leaving the page
 * loses the edits; opening a PDF loses nothing at all — the form is still
 * there, untouched, in the tab behind it. The hazard is a *stale document*,
 * not lost work, and a prompt that says "lose them?" about an action that
 * loses nothing is how people learn these dialogs are wrong and start clicking
 * through them. So this one states the actual fact and still lets the user go
 * ahead, which is often what they want: comparing the version already sent
 * against what they are now typing is a real thing to do.
 *
 * **`isDirty` is a required prop and not a context**, which is the opposite of
 * the call `ReadOnlyFields` makes about the same spread-out problem — and the
 * reason is this bug. A context is forgotten by *not wrapping*, and a missing
 * provider is silent: the links render, nothing prompts, and the failure looks
 * exactly like success. That is the shape of the defect being fixed here, so
 * repeating it would be a poor trade for four lines of wrapping. A required
 * prop is refused by the compiler instead, so the fourteenth call site cannot
 * be added without answering the question.
 *
 * Links that are **not** in a form stay plain anchors: the approvals queue,
 * the QC register and the purchase-order rows all point at documents as the
 * server holds them, so there is no draft that could be ahead of the file.
 */

const STALE =
  'This form has changes that have not been saved yet, and the PDF is built from the saved '
  + 'version — so it will not show them.\n\nOpen the saved version anyway?';

export function PdfLink({
  href,
  isDirty,
  title,
  children,
}: {
  href: string;
  /** From `useUnsavedChanges`. Read on click, so it must be the live answer. */
  isDirty: () => boolean;
  title?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      // `confirm` rather than a Modal, matching every other confirmation in
      // this app — and it has to be answered before the browser acts on the
      // click it is holding up.
      onClick={(e) => { if (isDirty() && !confirm(STALE)) e.preventDefault(); }}
    >
      {children}
    </a>
  );
}
