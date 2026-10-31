import { db } from '../db/connection.js';
import { fmtDate, fmtNum } from './format.js';
import { batchById, lotsUnderCoa } from './batch.js';

/*
 * **What the Certificate of Analysis states about itself, in one place**
 * (2026-10-31, the client with their own 48mm cap COA beside the app's:
 * *"Add the fields which are present in second image to COA page and a
 * checkbox whether it will be present in the pdf or not, also add lot No. as
 * a field"*).
 *
 * Every cell of that header was derived inside `buildCoaPdf`, which made it
 * correct and invisible: somebody issuing a certificate could not see what it
 * would say until they printed it, and could not drop a cell their buyer does
 * not want. The derivation moved here so that **the page and the paper read
 * one list** — a preview assembled separately is how a screen comes to
 * promise a cell the document does not print, which this codebase refuses
 * everywhere else.
 *
 * Three things the list adds to what was there:
 *
 * - **A tick per cell.** Only what is ticked *off* is stored (`coa_header`),
 *   the `column_config.hidden` rule, so every certificate on file prints
 *   exactly what it printed before and a cell added in a later release
 *   arrives drawn rather than silently suppressed.
 * - **A typed value over the derived one**, on the cells the record cannot
 *   supply *at the moment a certificate is issued*. A COA is required before
 *   dispatch, so the consignee, the invoice and the boxes do not exist yet —
 *   and their own paper states all three. Typed wins, blank falls back, which
 *   is `coa_buyer_order`'s own rule one field wider.
 * - **Lot No.**, which their paper carries and this app had only on the
 *   commercial invoice.
 *
 * **Customer, Product, Colour and Batch No. are not editable**, deliberately.
 * Each is solidly in the record, each is printed on documents that have
 * already gone to this buyer, and a typed copy here would be a second answer
 * able to disagree with them — the thing every derived figure in this app
 * exists to avoid. The tick is still offered on them: not printing a true
 * fact is a presentation choice, where printing a false one is not.
 */

export const COA_FIELD_KEYS = [
  'certificate', 'batch', 'product', 'colour', 'resin', 'period',
  'customer', 'buyer_order', 'lot_no',
  'invoice', 'consignee', 'boxes', 'dispatched',
] as const;

export type CoaFieldKey = (typeof COA_FIELD_KEYS)[number];

export interface CoaFieldSpec {
  key: CoaFieldKey;
  label: string;
  /** Can somebody type over what the record says? */
  editable: boolean;
  /**
   * Dropped from the certificate when it has no value, rather than printing
   * an em-dash. Which of the two each cell does is **today's behaviour kept
   * exactly**: the cells that have always printed a dash still do, and the
   * ones that were drawn only where there was something to say still are, so
   * the tick is the only new way for a cell to leave the page.
   */
  optional: boolean;
  /** Two of the header's three columns — an address needs the width. */
  span?: 2;
  /** Never ticked off: a certificate that does not state its own number is not one. */
  fixed?: boolean;
  /** Where the value comes from, for the page to say under an empty box. */
  hint?: string;
  placeholder?: string;
}

export const COA_FIELDS: CoaFieldSpec[] = [
  {
    key: 'certificate', label: 'Certificate No.  /  Date', editable: false, optional: false,
    fixed: true, hint: 'Drawn from this company’s own series when the certificate is issued',
  },
  { key: 'batch', label: 'Batch No.', editable: false, optional: false, hint: 'The lots this certificate covers' },
  { key: 'product', label: 'Product', editable: false, optional: false, hint: 'The catalogue product this job makes' },
  { key: 'colour', label: 'Colour', editable: false, optional: false, hint: 'The colour stated on the sales order line' },
  {
    key: 'resin', label: 'Resin', editable: true, optional: false, placeholder: 'HDPE',
    hint: 'What the product’s recipe consumes',
  },
  {
    key: 'period', label: 'Production Period', editable: true, optional: true, placeholder: 'MARCH’2026',
    hint: 'The span of the shifts booked into these lots',
  },
  { key: 'customer', label: 'Customer', editable: false, optional: false, span: 2, hint: 'The buyer on the sales order' },
  {
    key: 'buyer_order', label: "Buyer's Order", editable: true, optional: false, placeholder: 'PI or PO number',
    hint: 'The proforma behind the order, else the customer’s own PO — never our sales order',
  },
  {
    key: 'lot_no', label: 'Lot No.', editable: true, optional: true, placeholder: 'As the invoice states it',
    hint: 'The lot number on the commercial invoice these goods went out on',
  },
  {
    key: 'invoice', label: 'Invoice No.  /  Date', editable: true, optional: true, placeholder: 'AP/EX/189/25-26',
    hint: 'The invoice the trips carrying these lots were billed under',
  },
  {
    key: 'consignee', label: 'Consignee', editable: true, optional: true, placeholder: 'Who receives the goods',
    hint: 'The consignee on that invoice',
  },
  {
    key: 'boxes', label: 'Total Boxes', editable: true, optional: true, placeholder: '136 BOXES',
    hint: 'The boxes dispatched on these lots’ own order lines',
  },
  {
    key: 'dispatched', label: 'Dispatched', editable: true, optional: true, placeholder: '340000 PCS.',
    /*
     * Their paper calls this *Invoice Quantity*, which is the quantity
     * **billed**; what the record can answer is the quantity **dispatched on
     * these lots' own lines** — the same figure whenever the invoice bills
     * what went, and not the same claim. So the derived cell keeps the honest
     * word, and a desk that wants theirs types it: the box is editable.
     */
    hint: 'The pieces dispatched on these lots’ own order lines',
  },
];

const SPEC = new Map(COA_FIELDS.map((f) => [f.key, f]));
const isKey = (k: unknown): k is CoaFieldKey => typeof k === 'string' && SPEC.has(k as CoaFieldKey);

export interface CoaHeaderConfig {
  /** Ticked off — on the record, not on the page. */
  hidden: CoaFieldKey[];
  /** Typed over the derived value, per field. */
  values: Partial<Record<CoaFieldKey, string>>;
}

const str = (v: unknown) => (v == null ? '' : String(v)).trim();

/** As much as one cell of the header will hold. */
export const MAX_COA_VALUE = 200;

/**
 * Read the stored column back. **Never throws**, the rule `parseCoaExtra`
 * states one column over: a row hand-written, restored from a backup or left
 * by an older client is data rather than vocabulary, so a key this build does
 * not know and a value that is not a string are passed over. A certificate
 * drawn with one tick missing is survivable; a PDF route answering 500 is not.
 *
 * It is **idempotent** — the stored column is a string and a request body is
 * the object itself — so a reader can ask it without first knowing which of
 * the two it is holding.
 */
export function parseCoaHeader(raw: unknown): CoaHeaderConfig {
  let o: unknown = raw;
  if (raw == null || typeof raw === 'string') {
    const text = str(raw);
    if (!text) return { hidden: [], values: {} };
    try {
      o = JSON.parse(text);
    } catch {
      return { hidden: [], values: {} };
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { hidden: [], values: {} };
  const src = o as Record<string, unknown>;
  const hidden = (Array.isArray(src.hidden) ? src.hidden : [])
    // The certificate's own number is never ticked off, however the row got
    // here — the double rail this codebase puts on anything it refuses in a
    // route, so a hand-written row cannot produce a document that does not
    // say which certificate it is.
    .filter((k): k is CoaFieldKey => isKey(k) && !SPEC.get(k)!.fixed);
  const values: Partial<Record<CoaFieldKey, string>> = {};
  const rawValues = (src.values && typeof src.values === 'object' && !Array.isArray(src.values)
    ? src.values : {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(rawValues)) {
    // A cell nobody may type over cannot carry a typed value, whatever is
    // stored against it — the same rail, read for the other half.
    if (!isKey(k) || !SPEC.get(k)!.editable) continue;
    const value = str(v).slice(0, MAX_COA_VALUE);
    if (value) values[k] = value;
  }
  return { hidden: [...new Set(hidden)], values };
}

/**
 * Refuse what was sent, in the shape every guard in this module has — a
 * function returning the sentence to refuse with, so the rule is testable
 * without the HTTP harness this codebase does not have and the screen can
 * explain it rather than keep a copy.
 *
 * **An unknown key is refused here and ignored on read**, which is not a
 * contradiction: a request naming a cell this build has never heard of is a
 * mistake worth telling somebody about, where a stored row naming one is a
 * release that has moved on and must not take a certificate down with it.
 */
export function coaHeaderError(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return 'The certificate header must be a list of ticks and typed values.';
  }
  const src = raw as Record<string, unknown>;
  if (src.hidden !== undefined) {
    if (!Array.isArray(src.hidden)) return 'The fields left off the certificate must be a list.';
    for (const k of src.hidden) {
      if (!isKey(k)) return `"${str(k)}" is not a field on the certificate.`;
      if (SPEC.get(k)!.fixed) {
        return `${SPEC.get(k)!.label} always prints — a certificate has to state its own number.`;
      }
    }
  }
  if (src.values !== undefined) {
    if (!src.values || typeof src.values !== 'object' || Array.isArray(src.values)) {
      return 'The typed certificate values must be a list of fields.';
    }
    for (const [k, v] of Object.entries(src.values as Record<string, unknown>)) {
      if (!isKey(k)) return `"${k}" is not a field on the certificate.`;
      const spec = SPEC.get(k)!;
      if (!spec.editable) {
        return `${spec.label} is read from the record and cannot be typed over on the certificate.`;
      }
      if (str(v).length > MAX_COA_VALUE) return `The value under "${spec.label}" is too long to print in one cell.`;
    }
  }
  return null;
}

/**
 * **One header cell has a column of its own**, and the map does not keep a
 * second copy of it: `coa_buyer_order` predates this list, three routes write
 * it and the COA register reads it back, and rewriting a live column for
 * tidiness is what this codebase refuses. So the panel edits it like any
 * other cell and `buyerOrderFrom` lifts it back out on the way in.
 */
const OWN_COLUMN: CoaFieldKey[] = ['buyer_order'];

/**
 * The buyer's own reference as a request states it, or `null` where the
 * request says nothing about the header at all.
 *
 * **The header is sent whole or not at all** — the panel seeds itself from
 * every field, so a `values` map arriving without this key means somebody
 * cleared the box, not that they left it alone. That is what makes blanking
 * it a real answer: the certificate goes back to the proforma behind the
 * order.
 */
export function buyerOrderFrom(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const values = (raw as Record<string, unknown>).values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) return '';
  return str((values as Record<string, unknown>).buyer_order);
}

/** What gets written, once `coaHeaderError` has passed it. */
export function cleanCoaHeader(raw: unknown): string {
  const cfg = parseCoaHeader(raw);
  for (const k of OWN_COLUMN) delete cfg.values[k];
  return cfg.hidden.length || Object.keys(cfg.values).length ? JSON.stringify(cfg) : '';
}

export interface CoaField extends CoaFieldSpec {
  /** What the record says, before anything typed over it. */
  derived: string;
  /** What somebody typed instead, or ''. */
  typed: string;
  /** What prints: the typed value where there is one, else the derived one. */
  value: string;
  /** Ticked off — not printed. */
  hidden: boolean;
}

/**
 * Where the header is read from.
 *
 * A **certified lot** answers for the whole group the number covers, which is
 * what the document is about. A **job** answers for a certificate that does
 * not exist yet — the one-press `certify` shape, where the page has to show
 * what it is about to issue: the lots are the shifts nobody has certified, so
 * there is no trip and no invoice behind them and those cells are blank,
 * which is the honest preview rather than a gap.
 */
export type CoaHeaderSource =
  | { batchId: number }
  | { workOrderId: number; batchNumber?: string };

/**
 * One row per header cell, in the order the certificate prints them.
 *
 * Asked by `buildCoaPdf` and by the page that ticks them, so the two can
 * never describe different documents.
 */
export function coaHeaderFields(src: CoaHeaderSource): CoaField[] {
  // Read once rather than narrowed at each use: the source is a batch or a
  // job, and everything below asks the same two questions of it.
  const fromBatch = 'batchId' in src;
  const b = fromBatch ? batchById(src.batchId) : null;
  if (fromBatch && !b) return [];
  const lots = b ? (b.coa_no ? lotsUnderCoa(b.id) : [b]) : [];
  const workOrderId = b ? b.work_order_id : (src as { workOrderId: number }).workOrderId;
  const pendingNumber = fromBatch ? '' : String((src as { batchNumber?: string }).batchNumber ?? '');
  const cfg = parseCoaHeader(b?.coa_header ?? '');

  const wo = db.prepare(
    `SELECT w.*, o.customer_id, o.po_number,
            p.name AS product_name
       FROM work_orders w
       JOIN orders o ON o.id = w.order_id
       LEFT JOIN products p ON p.id = w.product_id
      WHERE w.id = ?`
  ).get(workOrderId) as Record<string, any> | undefined;
  if (!wo) return [];
  const c = db.prepare('SELECT name, address FROM customers WHERE id = ?')
    .get(wo.customer_id) as { name?: string; address?: string } | undefined;

  const ids = lots.map((l) => l.id);
  const holes = ids.map(() => '?').join(', ');

  /*
   * **Production period** is the span of the shift entries actually booked
   * into these lots, so it narrows when a mis-keyed shift is deleted. With no
   * lot yet it is the span of the shifts the press is about to sweep up,
   * which is exactly what the certificate will cover.
   */
  const span = ids.length
    ? db.prepare(
      `SELECT MIN(date) AS lo, MAX(date) AS hi FROM production_entries WHERE batch_id IN (${holes})`
    ).get(...(ids as never[])) as { lo: string | null; hi: string | null }
    : db.prepare(
      'SELECT MIN(date) AS lo, MAX(date) AS hi FROM production_entries WHERE work_order_id = ? AND batch_id IS NULL'
    ).get(workOrderId) as { lo: string | null; hi: string | null };

  const resin = (db.prepare(
    `SELECT m.name FROM product_materials pm JOIN materials m ON m.id = pm.material_id
      WHERE pm.product_id = (SELECT product_id FROM work_orders WHERE id = ?)
      ORDER BY pm.sort_order, pm.id`
  ).all(workOrderId) as { name: string }[]).map((r) => r.name).join(', ');

  /*
   * **Where these lots actually went.** `despatch_batches` says which lots
   * travelled on which trip, and a trip names the invoice it was billed
   * under — the only way this app can reach a consignee, an invoice number, a
   * lot number or a box count from a batch. Read rather than stored, like
   * everything else here, so correcting a trip or re-pointing an invoice
   * corrects the certificate.
   */
  const trips = ids.length ? db.prepare(
    `SELECT DISTINCT d.id AS despatch_id, ci.number AS invoice_number, ci.date AS invoice_date,
            ci.consignee AS consignee, ci.lot_no AS lot_no
       FROM despatch_batches dbx
       JOIN despatches d ON d.id = dbx.despatch_id
       LEFT JOIN commercial_invoices ci ON ci.id = d.invoice_id
      WHERE dbx.batch_id IN (${holes})
      ORDER BY d.date, d.id`
  ).all(...(ids as never[])) as {
    despatch_id: number; invoice_number: string | null; invoice_date: string | null;
    consignee: string | null; lot_no: string | null;
  }[] : [];

  /*
   * The boxes and pieces of **these lots' own lines**, not of the whole trip:
   * a lorry carries lines this certificate says nothing about, and summing
   * them would overstate what was certified. The lot names no line itself —
   * its work order does, the chain's own index rule.
   */
  const lotLines = ids.length ? (db.prepare(
    `SELECT DISTINCT w.order_line FROM batches bb
       JOIN work_orders w ON w.id = bb.work_order_id
      WHERE bb.id IN (${holes})`
  ).all(...(ids as never[])) as { order_line: number }[]).map((r) => Number(r.order_line)) : [];

  const shipped = trips.length && lotLines.length
    ? db.prepare(
      `SELECT COALESCE(SUM(di.packs), 0) AS boxes, COALESCE(SUM(di.qty), 0) AS pcs
         FROM despatch_items di
        WHERE di.despatch_id IN (${trips.map(() => '?').join(', ')})
          AND di.order_line IN (${lotLines.map(() => '?').join(', ')})`
    ).get(...(trips.map((t) => t.despatch_id) as never[]), ...(lotLines as never[])) as
      { boxes: number; pcs: number }
    : { boxes: 0, pcs: 0 };

  // One invoice is the ordinary case; a lot split across two consignments is
  // not, so the numbers are joined and the **date is stated only where it is
  // unambiguous** rather than one of them being picked to stand for both.
  const uniq = (xs: (string | null)[]) => [...new Set(xs.map((x) => (x ?? '').trim()).filter(Boolean))];
  const invNumbers = uniq(trips.map((t) => t.invoice_number));
  const invDates = uniq(trips.map((t) => t.invoice_date));
  const consignees = uniq(trips.map((t) => t.consignee));
  const lotNos = uniq(trips.map((t) => t.lot_no));

  const colour = String((db.prepare(
    `SELECT COALESCE(NULLIF(oi.color, ''), p.color, '') AS color
       FROM work_orders w
       JOIN (SELECT order_id, color, ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY sort_order, id) - 1 AS pos
               FROM order_items) oi ON oi.order_id = w.order_id AND oi.pos = w.order_line
       LEFT JOIN products p ON p.id = w.product_id
      WHERE w.id = ?`
  ).get(workOrderId) as { color?: string } | undefined)?.color ?? '');

  /*
   * **The buyer's own reference, never ours.** The sales order is this
   * company's internal number and means nothing to whoever reads the
   * certificate; their paper carries the proforma the buyer ordered against.
   * Typed first, then that proforma — reached by the back-pointer,
   * `dispatchProgress`'s own walk — then the customer's own PO.
   */
  const buyerOrder = String((db.prepare(
    'SELECT number FROM proforma_invoices WHERE order_id = ? ORDER BY id LIMIT 1'
  ).get(Number(wo.order_id)) as { number?: string } | undefined)?.number ?? '')
    || String(wo.po_number ?? '');

  const period = span.lo
    ? (span.lo === span.hi ? fmtDate(span.lo) : `${fmtDate(span.lo)} – ${fmtDate(String(span.hi))}`)
    : '';

  const many = lots.length > 1;
  const batchLabel = many
    ? `${lots[0].number} to ${lots[lots.length - 1].number}`
    : (lots[0]?.number ?? pendingNumber);

  const derived: Record<CoaFieldKey, string> = {
    certificate: b?.coa_no ? `${b.coa_no}   ${fmtDate(b.coa_date)}` : '',
    batch: batchLabel,
    product: String(wo.product_name || wo.description || ''),
    colour,
    resin,
    period,
    customer: [c?.name, c?.address].filter(Boolean).join('\n'),
    /*
     * The one typed field that predates this list and keeps its own column:
     * three routes write `coa_buyer_order` and the register reads it back, and
     * rewriting a live column for tidiness is what this codebase refuses. So
     * it is read here as the typed value and the map below leaves it alone.
     */
    buyer_order: buyerOrder,
    lot_no: lotNos.join(', '),
    invoice: [
      invNumbers.join(', '),
      // A trip can leave before its paperwork, so a blank invoice here is the
      // lorry having gone unbilled rather than a fault.
      invDates.length === 1 ? fmtDate(invDates[0]) : '',
    ].filter(Boolean).join('   '),
    consignee: consignees.join('\n'),
    boxes: shipped.boxes ? `${fmtNum(shipped.boxes, 0)} boxes` : '',
    dispatched: shipped.pcs ? `${fmtNum(shipped.pcs, 0)} pcs` : '',
  };

  return COA_FIELDS.map((spec) => {
    /*
     * A run of lots is headed as a range, the way their own paper writes it
     * (*Batch No: 05032026A+B TO 09032026A+B*); one lot still reads as
     * itself, so nothing already issued changes.
     */
    const label = spec.key === 'batch' && many ? 'Batch Nos.' : spec.label;
    const typed = spec.key === 'buyer_order' ? String(b?.coa_buyer_order ?? '') : (cfg.values[spec.key] ?? '');
    return {
      ...spec,
      label,
      derived: derived[spec.key],
      typed,
      value: typed || derived[spec.key],
      hidden: cfg.hidden.includes(spec.key),
    };
  });
}

/** What the certificate actually draws: ticked on, and with something to say. */
export function printedCoaFields(fields: CoaField[]): CoaField[] {
  return fields.filter((f) => !f.hidden && (f.value || !f.optional));
}
