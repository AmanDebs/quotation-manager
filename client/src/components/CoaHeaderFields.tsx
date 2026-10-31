import type { CoaField, CoaHeaderConfig } from '../types';
import { Input } from './ui';

/**
 * The certificate's header, cell by cell, with a tick on each.
 *
 * 2026-10-31, the client with their own 48mm cap COA beside the app's: *"Add
 * the fields which are present in second image to COA page and a checkbox
 * whether it will be present in the pdf or not, also add lot No. as a
 * field"*. Every one of those cells was already derived and printed — and
 * invisible until somebody printed it, so the person issuing a certificate
 * could not see what it would say, and could not drop a cell their buyer does
 * not want.
 *
 * **The list is the server's**, the same one `buildCoaPdf` draws from
 * (`services/coaHeader.ts`), so this panel cannot promise a cell the document
 * does not print. What it adds is the tick and, on the cells the record
 * cannot supply at issue time, a box to type the value into.
 *
 * **Only the differences are sent.** An untouched panel sends nothing at all
 * — the parent holds `null` until somebody ticks or types — so opening a
 * certificate and closing it cannot rewrite its header.
 *
 * One control, drawn by the certify page and by the register's correction
 * dialog alike: two copies is how the two come to offer different cells, the
 * call `CoaExtraFields` and `SuggestInput` already record.
 */

/** What is already on the certificate, as a config to edit from. */
export function seedCoaHeader(fields: CoaField[]): CoaHeaderConfig {
  return {
    hidden: fields.filter((f) => f.hidden).map((f) => f.key),
    values: Object.fromEntries(fields.filter((f) => f.typed).map((f) => [f.key, f.typed])),
  };
}

export function CoaHeaderFields({ fields, config, onChange, loading }: {
  fields: CoaField[] | undefined;
  /** `null` until somebody changes something — see above. */
  config: CoaHeaderConfig | null;
  onChange: (next: CoaHeaderConfig) => void;
  loading?: boolean;
}) {
  if (loading) return <p className="text-xs text-slate-400">Reading the header…</p>;
  if (!fields?.length) return null;

  const live = config ?? seedCoaHeader(fields);
  const hiddenOf = (key: string) => live.hidden.includes(key);
  const typedOf = (key: string) => live.values[key] ?? '';

  const setTick = (key: string, print: boolean) => onChange({
    ...live,
    hidden: print ? live.hidden.filter((k) => k !== key) : [...new Set([...live.hidden, key])],
  });
  const setValue = (key: string, value: string) => {
    const values = { ...live.values };
    // Blank is a real answer: it puts the cell back on what the record says.
    if (value.trim()) values[key] = value; else delete values[key];
    onChange({ ...live, values });
  };

  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        What the certificate&rsquo;s header states
      </p>
      <p className="mb-2 text-xs text-slate-400">
        Untick a cell to leave it off the printed certificate. The boxes are filled in
        from the record where it has an answer &mdash; type over one where it does not,
        or where this buyer wants it worded their way.
      </p>
      <div className="grid gap-x-5 gap-y-1 sm:grid-cols-2">
        {fields.map((f) => {
          const off = hiddenOf(f.key);
          const typed = typedOf(f.key);
          return (
            <div key={f.key} className="flex items-center gap-2 py-0.5">
              {/*
                The tick is its own label rather than wrapping the row: a
                `<label>` round a text box toggles the box every time somebody
                clicks into the field beside it.
              */}
              <input
                type="checkbox"
                className="h-3.5 w-3.5 shrink-0 accent-brand-600 disabled:opacity-40"
                checked={!off}
                disabled={!!f.fixed}
                title={f.fixed
                  ? 'A certificate has to state its own number — this one always prints'
                  : off ? 'Not printed' : 'Printed on the certificate'}
                onChange={(e) => setTick(f.key, e.target.checked)}
              />
              <span
                className={`w-28 shrink-0 text-[10px] font-semibold uppercase leading-tight tracking-wide ${
                  off ? 'text-slate-300' : 'text-slate-500'}`}
                title={f.hint}
              >
                {f.label}
              </span>
              {f.editable ? (
                <Input
                  className="min-w-0 flex-1"
                  value={typed}
                  disabled={off}
                  /*
                   * The derived value stands in the placeholder, so the box
                   * shows what will print while staying empty — which is what
                   * keeps *typed* and *fell back* different facts, rather than
                   * a prefilled box nobody can tell from a typed one.
                   */
                  placeholder={f.derived || f.placeholder || ''}
                  title={f.hint}
                  onChange={(e) => setValue(f.key, e.target.value)}
                />
              ) : (
                <span
                  className={`min-w-0 flex-1 truncate text-sm ${off ? 'text-slate-300' : 'text-slate-700'}`}
                  title={f.value || f.hint}
                >
                  {/*
                    An em-dash where the record is silent, which is what the
                    certificate itself prints on these cells — the page says
                    the same thing the paper will.
                  */}
                  {f.value.split('\n')[0] || <span className="text-slate-300">&mdash;</span>}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
