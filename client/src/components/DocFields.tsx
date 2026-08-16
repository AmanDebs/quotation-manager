import { useId } from 'react';
import { Input } from './ui';

/**
 * A document's own number, shown but not editable.
 *
 * Every number is claimed from its company's series inside the create
 * transaction. Editing one afterwards leaves a gap in that series and can
 * collide with a number already issued, which the unique index then rejects as
 * a 409 — so the field states the number and refuses the argument. The server
 * still accepts a number on PUT; this is a decision about the form, not a lock.
 */
export function DocNumber({ value, title }: { value?: string | null; title: string }) {
  return (
    <div
      className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-sm text-slate-600"
      title={title}
    >
      {value || '—'}
    </div>
  );
}

export const INCO_TERMS = ['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];

/**
 * INCO terms as suggestions, not a fixed set.
 *
 * The eleven Incoterms are the starting point, but real Aglo documents qualify
 * them with the place — "CIF Mozambique", "FOB Nhava Sheva" — and a dropdown
 * of bare codes cannot say that. A datalist offers the codes and still takes
 * whatever is typed.
 */
export function IncoTermsInput({
  value, onChange, disabled, placeholder = 'e.g. FOB Nhava Sheva, or type your own',
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const listId = useId();
  return (
    <>
      <Input
        list={listId}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      <datalist id={listId}>
        {INCO_TERMS.map((t) => <option key={t} value={t} />)}
      </datalist>
    </>
  );
}
