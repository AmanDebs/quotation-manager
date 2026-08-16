import { db } from '../db/connection.js';
import { round2 } from './totals.js';

/**
 * What a product is made of, and therefore what a job needs.
 *
 * The one place allowed to answer "how much material does this take" — the
 * same rule `services/receivables.ts` follows for credit. Everything is
 * expressed **per 1000 pieces**, because that is the basis the whole catalogue
 * is quoted and priced on: a 119 g preform is 119 kg of resin per 1000.
 *
 * A product with no recipe is the normal starting state — the real order desk
 * records material as one word, "HDPE", and nothing finer. So `requirementFor`
 * reports `hasRecipe: false` rather than a requirement of zero. Zero would read
 * as "needs nothing", and a shortfall report built on that would cheerfully
 * say every job is covered.
 */

export interface RecipeLine {
  material_id: number;
  name: string;
  category: string;
  unit: string;
  qty_per_1000: number;
  wastage_pct: number;
}

export interface RequirementLine extends RecipeLine {
  /** Stock units needed for the piece count asked about, wastage included. */
  qty: number;
}

const recipeSql = `
  SELECT pm.material_id, pm.qty_per_1000, pm.wastage_pct,
         m.name, m.category, m.unit
  FROM product_materials pm
  JOIN materials m ON m.id = pm.material_id
  WHERE pm.product_id = ?
  ORDER BY pm.sort_order, pm.id`;

export function recipeFor(productId: number): RecipeLine[] {
  return db.prepare(recipeSql).all(productId) as unknown as RecipeLine[];
}

/** True when this product has anything recorded at all. */
export function hasRecipe(productId: number): boolean {
  const row = db.prepare('SELECT COUNT(*) AS c FROM product_materials WHERE product_id = ?').get(productId) as { c: number };
  return row.c > 0;
}

/**
 * Material needed to make `pieces` of this product.
 *
 * `hasRecipe: false` means the question cannot be answered, which callers must
 * show as "not costed" — never as nothing needed.
 */
export function requirementFor(
  productId: number | null | undefined,
  pieces: number | null | undefined
): { hasRecipe: boolean; lines: RequirementLine[] } {
  if (!productId) return { hasRecipe: false, lines: [] };
  const recipe = recipeFor(productId);
  if (!recipe.length) return { hasRecipe: false, lines: [] };
  const thousands = (Number(pieces) || 0) / 1000;
  return {
    hasRecipe: true,
    lines: recipe.map((r) => ({
      ...r,
      qty: round2(thousands * r.qty_per_1000 * (1 + (r.wastage_pct || 0) / 100)),
    })),
  };
}

/** Adds requirements for several jobs into one figure per material. */
export function totalRequirement(
  jobs: { product_id: number | null; pieces: number | null }[]
): { lines: RequirementLine[]; uncosted: number } {
  const byMaterial = new Map<number, RequirementLine>();
  let uncosted = 0;
  for (const job of jobs) {
    const { hasRecipe: ok, lines } = requirementFor(job.product_id, job.pieces);
    if (!ok) { uncosted += 1; continue; }
    for (const line of lines) {
      const seen = byMaterial.get(line.material_id);
      if (seen) seen.qty = round2(seen.qty + line.qty);
      else byMaterial.set(line.material_id, { ...line });
    }
  }
  return { lines: [...byMaterial.values()], uncosted };
}
