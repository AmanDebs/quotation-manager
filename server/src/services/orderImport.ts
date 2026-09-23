import { parseWorkbook, splitHeader, splitAt, type Sheet } from './spreadsheet.js';
import { piecesPerBillingUnit } from './totals.js';
import { autoMapFields, loose, matchByName, norm } from './importMapping.js';

/**
 * Turning a desk's own order sheet into sales orders.
 *
 * Built for the one-time load a business does when it starts using this app:
 * the backlog of orders already on paper has to arrive in one go, and after
 * that the book is kept here. Both of Aglo's real sheets — the domestic
 * `Order` tab and the export `Order wise details` tab — are **one row per
 * order line with the order number repeating**, which is what this reads.
 *
 * It follows `productImport.ts` in the two ways that matter: the columns are
 * guessed from the headings and every one is correctable, and **preview and
 * import run this identical function** over the same re-uploaded file, so what
 * somebody confirms is exactly what gets written.
 *
 * What it deliberately does **not** do, each for a reason:
 *
 * - **It never creates a customer or a product.** A name in a spreadsheet is a
 *   spelling, not a record; creating from one is how a book comes to hold
 *   three versions of one buyer. An unmatched customer refuses that order by
 *   name — the fix is to add the customer, or correct the sheet, and preview
 *   again. An unmatched *product* is gentler: the line is imported as a custom
 *   line carrying the sheet's own wording, because an order line naming
 *   something that is not in the catalogue is ordinary and refusing the whole
 *   order for it would refuse the backlog.
 * - **It never updates an order already on file.** Unlike the catalogue, an
 *   order has jobs, trips and invoices hanging off it, and restating its lines
 *   from a sheet would rewrite a document the floor is working to. A number
 *   already used is skipped by name, which is also what makes running the
 *   import twice safe.
 * - **It draws no document numbers.** The backlog's numbers are already on
 *   paper with customers, so the sheet's own number is what is stored, and the
 *   counters in Settings are left exactly where they were — moving those
 *   forward is a separate, deliberate act.
 * - **It copies no status across.** Status here is derived from the jobs and
 *   the dispatch record (`orderStatus.ts`), so a word copied into the column
 *   would be restated by the first sync. The sheet's word is read for a
 *   different question — whether this order is still live — and answered per
 *   distinct word by whoever is importing; see `StatusAction`.
 */

export type OrderFieldKey =
  | 'number' | 'po_number' | 'po_date' | 'customer' | 'date' | 'revised_date' | 'promised_date'
  | 'payment_terms' | 'inco_terms' | 'destination' | 'currency' | 'spoc' | 'order_through' | 'remarks' | 'status'
  | 'code' | 'item' | 'color' | 'hsn_code' | 'pcs_per_pack' | 'packs' | 'pieces' | 'qty'
  | 'rate' | 'unit' | 'tax_pct' | 'supplier';

export interface OrderFieldSpec {
  key: OrderFieldKey;
  label: string;
  /** `order` is read once per order; `line` is read on every row. */
  scope: 'order' | 'line';
  required?: boolean;
  synonyms: string[];
}

/**
 * The declaration order is load-bearing, exactly as it is in `productImport`:
 * fields are matched in this order and a claimed column joins a `taken` set,
 * so whoever is declared earlier wins an ambiguous heading. Three pairs here
 * would otherwise collide, and each is why its neighbour sits where it does:
 * *PO Date* before *Date* (a bare "date" partial-matches "po date"), *Revised*
 * before *Promised* (both are production dates), and *Item Code* before
 * *Item*. `rate` before `unit` takes *Unit Price* off the unit column.
 */
export const ORDER_IMPORT_FIELDS: OrderFieldSpec[] = [
  { key: 'number', label: 'Order No.', scope: 'order', required: true, synonyms: ['sales order no', 'sale order no', 'order no', 'order number', 'so no', 'so number', 'our ref', 'order ref', 'number'] },
  { key: 'po_number', label: "Customer's PO No.", scope: 'order', synonyms: ['customer po no', 'buyer po no', 'po no', 'po number', 'customer po', 'buyer po', 'po'] },
  { key: 'po_date', label: "Customer's PO Date", scope: 'order', synonyms: ['customer po date', 'buyer po date', 'po date'] },
  { key: 'customer', label: 'Customer', scope: 'order', required: true, synonyms: ['party name', 'customer name', 'name of customer', 'customer', 'party', 'buyer', 'client'] },
  { key: 'date', label: 'Order Date', scope: 'order', synonyms: ['order date', 'so date', 'booking date', 'date'] },
  { key: 'revised_date', label: 'Revised Production Date', scope: 'order', synonyms: ['revised production date', 'revised date', 'revised'] },
  { key: 'promised_date', label: 'Promised Date', scope: 'order', synonyms: ['tentative date of desp', 'tentative date', 'promised despatch', 'promised date', 'original scheduled', 'delivery date', 'dispatch date', 'promised', 'scheduled'] },
  { key: 'payment_terms', label: 'Payment Terms', scope: 'order', synonyms: ['payment terms', 'payment term', 'payment'] },
  { key: 'inco_terms', label: 'INCO Terms', scope: 'order', synonyms: ['inco terms', 'incoterms', 'terms of delivery', 'delivery basis'] },
  { key: 'destination', label: 'Destination / Port', scope: 'order', synonyms: ['dest port', 'destination port', 'port of discharge', 'destination', 'deliver to', 'dest'] },
  { key: 'currency', label: 'Currency', scope: 'order', synonyms: ['currency', 'curr'] },
  { key: 'spoc', label: 'SPOC / Prepared By', scope: 'order', synonyms: ['spoc', 'prepared by', 'sales person', 'salesperson', 'entered by', 'ent by', 'executive'] },
  { key: 'order_through', label: 'Order Received Via', scope: 'order', synonyms: ['order through', 'received via', 'order via', 'source'] },
  { key: 'remarks', label: 'Remarks', scope: 'order', synonyms: ['remarks', 'remark', 'comments', 'notes', 'note'] },
  /*
   * Read to decide **what to do with the order**, never stored as a status:
   * status here is derived from the jobs and the dispatch record, so a word
   * copied into the column would be restated by the first sync. What the
   * sheet's word does decide is whether the order is still live — on the real
   * book 288 of 478 orders read *Delivered* and 5 *Cancelled*, and booking
   * those as open would raise a work order apiece for goods long gone.
   */
  { key: 'status', label: 'Status', scope: 'order', synonyms: ['order status', 'status', 'stage'] },

  { key: 'code', label: 'Item Code', scope: 'line', synonyms: ['item code', 'product code', 'sku code', 'code'] },
  { key: 'item', label: 'Item', scope: 'line', required: true, synonyms: ['item name', 'product name', 'standard name', 'description of goods', 'description', 'particulars', 'item', 'product', 'sku'] },
  { key: 'color', label: 'Colour', scope: 'line', synonyms: ['colour', 'color', 'shade'] },
  { key: 'hsn_code', label: 'HSN Code', scope: 'line', synonyms: ['hsn code', 'hsn sac', 'hsn', 'hs code'] },
  { key: 'pcs_per_pack', label: 'Pcs / Box', scope: 'line', synonyms: ['pcs per box', 'pieces per box', 'pcs box', 'pcs per carton', 'pcs carton', 'per box packing', 'box packing'] },
  { key: 'packs', label: 'Boxes', scope: 'line', synonyms: ['no of box', 'no of boxes', 'no of ctn', 'boxes', 'cartons', 'ctns', 'ctn', 'packs'] },
  { key: 'pieces', label: 'Total Pieces', scope: 'line', synonyms: ['total pcs', 'total pieces', 'quantity in pcs', 'qty in pcs', 'pieces', 'pcs'] },
  { key: 'qty', label: 'Quantity', scope: 'line', required: true, synonyms: ['ordered qty', 'order qty', 'qty ordered', 'quantity', 'qty'] },
  // Never the bare word "amount": on a line that is the extended total, and
  // reading it as a rate would multiply the order by its own quantity.
  { key: 'rate', label: 'Rate', scope: 'line', synonyms: ['basic price', 'unit price', 'rate qty', 'rate', 'price'] },
  { key: 'unit', label: 'Unit', scope: 'line', synonyms: ['unit of measure', 'uom', 'unit', 'basis'] },
  { key: 'tax_pct', label: 'Tax %', scope: 'line', synonyms: ['gst rate', 'tax rate', 'gst', 'tax'] },
  { key: 'supplier', label: 'Supplier', scope: 'line', synonyms: ['supplier', 'vendor'] },
];

export type OrderMapping = Partial<Record<OrderFieldKey, number>>;

/** Best-guess column for each field; the declaration order above decides ties. */
export function autoMapOrders(headers: string[]): OrderMapping {
  return autoMapFields(headers, ORDER_IMPORT_FIELDS);
}

/**
 * The **first number** in a cell: "1,20,000" → 120000, "₹ 10.50" → 10.5,
 * "@ 0.40+GST" → 0.4. Unreadable is null, so it can be flagged.
 *
 * First-token rather than strip-everything, which is what `productImport`
 * does: on the live order book the price column reads `@0.90+GST(Ex-works)`,
 * and stripping to `[0-9.-]` leaves `0.90-` — not a number, so a stated price
 * came through as nothing. 442 of that sheet's 804 price cells carry a figure
 * and only 27 are plain.
 */
export function parseNum(raw: string): number | null {
  const m = /-?\d[\d,]*\.?\d*/.exec(raw);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  // Deliberately not rounded: a rate may be quoted to four places, and the
  // money is rounded once, by `computeTotals`, where all money math lives.
  return Number.isFinite(n) ? n : null;
}

/** What a rate cell is quoted against, where the cell itself says. */
export type RateBasis = 'per_piece' | 'per_1000';

/**
 * A price cell, read as a rate per 1000 pieces — the basis this app prices on.
 *
 * The live order book writes prices as notes rather than figures, so the cell
 * is read for what it says before the dialog's choice is applied:
 *
 * - `/KG` is a **resin** price, not a rate for the goods — Aglo's own sheet
 *   states `@128.40/KG` beside `@3.017/PC` for the same line, the second being
 *   the first times the piece weight. Converting would need the catalogue's
 *   `weight_grams` to be right for that product, and a rate is money, so it is
 *   **refused** with the text shown instead of guessed at.
 * - `/PC`, `per piece`, `each` is per piece whatever the dialog says, and
 *   `per 1000` likewise — a marker in the record beats a setting.
 * - Silence takes the dialog's basis, which defaults to **per piece**: that is
 *   what this desk's column holds (`@0.65++` on a cap), and the preview's
 *   order total is what makes a 1000-fold slip visible.
 */
export function rateFromCell(raw: string, basis: RateBasis): { pieceRate: number | null; note?: string } {
  const s = raw.trim();
  if (!s) return { pieceRate: null };
  const n = parseNum(s);
  if (n === null) return { pieceRate: null, note: `Price “${s}” states no figure — imported at 0` };
  if (/\bkgs?\b/i.test(s)) {
    return { pieceRate: null, note: `“${s}” is a price per kilo, not per piece — imported at 0` };
  }
  const perPiece = /\/\s*pcs?\b|per\s*pcs?\b|per\s*piece|\beach\b/i.test(s) ? true
    : /per\s*1000|\/\s*1000|per\s*thousand/i.test(s) ? false
    : basis === 'per_piece';
  return { pieceRate: perPiece ? n : n / 1000 };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** Excel counts days from 1899-12-30, which absorbs its own 1900 leap-year bug. */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

const ymd = (y: number, m: number, d: number) =>
  m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2999
    ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    : '';

/**
 * A cell that means a date, as `YYYY-MM-DD` — or `''`, which is what this app
 * reads as *no date* everywhere rather than guessing one.
 *
 * Four shapes, and the one judgement worth stating: a numeric-only cell is an
 * **Excel serial**, because `spreadsheet.ts` reads cell text and never
 * interprets styles, so that is how every date in a real .xlsx arrives here;
 * and `05/09/2026` is read **day first**, the convention on this desk, since
 * nothing in the file says which way round it is meant.
 */
export function parseDate(raw: string): string {
  const s = raw.trim();
  if (!s) return '';

  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    // 20000–80000 is 1954 to 2119. A bare 5 or 2026 in a date column is not a
    // date anybody meant, and turning it into one would be worse than a blank.
    if (n < 20000 || n > 80000) return '';
    const d = new Date(EXCEL_EPOCH + Math.round(n) * 86400000);
    return d.toISOString().slice(0, 10);
  }

  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (iso) return ymd(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const named = /^(\d{1,2})[\s\-/.]+([A-Za-z]{3,})[\s\-/.,]+(\d{2,4})/.exec(s);
  if (named) {
    const m = MONTHS.indexOf(named[2].slice(0, 3).toLowerCase()) + 1;
    const y = Number(named[3]);
    return m ? ymd(y < 100 ? 2000 + y : y, m, Number(named[1])) : '';
  }

  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s);
  if (dmy) {
    const y = Number(dmy[3]);
    return ymd(y < 100 ? 2000 + y : y, Number(dmy[2]), Number(dmy[1]));
  }
  return '';
}

/**
 * What to do with an order carrying a given status word.
 *
 * `open` books it as this app books any order — jobs raised, status derived.
 * `completed` and `cancelled` book the order and **raise no jobs**, since
 * there is nothing left to make; the status is written directly, which the
 * ladder respects, a person's status being a floor the facts build on.
 * `skip` leaves it out altogether.
 */
export type StatusAction = 'open' | 'completed' | 'cancelled' | 'skip';

/** What a status word most likely means, before anybody overrides it. */
export function guessStatusAction(text: string): StatusAction {
  const t = text.toLowerCase();
  if (/cancel|reject|drop/.test(t)) return 'cancelled';
  if (/deliver|complete|despatch|dispatch|shipp|closed|done/.test(t)) return 'completed';
  return 'open';
}

/* ------------------------------------------------------------------ */

export interface CustomerRef {
  id: number; name: string; currency: string; country: string; is_export: number;
}
export interface ProductRef {
  id: number; name: string; color: string; pcs_per_pack: number | null;
  hsn_code: string; unit: string; unit_price: number;
}
export interface Lookups {
  /** Only the customers this caller may use — scope is applied before we get here. */
  customers: CustomerRef[];
  products: ProductRef[];
  /** Lower-cased document number → order id, for numbers already on file. */
  orderNumbers: Map<string, number>;
}

export interface DraftLine {
  row: number;
  product_id: number | null;
  description: string;
  code: string;
  color: string;
  hsn_code: string;
  unit: string;
  qty: number | null;
  unit_price: number;
  tax_pct: number;
  packs: number | null;
  pcs_per_pack: number | null;
  total_pcs: number | null;
  supplier: string;
  scheduled_date: string;
  /** What was matched, or what was adjusted, in the words the preview shows. */
  note?: string;
}

export interface DraftOrder {
  number: string;
  /** Sheet rows this order was read from, so a finding can be pointed at. */
  rows: number[];
  customer_text: string;
  customer_id: number | null;
  customer_name: string;
  date: string;
  po_number: string;
  po_date: string;
  promised_date: string;
  revised_date: string;
  payment_terms: string;
  inco_terms: string;
  destination: string;
  spoc: string;
  order_through: string;
  remarks: string;
  currency: string;
  is_export: number;
  tax_type: 'none' | 'igst';
  /** The sheet's own word, and what this import will do about it. */
  status_text: string;
  status_action: StatusAction;
  /** The status to store: blank for an ordinary booking, which then derives it. */
  import_status: '' | 'completed' | 'cancelled';
  lines: DraftLine[];
  /** Lines read but not imported, with the reason on each. */
  dropped: { row: number; note: string }[];
  action: 'create' | 'skip';
  note?: string;
  existingId?: number;
  total: number;
}

export interface OrderBuildResult {
  sheetNames: string[];
  sheet: string;
  headerRow: number;
  headers: string[];
  mapping: OrderMapping;
  orders: DraftOrder[];
  /** Every status word the sheet uses, with its count and what will happen to it. */
  statuses: { text: string; count: number; action: StatusAction }[];
  summary: { create: number; skip: number; lines: number; rows: number };
}

export interface OrderBuildOptions {
  sheet?: string;
  headerRow?: number;
  mapping?: OrderMapping;
  /**
   * What the Quantity column holds. `pieces` is the default because both real
   * desk sheets state a piece count (1,20,000) against a rate quoted per 1000,
   * which is how this catalogue is priced; `billing` takes the figure as the
   * billing quantity exactly as typed, for a book kept in kilos.
   */
  quantityBasis?: 'pieces' | 'billing';
  /** The rate basis a line opens on, matching the line editor's own default. */
  defaultUnit?: string;
  /** Tax on a domestic line where the sheet states none. 18% is this catalogue's answer. */
  defaultTaxPct?: number;
  /**
   * What an unmarked rate is quoted against. **Per piece by default**, which
   * is what this desk's price column holds; a cell saying `/PC` or `per 1000`
   * overrides it either way.
   */
  rateBasis?: RateBasis;
  /** What to do with each status word, keyed by the word as the sheet spells it. */
  statusActions?: Record<string, StatusAction>;
}

/** Name + colour + pcs per box, the catalogue's own identity for a product. */
const productKey = (name: string, color: string, pcs: number | null) =>
  [loose(name), norm(color), pcs ?? ''].join('|');

/**
 * Read a workbook and work out what it would book, writing nothing.
 *
 * Rows are grouped into orders by **order number**, and a row whose number
 * cell is blank continues the order above it — which is not a nicety: a merged
 * cell in Excel carries its value on the first row only, and repeating the
 * number down the block is how both real sheets are kept. The customer follows
 * the same rule, so a group is keyed on the two together and one number reused
 * for two buyers stays two orders.
 */
export function buildOrderImport(
  buf: Buffer,
  filename: string,
  lookups: Lookups,
  opts: OrderBuildOptions = {}
): OrderBuildResult {
  const sheets: Sheet[] = parseWorkbook(buf, filename);
  if (sheets.length === 0) throw new Error('That file has no readable sheets.');

  const chosen = sheets.find((s) => s.name === opts.sheet)
    ?? sheets.find((s) => s.rows.some((r) => r.some((c) => c !== '')))
    ?? sheets[0];

  const split = opts.headerRow !== undefined && opts.headerRow >= 0
    ? splitAt(chosen.rows, opts.headerRow)
    : splitHeader(chosen.rows);
  const { headers, body, headerRow } = split;

  const mapping = opts.mapping && Object.keys(opts.mapping).length ? opts.mapping : autoMapOrders(headers);
  const basis = opts.quantityBasis ?? 'pieces';
  const rateBasis = opts.rateBasis ?? 'per_piece';
  const defaultUnit = opts.defaultUnit || 'per 1000';
  const defaultTax = opts.defaultTaxPct ?? 18;

  const cell = (r: string[], key: OrderFieldKey) => {
    const idx = mapping[key];
    return idx === undefined || idx < 0 ? '' : (r[idx] ?? '').trim();
  };
  const numCell = (r: string[], key: OrderFieldKey) => {
    const raw = cell(r, key);
    return raw ? parseNum(raw) : null;
  };

  const byKey = new Map<string, DraftOrder>();
  const order: DraftOrder[] = [];
  let current: DraftOrder | null = null;

  body.forEach((r, i) => {
    // The row number as Excel shows it. Fully blank rows are dropped by the
    // splitter, so this drifts on a sheet full of them — near enough to find.
    const rowNo = headerRow + 2 + i;
    const number = cell(r, 'number');
    const customerText = cell(r, 'customer');

    if (number || (!current && customerText)) {
      const num = number || '';
      const cust = customerText || current?.customer_text || '';
      const key = `${norm(num)}|${norm(cust)}`;
      let existing = byKey.get(key);
      if (!existing) {
        existing = blankOrder(num, cust);
        byKey.set(key, existing);
        order.push(existing);
      }
      current = existing;
    }
    if (!current) return;  // a leading row with neither number nor customer

    const o = current;
    o.rows.push(rowNo);
    // Header fields: the first row of the group that states one wins, so a
    // sheet that repeats them down the block and one that states them once
    // both read the same.
    const fill = (field: keyof DraftOrder, key: OrderFieldKey, date = false) => {
      if (o[field]) return;
      const raw = cell(r, key);
      if (!raw) return;
      (o as unknown as Record<string, unknown>)[field] = date ? parseDate(raw) : raw;
    };
    if (!o.customer_text && customerText) o.customer_text = customerText;
    fill('date', 'date', true);
    fill('po_number', 'po_number');
    fill('po_date', 'po_date', true);
    fill('promised_date', 'promised_date', true);
    fill('revised_date', 'revised_date', true);
    fill('payment_terms', 'payment_terms');
    fill('inco_terms', 'inco_terms');
    fill('destination', 'destination');
    fill('spoc', 'spoc');
    fill('order_through', 'order_through');
    fill('remarks', 'remarks');
    fill('currency', 'currency');
    fill('status_text', 'status');

    const line = readLine(r, rowNo);
    if (line.drop) o.dropped.push({ row: rowNo, note: line.drop });
    else if (line.line) o.lines.push(line.line);
  });

  function blankOrder(number: string, customerText: string): DraftOrder {
    return {
      number, rows: [], customer_text: customerText, customer_id: null, customer_name: '',
      date: '', po_number: '', po_date: '', promised_date: '', revised_date: '',
      payment_terms: '', inco_terms: '', destination: '', spoc: '', order_through: '', remarks: '',
      currency: '', is_export: 0, tax_type: 'igst',
      status_text: '', status_action: 'open', import_status: '',
      lines: [], dropped: [], action: 'create', total: 0,
    };
  }

  function readLine(r: string[], rowNo: number): { line?: DraftLine; drop?: string; note?: string } {
    const text = cell(r, 'item');
    const color = cell(r, 'color');
    const code = cell(r, 'code');
    const qtyRaw = cell(r, 'qty');
    const qtyNum = qtyRaw ? parseNum(qtyRaw) : null;
    const piecesNum = numCell(r, 'pieces');
    const packs = numCell(r, 'packs');
    let pcsPerPack = numCell(r, 'pcs_per_pack');

    if (!text && !code && qtyNum == null && piecesNum == null) return {};      // a spacer row
    if (!text && !code) return { drop: 'No item on this row' };
    if (qtyNum == null && piecesNum == null) return { drop: `No quantity for "${text || code}"` };
    if (qtyRaw && qtyNum == null) return { drop: `Quantity "${qtyRaw}" is not a number` };

    const notes: string[] = [];
    const match = matchByName(text, lookups.products);
    let product: ProductRef | undefined;
    if (text) {
      // Colour and pieces-per-box are part of a product's identity here, so a
      // sheet stating them picks between two catalogue rows of one name.
      const wanted = productKey(text, color, pcsPerPack);
      product = lookups.products.find((p) => productKey(p.name, p.color, p.pcs_per_pack) === wanted)
        ?? (color ? lookups.products.find((p) => loose(p.name) === loose(text) && norm(p.color) === norm(color)) : undefined)
        ?? match.hit;
      if (!product) {
        notes.push(match.ambiguous
          ? 'More than one catalogue product reads like this — imported as a custom line'
          : 'Not in the catalogue — imported as a custom line');
      }
    }

    const unit = (cell(r, 'unit') || product?.unit || defaultUnit).toLowerCase();
    const per = piecesPerBillingUnit(unit);
    if (pcsPerPack == null && product?.pcs_per_pack != null) pcsPerPack = product.pcs_per_pack;

    // Pieces and the billing quantity are two readings of one figure, and
    // `billedQty` derives the second from the first on a piece basis — so on
    // that basis the piece count is what is stored and the quantity is left to
    // be derived, which is exactly how a line typed on the form behaves.
    let total_pcs = piecesNum;
    let qty: number | null = null;
    if (basis === 'pieces' && per) {
      total_pcs = piecesNum ?? qtyNum;
    } else {
      qty = qtyNum;
    }
    // Boxes × pcs per box is the piece count where nothing states it, the
    // dispatch form's own arithmetic read the other way round.
    if (total_pcs == null && packs != null && pcsPerPack != null) total_pcs = packs * pcsPerPack;

    /*
     * The rate is read per piece and then converted onto the line's own
     * billing basis, which is the only place that knows what `per` is: a
     * `per 1000` line takes ×1000, a per-piece line the figure itself, and a
     * weight-billed line is quoted per kilo and takes the cell as typed.
     */
    const cellText = cell(r, 'rate');
    const priced = rateFromCell(cellText, rateBasis);
    if (priced.note) notes.push(priced.note);
    else if (priced.pieceRate == null) notes.push('No rate on this row — imported at 0');
    const rate = per != null
      ? (priced.pieceRate ?? 0) * per
      : (parseNum(cellText) ?? 0);
    const taxRaw = numCell(r, 'tax_pct');

    return {
      line: {
        row: rowNo,
        product_id: product?.id ?? null,
        description: text || code,
        code,
        color: color || product?.color || '',
        hsn_code: cell(r, 'hsn_code') || product?.hsn_code || '',
        unit,
        qty,
        unit_price: rate,
        tax_pct: taxRaw ?? defaultTax,
        packs: packs ?? (total_pcs != null && pcsPerPack ? Math.round((total_pcs / pcsPerPack) * 100) / 100 : null),
        pcs_per_pack: pcsPerPack,
        total_pcs,
        supplier: cell(r, 'supplier'),
        scheduled_date: parseDate(cell(r, 'promised_date')),
        note: notes.join('; ') || undefined,
      },
    };
  }

  /*
   * A number used twice on one sheet is two different orders, not one.
   *
   * Measured on the live book: 33 of its numbers are stated against more than
   * one customer — `AP/0216` against three — because the series has run round
   * across years. Grouping them together would merge one buyer's order into
   * another's, and writing both under one number is refused by the per-company
   * unique index, which would take the whole load down with it. So the later
   * ones are suffixed on the way in, as `connection.ts` suffixes the
   * duplicates it finds already on file, and the preview says so: the number
   * on the paperwork is still readable in it, and it can be corrected after.
   */
  const usedNumbers = new Map<string, number>();
  for (const o of order) {
    if (!o.number) continue;
    const key = o.number.trim().toLowerCase();
    const seenBefore = usedNumbers.get(key) ?? 0;
    usedNumbers.set(key, seenBefore + 1);
    if (seenBefore) {
      const original = o.number;
      o.number = `${o.number}-${seenBefore + 1}`;
      o.note = `${original} is used by more than one customer on this sheet — imported as ${o.number}`;
    }
  }

  const statusSeen = new Map<string, number>();
  for (const o of order) {
    const text = o.status_text.trim();
    if (text) statusSeen.set(text, (statusSeen.get(text) ?? 0) + 1);
  }
  const statuses = [...statusSeen].map(([text, count]) => ({
    text,
    count,
    action: opts.statusActions?.[text] ?? guessStatusAction(text),
  })).sort((a, b) => b.count - a.count);
  const actionFor = new Map(statuses.map((s) => [s.text, s.action]));

  // Now decide what each order would do. Customer, currency and the export
  // flag are settled here because all three follow from the customer record —
  // `fromCustomer()` on the quotation form makes exactly the same derivation.
  for (const o of order) {
    if (!o.number) { o.action = 'skip'; o.note = 'No order number'; continue; }

    const match = matchByName(o.customer_text, lookups.customers);
    if (match.hit) {
      o.customer_id = match.hit.id;
      o.customer_name = match.hit.name;
      const isExport = match.hit.is_export
        || (match.hit.country.trim().toLowerCase() !== 'india' && match.hit.country.trim() !== '' ? 1 : 0);
      o.is_export = isExport ? 1 : 0;
      o.tax_type = isExport ? 'none' : 'igst';
      if (!o.currency) o.currency = match.hit.currency || 'INR';
    } else {
      o.currency = o.currency || 'INR';
    }
    if (o.is_export) for (const l of o.lines) l.tax_pct = 0;

    o.total = Math.round(o.lines.reduce((sum, l) => {
      const billed = l.qty ?? (piecesPerBillingUnit(l.unit) && l.total_pcs != null
        ? l.total_pcs / piecesPerBillingUnit(l.unit)! : l.total_pcs ?? 0);
      return sum + (billed ?? 0) * l.unit_price;
    }, 0) * 100) / 100;

    o.status_action = actionFor.get(o.status_text.trim()) ?? 'open';
    o.import_status = o.status_action === 'completed' ? 'completed'
      : o.status_action === 'cancelled' ? 'cancelled' : '';

    const existingId = lookups.orderNumbers.get(o.number.trim().toLowerCase());
    if (existingId !== undefined) {
      o.action = 'skip';
      o.note = 'Already on file — left exactly as it is';
      o.existingId = existingId;
    } else if (o.status_action === 'skip') {
      o.action = 'skip';
      o.note = `Status “${o.status_text}” — not being imported`;
    } else if (!o.customer_id) {
      o.action = 'skip';
      o.note = match.ambiguous
        ? `More than one customer reads like "${o.customer_text}" — correct the spelling and preview again`
        : o.customer_text
          ? `No customer called "${o.customer_text}" — add them first, or correct the spelling`
          : 'No customer named';
    } else if (o.lines.length === 0) {
      o.action = 'skip';
      o.note = 'No line with a quantity';
    }
  }

  return {
    sheetNames: sheets.map((s) => s.name),
    sheet: chosen.name,
    headerRow,
    headers,
    mapping,
    orders: order,
    statuses,
    summary: {
      create: order.filter((o) => o.action === 'create').length,
      skip: order.filter((o) => o.action === 'skip').length,
      lines: order.filter((o) => o.action === 'create').reduce((n, o) => n + o.lines.length, 0),
      rows: body.length,
    },
  };
}
