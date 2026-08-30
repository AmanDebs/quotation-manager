import { useId } from 'react';
import type { LineItem } from '../types';
import { Button, Input } from './ui';
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
