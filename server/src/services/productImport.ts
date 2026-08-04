import { parseWorkbook, splitHeader, splitAt, type Sheet } from './spreadsheet.js';

/**
 * Turning a customer's own spreadsheet into catalogue rows.
 *
 * The shape of these sheets is never the same twice, so nothing is assumed:
 * the columns are guessed from the headings, everything is shown back for
 * confirmation, and the user can correct any of it before a single row is
 * written. Preview and import run the identical pipeline, so what is shown is
 * exactly what gets saved.
 */

export interface FieldSpec {
  key: 'name' | 'description' | 'hsn_code' | 'unit' | 'unit_price' | 'country_of_origin' | 'color'
     | 'pcs_per_pack' | 'qty_20ft' | 'qty_40ft';
  label: string;
  required?: boolean;
  numeric?: boolean;
  /** Lower-cased heading fragments that identify this column. */
  synonyms: string[];
}

export const IMPORT_FIELDS: FieldSpec[] = [
  { key: 'name', label: 'Product Name', required: true, synonyms: ['product name', 'product', 'name', 'item name', 'item', 'sku', 'standard name', 'particulars', 'description of goods'] },
  { key: 'description', label: 'Description', synonyms: ['description', 'details', 'specification', 'spec', 'remarks'] },
  { key: 'hsn_code', label: 'HSN Code', synonyms: ['hsn code', 'hsn/sac', 'hsn', 'hs code', 'hscode'] },
  { key: 'unit', label: 'Unit', synonyms: ['unit of measure', 'unit', 'uom', 'measure'] },
  { key: 'unit_price', label: 'Default Price', numeric: true, synonyms: ['basic price', 'unit price', 'default price', 'price', 'rate', 'amount'] },
  { key: 'pcs_per_pack', label: 'Pcs / Box', numeric: true, synonyms: ['pcs box', 'pcs per box', 'pieces per box', 'pcs carton', 'pcs per carton', 'pieces per carton', 'pcs pack', 'qty per box', 'box qty'] },
  { key: 'qty_20ft', label: 'Boxes per 20ft', numeric: true, synonyms: ['boxes per 20ft', 'boxes 20ft', '20ft', '20 ft', "20'", '20ft container', '20'] },
  { key: 'qty_40ft', label: 'Boxes per 40ft', numeric: true, synonyms: ['boxes per 40ft', 'boxes 40ft', '40ft', '40 ft', "40'", '40ft container', '40'] },
  { key: 'country_of_origin', label: 'Country of Origin', synonyms: ['country of origin', 'origin', 'country'] },
  { key: 'color', label: 'Colour', synonyms: ['colour', 'color'] },
];

export type Mapping = Partial<Record<FieldSpec['key'], number>>;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Best-guess column for each field: exact heading match beats a partial one. */
export function autoMap(headers: string[]): Mapping {
  const normalised = headers.map(norm);
  const taken = new Set<number>();
  const mapping: Mapping = {};

  for (const field of IMPORT_FIELDS) {
    let bestIdx = -1;
    let bestScore = 0;
    normalised.forEach((h, i) => {
      if (!h || taken.has(i)) return;
      for (const syn of field.synonyms) {
        // Exact heading is a much stronger signal than a word appearing in it.
        const score = h === syn ? 100 - field.synonyms.indexOf(syn)
          : h.includes(syn) ? 50 - field.synonyms.indexOf(syn)
          : 0;
        if (score > bestScore) { bestScore = score; bestIdx = i; }
      }
    });
    if (bestIdx >= 0) { mapping[field.key] = bestIdx; taken.add(bestIdx); }
  }

  // A sheet with only "Description" and no name column still has a usable name.
  if (mapping.name === undefined && mapping.description !== undefined) {
    mapping.name = mapping.description;
    delete mapping.description;
  }
  return mapping;
}

/** "₹ 1,234.50" → 1234.5. Anything unreadable becomes null so it can be flagged. */
export function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export interface DraftProduct {
  name: string; description: string; hsn_code: string; unit: string;
  unit_price: number; country_of_origin: string; color: string;
  pcs_per_pack: number | null; qty_20ft: number | null; qty_40ft: number | null;
}

/**
 * What makes two catalogue rows "the same product".
 *
 * Not the name alone: the same item is genuinely stocked at more than one box
 * count (the user's own sheet lists 27mm 3 start Alaska at both 8500 and 9000
 * per box), and those are separate things to quote and load. Colour and pieces
 * per box are therefore part of the identity.
 */
export function identityKey(p: { name: string; color?: string; pcs_per_pack?: number | null }): string {
  return [
    p.name.trim().toLowerCase(),
    (p.color ?? '').trim().toLowerCase(),
    p.pcs_per_pack ?? '',
  ].join('|');
}

export interface PreviewRow {
  /** 1-based row number in the original sheet, so the user can find it. */
  row: number;
  product: DraftProduct;
  action: 'create' | 'update' | 'skip';
  /** Why the row is skipped, or what was adjusted. */
  note?: string;
  existingId?: number;
}

export interface BuildResult {
  sheetNames: string[];
  sheet: string;
  headerRow: number;
  headers: string[];
  mapping: Mapping;
  rows: PreviewRow[];
  summary: { create: number; update: number; skip: number; total: number };
}

export interface BuildOptions {
  sheet?: string;
  headerRow?: number;
  mapping?: Mapping;
  /** What to do when a product of the same name already exists. */
  onDuplicate?: 'update' | 'skip';
}

/**
 * Parse a workbook and work out what each row would do, without writing
 * anything. `existing` maps lower-cased product name → id.
 */
export function buildImport(
  buf: Buffer,
  filename: string,
  existing: Map<string, number>,
  opts: BuildOptions = {}
): BuildResult {
  const sheets: Sheet[] = parseWorkbook(buf, filename);
  if (sheets.length === 0) throw new Error('That file has no readable sheets.');

  const chosen = sheets.find((s) => s.name === opts.sheet)
    // Default to the first sheet that actually has content.
    ?? sheets.find((s) => s.rows.some((r) => r.some((c) => c !== '')))
    ?? sheets[0];

  const split = opts.headerRow !== undefined && opts.headerRow >= 0
    ? splitAt(chosen.rows, opts.headerRow)
    : splitHeader(chosen.rows);
  const { headers, body, headerRow } = split;

  const mapping = opts.mapping && Object.keys(opts.mapping).length ? opts.mapping : autoMap(headers);
  const onDuplicate = opts.onDuplicate ?? 'update';

  const cell = (r: string[], idx: number | undefined) =>
    idx === undefined || idx < 0 ? '' : (r[idx] ?? '').trim();

  const seen = new Set<string>();
  const rows: PreviewRow[] = body.map((r, i) => {
    const name = cell(r, mapping.name);
    const priceRaw = cell(r, mapping.unit_price);
    const price = priceRaw ? parseNumber(priceRaw) : 0;
    const num = (key: FieldSpec['key']) => {
      const raw = cell(r, mapping[key]);
      return raw ? parseNumber(raw) : null;
    };

    const product: DraftProduct = {
      name,
      description: cell(r, mapping.description),
      hsn_code: cell(r, mapping.hsn_code),
      unit: cell(r, mapping.unit).toLowerCase() || 'unit',
      unit_price: price ?? 0,
      country_of_origin: cell(r, mapping.country_of_origin) || 'India',
      color: cell(r, mapping.color),
      pcs_per_pack: num('pcs_per_pack'),
      qty_20ft: num('qty_20ft'),
      qty_40ft: num('qty_40ft'),
    };
    // Row number as the user sees it in Excel: header row + offset + 1.
    const rowNo = headerRow + 2 + i;

    if (!name) return { row: rowNo, product, action: 'skip', note: 'No product name in this row' };

    const key = identityKey(product);
    if (seen.has(key)) return { row: rowNo, product, action: 'skip', note: 'Repeat of an earlier row in this sheet' };
    seen.add(key);

    const existingId = existing.get(key);
    const note = priceRaw && price === null ? `Price "${priceRaw}" is not a number — imported as 0` : undefined;

    if (existingId !== undefined) {
      return onDuplicate === 'skip'
        ? { row: rowNo, product, action: 'skip', note: 'Already in the catalogue', existingId }
        : { row: rowNo, product, action: 'update', note, existingId };
    }
    return { row: rowNo, product, action: 'create', note };
  });

  return {
    sheetNames: sheets.map((s) => s.name),
    sheet: chosen.name,
    headerRow,
    headers,
    mapping,
    rows,
    summary: {
      create: rows.filter((r) => r.action === 'create').length,
      update: rows.filter((r) => r.action === 'update').length,
      skip: rows.filter((r) => r.action === 'skip').length,
      total: rows.length,
    },
  };
}

/** Decode the base64 (or data-URL) payload the browser sends. */
export function decodeUpload(file: string): Buffer {
  const comma = file.indexOf(',');
  const base64 = file.startsWith('data:') && comma >= 0 ? file.slice(comma + 1) : file;
  return Buffer.from(base64, 'base64');
}
