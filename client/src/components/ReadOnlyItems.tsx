import type { LineItem } from '../types';
import { fmtMoney, fmtQty } from '../lib/format';

/**
 * The line items of a document that can no longer be edited.
 *
 * Shared by the quotation (superseded revisions) and the proforma (converted
 * into an order). Deliberately its own component rather than a `readOnly` flag
 * on `LineItemsEditor`: that editor is a grid of inputs with product pickers,
 * packing rows and per-line arithmetic, and disabling all of it would leave a
 * form pretending to be a table. This is the table.
 *
 * Packing columns appear only when some line carries packing, so a
 * weight-billed document does not print three empty columns.
 */
export default function ReadOnlyItems({ items, currency }: { items: LineItem[]; currency: string }) {
  const hasPacking = items.some((it) => it.pcs_per_pack != null || it.packs != null || it.total_pcs != null);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
          <th className="pb-1 pr-3">Description</th>
          {hasPacking && <th className="pb-1 pr-3 text-right">Pcs/Box</th>}
          {hasPacking && <th className="pb-1 pr-3 text-right">Boxes</th>}
          {hasPacking && <th className="pb-1 pr-3 text-right">Total Qty</th>}
          <th className="pb-1 pr-3 text-right">Qty</th>
          <th className="pb-1 pr-3 text-right">Unit Price</th>
          <th className="pb-1 pr-3">Unit</th>
          <th className="pb-1 text-right">Amount</th>
        </tr>
      </thead>
      <tbody>
        {items.map((it, i) => (
          <tr key={i} className="border-b border-slate-100 last:border-0">
            <td className="py-1.5 pr-3">{it.description}</td>
            {hasPacking && <td className="py-1.5 pr-3 text-right tabular-nums">{it.pcs_per_pack != null ? fmtQty(it.pcs_per_pack) : '—'}</td>}
            {hasPacking && <td className="py-1.5 pr-3 text-right tabular-nums">{it.packs != null ? fmtQty(it.packs) : '—'}</td>}
            {hasPacking && <td className="py-1.5 pr-3 text-right tabular-nums">{it.total_pcs != null ? fmtQty(it.total_pcs) : '—'}</td>}
            <td className="py-1.5 pr-3 text-right tabular-nums">{it.qty != null ? fmtQty(it.qty) : '—'}</td>
            <td className="py-1.5 pr-3 text-right tabular-nums">{fmtMoney(it.unit_price, currency)}</td>
            <td className="py-1.5 pr-3">{it.unit}</td>
            <td className="py-1.5 text-right tabular-nums">{it.qty != null ? fmtMoney((it.amount ?? it.qty * it.unit_price), currency) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
