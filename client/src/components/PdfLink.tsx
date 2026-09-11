import type { ReactNode } from 'react';
import type { PdfGuard } from '../lib/useUnsavedChanges';

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
 * **The dialog is the hook's, not a `confirm()`** (2026-09-12, the user having
 * put the two side by side: the navigation prompt was the app's own modal
 * with three buttons and this was the browser's black box with two). It is
 * the same modal now, with the wording this case needs — leaving the page
 * loses the edits, opening a PDF loses nothing at all, the form being still
 * there in the tab behind — and the third button this case wanted all along:
 * **Save & open**, which is what somebody who clicked 📄 mid-edit almost
 * always meant.
 *
 * **`guard` is a required prop and not a context**, which is the opposite of
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
export function PdfLink({
  href,
  guard,
  title,
  blocked,
  children,
}: {
  href: string;
  /** From `useUnsavedChanges`: asks whether the form is dirty, and owns the dialog if it is. */
  guard: PdfGuard;
  title?: string;
  /**
   * Why the document cannot be printed yet — the blocking findings from
   * `checks`, joined. The server refuses the same PDF with the same sentence
   * (422), so this is the explanation in front of the refusal rather than a
   * second copy of the rule: a link that fails when clicked teaches people to
   * click it twice.
   */
  blocked?: string;
  children: ReactNode;
}) {
  if (blocked) {
    return (
      <span className="inline-block cursor-not-allowed opacity-60" title={`Cannot print yet — ${blocked}`} aria-disabled="true">
        {children}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      // The browser is holding the click; a dirty form takes it over and the
      // dialog opens the PDF itself once the person has said which version.
      onClick={(e) => { if (guard.isDirty()) { e.preventDefault(); guard.ask(href); } }}
    >
      {children}
    </a>
  );
}
