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

/* ------------------------------------------------------------------ */
/* THE RECIPE A JOB WAS RAISED AGAINST                                 */
/* ------------------------------------------------------------------ */

/**
 * A job is costed against the recipe **as it stood when it was raised**.
 *
 * `product_materials` is live and editable, so reading a job through it costs
 * the job against whatever the recipe says today: correct a resin quantity in
 * March and every open job silently restates what it needs, which is exactly
 * the production drift a BOM snapshot exists to prevent. The fix is the one
 * this codebase already applies twice — `qc_results` copies the tolerance onto
 * the result, `material_moves.rate` stamps what a unit cost on arrival.
 *
 * **Silence falls back rather than meaning zero.** A job with no snapshot is
 * read through the live recipe, which covers both jobs raised before this
 * existed and jobs raised for a product that had no recipe at the time — so
 * nothing already on file changes its answer, and a recipe recorded later
 * still reaches the jobs that were waiting for one.
 */

const snapshotSql = `
  SELECT wm.material_id, wm.qty_per_1000, wm.wastage_pct,
         m.name, m.category, m.unit
  FROM work_order_materials wm
  JOIN materials m ON m.id = wm.material_id
  WHERE wm.work_order_id = ?
  ORDER BY wm.sort_order, wm.id`;

/** The recipe stamped on this job, or an empty list if it carries none. */
export function recipeForJob(workOrderId: number): RecipeLine[] {
  return db.prepare(snapshotSql).all(workOrderId) as unknown as RecipeLine[];
}

/**
 * Copy the product's current recipe onto a job, replacing whatever it had.
 *
 * Called when a job is raised, inside that transaction, and again only when
 * somebody explicitly asks for it — see `POST /work-orders/:id/recipe-snapshot`.
 * Writing nothing for a product with no recipe is deliberate: the job then
 * falls back, and picks up a recipe recorded afterwards.
 */
export function snapshotRecipe(workOrderId: number, productId: number | null | undefined): void {
  db.prepare('DELETE FROM work_order_materials WHERE work_order_id = ?').run(workOrderId);
  if (!productId) return;
  db.prepare(
    `INSERT INTO work_order_materials (work_order_id, material_id, qty_per_1000, wastage_pct, sort_order)
     SELECT ?, material_id, qty_per_1000, wastage_pct, sort_order
       FROM product_materials WHERE product_id = ?`
  ).run(workOrderId, productId);
}

/**
 * What a job still needs, against the recipe it was raised on.
 *
 * The counterpart to `requirementFor`, which answers for a *product* and is
 * still the right question where there is no job to ask about — the order-book
 * shortfall counts lines nobody has raised a job for yet.
 *
 * `snapshot` says which recipe answered, so the screen can tell somebody that
 * a job is costed against an older one and offer to bring it up to date. A job
 * reading the live recipe is not stale; it simply never had one stamped.
 */
export function requirementForJob(
  workOrderId: number,
  productId: number | null | undefined,
  pieces: number | null | undefined
): { hasRecipe: boolean; snapshot: boolean; lines: RequirementLine[] } {
  const stamped = recipeForJob(workOrderId);
  if (stamped.length) return { ...spread(stamped, pieces), snapshot: true };
  return { ...requirementFor(productId, pieces), snapshot: false };
}

/** The per-1000 figures applied to a piece count. */
function spread(recipe: RecipeLine[], pieces: number | null | undefined) {
  const thousands = (Number(pieces) || 0) / 1000;
  return {
    hasRecipe: true,
    lines: recipe.map((r) => ({
      ...r,
      qty: round2(thousands * r.qty_per_1000 * (1 + (r.wastage_pct || 0) / 100)),
    })),
  };
}

/**
 * Whether a job's stamped recipe still matches the product's.
 *
 * Compared on the figures alone — material, quantity per 1000 and wastage —
 * because those are what a requirement is made of; a material renamed on the
 * master is the same material. A job with no snapshot is never "differs": it
 * is reading the live recipe already.
 */
export function recipeDiffers(workOrderId: number, productId: number | null | undefined): boolean {
  const stamped = recipeForJob(workOrderId);
  if (!stamped.length) return false;
  const live = productId ? recipeFor(productId) : [];
  const key = (r: RecipeLine[]) => JSON.stringify(
    r.map((l) => [l.material_id, l.qty_per_1000, l.wastage_pct]).sort((a, b) => a[0] - b[0])
  );
  return key(stamped) !== key(live);
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
