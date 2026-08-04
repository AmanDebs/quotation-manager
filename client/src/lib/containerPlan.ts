/**
 * Working out what mix of products fills a container.
 *
 * The catalogue records, per product, how many boxes of it fill a 20ft and a
 * 40ft container. Different products box up differently, so capacity is not a
 * single number — one box of product i occupies 1/Cᵢ of a container, where Cᵢ
 * is that product's boxes-per-container. A mixed load therefore has to satisfy
 *
 *     Σ (boxesᵢ / Cᵢ)  ≤  number of containers
 *
 * which is what both modes below solve, in opposite directions.
 *
 * One plan covers containers of a single size. A shipment using both a 20ft
 * and a 40ft is two plans, because the space a box occupies is expressed as a
 * fraction of its own container type.
 */

export type ContainerSize = '20ft' | '40ft';
/** Whether the ratio (or requirement) is expressed in boxes or in pieces. */
export type Basis = 'boxes' | 'pieces';

const EPS = 1e-9;

export interface PlanInput {
  productId: number;
  name: string;
  pcsPerBox: number | null;
  boxesPerContainer: number | null;
  /** Mode A: relative share. Mode B: how much is required. */
  value: number;
}

export interface PlanRow extends PlanInput {
  boxes: number;
  pieces: number | null;
  /** Containers' worth of space this line occupies. */
  space: number;
  /** Share of the total space used, as a percentage. */
  sharePct: number;
  issue?: string;
}

export interface PlanResult {
  rows: PlanRow[];
  /** Containers the plan actually uses. */
  containers: number;
  /** Total space consumed, in containers (e.g. 1.94 of 2). */
  spaceUsed: number;
  /** 0–100. */
  utilisation: number;
  /** What could still be squeezed in, named for the roomiest remaining product. */
  leftover: { name: string; boxes: number } | null;
  issues: string[];
}

const usable = (l: PlanInput) => l.boxesPerContainer != null && l.boxesPerContainer > 0 && l.value > 0;

function issueFor(l: PlanInput): string | undefined {
  if (l.boxesPerContainer == null || l.boxesPerContainer <= 0) return 'No boxes-per-container set for this size';
  if (l.value <= 0) return undefined;
  return undefined;
}

function finish(rows: PlanRow[], containers: number): PlanResult {
  const spaceUsed = rows.reduce((s, r) => s + r.space, 0);
  const withShare = rows.map((r) => ({ ...r, sharePct: spaceUsed > 0 ? (r.space / spaceUsed) * 100 : 0 }));

  // Express the gap in something loadable: boxes of whichever line packs
  // smallest, since that is what actually fits into an awkward remainder.
  const gap = containers - spaceUsed;
  let leftover: PlanResult['leftover'] = null;
  if (gap > EPS) {
    const candidates = withShare.filter((r) => r.boxesPerContainer && r.boxes > 0);
    const best = candidates.sort((a, b) => b.boxesPerContainer! - a.boxesPerContainer!)[0];
    if (best) leftover = { name: best.name, boxes: Math.floor(gap * best.boxesPerContainer! + EPS) };
  }

  return {
    rows: withShare,
    containers,
    spaceUsed: Math.round(spaceUsed * 1000) / 1000,
    utilisation: containers > 0 ? Math.min(100, Math.round((spaceUsed / containers) * 1000) / 10) : 0,
    leftover: leftover && leftover.boxes > 0 ? leftover : null,
    issues: withShare.map((r) => r.issue).filter((x): x is string => !!x),
  };
}

/**
 * Mode A — "I have N containers, what mix goes in them?"
 *
 * Scales the requested ratio until the containers are exactly full, then rounds
 * to whole boxes and hands the rounding remainder back out largest-share-first,
 * so the answer stays loadable without wasting the space rounding freed up.
 */
export function planFill(lines: PlanInput[], size: ContainerSize, containers: number, basis: Basis): PlanResult {
  void size; // capacity is already resolved into boxesPerContainer by the caller
  const active = lines.filter(usable);
  const rows: PlanRow[] = lines.map((l) => ({
    ...l, boxes: 0, pieces: l.pcsPerBox ? 0 : null, space: 0, sharePct: 0, issue: issueFor(l),
  }));
  if (!active.length || containers <= 0) return finish(rows, Math.max(0, containers));

  // Space consumed per unit of ratio weight, in containers.
  const spacePerUnit = (l: PlanInput) =>
    basis === 'boxes'
      ? 1 / l.boxesPerContainer!
      : 1 / ((l.pcsPerBox && l.pcsPerBox > 0 ? l.pcsPerBox : 1) * l.boxesPerContainer!);

  const denominator = active.reduce((s, l) => s + l.value * spacePerUnit(l), 0);
  if (denominator <= 0) return finish(rows, containers);
  const k = containers / denominator;

  // Exact (fractional) box counts implied by the ratio.
  const exact = new Map<number, number>();
  for (const l of active) {
    const amount = k * l.value; // in the chosen basis
    const boxes = basis === 'boxes' ? amount : amount / (l.pcsPerBox && l.pcsPerBox > 0 ? l.pcsPerBox : 1);
    exact.set(l.productId, boxes);
  }

  for (const r of rows) {
    const e = exact.get(r.productId);
    if (e === undefined) continue;
    r.boxes = Math.floor(e + EPS);
    r.space = r.boxes / r.boxesPerContainer!;
  }

  // Give the rounding remainder back, one box at a time, to whichever line is
  // furthest below its exact share and still fits.
  let remaining = containers - rows.reduce((s, r) => s + r.space, 0);
  const deficit = new Map<number, number>();
  for (const l of active) deficit.set(l.productId, (exact.get(l.productId) ?? 0) - (rows.find((r) => r.productId === l.productId)?.boxes ?? 0));

  for (;;) {
    const candidates = rows
      .filter((r) => usable(r) && 1 / r.boxesPerContainer! <= remaining + EPS)
      .sort((a, b) => (deficit.get(b.productId) ?? 0) - (deficit.get(a.productId) ?? 0));
    const pick = candidates[0];
    if (!pick) break;
    pick.boxes += 1;
    pick.space = pick.boxes / pick.boxesPerContainer!;
    remaining -= 1 / pick.boxesPerContainer!;
    deficit.set(pick.productId, (deficit.get(pick.productId) ?? 0) - 1);
  }

  for (const r of rows) r.pieces = r.pcsPerBox ? r.boxes * r.pcsPerBox : null;
  return finish(rows, containers);
}

/**
 * Mode B — "This is what I have to ship, how many containers is that?"
 *
 * `value` is the required quantity, in boxes or pieces. Pieces round up to
 * whole boxes, because a part-filled box still occupies a box of space.
 */
export function planRequirement(lines: PlanInput[], size: ContainerSize, basis: Basis): PlanResult {
  void size;
  const rows: PlanRow[] = lines.map((l) => {
    const issue = issueFor(l);
    const boxes = l.value <= 0
      ? 0
      : basis === 'boxes'
        ? Math.ceil(l.value - EPS)
        : Math.ceil(l.value / (l.pcsPerBox && l.pcsPerBox > 0 ? l.pcsPerBox : 1) - EPS);
    return {
      ...l,
      boxes,
      pieces: l.pcsPerBox ? boxes * l.pcsPerBox : null,
      space: l.boxesPerContainer ? boxes / l.boxesPerContainer : 0,
      sharePct: 0,
      issue: issue ?? (basis === 'pieces' && !l.pcsPerBox && l.value > 0 ? 'No pcs/box set — cannot convert pieces to boxes' : undefined),
    };
  });
  const spaceUsed = rows.reduce((s, r) => s + r.space, 0);
  return finish(rows, Math.ceil(spaceUsed - EPS));
}

/** Capacity for the chosen container size, or null when the product has none recorded. */
export function capacityFor(p: { qty_20ft: number | null; qty_40ft: number | null }, size: ContainerSize): number | null {
  return size === '20ft' ? p.qty_20ft : p.qty_40ft;
}
