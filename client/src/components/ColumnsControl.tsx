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
  { key: 'total_pcs', label: 'Total pieces' },
  { key: 'qty', label: 'Quantity' },
  { key: 'color', label: 'Colour' },
  { key: 'unit_price', label: 'Unit Price' },
  { key: 'uom', label: 'UOM / Rate basis' },
  { key: 'per_1000', label: 'Rate per 1000 pcs' },
  { key: 'tax', label: 'Tax %' },
  { key: 'code', label: 'Code (size/spec)' },
  { key: 'supplier', label: 'Supplier' },
];

/**
 * A quotation is not a tax document, so it carries no HSN column — in the
 * editor, in the tick-list, or on the PDF. `hsn_code` is still stored and
 * still carries forward to the proforma and invoice, where GST needs it.
 */
export const QUOTATION_OMIT = ['hsn'];
export const QUOTATION_ITEM_COLUMNS: ToggleableColumn[] =
  ITEM_COLUMNS.filter((c) => !QUOTATION_OMIT.includes(c.key));

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
          <div className="absolute right-0 z-20 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-3 shadow-xl">
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
