import { useState } from 'react';
import type { ColumnConfig } from '../types';
import { Button, Input } from './ui';

export interface ToggleableColumn { key: string; label: string }

/**
 * Optional columns per document type, listed in the order the line-items
 * editor and the quotation PDF lay them out, so the tick-list reads the same
 * way as the table it controls.
 */
export const ITEM_COLUMNS: ToggleableColumn[] = [
  { key: 'image', label: 'Product photo' },
  { key: 'hsn', label: 'HSN Code' },
  { key: 'pcs_per_pack', label: 'Pcs per box' },
  { key: 'packs', label: 'Boxes / Cartons' },
  { key: 'qty_20ft', label: 'Boxes per 20ft' },
  { key: 'qty_40ft', label: 'Boxes per 40ft HC' },
  { key: 'total_pcs', label: 'Total pieces' },
  { key: 'qty', label: 'Quantity' },
  { key: 'color', label: 'Colour' },
  { key: 'unit_price', label: 'Unit Price' },
  { key: 'uom', label: 'UOM / Rate basis' },
  { key: 'per_1000', label: 'Rate per 1000 pcs' },
  { key: 'tax', label: 'Tax %' },
  { key: 'code', label: 'Code (size/spec)' },
  { key: 'supplier', label: 'Supplier' },
  { key: 'amount', label: 'Amount / line total' },
];

/**
 * Columns a quotation does not carry — in the editor, in the tick-list, or on
 * the PDF.
 *
 * `hsn`: a quotation is not a tax document. The value is still stored and
 * still carries forward to the proforma and invoice, where GST needs it.
 *
 * `qty`: the amount follows the packing figures now — boxes × pcs/box gives
 * Total Qty, and that divided by the rate basis is what gets billed. A second
 * quantity field could only contradict it. See billedQty() in
 * server/src/services/totals.ts.
 */
export const QUOTATION_OMIT = ['hsn', 'qty'];

/**
 * Columns a proforma does not carry.
 *
 * `hsn`: Aglo's own proformas state the HS code once, in the customs block
 * (`hs_code` on the header), never per line — see the Emeraude sample in
 * `D:\Quotation Doc\`. The per-line value is still stored and still carries
 * forward to the commercial invoice, which does print it.
 *
 * `qty`: same reasoning as the quotation — one quantity per line, not two that
 * can disagree. A proforma is often billed by weight rather than by piece, so
 * Total Qty is read in whatever the rate basis is: pieces against a per-1000
 * rate, kilos against a per-kg one. See billedQty() in
 * server/src/services/totals.ts, which falls back to Total Qty for exactly
 * this reason.
 */
export const PROFORMA_OMIT = ['hsn', 'qty'];

/** Container loadability is meaningless to a domestic GST buyer. */
export const LOADABILITY_COLUMNS = ['qty_20ft', 'qty_40ft'];

/**
 * Columns a **new** document starts with turned off.
 *
 * Loadability is planning information, not something most documents need to
 * state: it answers "how many boxes fill a container", which matters while a
 * shipment is being worked out and clutters every line the rest of the time.
 * The Container Planner and the proforma's Container Fitment panel are where
 * that question actually gets asked. Ticking the box brings the column back
 * for that one document.
 *
 * This is a **default, not a rule** — it is written into the document's own
 * `column_config` when it is created, so the choice is stored with the
 * document rather than re-applied on every read. Two things follow from that:
 * a document already raised keeps whatever it was saved with, and changing
 * this list later does not silently reformat anything on file.
 */
export const DEFAULT_HIDDEN_COLUMNS = [...LOADABILITY_COLUMNS];

/** The column config a new document starts from. */
export function newColumnConfig(): ColumnConfig {
  return { hidden: [...DEFAULT_HIDDEN_COLUMNS] };
}

/**
 * Whether a config carries a choice somebody actually made.
 *
 * Carry-forward copies the source document's columns onto the new one, which
 * is right when the source has preferences and wrong when it has none — an
 * older quotation saved before these defaults existed would otherwise hand a
 * blank config to the proforma and undo them.
 */
export function hasColumnPrefs(config?: ColumnConfig | null): config is ColumnConfig {
  return !!(config?.hidden?.length || config?.custom?.some(Boolean));
}

const withLoadability = (omit: string[], isExport: boolean) =>
  (isExport ? omit : [...omit, ...LOADABILITY_COLUMNS]);

const columnsFor = (omit: string[]) => ITEM_COLUMNS.filter((c) => !omit.includes(c.key));

/** What a quotation offers, given whether it is an export document. */
export function quotationOmit(isExport: boolean): string[] {
  return withLoadability(QUOTATION_OMIT, isExport);
}

export function quotationColumns(isExport: boolean): ToggleableColumn[] {
  return columnsFor(quotationOmit(isExport));
}

export function proformaOmit(isExport: boolean): string[] {
  return withLoadability(PROFORMA_OMIT, isExport);
}


export const PACKING_COLUMNS: ToggleableColumn[] = [
  { key: 'hsn', label: 'HSN Code' },
  { key: 'packages', label: 'Qty in Boxes' },
  { key: 'thousand_pcs', label: 'Thousand Pcs' },
  { key: 'net_weight', label: 'Net Weight' },
  { key: 'gross_weight', label: 'Gross Weight' },
];

/**
 * Lets the user hide columns they don't need and name up to three custom
 * columns. Columns with no data anywhere are dropped from the PDF automatically;
 * this control is for explicitly forcing one off.
 */
export default function ColumnsControl({
  config, onChange, columns = ITEM_COLUMNS, disabled,
}: {
  config: ColumnConfig;
  onChange: (c: ColumnConfig) => void;
  columns?: ToggleableColumn[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hidden = new Set(config.hidden ?? []);
  const custom = config.custom ?? ['', '', ''];

  const toggle = (key: string) => {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key); else next.add(key);
    onChange({ ...config, hidden: [...next] });
  };

  const setCustom = (i: number, value: string) => {
    const next = [custom[0] ?? '', custom[1] ?? '', custom[2] ?? ''];
    next[i] = value;
    onChange({ ...config, custom: next });
  };

  const hiddenCount = hidden.size;
  const customCount = custom.filter(Boolean).length;

  return (
    <div className="relative">
      <Button variant="secondary" onClick={() => setOpen((o) => !o)} disabled={disabled}>
        ⚙ Columns{hiddenCount || customCount ? ` (${hiddenCount ? `${hiddenCount} hidden` : ''}${hiddenCount && customCount ? ', ' : ''}${customCount ? `${customCount} custom` : ''})` : ''}
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-72 rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
            <div className="mb-2 text-xs font-semibold uppercase text-slate-500">Show columns</div>
            <div className="space-y-1">
              {columns.map((c) => (
                <label key={c.key} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={!hidden.has(c.key)} onChange={() => toggle(c.key)} />
                  {c.label}
                </label>
              ))}
            </div>
            <div className="mt-3 border-t border-slate-100 pt-2">
              <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Custom columns</div>
              <div className="space-y-1.5">
                {[0, 1, 2].map((i) => (
                  <Input
                    key={i}
                    value={custom[i] ?? ''}
                    onChange={(e) => setCustom(i, e.target.value)}
                    placeholder={`Custom column ${i + 1} name (e.g. Mould No.)`}
                  />
                ))}
              </div>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Empty columns are hidden on the PDF automatically. Unticking one hides it even when it has data.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Columns every document except the quotation shows but does not let you turn
 * off.
 *
 * `amount`: a quotation may be sent as a rate-and-packing price list with the
 * line totals and grand total deliberately left off. An invoice may not — one
 * with no amounts cannot be presented for GST or customs — and a proforma is
 * what an advance is paid against, so it has to state what is owed.
 *
 * This is deliberately **not** part of PROFORMA_OMIT, and there is a bug in the
 * difference. An `omit` list is read by `LineItemsEditor` as well as by the
 * tick-list, and there it means "this document never has this column at all"
 * — so putting `amount` in it did not merely stop the column being toggled, it
 * removed the Amount column from the proforma editor outright. "Not offered as
 * a choice" and "never present" are different things and need different lists.
 */
const NOT_TOGGLEABLE_OUTSIDE_QUOTATION = ['amount'];

/**
 * Columns a document type shows **whatever its stored config says**.
 *
 * Taking a column out of the tick-list only stops it being turned off *here*.
 * A config is not made here alone: carry-forward copies the source document's
 * columns onto the new one, and a quotation sent as a rate-and-packing price
 * list carries `amount` in its hidden list. That landed on the proforma raised
 * from it, where there is no tick to turn it back on — a proforma with no
 * Amount column and no way to get one, which is what an advance is paid
 * against. The same config then rides on to the order and the commercial
 * invoice.
 *
 * So the rule is enforced where the columns are drawn rather than only where
 * they are chosen: `LineItemsEditor` takes these as `forced` and the PDF
 * builders apply the same list. It is derived on every read, so a document
 * already saved with the bad config repairs itself and no migration is needed.
 *
 * `total_pcs` on the proforma: `qty` is omitted there — one quantity per line,
 * never two that can disagree — which leaves Total Qty as the proforma's
 * *only* quantity column. Hidden, the document cannot say how much of what is
 * being bought, and the amount it inherits is blank because nothing can be
 * typed to produce one. Orders and invoices keep Qty, so they do not need it.
 */
export const PROFORMA_FORCED = ['total_pcs', ...NOT_TOGGLEABLE_OUTSIDE_QUOTATION];
export const INVOICE_FORCED = NOT_TOGGLEABLE_OUTSIDE_QUOTATION;
export const ORDER_FORCED = NOT_TOGGLEABLE_OUTSIDE_QUOTATION;

/** The tick-list for a proforma: its own omissions, plus what it always shows. */
export function proformaColumns(isExport: boolean): ToggleableColumn[] {
  return columnsFor([...proformaOmit(isExport), ...PROFORMA_FORCED]);
}

export function invoiceColumns(): ToggleableColumn[] {
  return columnsFor(INVOICE_FORCED);
}

export function orderColumns(): ToggleableColumn[] {
  return columnsFor(ORDER_FORCED);
}
