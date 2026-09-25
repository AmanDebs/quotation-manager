import type { DocumentFinding } from '../types';

/**
 * What the server says is still missing, on a document with **no approval to
 * hold an unfinished one back**.
 *
 * The sales order has been in this position since 2026-09-15 and the domestic
 * quotation and proforma joined it on 2026-09-25, when approval stopped
 * applying to them — so the PDF is what waits, and the reasons sit here in the
 * server's own words rather than behind a button that fails when pressed.
 *
 * Its twin is `ApprovalStrip`, which draws the same findings under an approval
 * somebody has to grant. Two copies of this strip is how the two would come to
 * word the same refusal differently.
 */
export default function ChecksStrip({ checks }: { checks?: DocumentFinding[] }) {
  const blocking = (checks ?? []).filter((c) => c.level === 'block');
  const warnings = (checks ?? []).filter((c) => c.level === 'warn');
  if (!blocking.length && !warnings.length) return null;

  return (
    <>
      {blocking.length > 0 && (
        <div className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
          <strong>Not finished — the PDF will not print until these are filled in:</strong>{' '}
          {blocking.map((c) => c.message).join(' ')}
        </div>
      )}
      {warnings.length > 0 && (
        // Worth saying, never worth refusing over — see services/documentChecks.ts.
        <div className="mb-4 rounded-lg bg-white px-3 py-2 text-sm text-amber-900/90 ring-1 ring-inset ring-amber-200">
          <strong className="text-amber-800">Worth checking:</strong>{' '}
          {warnings.map((c) => c.message).join(' ')}
        </div>
      )}
    </>
  );
}
