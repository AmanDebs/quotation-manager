import { db } from '../db/connection.js';
import { LIVE_OK } from './production.js';
import { shiftCapacity } from './runPlan.js';
import { productionLines, SHIFTS } from './shifts.js';
import { round2 } from './totals.js';

/**
 * The production plan and what came of it, folded whichever way was asked for
 * (2026-11-24, the brief's *"Management Dashboard displaying product-wise
 * production status, colour-wise breakup, work order progress, shift-wise
 * output, line-wise utilization, pending vs completed"* — six cuts of one
 * body of facts, with filters for date, product, colour, work order, line and
 * shift).
 *
 * **Six fixed sheets would have been the literal build and a configurable
 * fold is the better one**, which is the call `pivotOrderLines` already made
 * about the order book: every one of those six is this grid with different
 * rows and a different measure, and the seventh question nobody has asked yet
 * is a release away otherwise. The shape is that pivot's exactly — the same
 * dimension and measure tables, the same capped column axis, the same row
 * type on the wire — so the client draws it with the same component rather
 * than a third copy of a grid.
 *
 * **The grain is one allocation of one run**, which is the only grain that can
 * answer all six: a run says date, line and shift, and its allocation says
 * product, colour and work order. Everything else is a fold over that.
 */

/** The tail of a capped column axis. A real value cannot contain NUL. */
export const PROD_OTHER = '\u0000';

/** At most this many columns before the rest are gathered into `PROD_OTHER`. */
const MAX_COLUMNS = 40;

export interface ProductionFilter {
  /** Inclusive, on the run's own date. */
  from?: string;
  to?: string;
  machine_id?: number;
  shift?: string;
  product_id?: number;
  color?: string;
  work_order_id?: number;
  /** '' | 'open' | 'done' — whether the shift has been signed off. */
  signed?: string;
  scopeSql?: string;
  scopeParams?: unknown[];
}

/** One work order's share of one run, with what that share actually got. */
export interface ProductionRow {
  run_id: number;
  date: string;
  machine_id: number;
  line_name: string;
  shift: string;
  /** '' while the shift is open, 'done' once signed off. */
  signed: string;
  product_id: number | null;
  product_name: string;
  color: string;
  work_order_id: number;
  job_number: string;
  order_id: number;
  order_number: string;
  customer_name: string;
  planned: number;
  made: number;
  rejected: number;
  /**
   * The **run's** own, carried on every one of its allocations and summed
   * once per run — see the `once` measures below.
   */
  downtime_mins: number;
  capacity: number | null;
}

interface DimSpec {
  key: string;
  label: string;
  /** The query key a cell drills through on, or '' where none can. */
  param: string;
  kind: 'values' | 'plain' | 'month' | 'date';
  of: (r: ProductionRow) => string;
}

interface MeasureSpec {
  key: string;
  label: string;
  of: (r: ProductionRow) => number;
  /** Count the distinct runs behind the cell rather than summing a figure. */
  distinct?: boolean;
  /**
   * Sum `of` **once per run** rather than once per allocation. A line's
   * downtime and a shift's capacity are facts about the *run*, so adding them
   * up over its allocations would count a shared run's stoppage twice.
   */
  once?: boolean;
}

const monthOf = (d: string) => (d && d.length >= 7 ? d.slice(0, 7) : '');

/**
 * **`param` is what the drill target honours, not what this sheet filters
 * by.** The two are different lists and conflating them is a link that lies:
 * a cell drills into the **board**, which narrows by date, line and shift and
 * by nothing else, so a product or colour cell carrying `product_id` would
 * land on a board showing every product — a list that does not add up to the
 * figure it was clicked from, which is the one thing `OrderPivot` says a cell
 * must never do. Found by reading a rendered href. Those four are drawn as
 * **text**, and the sheet still takes all six as filters by URL.
 */
const DIMENSIONS: DimSpec[] = [
  { key: 'product', label: 'Product', param: '', kind: 'plain', of: (r) => (r.product_id ? String(r.product_id) : '') },
  { key: 'color', label: 'Colour', param: '', kind: 'values', of: (r) => r.color },
  { key: 'job', label: 'Work order', param: '', kind: 'plain', of: (r) => r.job_number },
  { key: 'line', label: 'Line', param: 'machine_id', kind: 'plain', of: (r) => String(r.machine_id) },
  { key: 'shift', label: 'Shift', param: 'shift', kind: 'plain', of: (r) => r.shift },
  { key: 'date', label: 'Date', param: 'date', kind: 'date', of: (r) => r.date },
  { key: 'month', label: 'Month', param: '', kind: 'month', of: (r) => monthOf(r.date) },
  { key: 'customer', label: 'Customer', param: '', kind: 'values', of: (r) => r.customer_name },
  { key: 'order', label: 'Sales order', param: '', kind: 'values', of: (r) => r.order_number },
  { key: 'signed', label: 'Signed off', param: '', kind: 'plain', of: (r) => (r.signed === 'done' ? 'done' : 'open') },
];

const MEASURES: MeasureSpec[] = [
  { key: 'planned', label: 'Pieces planned', of: (r) => r.planned },
  // Already `LIVE_OK`, so a condemned lot counts for nothing here either.
  { key: 'made', label: 'Pieces made', of: (r) => r.made },
  { key: 'rejected', label: 'Pieces rejected', of: (r) => r.rejected },
  /*
   * Clamped per allocation and only then summed — `balance`'s own rule from
   * the order pivot. `SUM(MAX(planned - made, 0))` and `SUM(planned) -
   * SUM(made)` part company the moment one shift over-runs, and a shift that
   * beat its plan would otherwise cancel a real shortfall somewhere else.
   */
  { key: 'short', label: 'Not made', of: (r) => Math.max(0, r.planned - r.made) },
  { key: 'downtime', label: 'Downtime (min)', of: (r) => r.downtime_mins, once: true },
  /*
   * What the line could have made of that product in that shift. A sum, so a
   * cell can be read against `made` beside it — which is what *line-wise
   * utilisation* is, and is deliberately **not** offered as a ratio: a pivot
   * cell carries one number, and a percentage would hide both of the figures
   * it was worked out from. A run whose product has no rate contributes
   * nothing rather than a zero.
   */
  { key: 'capacity', label: 'Shift capacity', of: (r) => r.capacity ?? 0, once: true },
  { key: 'allocations', label: 'Work order shares', of: () => 1 },
  /*
   * Distinct, never a sum: a run serving three work orders is one run, and a
   * per-run figure added over its allocations is multiplied by three. The
   * `orders` measure in the order pivot keeps a Set for exactly this, and the
   * same consequence holds — a run whose allocations fall in two cells is
   * counted in each, while the grand total has its own Set and so counts it
   * once.
   */
  { key: 'runs', label: 'Shifts', of: () => 0, distinct: true },
];

export type ProductionDimension = Omit<DimSpec, 'of'>;
/**
 * `money: false` on every one of them, so the shape matches the order pivot's
 * exactly and one client component draws both. Production has no currency:
 * there is one grid and nothing on it is money.
 */
export type ProductionMeasure = Omit<MeasureSpec, 'of' | 'distinct' | 'once'> & { money: false };

export const PRODUCTION_DIMENSIONS: ProductionDimension[] = DIMENSIONS.map(({ of, ...d }) => d);
export const PRODUCTION_MEASURES: ProductionMeasure[] =
  MEASURES.map(({ of, distinct, once, ...m }) => ({ ...m, money: false as const }));

export interface ProductionPivotRow {
  /** One raw value per row dimension — what this row's links filter on. */
  keys: string[];
  cells: Record<string, number>;
  /** Allocations behind each cell, for the hover. */
  counts: Record<string, number>;
  total: number;
  count: number;
}

export interface ProductionPivot {
  rows: string[];
  column: string;
  measure: string;
  money: false;
  columns: string[];
  folded: number;
  grids: {
    currency: string;
    rows: ProductionPivotRow[];
    cells: Record<string, number>;
    total: number;
    count: number;
  }[];
  /** How many allocations the sheet was folded from. */
  lines: number;
  dimensions: ProductionDimension[];
  measures: ProductionMeasure[];
  /** What the whole filtered set comes to, whatever the fold. */
  summary: ProductionSummary;
}

export interface ProductionSummary {
  runs: number;
  allocations: number;
  planned: number;
  made: number;
  rejected: number;
  short: number;
  downtime_mins: number;
  /** Shifts that ran, fell short and nobody has signed off. */
  awaiting: number;
}

/**
 * Every allocation in the filtered window, with what it made.
 *
 * Read in one statement rather than per run — the N+1 this codebase keeps
 * bounding — and **through `LIVE_OK`**, so a scrapped lot is not reported as
 * output here any more than it is on the board or in the gate.
 */
export function productionRows(f: ProductionFilter = {}): ProductionRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, ...p: unknown[]) => { where.push(sql); params.push(...p); };

  if (f.from) add('r.date >= ?', f.from);
  if (f.to) add('r.date <= ?', f.to);
  if (f.machine_id) add('r.machine_id = ?', f.machine_id);
  if (f.shift) add('UPPER(TRIM(r.shift)) = ?', String(f.shift).trim().toUpperCase());
  if (f.product_id) add('COALESCE(w.product_id, 0) = ?', f.product_id);
  if (f.work_order_id) add('a.work_order_id = ?', f.work_order_id);
  // A blank is a real answer here — the lines stating no colour — so it is
  // asked for as `color=` present and empty, the rule the book's own tick
  // lists follow. `undefined` means no filter at all.
  if (f.color !== undefined) add(`COALESCE(NULLIF(oi.color, ''), p.color, '') = ?`, f.color);
  if (f.signed === 'done') add(`r.status = 'done'`);
  if (f.signed === 'open') add(`r.status <> 'done'`);
  if (f.scopeSql) add(f.scopeSql, ...(f.scopeParams ?? []));

  const rows = db.prepare(
    `SELECT r.id AS run_id, r.date, r.machine_id, r.shift, r.status AS signed,
            COALESCE(m.name, '') AS line_name,
            a.work_order_id, a.qty_planned AS planned,
            w.number AS job_number, w.product_id,
            COALESCE(p.name, w.description, '') AS product_name,
            COALESCE(NULLIF(oi.color, ''), p.color, '') AS color,
            w.order_id, o.number AS order_number, c.name AS customer_name,
            COALESCE((SELECT SUM(${LIVE_OK('e')}) FROM production_entries e
                       WHERE e.run_id = r.id AND e.work_order_id = a.work_order_id), 0) AS made,
            COALESCE((SELECT SUM(e.qty_reject) FROM production_entries e
                       WHERE e.run_id = r.id AND e.work_order_id = a.work_order_id), 0) AS rejected,
            COALESCE((SELECT SUM(e.downtime_mins) FROM production_entries e
                       WHERE e.run_id = r.id), 0) AS downtime_mins
       FROM run_allocations a
       JOIN production_runs r ON r.id = a.run_id
       JOIN work_orders w ON w.id = a.work_order_id
       JOIN orders o ON o.id = w.order_id
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN machines m ON m.id = r.machine_id
       LEFT JOIN products p ON p.id = w.product_id
       LEFT JOIN (
         SELECT order_id, color,
                ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY sort_order, id) - 1 AS pos
           FROM order_items
       ) oi ON oi.order_id = w.order_id AND oi.pos = w.order_line
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.date, r.machine_id, r.shift, a.id`
  ).all(...(params as never[])) as Record<string, unknown>[];

  /*
   * Capacity is the line's own and wants a rate per product, so the lines are
   * read once here rather than per row — `shiftCapacity` is memo-free and
   * would otherwise re-measure the shift book for every allocation on the
   * sheet.
   */
  const lines = new Map(productionLines().map((l) => [l.id, l]));
  const capacity = new Map<string, number | null>();
  const capOf = (productId: number | null, machineId: number): number | null => {
    const key = `${productId ?? 0}|${machineId}`;
    if (!capacity.has(key)) {
      const line = lines.get(machineId);
      capacity.set(key, line ? shiftCapacity(productId, line) : null);
    }
    return capacity.get(key) ?? null;
  };

  return rows.map((r) => {
    const productId = r.product_id === null ? null : Number(r.product_id);
    return {
      run_id: Number(r.run_id),
      date: String(r.date ?? ''),
      machine_id: Number(r.machine_id),
      line_name: String(r.line_name ?? ''),
      shift: String(r.shift ?? ''),
      signed: String(r.signed ?? ''),
      product_id: productId,
      product_name: String(r.product_name ?? ''),
      color: String(r.color ?? ''),
      work_order_id: Number(r.work_order_id),
      job_number: String(r.job_number ?? ''),
      order_id: Number(r.order_id),
      order_number: String(r.order_number ?? ''),
      customer_name: String(r.customer_name ?? ''),
      planned: round2(Number(r.planned) || 0),
      made: round2(Number(r.made) || 0),
      rejected: round2(Number(r.rejected) || 0),
      downtime_mins: Number(r.downtime_mins) || 0,
      capacity: capOf(productId, Number(r.machine_id)),
    };
  });
}

/** What the whole filtered set comes to, whatever the fold is. */
export function summariseProduction(rows: ProductionRow[]): ProductionSummary {
  const runs = new Map<number, ProductionRow[]>();
  for (const r of rows) {
    const mine = runs.get(r.run_id) ?? [];
    mine.push(r);
    runs.set(r.run_id, mine);
  }
  let awaiting = 0;
  let downtime = 0;
  for (const [, mine] of runs) {
    // Once per run, for the reason the `once` measures give.
    downtime += mine[0].downtime_mins;
    const planned = mine.reduce((n, r) => n + r.planned, 0);
    const made = mine.reduce((n, r) => n + r.made, 0);
    const started = made > 0 || mine.some((r) => r.rejected > 0) || mine[0].downtime_mins > 0;
    // A shift nobody has booked anything against is not behind — it has not
    // run. The defect the board's own strip shipped with, caught by rendering.
    if (mine[0].signed !== 'done' && started && planned > made) awaiting += 1;
  }
  return {
    runs: runs.size,
    allocations: rows.length,
    planned: round2(rows.reduce((n, r) => n + r.planned, 0)),
    made: round2(rows.reduce((n, r) => n + r.made, 0)),
    rejected: round2(rows.reduce((n, r) => n + r.rejected, 0)),
    short: round2(rows.reduce((n, r) => n + Math.max(0, r.planned - r.made), 0)),
    downtime_mins: downtime,
    awaiting,
  };
}

interface Acc {
  n: number;
  lines: number;
  /** Runs already counted into this cell, for `distinct` and `once`. */
  seen?: Set<number>;
}

/**
 * Fold the production record.
 *
 * In TypeScript over `productionRows`, which is `pivotOrderLines`' own call
 * and for its reasons: the measures are not all sums (one counts distinct
 * runs and two add a per-run figure once), and the clamped shortfall parts
 * company with a grouped subtraction the moment a shift over-runs.
 */
export function pivotProduction(
  f: ProductionFilter = {},
  opts: { rows?: (string | undefined)[]; column?: string; measure?: string } = {},
): ProductionPivot {
  const rows = productionRows(f);

  /*
   * A key the build does not know is **ignored rather than trusted** — the
   * rule the permissions loader states about a stored level — so a stale link
   * falls back to the default instead of drawing a sheet of nothing.
   */
  const dims: DimSpec[] = [];
  for (const key of opts.rows ?? []) {
    const d = DIMENSIONS.find((x) => x.key === key);
    // The same dimension twice down the side is noise, not a second level.
    if (d && !dims.includes(d)) dims.push(d);
  }
  if (!dims.length) dims.push(DIMENSIONS[0]);
  const col = DIMENSIONS.find((d) => d.key === opts.column);
  const measure = MEASURES.find((m) => m.key === opts.measure) ?? MEASURES[0];

  const blank = (): Acc =>
    (measure.distinct || measure.once ? { n: 0, lines: 0, seen: new Set() } : { n: 0, lines: 0 });
  const addTo = (a: Acc, r: ProductionRow) => {
    a.lines += 1;
    if (a.seen) {
      if (a.seen.has(r.run_id)) return;
      a.seen.add(r.run_id);
      a.n += measure.distinct ? 1 : measure.of(r);
      return;
    }
    a.n += measure.of(r);
  };

  /** Row key → its cells, its total, and the dimension values behind it. */
  const byRow = new Map<string, { keys: string[]; cells: Map<string, Acc>; total: Acc }>();
  const colCounts = new Map<string, number>();
  const grand = { cells: new Map<string, Acc>(), total: blank() };

  for (const r of rows) {
    const keys = dims.map((d) => d.of(r));
    const rowKey = keys.join('\u0001');
    let entry = byRow.get(rowKey);
    if (!entry) {
      entry = { keys, cells: new Map(), total: blank() };
      byRow.set(rowKey, entry);
    }
    addTo(entry.total, r);
    addTo(grand.total, r);
    if (!col) continue;
    const c = col.of(r);
    colCounts.set(c, (colCounts.get(c) ?? 0) + 1);
    for (const [map, key] of [[entry.cells, c], [grand.cells, c]] as const) {
      let acc = map.get(key);
      if (!acc) { acc = blank(); map.set(key, acc); }
      addTo(acc, r);
    }
  }

  /*
   * The column axis is capped and the tail gathered, the rule `facetOver`
   * states about a tick list: *Date* across the top of a quarter would
   * otherwise draw ninety columns. A distinct count **unions** into the tail
   * rather than adding, or a run appearing in two folded columns would be
   * counted twice in one cell.
   */
  let columns: string[] = [];
  let folded = 0;
  if (col) {
    const all = [...colCounts.keys()].sort((a, b) => {
      if (col.kind === 'month' || col.kind === 'date') return a.localeCompare(b);
      return (colCounts.get(b) ?? 0) - (colCounts.get(a) ?? 0) || a.localeCompare(b);
    });
    if (all.length > MAX_COLUMNS) {
      const keep = col.kind === 'month' || col.kind === 'date'
        ? all.slice(0, MAX_COLUMNS)
        : [...all].sort((a, b) => (colCounts.get(b) ?? 0) - (colCounts.get(a) ?? 0)).slice(0, MAX_COLUMNS);
      const kept = new Set(keep);
      folded = all.length - keep.length;
      const fold = (map: Map<string, Acc>) => {
        const tail = blank();
        for (const [k, acc] of [...map]) {
          if (kept.has(k)) continue;
          map.delete(k);
          tail.lines += acc.lines;
          if (tail.seen && acc.seen) {
            for (const id of acc.seen) tail.seen.add(id);
            // Re-add only what this run contributes, never the cell's sum.
            tail.n = measure.distinct ? tail.seen.size : tail.n + acc.n;
          } else tail.n += acc.n;
        }
        if (tail.lines) map.set(PROD_OTHER, tail);
      };
      for (const [, e] of byRow) fold(e.cells);
      fold(grand.cells);
      columns = (col.kind === 'month' || col.kind === 'date'
        ? keep : keep.sort((a, b) => a.localeCompare(b))).concat(folded ? [PROD_OTHER] : []);
    } else {
      columns = all;
    }
  }

  const out = (acc: Acc) => (measure.distinct && acc.seen ? acc.seen.size : round2(acc.n));
  const cellsOf = (map: Map<string, Acc>) =>
    Object.fromEntries([...map].map(([k, a]) => [k, out(a)]));
  const countsOf = (map: Map<string, Acc>) =>
    Object.fromEntries([...map].map(([k, a]) => [k, a.lines]));

  const gridRows: ProductionPivotRow[] = [...byRow.values()]
    .map((e) => ({
      keys: e.keys,
      cells: cellsOf(e.cells),
      counts: countsOf(e.cells),
      total: out(e.total),
      count: e.total.lines,
    }))
    .sort((a, b) => b.total - a.total || a.keys.join().localeCompare(b.keys.join()));

  return {
    rows: dims.map((d) => d.key),
    column: col?.key ?? '',
    measure: measure.key,
    money: false,
    columns,
    folded,
    grids: [{
      currency: '',
      rows: gridRows,
      cells: cellsOf(grand.cells),
      total: out(grand.total),
      count: grand.total.lines,
    }],
    lines: rows.length,
    dimensions: PRODUCTION_DIMENSIONS,
    measures: PRODUCTION_MEASURES,
    summary: summariseProduction(rows),
  };
}

/** The shift vocabulary, so the client labels `A` without a second copy. */
export const SHIFT_LABELS: Record<string, string> =
  Object.fromEntries(SHIFTS.map((s) => [s.key, s.label]));
