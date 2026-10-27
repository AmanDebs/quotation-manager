import type { CoaExtra } from '../types';
import { Button, Input } from './ui';

/**
 * The extra details one buyer asks to see on their certificate.
 *
 * 2026-10-27, the client: *"COA - optional field to be add : Customer may want
 * specific details to be added like Purchase order"*. Every other cell in that
 * header is derived from the record or is one of the three somebody types, and
 * that is the right default — a header assembled from the book cannot disagree
 * with it. What it cannot do is answer a requirement nobody here invented, and
 * those requirements differ per customer, so this is a list rather than a
 * fourth named field.
 *
 * **One control, not two**, drawn by the certify page and by the register's
 * correction dialog alike: two copies of a control is how the two come to ask
 * different things, the call `SuggestInput` and `SegmentedTabs` already record.
 *
 * **Label and value, because the header is a grid of labelled cells** — a bare
 * line of text would read as a note stuck to a table, and the label is what
 * makes the value mean anything to whoever reads the page.
 */
export const MAX_COA_EXTRA = 6;

export function CoaExtraFields({ rows, onChange }: {
  rows: CoaExtra[];
  onChange: (rows: CoaExtra[]) => void;
}) {
  const set = (i: number, patch: Partial<CoaExtra>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Extra details on the certificate
      </p>
      {/*
        Said rather than left to be discovered, and said **accurately**: a row
        with neither box filled in is dropped, where one with a label and no
        value is refused — a labelled cell with nothing in it is a dead box on
        the page. The first draft of this line claimed both were dropped,
        which the render caught.
      */}
      <p className="mb-2 text-xs text-slate-400">
        Anything this customer asks to see — their own order number, a material
        code, a shelf life. Printed in the certificate's header, under the
        details it works out for itself. Fill in both boxes; an empty row is
        simply left off.
      </p>
      {rows.map((r, i) => (
        <div key={i} className="mb-1 flex items-center gap-2">
          <Input
            className="w-48"
            value={r.label}
            placeholder="Customer's PO"
            onChange={(e) => set(i, { label: e.target.value })}
          />
          <Input
            className="flex-1"
            value={r.value}
            placeholder="4500123456"
            onChange={(e) => set(i, { value: e.target.value })}
          />
          {/*
            Drawn at all times rather than on hover: the line-items editor
            records what hiding a remove control costs, and here there are at
            most six rows to keep quiet.
          */}
          <button
            type="button"
            className="px-1 text-slate-300 hover:text-red-500"
            title="Remove this detail"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      {rows.length < MAX_COA_EXTRA && (
        <Button
          variant="secondary"
          className="mt-1"
          onClick={() => onChange([...rows, { label: '', value: '' }])}
        >
          + Add a detail
        </Button>
      )}
    </div>
  );
}
