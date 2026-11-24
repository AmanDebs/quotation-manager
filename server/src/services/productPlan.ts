import { db } from '../db/connection.js';
import { orderLines, type Filters, type OrderLine } from './orderLines.js';
import { JOB_END, JOB_START, LIVE_OK } from './production.js';
import { outputRates, type OutputRate } from './outputRate.js';
import { round2 } from './totals.js';

/**
 * The production plan read from the top: **product → colour → work order**
 * (2026-11-24, the client asking for a product-wise planning and execution
 * system on exactly that hierarchy).
 *
 * **The top two levels are derived, and that is the whole design.** Colour
 * lives on the order line (`order_items.color`, mandatory on every goods line
 * of all four selling documents since 2026-09-17), and a work order is one
 * order line — so a job has exactly one colour by construction, and a
 * product's demand *is* the sum of its colours, which *is* the sum of the work
 * orders under them. The client's reconciliation rules 1 and 2 therefore need
 * no storage, no target column and no sync to keep in step: there is nothing
 * for two figures to disagree about. Storing a product-wise target beside the
 * order lines would be a second answer able to contradict the first, which is
 * what this codebase refuses everywhere else.
 *
 * It also corrects a real misreport. `productDemand` keys a catalogue line on
 * the product **alone** and then copies `color` from whichever line it happened
 * to see first — so two colours of one product fold into one row wearing one
 * arbitrary colour. Folding by the pair is what the hierarchy asks for and
 * what that row should always have said.
 *
 * Nothing here is stored and nothing is a second opinion: the demand is
 * `orderLines`', the output is `LIVE_OK`'s, the dates are `JOB_START`/`JOB_END`
 * and the rate is `outputRates`'. Correct a shift, a line or an order and every
 * figure on this screen follows.
 */

/** One work order under a colour — the bottom level the client can act on. */
export interface PlanJob {
  id: number;
  number: string;
  status: string;
  order_id: number;
  order_number: string;
  customer_name: string;
  /** Pieces this instruction is for. Never edited here — see `qty_planned`. */
  qty_planned: number;
  /** Good pieces booked against it, scrapped lots dropped (`LIVE_OK`). */
  made: number;
  /** Still to make. Floored at zero: an over-run is not negative work. */
  balance: number;
  /** The dates that stand — revised where set, else planned. */
  start: string;
  end: string;
  /** Blank where the job carries no plan at all, which is most of the book. */
  dated: boolean;
}

/** One colour of one product, with the work orders it is wanted for. */
export interface ColourPlan {
  color: string;
  /** Pieces demanded by the customers, in pieces (`piecesOrdered`'s rule). */
  ordered: number;
  /**
   * Pieces the floor has been *instructed* to make — the sum of `qty_planned`
   * over the live jobs on these lines. Equal to `ordered` on an ordinary book,
   * and the gap is `unplanned` below.
   */
  planned: number;
  made: number;
  shipped: number;
  /** What is still owed to the customers: ordered less made, floored. */
  pending: number;
  /**
   * Demand no job covers — the client's reconciliation rule 3 read at this
   * level. **Reported rather than hidden**, the rule this codebase follows
   * about every gap it cannot close by itself (`hasRecipe: false`,
   * `unpriced_qty`, `unplaced`): a planner needs to see that 40,000 pieces of
   * a colour have been sold and instructed to nobody.
   */
  unplanned: number;
  /** Distinct sales orders, and live jobs, behind this colour. */
  orders: number;
  jobs: number;
  /** Of those jobs, how many carry a date at all. */
  dated: number;
  /** Earliest date still owed, over lines not yet fully dispatched. */
  next_due: string;
  work_orders: PlanJob[];
}

/** One product, and the colours it is wanted in. */
export interface ProductPlan {
  key: string;
  product_id: number | null;
  /** The catalogue name, falling back to the line's own wording. */
  item: string;
  code: string;
  unit: string;
  ordered: number;
  planned: number;
  made: number;
  shipped: number;
  pending: number;
  unplanned: number;
  orders: number;
  jobs: number;
  dated: number;
  next_due: string;
  /**
   * How fast this product goes, where the record says — `outputRates`' own
   * answer, stated-beats-measured, **never zero and never a guess**.
   */
  rate: OutputRate | null;
  /**
   * Production days to clear `pending` at that rate, or null where there is no
   * rate to divide by. This is the figure the planner could not get anywhere
   * before: *this product owes 3,00,000 pieces, which is six days*.
   */
  days: number | null;
  colours: ColourPlan[];
}

/** The figures over the whole filtered book, for the strip above the table. */
export interface PlanSummary {
  products: number;
  colours: number;
  jobs: number;
  ordered: number;
  made: number;
  pending: number;
  unplanned: number;
  /** Products carrying pending work that have no output rate to plan by. */
  no_rate: number;
}

/**
 * Every live job on the book, indexed by the order line it is against.
 *
 * **Keyed on `order_id:order_line`**, the index the whole chain is keyed on
 * (`syncPackingList`, `dispatchProgress`, `LINE_AT_POSITION`) and the one
 * `work_orders.order_line` already *is*. A split run is two jobs on one line
 * and both are kept, since both are real instructions.
 *
 * **Cancelled jobs are left out**, as every roll-up in this app leaves them
 * out: a cancelled instruction commits nothing and counting its `qty_planned`
 * would report work nobody is going to do.
 *
 * It is read unscoped and **attached only to lines the caller was already
 * given** — `orderLines(f)` applies the scope clause, so a job on an order
 * this login cannot see is never looked up and never returned. Scoping holds
 * by construction rather than by a second clause that could be forgotten.
 */
function jobsByLine(): Map<string, PlanJob[]> {
  const rows = db.prepare(
    `SELECT w.id, w.number, w.status, w.order_id, w.order_line, w.qty_planned,
            o.number AS order_number, c.name AS customer_name,
            ${JOB_START('w')} AS start, ${JOB_END('w')} AS end,
            COALESCE((SELECT SUM(${LIVE_OK('e')}) FROM production_entries e
                       WHERE e.work_order_id = w.id), 0) AS made
       FROM work_orders w
       JOIN orders o ON o.id = w.order_id
       JOIN customers c ON c.id = o.customer_id
      WHERE w.status <> 'cancelled'
      ORDER BY w.order_id, w.order_line, w.id`
  ).all() as Record<string, unknown>[];

  const out = new Map<string, PlanJob[]>();
  for (const r of rows) {
    const made = round2(Number(r.made) || 0);
    const qty = round2(Number(r.qty_planned) || 0);
    const start = String(r.start ?? '');
    const end = String(r.end ?? '');
    const key = `${Number(r.order_id)}:${Number(r.order_line)}`;
    const list = out.get(key) ?? [];
    list.push({
      id: Number(r.id),
      number: String(r.number ?? ''),
      status: String(r.status ?? ''),
      order_id: Number(r.order_id),
      order_number: String(r.order_number ?? ''),
      customer_name: String(r.customer_name ?? ''),
      qty_planned: qty,
      made,
      // An over-run leaves nothing to make rather than negative work, which is
      // `progressFor`'s own rule about the same subtraction.
      balance: round2(Math.max(0, qty - made)),
      start,
      end,
      dated: !!(start || end),
    });
    out.set(key, list);
  }
  return out;
}

/** Blank sorts last: a colour nobody stated is not the first thing to plan. */
const byColour = (a: ColourPlan, b: ColourPlan) =>
  (a.color || '￿').localeCompare(b.color || '￿');

/**
 * The book folded product → colour → work order, under the same filters the
 * order book's own views take.
 *
 * Folded in TypeScript over `orderLines(f)` rather than as a `GROUP BY`, which
 * is `productDemand`'s and `pivotOrderLines`' own call and for their reasons:
 * `lineWhere` is private, so grouping over it would mean exporting the single
 * definition of *which lines*, and a line's state is `stateOf` here against
 * `LINE_STATE_SQL` there — folding in TypeScript asks `stateOf`, so a figure
 * on this page can never disagree with the pill the order book prints beside
 * it. The cost is reading every matching line, which on the live book is eight
 * hundred of them.
 */
export function productPlan(f: Filters = {}): ProductPlan[] {
  const lines = orderLines(f);
  const jobs = jobsByLine();

  type Group = ProductPlan & { orderIds: Set<number>; byColour: Map<string, ColourPlan & { orderIds: Set<number> }> };
  const groups = new Map<string, Group>();

  for (const line of lines) {
    // A custom line naming no catalogue product is a real thing — an employee
    // meeting a new product mid-order is expected — so it groups by what it
    // says rather than being dropped or swept into one "custom" pile, which is
    // `productDemand`'s own rule.
    const key = line.product_id
      ? `p:${line.product_id}`
      : `d:${line.description.trim().toLowerCase()}`;
    const colour = (line.color ?? '').trim();

    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        product_id: line.product_id,
        item: line.product_name || line.description,
        code: line.code,
        unit: line.unit,
        ordered: 0, planned: 0, made: 0, shipped: 0, pending: 0, unplanned: 0,
        orders: 0, jobs: 0, dated: 0, next_due: '',
        rate: null, days: null, colours: [],
        orderIds: new Set<number>(),
        byColour: new Map(),
      };
      groups.set(key, g);
    }

    let c = g.byColour.get(colour);
    if (!c) {
      c = {
        color: colour,
        ordered: 0, planned: 0, made: 0, shipped: 0, pending: 0, unplanned: 0,
        orders: 0, jobs: 0, dated: 0, next_due: '',
        work_orders: [],
        orderIds: new Set<number>(),
      };
      g.byColour.set(colour, c);
    }

    const mine = jobs.get(`${line.order_id}:${line.order_line}`) ?? [];
    const planned = mine.reduce((sum, j) => sum + j.qty_planned, 0);

    for (const target of [g, c]) {
      target.ordered = round2(target.ordered + line.ordered);
      target.planned = round2(target.planned + planned);
      target.made = round2(target.made + line.made);
      // The dispatch record, as `stateOf` reads it — not the invoice. An export
      // order is regularly billed before the lorry leaves.
      target.shipped = round2(target.shipped + line.sent);
      target.pending = round2(target.pending + Math.max(0, line.ordered - line.made));
      target.unplanned = round2(target.unplanned + Math.max(0, line.ordered - planned));
      target.jobs += mine.length;
      target.dated += mine.filter((j) => j.dated).length;
      target.orderIds.add(line.order_id);

      const due = dueOf(line);
      if (line.state !== 'fully_dispatched' && due && (!target.next_due || due < target.next_due)) {
        target.next_due = due;
      }
    }
    c.work_orders.push(...mine);
  }

  const rates = outputRates([...groups.values()].map((g) => g.product_id ?? 0));

  return [...groups.values()]
    .map(({ orderIds, byColour: cols, ...g }) => {
      const rate = g.product_id ? rates.get(g.product_id) ?? null : null;
      return {
        ...g,
        orders: orderIds.size,
        rate,
        // Ceil, and at least a day where anything is owed: a job of two
        // hundred pieces still occupies a line for a setup and a run, which is
        // `layOutQueue`'s own floor on the same division.
        days: rate && rate.pcs_per_day > 0 && g.pending > 0
          ? Math.max(1, Math.ceil(g.pending / rate.pcs_per_day))
          : null,
        colours: [...cols.values()]
          .map(({ orderIds: ids, ...c }) => ({ ...c, orders: ids.size }))
          .sort(byColour),
      };
    })
    // Most still owed first: the page exists to say what to run next.
    .sort((a, b) => b.pending - a.pending || a.item.localeCompare(b.item));
}

/**
 * When a line is owed, by `ORDER_DUE`'s own precedence read per line: the
 * order's revised date, else its promised one, else this line's own latest job
 * finish — which is the more precise answer, a five-line order being able to
 * have one line due this week and another next month.
 */
const dueOf = (line: OrderLine): string =>
  line.revised_date || line.promised_date || line.job_end || '';

/** Fold the whole plan into the figures the strip above the table states. */
export function summarisePlan(plan: ProductPlan[]): PlanSummary {
  return {
    products: plan.length,
    colours: plan.reduce((sum, p) => sum + p.colours.length, 0),
    jobs: plan.reduce((sum, p) => sum + p.jobs, 0),
    ordered: round2(plan.reduce((sum, p) => sum + p.ordered, 0)),
    made: round2(plan.reduce((sum, p) => sum + p.made, 0)),
    pending: round2(plan.reduce((sum, p) => sum + p.pending, 0)),
    unplanned: round2(plan.reduce((sum, p) => sum + p.unplanned, 0)),
    // Counted over products that actually owe something: a product with
    // nothing pending needs no rate, and counting it would send somebody to
    // type a figure that changes nothing.
    no_rate: plan.filter((p) => p.pending > 0 && !p.rate).length,
  };
}
