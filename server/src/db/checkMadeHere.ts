/**
 * Read-only audit: products whose make-or-buy flag disagrees with the record.
 *
 * `npm run check-made-here` in `server/`, where the database is.
 *
 * `products.made_here` is a one-tick field with three consequences, and none of
 * them is visible on the product itself — which is what makes a wrong tick
 * expensive and quiet. A line naming a bought-in product:
 *
 *   - raises **no work order** (`syncOrderJobs`), so the floor is never told to
 *     make it;
 *   - is **never asked for a QC pass** (`qcBlockError`), so it ships
 *     uninspected — right for a traded good, which has no job by nature, and a
 *     hole in the gate for one this plant actually moulds;
 *   - **never reaches the Ready to dispatch queue** (`readyLines`, 2026-10-08),
 *     so nobody is notified when it is finished.
 *
 * The flag cannot be set wrongly by silence: `madeHere(undefined)` is 1 on both
 * the POST and the PUT, the column's default is 1, and neither importer writes
 * it. So a 0 is always somebody's tick, and a tick is what this re-reads
 * against the rest of the record.
 *
 * **It never writes,** the rule `checkSeries.ts` states and `checkBank.ts`
 * repeats: the database is opened read-only and there is no `--fix`. Which of
 * the two halves is wrong is a judgement — a product genuinely bought in and
 * one that is moulded here look identical in the catalogue, and only the people
 * who buy it know which. Flipping a flag also changes what the next save of
 * every open order does, so it is a decision somebody takes per product.
 *
 * It reports only what it can **positively place**, the rule `checkBank.ts`
 * states: a product with no recipe, no specification, no job and no purchase
 * says nothing about itself and is left out, rather than being guessed at. On a
 * catalogue where most rows have no recipe yet, guessing would bury the real
 * findings under a list of everything.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'), { readOnly: true });

/**
 * A database older than the column cannot be audited against it — and it is
 * also not wrong, every product on it being made here by definition. Said
 * rather than thrown, the trap `batches.disposition` records from the boot
 * side: a missing column reaching the user as a stack trace explains nothing.
 */
const columns = (db.prepare('PRAGMA table_info(products)').all() as unknown as { name: string }[])
  .map((c) => String(c.name));
if (!columns.includes('made_here')) {
  console.log(
    'This database predates products.made_here, so every product is made here'
    + ' and there is nothing to audit. Start the app once to add the column.'
  );
  db.close();
  process.exit(0);
}
/** `active` is newer still, and its absence means nothing is retired. */
const ACTIVE = columns.includes('active') ? 'COALESCE(p.active, 1)' : '1';

interface Row {
  id: number;
  name: string;
  color: string;
  made_here: number;
  active: number;
  recipe: number;
  spec: number;
  jobs: number;
  output: number;
  purchased: number;
  open_lines: number;
}

/**
 * Every product, with the evidence either way beside it.
 *
 * Asked as correlated subqueries rather than six joins, since a product with
 * two recipe lines and three jobs must not be counted as six of each — the
 * N+1 this codebase keeps bounding does not arise, the catalogue being
 * hundreds of rows read once.
 */
const rows = db.prepare(
  `SELECT p.id, p.name, COALESCE(p.color, '') AS color,
          COALESCE(p.made_here, 1) AS made_here,
          ${ACTIVE} AS active,
          (SELECT COUNT(*) FROM product_materials m WHERE m.product_id = p.id)  AS recipe,
          (SELECT COUNT(*) FROM product_qc_params q WHERE q.product_id = p.id)  AS spec,
          (SELECT COUNT(*) FROM work_orders w
            WHERE w.product_id = p.id AND w.status <> 'cancelled')              AS jobs,
          (SELECT COUNT(*) FROM production_entries e
             JOIN work_orders w ON w.id = e.work_order_id
            WHERE w.product_id = p.id)                                          AS output,
          (SELECT COUNT(*) FROM po_items i WHERE i.product_id = p.id)           AS purchased,
          (SELECT COUNT(*) FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
            WHERE oi.product_id = p.id AND oi.is_charge = 0
              AND o.status NOT IN ('completed', 'cancelled'))                   AS open_lines
     FROM products p
    ORDER BY p.name, p.id`
).all() as unknown as Row[];

const label = (r: Row) =>
  `${r.name}${r.color ? ` · ${r.color}` : ''}${r.active ? '' : ' (disabled)'}`;

/** What the record says this product is, in the words the finding needs. */
const madeEvidence = (r: Row) => [
  r.recipe ? `a recipe (${r.recipe} material${r.recipe === 1 ? '' : 's'})` : '',
  r.spec ? 'a QC specification' : '',
  r.jobs ? `${r.jobs} work order${r.jobs === 1 ? '' : 's'}` : '',
  r.output ? `${r.output} shift${r.output === 1 ? '' : 's'} booked` : '',
].filter(Boolean).join(', ');

const total = rows.length;
const bought = rows.filter((r) => !r.made_here);

/*
 * The expensive direction. A product the record says is made here, ticked
 * bought in: no job is raised for it, the QC gate lets its lines through, and
 * it never reaches the dispatch queue.
 */
const wronglyBought = bought.filter((r) => r.recipe || r.spec || r.jobs || r.output);

/*
 * The cheap direction, and deliberately narrower. Having no recipe proves
 * nothing — most of this catalogue has none — so a product is only named here
 * when it has actually been **bought on a purchase order** and has never been
 * made: a job will be raised for it that nobody is going to run.
 */
const wronglyMade = rows.filter((r) => r.made_here && r.purchased && !r.recipe && !r.jobs && !r.output);

console.log(`${total} product${total === 1 ? '' : 's'}: ${total - bought.length} made here, ${bought.length} bought in.\n`);

if (wronglyBought.length) {
  console.log(`Ticked bought in, but the record says this plant makes them — ${wronglyBought.length}:`);
  for (const r of wronglyBought) {
    console.log(`  ${label(r)}`);
    console.log(`      has ${madeEvidence(r)}`);
    if (r.open_lines) {
      console.log(
        `      and is on ${r.open_lines} open order line${r.open_lines === 1 ? '' : 's'}`
        + ' — those raise no job, are never asked for a QC pass, and never reach Ready to dispatch'
      );
    }
    if (r.purchased) console.log(`      (it has also been bought ${r.purchased} time${r.purchased === 1 ? '' : 's'}, so it may genuinely be both)`);
  }
  console.log('');
}

if (wronglyMade.length) {
  console.log(`Ticked made here, but they are bought and have never been made — ${wronglyMade.length}:`);
  for (const r of wronglyMade) {
    console.log(`  ${label(r)}  — on ${r.purchased} purchase order line${r.purchased === 1 ? '' : 's'}, no recipe, no job ever`);
  }
  console.log('');
}

/*
 * The impact figure, which is the one that says whether any of this matters
 * today: what is on the books right now carrying the flag. Reported whether or
 * not a finding was made, since a correct tick on a line nobody inspects is
 * still worth knowing the size of.
 */
const onBooks = bought.reduce((t, r) => t + r.open_lines, 0);
if (onBooks) {
  console.log(
    `${onBooks} open order line${onBooks === 1 ? ' names' : 's name'} a bought-in product.`
    + ' No work order is raised for them, the QC gate does not hold them, and they do not'
    + ' appear in Ready to dispatch — correct for a traded good, and a hole for anything moulded here.\n'
  );
}

console.log(
  wronglyBought.length || wronglyMade.length
    ? 'Open each product named above and set *Made or bought* to what it really is.'
      + '\nNothing else has to change: an untouched job follows the next save of its order,'
      + '\nand a flag corrected today does not restate a job the floor has already worked.'
    : 'Nothing to correct: every flag agrees with the recipes, specifications, jobs and'
      + '\npurchases on file. Products the record says nothing about are left out rather than guessed at.'
);

db.close();
