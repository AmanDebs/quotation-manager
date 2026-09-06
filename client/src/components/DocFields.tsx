import { useEffect, useRef, useState } from 'react';
import type { LineItem } from '../types';
import { Button, Input, StaticValue, useReadOnlyFields } from './ui';
import { fmtMoney } from '../lib/format';

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
  // The grey box says "settled, unlike its neighbours". On a read-only
  // document nothing is editable, so it would be the only box on the card.
  if (useReadOnlyFields()) return <StaticValue title={title}>{value}</StaticValue>;
  return (
    <div
      className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-sm text-slate-600"
      title={title}
    >
      {value || '—'}
    </div>
  );
}

/**
 * The delivery bases this desk actually quotes on, per document type.
 *
 * Confirmed with Aglo 2026-09-06. The eleven Incoterms were offered before,
 * which is the published set rather than the used one — and it put FCA, CPT,
 * DAP and the rest in front of somebody who never quotes them, while missing
 * **FOR**, which is not an Incoterm at all but is how a domestic Indian sale
 * is priced.
 *
 * `value` is what goes on the document, `label` is what the list reads: the
 * gloss helps at the moment of choosing and would be noise printed on a
 * customer's invoice. Real Aglo documents qualify the basis with a place —
 * "CIF Mozambique", "FOB Nhava Sheva" — so these stay **suggestions**, and the
 * field takes whatever is typed. That is also why nothing already stored is at
 * risk: a document holding `FCA` or `CPT` still shows it, the list simply no
 * longer offers it.
 */
export interface Suggestion { value: string; label: string }

/** @deprecated The name this list had when it was the only one. */
export type IncoTerm = Suggestion;

export const INCO_TERMS_DOMESTIC: Suggestion[] = [
  { value: 'EX-Works', label: 'EX-Works' },
  { value: 'FOR', label: 'FOR (Free on Road)' },
];

export const INCO_TERMS_EXPORT: Suggestion[] = [
  { value: 'EX-Works', label: 'EX-Works' },
  { value: 'FOB', label: 'FOB (Free on Board)' },
  { value: 'CIF', label: 'CIF (Cost, Insurance & Freight)' },
  { value: 'CFR', label: 'CFR (Cost & Freight)' },
  { value: 'DDP', label: 'DDP (Delivered Duty Paid)' },
];

/**
 * The payment terms this desk actually offers, per document type (Aglo,
 * 2026-09-06). Two families on each side, and the split is the point:
 *
 * - **Domestic** — an advance with the balance settled *before dispatch*, or
 *   plain credit counted from the invoice.
 * - **Export** — an advance with the balance *against shipping documents*,
 *   which is how a consignment travelling on a bill of lading is settled, or
 *   credit counted **from the BL date** rather than from the invoice.
 *
 * The advance percentage genuinely varies by deal, hence three of each rather
 * than one with a blank to fill in. `value` and `label` are the same string
 * here — unlike the INCO list, where the gloss helps at the moment of choosing
 * and would be noise printed on a customer's invoice — because these terms are
 * written on the document exactly as they read.
 *
 * They stay **suggestions**: the box takes whatever is typed, so a deal on
 * 20/80 or "100% CAD" is still expressible, and nothing already stored is at
 * risk — a document holding its own wording still shows it.
 */
const ADVANCE_PCT = [30, 40, 50];
const term = (t: string): Suggestion => ({ value: t, label: t });

export const PAYMENT_TERMS_DOMESTIC: Suggestion[] = [
  ...ADVANCE_PCT.map((p) => term(`${p}% Advance and Balance before Dispatch`)),
  ...[30, 45, 60].map((d) => term(`${d} Days Credit`)),
];

export const PAYMENT_TERMS_EXPORT: Suggestion[] = [
  ...ADVANCE_PCT.map((p) => term(`${p}% Advance and Balance against shipping documents`)),
  ...[30, 60, 75].map((d) => term(`${d} Days from BL date`)),
];

/**
 * A text box that offers suggestions, drawn by us.
 *
 * A `<datalist>` did this job and was dropped for one reason: the browser
 * draws that list itself, so on Windows it arrived as a black OS menu in the
 * middle of a pale form — the one control in the app that did not look like
 * the app. This is the same idea drawn by us, and it keeps the part that
 * mattered: the box is a plain text input, so "CIF Mozambique" can be typed
 * over the suggestion.
 *
 * The panel is positioned **inside a relative wrapper** rather than portalled
 * the way `SearchSelect` is. That is deliberate and only safe here: these are
 * header fields on a `Card`, which has no `overflow` of its own — the reason
 * `Card` must never gain `overflow-hidden`. The line-items table is the case
 * that needs a portal, and this is not it.
 *
 * It is one component with two callers rather than two components, because two
 * copies of a control is how the two come to look different from each other.
 */
function SuggestInput({
  options, value, onChange, disabled, placeholder, label,
}: {
  options: Suggestion[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** What the chevron announces to a screen reader. */
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Close on a click anywhere else. Registered only while open, so the app is
  // not listening to every click on every form for the sake of one field.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Typing filters the suggestions, but never removes them all: a basis
  // qualified with a place ("CIF Mozambique") stops matching its own code
  // after the space, and a list that emptied itself would look broken.
  const q = value.trim().toLowerCase();
  const matches = options.filter((t) => !q || t.label.toLowerCase().includes(q) || q.includes(t.value.toLowerCase()));
  const shown = matches.length ? matches : options;

  if (useReadOnlyFields()) return <StaticValue>{value}</StaticValue>;

  return (
    <div className="relative" ref={wrap}>
      <Input
        disabled={disabled}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
        placeholder={placeholder}
        className="w-full pr-7"
      />
      {!disabled && (
        <button
          type="button"
          // `onMouseDown` rather than `onClick`: the input's focus handler
          // would otherwise reopen the panel this click is trying to close.
          onMouseDown={(e) => { e.preventDefault(); setOpen((o) => !o); }}
          className="absolute inset-y-0 right-0 flex w-7 items-center justify-center text-slate-400 hover:text-slate-600"
          aria-label={label}
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      {open && !disabled && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          {shown.map((t) => (
            <button
              key={t.value}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); onChange(t.value); setOpen(false); }}
              // `leading-snug`: a payment term runs to a sentence and wraps in
              // a narrow column, and two lines of an option have to read as
              // one entry rather than as two.
              className={`block w-full px-3 py-1.5 text-left text-sm leading-snug hover:bg-slate-50 ${
                value === t.value ? 'font-medium text-brand-700' : 'text-slate-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The delivery basis, offered from the list this document type quotes on. */
export function IncoTermsInput({
  value, onChange, disabled, isExport, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  /** Which list to offer. Domestic is the default a form starts on. */
  isExport?: boolean;
  placeholder?: string;
}) {
  return (
    <SuggestInput
      options={isExport ? INCO_TERMS_EXPORT : INCO_TERMS_DOMESTIC}
      value={value}
      onChange={onChange}
      disabled={disabled}
      label="Show delivery bases"
      placeholder={placeholder ?? (isExport ? 'e.g. FOB Nhava Sheva, or type your own' : 'e.g. EX-Works, or type your own')}
    />
  );
}

/** How this document is to be paid, offered from the list its type is sold on. */
export function PaymentTermsInput({
  value, onChange, disabled, isExport, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  isExport?: boolean;
  placeholder?: string;
}) {
  return (
    <SuggestInput
      options={isExport ? PAYMENT_TERMS_EXPORT : PAYMENT_TERMS_DOMESTIC}
      value={value}
      onChange={onChange}
      disabled={disabled}
      label="Show payment terms"
      placeholder={placeholder ?? (isExport
        ? 'e.g. 40% Advance and Balance against shipping documents'
        : 'e.g. 40% Advance and Balance before Dispatch')}
    />
  );
}

/**
 * What is left of the header Freight and Insurance fields.
 *
 * Those two boxes are gone: freight, insurance and tooling are entered as
 * **charge lines** now, which is the better model for the reason the totals
 * service already documents — a charge line carries its own tax rate, while the
 * header fields had none of their own and had to have one apportioned across
 * the goods lines to be taxed at all. One way of entering a charge is enough,
 * and the line is the one that shows on the document.
 *
 * But the columns stay, and so does the arithmetic, because **documents already
 * raised keep their figures**. This renders nothing at all on the ordinary
 * document, and on one carrying a legacy amount it says so rather than leaving
 * money in the total with nothing on screen to explain it — which is what
 * simply deleting the inputs would have done.
 *
 * The button is the way out. Without it a legacy amount would be permanently
 * stuck: no input to clear it, and a total nobody could reconcile. It moves the
 * two into one charge line and zeroes them, taking **the rate most of the goods
 * lines already use** — on a single-rate document, which is the ordinary case,
 * that is exactly what the apportionment was doing, so the grand total does not
 * move. Where the lines carry different rates it can shift, and the note says
 * so instead of pretending otherwise.
 */
export function HeaderCharges({
  freight, insurance, currency, items, onChange,
}: {
  freight: number;
  insurance: number;
  currency: string;
  items: LineItem[];
  onChange: (patch: { freight: number; insurance: number; items: LineItem[] }) => void;
}) {
  const total = (Number(freight) || 0) + (Number(insurance) || 0);
  if (total <= 0) return null;

  const goods = items.filter((i) => !i.is_charge);
  const tally = new Map<number, number>();
  for (const g of goods) {
    const r = Number(g.tax_pct) || 0;
    tally.set(r, (tally.get(r) ?? 0) + 1);
  }
  const rate = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const mixedRates = tally.size > 1;

  const move = () =>
    onChange({
      freight: 0,
      insurance: 0,
      items: [
        ...items,
        {
          description: 'Freight & Insurance',
          is_charge: 1,
          hsn_code: '',
          qty: null,
          unit: 'unit',
          unit_price: total,
          tax_pct: rate,
          color: '',
          packs: null,
          pcs_per_pack: null,
          total_pcs: null,
          custom1: '', custom2: '', custom3: '',
        } as LineItem,
      ],
    });

  return (
    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <div className="font-semibold">
        This document carries {fmtMoney(freight, currency)} freight and {fmtMoney(insurance, currency)} insurance
        in its header
      </div>
      <p className="mt-0.5 text-amber-800">
        Entered before charges moved onto their own line. The amount is still in the total, which is why
        the lines below do not sum to it. Moving it into a charge line makes it visible on the document.
        {mixedRates
          ? ' Your lines carry more than one tax rate, so the total may shift slightly — check it afterwards.'
          : ''}
      </p>
      <Button variant="secondary" className="mt-2" onClick={move}>
        Move into a charge line{rate ? ` at ${rate}%` : ''}
      </Button>
    </div>
  );
}
