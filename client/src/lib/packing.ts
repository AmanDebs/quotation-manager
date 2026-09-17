import { piecesOrdered } from './pieces';

/**
 * What a packed line weighs, from the catalogue (2026-09-17, the client with
 * the packing list in front of them: *"Net weight – to pick from product
 * weight. Gross weight is 2 kg per box extra"*).
 *
 * Net is the product's grams per piece times the pieces on the line — the
 * figure `products.weight_grams` was added for, and the same number as kilos
 * per 1000 — and gross adds a flat allowance per box for the carton itself.
 * Their example: 3.3 g and 5,000 pieces in a box is 16.5 kg net, and 18.5 kg
 * gross at 2 kg a box.
 *
 * `null`, never 0, where the record cannot say: a product with no weight on
 * file (the catalogue has many, and `weight_grams` is deliberately never
 * guessed), a line naming no product, a weight-billed line with no piece
 * count. Gross alone is `null` where the line states no box count, since the
 * allowance is per box and a guessed count would put a guessed tare on a
 * customs document. Two decimals, the figure the packing list prints.
 */
export const BOX_TARE_KG = 2;

export interface PackedLine {
  qty?: number | null;
  unit?: string | null;
  total_pcs?: number | null;
  packs?: number | null;
  pcs_per_pack?: number | null;
  is_charge?: number | boolean | null;
}

export function boxesOn(line: PackedLine): number | null {
  if (line.packs != null && Number(line.packs) > 0) return Number(line.packs);
  const pieces = piecesOrdered(line);
  if (pieces == null || !line.pcs_per_pack) return null;
  return pieces / Number(line.pcs_per_pack);
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Net plus the carton allowance; `null` with no box count to charge it per. */
export function grossFor(net: number, line: PackedLine): number | null {
  const boxes = boxesOn(line);
  return boxes == null ? null : r2(net + BOX_TARE_KG * boxes);
}

export function packingWeights(line: PackedLine, weightGrams: number | null | undefined): { net: number; gross: number | null } | null {
  if (line.is_charge) return null;
  if (weightGrams == null || !(Number(weightGrams) > 0)) return null;
  const pieces = piecesOrdered(line);
  if (pieces == null) return null;
  const net = r2((Number(weightGrams) * pieces) / 1000);
  return { net, gross: grossFor(net, line) };
}
