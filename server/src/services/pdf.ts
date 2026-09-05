import PdfPrinter from 'pdfmake';
import pdfFonts from 'pdfmake/build/vfs_fonts.js';
import type { TDocumentDefinitions, Content } from 'pdfmake/interfaces';
import { inflateSync } from 'node:zlib';
import { db } from '../db/connection.js';
import { amountInWords } from './amountInWords.js';
import { round2, isPieceBasis, piecesPerBillingUnit } from './totals.js';
import { invoiceReceivable, proformaAdvance } from './receivables.js';
import { paramsFor, specOwner, checksForWorkOrder } from './qc.js';
import { getCompany, defaultCompany } from './companies.js';

// The npm package ships fonts only as base64 vfs; decode them for the server printer.
const vfs: Record<string, string> =
  (pdfFonts as any).vfs ?? (pdfFonts as any).pdfMake?.vfs ?? (pdfFonts as any);
const font = (name: string) => Buffer.from(vfs[name], 'base64');

const printer = new PdfPrinter({
  Roboto: {
    normal: font('Roboto-Regular.ttf'),
    bold: font('Roboto-Medium.ttf'),
    italics: font('Roboto-Italic.ttf'),
    bolditalics: font('Roboto-MediumItalic.ttf'),
  },
});

type Row = Record<string, any>;
// pdfmake's TableCell union is too narrow for our dynamic cell construction.
type Cell = any;

const currencySymbols: Record<string, string> = { INR: '₹', USD: '$', EUR: '€' };
const currencyNames: Record<string, string> = { INR: 'INR', USD: 'USD', EUR: 'EURO' };

function fmtMoney(n: number, currency: string): string {
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  return `${currencySymbols[currency] ?? currency + ' '}${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n || 0)}`;
}

function fmtNum(n: number | null | undefined, maxFrac = 3): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: maxFrac }).format(n);
}

function fmtDate(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

/* ------------------------------------------------------------------ */
/* Image safety                                                        */
/* ------------------------------------------------------------------ */

/**
 * A stored image is only handed to pdfmake once we know it decodes.
 *
 * This is a crash guard, not a nicety. pdfkit's PNG path inflates the IDAT
 * data through zlib's *callback* API and rethrows any failure from inside that
 * callback — so a corrupt PNG surfaces as an uncaughtException on a later
 * tick, escaping both the promise in renderPdf and the try/catch in
 * routes/pdf.ts, and taking the whole server process down with it. One bad
 * logo would then break every document for everyone, not just its own.
 *
 * Validating up front costs one synchronous inflate of an image we were about
 * to decode anyway, and turns the failure into "the PDF prints without the
 * picture".
 */
const IMAGE_DATA_URL = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngDecodes(buf: Buffer): boolean {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  const idat: Buffer[] = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const start = off + 8;
    // A length that runs past the buffer means the file is truncated or lying.
    if (len > buf.length || start + len + 4 > buf.length) return false;
    if (type === 'IDAT') idat.push(buf.subarray(start, start + len));
    if (type === 'IEND') break;
    off = start + len + 4;
  }
  if (!idat.length) return false;
  try {
    inflateSync(Buffer.concat(idat));
    return true;
  } catch {
    return false;
  }
}

/**
 * JPEG failures throw synchronously from pdfkit, so they are already caught
 * and turned into a 500 — this only needs to be good enough to spot a file
 * that is not a JPEG at all. A false positive costs a 500, never a crash.
 */
function jpegLooksSane(buf: Buffer): boolean {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return false;
  for (let i = 2; i + 1 < buf.length; i++) {
    if (buf[i] !== 0xff) continue;
    const marker = buf[i + 1];
    // Any start-of-frame marker: C0–CF except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return true;
  }
  return false;
}

/** The data URL if pdfmake can be trusted with it, otherwise ''. */
export function safeImage(value: unknown): string {
  const dataUrl = typeof value === 'string' ? value.trim() : '';
  if (!dataUrl) return '';
  const m = IMAGE_DATA_URL.exec(dataUrl);
  if (!m) return '';
  let buf: Buffer;
  try {
    buf = Buffer.from(m[2], 'base64');
  } catch {
    return '';
  }
  const ok = m[1] === 'png' ? pngDecodes(buf) : jpegLooksSane(buf);
  if (!ok) console.warn(`Skipping an undecodable ${m[1]} image (${buf.length} bytes) in a PDF`);
  return ok ? dataUrl : '';
}

/** Drops any line-item photo that would not decode, in place. */
function sanitiseItemImages(items: Row[]): void {
  for (const it of items) {
    if (it.image) it.image = safeImage(it.image);
  }
}

/**
 * The letterhead for one document, taken from the company that issued it.
 *
 * Every builder passes its own row's `company_id`, so the paperwork is
 * reproducible: a 2026 invoice reprinted in 2028 still carries the entity,
 * GSTIN and logo it actually went out under, whatever the group looks like by
 * then. Falls back to the group default when a document predates the column.
 */
function companyProfile(companyId: unknown): Row {
  const id = Number(companyId);
  const s = (Number.isInteger(id) && id > 0 ? getCompany(id) : defaultCompany()) as Row;
  s.theme = s.theme_color || '#8b1a1a';
  // Both images reach pdfmake from here, so one check covers every builder.
  s.logo = safeImage(s.logo);
  s.signature = safeImage(s.signature);
  return s;
}

/** Rate label like "USD/1000" or "₹/pc" from the item unit. */
function uomLabel(currency: string, unit: string): string {
  const u = (unit || 'unit').toLowerCase();
  const cur = currency;
  if (u === 'per 1000') return `${cur}/1000`;
  if (u === 'unit') return `${cur}/pc`;
  return `${cur}/${unit}`;
}

const BOX = '#4a4a4a';
const boxedLayout = {
  hLineColor: BOX, vLineColor: BOX,
  hLineWidth: () => 0.6, vLineWidth: () => 0.6,
  paddingTop: () => 3, paddingBottom: () => 3, paddingLeft: () => 5, paddingRight: () => 5,
};

const gridLayout = {
  hLineColor: '#bbbbbb', vLineColor: '#bbbbbb',
  hLineWidth: () => 0.5, vLineWidth: () => 0.5,
  paddingTop: () => 3, paddingBottom: () => 3,
};

/** Label + value stacked inside one boxed cell (AP/EX invoice style). */
function lv(label: string, value: string, opts: Cell = {}): Cell {
  return {
    stack: [
      { text: label.toUpperCase(), fontSize: 6.5, bold: true, color: '#333333' },
      { text: value || '—', fontSize: 8, margin: [0, 1.5, 0, 0] },
    ],
    ...opts,
  };
}

/** Aglo-style page header: logo left, company block right in theme color. */
/**
 * Which registration numbers belong on which document.
 *
 * Confirmed with Aglo (2026-09-03), and the rules are narrower than printing
 * all three on everything:
 *
 * - **GSTIN is a domestic thing.** An export sale is zero-rated and the buyer
 *   is abroad; the number means nothing to them and does not belong on the
 *   page.
 * - **PAN is not printed at all.** It was never asked for on any of these
 *   documents. The column stays — removing it would be a destructive schema
 *   change for a field nothing now reads.
 * - **IEC belongs on the export commercial invoice only.** It is the code the
 *   consignment clears customs under, so it belongs on the document that goes
 *   with the goods, not on a quotation or an order confirmation.
 */
function registrationLine(s: Row, opts: HeaderOpts): string {
  return [
    !opts.isExport && s.gstin && `GSTIN: ${s.gstin}`,
    opts.isExport && opts.isCommercialInvoice && s.iec && `IEC: ${s.iec}`,
  ].filter(Boolean).join('  |  ');
}

interface HeaderOpts {
  isExport?: boolean;
  /** Only the commercial invoice carries the IEC. */
  isCommercialInvoice?: boolean;
}

function companyHeader(s: Row, opts: HeaderOpts = {}): Content[] {
  const right: any = {
    stack: [
      { text: s.company_name || 'Company Name', fontSize: 14, bold: true, color: s.theme, alignment: 'right' },
      { text: [s.address, [s.city, s.state ? s.state : '', s.pincode].filter(Boolean).join(', '), s.country].filter(Boolean).join(', '), fontSize: 8, color: '#555555', alignment: 'right', margin: [0, 2, 0, 0] },
      { text: [s.phone && `Sales cell: ${s.phone}`, s.email && `Email: ${s.email}`, s.website].filter(Boolean).join('  |  '), fontSize: 8, color: '#555555', alignment: 'right', margin: [0, 1.5, 0, 0] },
      { text: registrationLine(s, opts), fontSize: 7.5, color: '#777777', alignment: 'right', margin: [0, 1.5, 0, 0] },
    ],
    width: '*',
  };
  // The logo column eats into the right block, which gets the rest of the
  // 515pt content width. **Widening it wraps the contact row**, which costs a
  // whole line and undoes the point of enlarging the logo — at 176 the demo
  // company's "Sales cell | Email | website" line broke in two. 158 leaves
  // 349pt, within a few points of what that row had before.
  //
  // The row is as tall as the logo or the text stack, whichever is taller, and
  // the stack runs about 52pt, so height up to that is free. A wide logo is
  // bound by the width above, not the height here.
  const cols: Content = s.logo
    ? { columns: [{ image: s.logo, fit: [158, 80] as [number, number], width: 158 }, right], columnGap: 8 }
    : right;
  return [
    cols,
    { canvas: [{ type: 'line', x1: 0, y1: 4, x2: 515, y2: 4, lineWidth: 2, lineColor: s.theme }], margin: [0, 0, 0, 2] as any },
  ];
}

/**
 * The letter-spaced document title. Tracking comes from pdfmake's
 * characterSpacing rather than joining the letters with spaces — a real space
 * is a full word-space wide (~0.25em), which reads as gappy rather than as
 * tracking and cannot be tuned.
 */
function docTitle(s: Row, title: string): Content {
  return {
    text: title,
    fontSize: 14, bold: true, characterSpacing: 1.6, alignment: 'center', color: s.theme,
    decoration: 'underline', margin: [0, 4, 0, 6] as any,
  };
}

/**
 * "NOTES & TERMS" bullet list from notes + default terms.
 *
 * Terms are typed by hand in Settings, and people number them inline as often
 * as they put one per line — "1. Prices are ex-works. 2. Levies extra." would
 * otherwise print as a single bullet carrying a stray "2.". So split on both:
 * newlines first, then on an inline "<n>." or "<n>)" that starts a new clause.
 * The lookahead requires a following space, so a decimal or "(119 ±2)" is safe.
 */
function notesAndTerms(s: Row, docNotes: string, title = 'NOTES & TERMS:'): Content[] {
  const bullets = [docNotes, s.default_terms]
    .filter(Boolean)
    .flatMap((t: string) => t.split('\n'))
    .flatMap((line) => line.split(/\s+(?=\d{1,2}[.)]\s)/))
    .map((line) => line.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean);
  if (!bullets.length) return [];
  return [
    { text: title, fontSize: 9, bold: true, color: s.theme, margin: [0, 10, 0, 3] as any },
    { ul: bullets.map((b) => ({ text: b, fontSize: 8, margin: [0, 1, 0, 1] as any })) },
  ];
}

/**
 * Who signs, and where.
 *
 * The seller's block sits on the **left** with the preparer's name beneath it,
 * and the buyer signs on the right — the arrangement Aglo asked for on
 * 2026-09-03. Prepared By belongs with the seller: it names whoever in the
 * office drew the document up, so it reads as part of that block rather than
 * as something the buyer is being asked to fill in.
 *
 * Shared by the proforma and the order confirmation. The order passes no
 * `buyerSide`, so its right-hand column is simply empty.
 */
function signatureBlock(s: Row, opts: { buyerSide?: boolean; preparedBy?: string } = {}): Content {
  // The seller signs and stamps here; the buyer needs the same room opposite.
  const signingSpace = 42;
  const supplier: any = {
    stack: [
      { text: `For ${s.company_name || 'Company'}`, fontSize: 8, bold: true },
      ...(s.signature
        ? [{ image: s.signature, fit: [110, signingSpace] as [number, number], margin: [0, 4, 0, 4] as any }]
        : [{ text: ' ', margin: [0, signingSpace / 2, 0, 0] as any }]),
      { text: 'Authorised Signatory', fontSize: 8 },
      ...(opts.preparedBy
        ? [{ text: `Prepared By: ${opts.preparedBy}`, fontSize: 7.5, color: '#666666', margin: [0, 6, 0, 0] as any }]
        : []),
    ],
    width: '*',
  };
  const buyer: any = {
    stack: opts.buyerSide
      ? [
        // Flush with the right margin, so it finishes level with the right-hand
        // edge of the items table above rather than floating mid-page.
        { text: "BUYER'S SIGNATURE & STAMP", fontSize: 8, bold: true, alignment: 'right' },
        // Empty room to sign into, the same depth the seller's stamp takes, so
        // the two blocks read as a pair rather than one floating beside the
        // other's middle.
        { text: ' ', margin: [0, signingSpace / 2, 0, 0] as any },
      ]
      : [{ text: '' }],
    // Fixed, so the seller's '*' column pushes this one to the right end.
    width: 190,
  };
  return {
    // Two equal columns, both headings on the same line. The buyer used to be
    // pushed 30pt down to clear a signature image that sat on the other side;
    // once the columns swapped that margin stranded it against nothing.
    columns: [supplier, buyer],
    columnGap: 24,
    margin: [0, 18, 0, 0] as any,
  };
}

function roundOffOf(doc: Row): number {
  return round2(Number(doc.grand_total) - (Number(doc.subtotal) + Number(doc.freight || 0) + Number(doc.insurance || 0) + Number(doc.tax_total)));
}

function taxRows(doc: Row, currency: string): [string, string][] {
  const rows: [string, string][] = [];
  if (doc.tax_type === 'cgst_sgst' && doc.tax_total > 0) {
    rows.push(['Add CGST', fmtMoney(doc.tax_total / 2, currency)], ['Add SGST', fmtMoney(doc.tax_total / 2, currency)]);
  } else if (doc.tax_type === 'igst' && doc.tax_total > 0) {
    rows.push(['Add IGST', fmtMoney(doc.tax_total, currency)]);
  }
  return rows;
}

/** Right-aligned totals band: light rows + theme-filled emphasis bars (Sanya style). */
export interface MoneyRow {
  label: string;
  value: string;
  band?: boolean;
  /**
   * Carry the columns' totals on this row rather than on the last one.
   *
   * The additive columns have to be totalled somewhere, and the natural place
   * is the row that closes the table. "Last row" was fine while the grand
   * total *was* the last row, but an invoice adds Amount Received and Balance
   * Due after it — and the boxes and pieces shipped have nothing to do with
   * the balance outstanding. Saying which row owns the sums is one word here
   * and removes the positional assumption.
   */
  sums?: boolean;
}

/**
 * The money lines that close a document: subtotal, freight and insurance, tax,
 * round off, grand total. Shared so they read identically whether they are
 * drawn as a band beside the page or folded into the items table itself.
 */
function totalsRows(doc: Row, currency: string, grandLabel: string): MoneyRow[] {
  const bandRows: MoneyRow[] = [];
  const hasExtras = Number(doc.freight) || Number(doc.insurance) || doc.tax_total > 0 || roundOffOf(doc) !== 0;
  bandRows.push({ label: 'TOTAL PRICE', value: fmtMoney(doc.subtotal, currency), band: hasExtras ? true : false });
  if (Number(doc.freight) && Number(doc.insurance)) {
    bandRows.push({ label: 'Indicative Freight & Insurance', value: fmtMoney(Number(doc.freight) + Number(doc.insurance), currency) });
  } else {
    if (Number(doc.freight)) bandRows.push({ label: 'Add Freight', value: fmtMoney(doc.freight, currency) });
    if (Number(doc.insurance)) bandRows.push({ label: 'Add Insurance', value: fmtMoney(doc.insurance, currency) });
  }
  for (const [l, v] of taxRows(doc, currency)) bandRows.push({ label: l, value: v });
  const ro = roundOffOf(doc);
  if (ro !== 0) bandRows.push({ label: 'Round off', value: (ro > 0 ? '' : '(') + Math.abs(ro).toFixed(2) + (ro > 0 ? '' : ')') });
  bandRows.push({ label: grandLabel, value: fmtMoney(doc.grand_total, currency), band: true });
  return bandRows;
}

function totalsBand(s: Row, doc: Row, currency: string, grandLabel: string): Content {
  const bandRows = totalsRows(doc, currency, grandLabel);

  return {
    columns: [
      { text: '', width: '*' },
      {
        table: {
          widths: ['*', 95],
          body: bandRows.map((r) => [
            { text: r.label, fontSize: r.band ? 8.5 : 8, bold: !!r.band, color: r.band ? '#ffffff' : '#222222', fillColor: r.band ? s.theme : '#f4f2f0' },
            { text: r.value, fontSize: r.band ? 8.5 : 8, bold: !!r.band, alignment: 'right', color: r.band ? '#ffffff' : '#222222', fillColor: r.band ? s.theme : '#f4f2f0' },
          ]),
        },
        layout: { hLineColor: '#ffffff', vLineColor: '#ffffff', hLineWidth: () => 1.5, vLineWidth: () => 0, paddingTop: () => 4, paddingBottom: () => 4, paddingLeft: () => 6, paddingRight: () => 6 },
        width: 300,
      },
    ],
    margin: [0, 8, 0, 0] as any,
  };
}

function amountWords(doc: Row, currency: string): Content {
  return {
    text: `Amount in Words: ${amountInWords(doc.grand_total, currency)}`,
    fontSize: 10, bold: true, italics: true, margin: [0, 6, 0, 0] as any,
  };
}

function customerAddress(c: Row, withContact = true): string {
  // Phone and email share a line. Each costs a full line of the buyer block
  // otherwise, and that block sits above every line item on the page.
  const contact = [c.phone && `Phone: ${c.phone}`, c.email && `Email: ${c.email}`]
    .filter(Boolean).join('   |   ');
  const lines = [
    c.name, c.contact_person && `Attn: ${c.contact_person}`, c.address,
    [c.city, c.country].filter(Boolean).join(', '),
    c.gstin && `GSTIN: ${c.gstin}`, withContact && contact,
  ].filter(Boolean).map(String);
  // A customer whose address line is just the country prints it twice.
  return lines.filter((l, i) => l.toLowerCase() !== lines[i - 1]?.toLowerCase()).join('\n');
}

function baseDoc(content: Content[]): TDocumentDefinitions {
  return {
    pageSize: 'A4',
    // Top margin trimmed to pay for a larger logo: 26pt is ~9mm, well inside
    // the unprintable edge of any office printer.
    pageMargins: [40, 26, 40, 42],
    content,
    footer: (currentPage, pageCount) => ({
      text: `Page ${currentPage} of ${pageCount}`, alignment: 'center', fontSize: 7, color: '#999999',
    }),
    defaultStyle: { fontSize: 9, color: '#1a1a1a' },
  };
}

const th = (s: Row, text: string): Cell => ({ text, bold: true, fontSize: 7.5, color: '#ffffff', fillColor: s.theme, alignment: 'center' });

/* ------------------------------------------------------------------ */
/* Column-driven items table                                           */
/* ------------------------------------------------------------------ */

export interface ColumnSpec {
  key: string;
  label: string;
  width: number | '*';
  align?: 'left' | 'right' | 'center';
  /** Cell text for an item; return '' to count as empty for auto-hide. */
  value: (it: Row, index: number) => string;
  /**
   * Render something other than text — an image, say. `value` is still used to
   * decide whether the column is empty and can be dropped.
   */
  cell?: (it: Row, index: number) => Cell;
  /** Always keep this column, even when every value is empty. */
  always?: boolean;
  /**
   * Banner shared with the adjacent columns carrying the same name, drawn as a
   * second header row above them — QUANTITY over CTN. / IMAGE / PCS. per CTN.,
   * the way the real proformas group them. Only adjacent columns group; a gap
   * starts a new banner.
   */
  group?: string;
  /**
   * Adds this column up in the table's closing TOTAL row.
   *
   * Only genuinely additive figures qualify: boxes and pieces add, money adds.
   * A rate does not, and neither does pcs-per-box — summing those produces a
   * number that looks authoritative and means nothing.
   */
  sum?: (items: Row[]) => string;
}

export interface ColumnConfig {
  hidden?: string[];
  custom?: string[];
}

/**
 * Columns a document type prints whatever its stored config says — the PDF
 * half of PROFORMA_FORCED / INVOICE_FORCED / ORDER_FORCED in the client's
 * `components/ColumnsControl.tsx`, and it has to be the same list on both
 * sides or the paper and the screen disagree about the same document.
 *
 * A config is not written only by the tick-list beside the table it controls:
 * carry-forward copies the source document's columns onto the new one. A
 * quotation sent as a rate-and-packing price list carries `amount` hidden, and
 * that rode onto the proforma raised from it — which is what an advance is
 * paid against — and onward to the order and the commercial invoice, where an
 * amount-less document cannot be presented for GST or customs at all.
 *
 * Applied on read rather than fixed in the rows, so a document already saved
 * with such a config prints correctly and nothing needs migrating.
 */
function forceColumns(cfg: ColumnConfig, forced: string[]): ColumnConfig {
  if (!cfg.hidden?.some((k) => forced.includes(k))) return cfg;
  return { ...cfg, hidden: cfg.hidden.filter((k) => !forced.includes(k)) };
}

/**
 * `total_pcs` on the proforma: `qty` is omitted there, which leaves Total Qty
 * as its only quantity column. Orders and invoices keep Qty and so do not need
 * it forced.
 */
const PROFORMA_FORCED = ['total_pcs', 'amount'];
const INVOICE_FORCED = ['amount'];
const ORDER_FORCED = ['amount'];

/**
 * Builds the line-items table honouring the document's column_config:
 * explicitly hidden columns are dropped, columns with no data anywhere are
 * dropped automatically, and up to three named custom columns are appended.
 */
function itemsTable(s: Row, items: Row[], specs: ColumnSpec[], cfg: ColumnConfig, footer: MoneyRow[] = []) {
  const hidden = new Set(cfg.hidden ?? []);
  const customNames = (cfg.custom ?? []).slice(0, 3);

  const columns = specs.filter((c) => {
    if (hidden.has(c.key)) return false;
    if (c.always) return true;
    return items.some((it) => {
      const v = c.value(it, 0);
      return v !== '' && v !== '—';
    });
  });

  customNames.forEach((name, i) => {
    if (!name) return;
    const key = `custom${i + 1}`;
    if (hidden.has(key)) return;
    columns.push({
      key,
      label: name,
      width: 55,
      align: 'center',
      value: (it) => String(it[key] ?? ''),
      always: true,
    });
  });

  const head = (c: ColumnSpec): Cell => ({ ...th(s, c.label), alignment: c.key === 'description' ? 'left' : 'center' });

  // One header row unless some column asks to sit under a banner, in which case
  // ungrouped columns span both rows and each banner spans its own run.
  const headers: Cell[][] = [];
  if (!columns.some((c) => c.group)) {
    headers.push(columns.map(head));
  } else {
    const top: Cell[] = [];
    const bottom: Cell[] = [];
    for (let i = 0; i < columns.length;) {
      const c = columns[i];
      if (!c.group) {
        top.push({ ...head(c), rowSpan: 2 });
        bottom.push({});
        i += 1;
        continue;
      }
      let span = 1;
      while (i + span < columns.length && columns[i + span].group === c.group) span += 1;
      top.push({ ...th(s, c.group), colSpan: span });
      for (let k = 1; k < span; k += 1) top.push({});
      for (let k = 0; k < span; k += 1) bottom.push(head(columns[i + k]));
      i += span;
    }
    headers.push(top, bottom);
  }

  /** Spread a label across every column but the last, value in the last. */
  const spanned = (label: Cell, value: Cell): Cell[] => {
    const span = Math.max(1, columns.length - 1);
    const cells: Cell[] = [{ ...label, colSpan: span }];
    for (let k = 1; k < span; k += 1) cells.push({});
    cells.push(value);
    return cells;
  };

  // Freight, tax and the grand total, inside the table rather than in a band
  // beside it — the page has no room to spare above the signature.
  const money = (r: MoneyRow): Cell[] => {
    const style = {
      fontSize: r.band ? 8.5 : 8, bold: !!r.band,
      color: r.band ? '#ffffff' : '#222222', fillColor: r.band ? s.theme : '#f4f2f0',
    };
    return spanned({ text: r.label, alignment: 'right', ...style }, { text: r.value, alignment: 'right', ...style });
  };

  /**
   * One closing row, not two.
   *
   * The additive columns are totalled on the *last* money row rather than on a
   * TOTAL row of their own, so the table ends once. The final column shows that
   * row's own figure — the grand total, freight and all — rather than the sum
   * of the amounts above it, which is why the freight line sits directly above
   * carrying its own value.
   */
  const firstSum = columns.findIndex((c) => c.sum);
  const canSum = firstSum > 0 && items.length > 0;
  const closingIndex = footer.length
    ? (footer.findIndex((r) => r.sums) >= 0 ? footer.findIndex((r) => r.sums) : footer.length - 1)
    : -1;
  const closing = closingIndex >= 0 ? footer[closingIndex] : null;

  const summedClosing = (r: MoneyRow): Cell[] => {
    const style = {
      bold: true, fontSize: r.band ? 8.5 : 8,
      color: r.band ? '#ffffff' : '#222222', fillColor: r.band ? s.theme : '#f4f2f0',
    };
    return [
      { text: r.label, colSpan: firstSum, alignment: 'right', ...style },
      ...Array.from({ length: firstSum - 1 }, () => ({} as Cell)),
      ...columns.slice(firstSum).map((c, i) => ({
        text: firstSum + i === columns.length - 1 ? r.value : (c.sum ? c.sum(items) : ''),
        alignment: c.align ?? 'left', ...style,
      } as Cell)),
    ];
  };

  const closingRows: Cell[][] = canSum
    ? (closing
      // Sums ride on the closing row; everything either side of it, including
      // anything after the total, stays a plain span.
      ? [
        ...footer.slice(0, closingIndex).map(money),
        summedClosing(closing),
        ...footer.slice(closingIndex + 1).map(money),
      ]
      // No money rows on this document, so the sums get a row of their own.
      : [summedClosing({ label: 'TOTAL', value: '' })])
    : footer.map(money);

  const body: Cell[][] = [
    ...headers,
    ...items.map((it, i) =>
      columns.map((c) => ({
        ...(c.cell ? c.cell(it, i) : { text: c.value(it, i) }),
        fontSize: 8,
        alignment: c.align ?? 'left',
        fillColor: i % 2 ? '#f7f5f4' : undefined,
      }))
    ),
    ...closingRows,
  ];

  return {
    table: { headerRows: headers.length, widths: columns.map((c) => c.width), body },
    layout: gridLayout,
  } as Content;
}

/** The lines that are actually goods — charges carry no quantity to add up. */
const goodsOnly = (rows: Row[]): Row[] => rows.filter((it) => !it.is_charge);

/**
 * Totals the Total Qty column — one figure per basis, never one across all.
 *
 * The column holds each line's billing quantity read in whatever its rate is
 * quoted against: pieces on a per-1000 or per-unit line, kilos on a per-kg
 * one. Those do not add. A document carrying 30,50,000 pieces and 5 tonnes
 * summed to `30,50,005`, a number that is true of nothing. Each basis is now
 * totalled separately and labelled, and only when there is more than one — the
 * ordinary all-pieces proforma still closes on a single plain figure.
 *
 * Lines priced per unit stay in with the pieces: 5,000 units is 5,000 pieces.
 * A charge line is not goods and never joins any bucket — one freight bill is
 * not one of anything these columns are counting.
 */
function qtyTotal(rows: Row[]): string {
  const byBasis = new Map<string, number>();
  for (const it of goodsOnly(rows)) {
    const pieces = isPieceBasis(it.unit);
    // total_pcs is already a piece count; the legacy `qty` is in billing units,
    // so 1,785 at "per 1000" is 17,85,000 pieces. Scaling it up is what lets
    // the two sit in the same bucket at all.
    const q = it.total_pcs != null
      ? Number(it.total_pcs)
      : Number(it.qty) * (pieces ? piecesPerBillingUnit(it.unit)! : 1);
    if (!Number.isFinite(q) || q === 0) continue;
    // Every piece basis shares one bucket, keyed '' so it prints bare.
    const basis = pieces ? '' : String(it.unit ?? '').trim();
    byBasis.set(basis, (byBasis.get(basis) ?? 0) + q);
  }
  if (!byBasis.size) return '';
  const mixed = byBasis.size > 1;
  return [...byBasis]
    .map(([basis, total]) =>
      `${fmtNum(total, basis ? 3 : 0)}${basis ? ` ${basis}` : mixed ? ' PCS' : ''}`)
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* QUOTATION — modeled on the Sanya Industries sample                  */
/* ------------------------------------------------------------------ */
export function buildQuotationPdf(id: number): TDocumentDefinitions {
  const q = db.prepare('SELECT * FROM quotations WHERE id = ?').get(id) as Row;
  if (!q) throw new Error('Quotation not found');
  // The company that issued it, not whichever is current — a reprint years
  // later must still carry the right entity, GSTIN and letterhead.
  const s = companyProfile(q.company_id);
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(q.customer_id) as Row;
  const items = db.prepare('SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY sort_order, id').all(id) as Row[];
  // The quotation is the only document that prints line photos.
  sanitiseItemImages(items);

  const cur = q.currency;
  const showTax = q.tax_type !== 'none';
  const hasQty = items.some((it) => it.qty != null);
  const cfg: ColumnConfig = JSON.parse(String(q.column_config || '{}'));
  /**
   * A quotation may be sent as a rate-and-packing price list.
   *
   * Hiding the Amount column takes the money band with it — the grand total,
   * the subtotal, the tax rows and the indicative freight and insurance all
   * come out of `totalsRows`, and printing a total under a table with no line
   * amounts in it would be the one figure nobody could check. The items table
   * needs no help: `itemsTable` tests `hidden` before `always`.
   *
   * This is presentation only. `computeTotals` still runs on save and the
   * document still carries its subtotal, tax and grand total; the list, the
   * dashboard and the Excel export all still show them, and ticking the column
   * back on prints the same figure it always would have.
   */
  const showMoney = hasQty && !(cfg.hidden ?? []).includes('amount');

  const meta: Content = {
    columns: [
      {
        table: {
          widths: [92, '*'],
          body: [
            // No quotation number on the page, by request. It still names the
            // downloaded file and still identifies the record in the app.
            [{ text: 'Quotation Date:', bold: true, color: s.theme, fontSize: 8.5, border: [false, false, false, false] }, { text: fmtDate(q.date), fontSize: 8.5, border: [false, false, false, false] }],
            [{ text: 'Customer / Buyer:', bold: true, color: s.theme, fontSize: 8.5, border: [false, false, false, false] }, { text: c.name, fontSize: 8.5, bold: true, border: [false, false, false, false] }],
            [{ text: 'Address:', bold: true, color: s.theme, fontSize: 8.5, border: [false, false, false, false] }, { text: [c.address, c.city].filter(Boolean).join(', ') || '—', fontSize: 8.5, border: [false, false, false, false] }],
            [{ text: 'Country:', bold: true, color: s.theme, fontSize: 8.5, border: [false, false, false, false] }, { text: c.country || '—', fontSize: 8.5, border: [false, false, false, false] }],
          ],
        },
        layout: 'noBorders',
        width: '*',
      },
      {
        table: {
          widths: [80, '*'],
          body: [
            [{ text: 'Price Validity:', bold: true, color: s.theme, fontSize: 8.5, border: [false, false, false, false] }, { text: q.validity_date ? fmtDate(q.validity_date) : '—', fontSize: 8.5, bold: true, border: [false, false, false, false] }],
            [{ text: 'Currency:', bold: true, color: s.theme, fontSize: 8.5, border: [false, false, false, false] }, { text: cur, fontSize: 8.5, border: [false, false, false, false] }],
            ...(q.payment_terms ? [[{ text: 'Payment Terms:', bold: true, color: s.theme, fontSize: 8.5, border: [false, false, false, false] }, { text: q.payment_terms, fontSize: 8.5, border: [false, false, false, false] }]] : []),
            ...(q.delivery_terms ? [[{ text: 'Delivery:', bold: true, color: s.theme, fontSize: 8.5, border: [false, false, false, false] }, { text: q.delivery_terms, fontSize: 8.5, border: [false, false, false, false] }]] : []),
          ] as any,
        },
        layout: 'noBorders',
        width: 230,
      },
    ],
    margin: [0, 0, 0, 8] as any,
  };

  // Column order, as the user specified it: what the item *is* (description,
  // photo), then how it packs (pcs/box, boxes, total qty), then what it costs
  // (unit price, total). UOM sits with Unit Price because it is what makes
  // "10" mean "INR/1000", and Tax % lands just before the money it applies to.
  const specs: ColumnSpec[] = [
    { key: 'sl', label: 'SL', width: 18, align: 'center', always: true, value: (_it, i) => String(i + 1) },
    { key: 'description', label: 'Product Description', width: '*', always: true, value: (it) => String(it.description) },
    // Photos are a selling aid, so they appear on the quotation and nowhere
    // else. The column drops out entirely when no line carries one.
    {
      key: 'image', label: 'Photo', width: 46, align: 'center',
      value: (it) => String(it.image || ''),
      cell: (it) => (it.image ? { image: String(it.image), fit: [40, 40] as [number, number] } : { text: '' }),
    },
    // No HSN: a quotation is not a tax document. The value is still stored and
    // still carries forward to the proforma and invoice, which do print it.
    { key: 'pcs_per_pack', label: 'Pcs/Box', width: 42, align: 'right', value: (it) => (it.pcs_per_pack != null ? fmtNum(it.pcs_per_pack, 0) : '') },
    { key: 'packs', label: 'Boxes', width: 40, align: 'right', value: (it) => (it.packs != null ? fmtNum(it.packs, 0) : '') },
    // Loadability, the way the real Aglo quotations state it. Export only: a
    // domestic GST buyer is not shipping in containers. Both still auto-hide
    // when no line has the figures.
    ...(q.is_export
      ? [
        { key: 'qty_20ft', label: 'Boxes/20ft', width: 44, align: 'right' as const, value: (it: Row) => (it.qty_20ft != null ? fmtNum(it.qty_20ft, 0) : '') },
        { key: 'qty_40ft', label: 'Boxes/40ft HC', width: 50, align: 'right' as const, value: (it: Row) => (it.qty_40ft != null ? fmtNum(it.qty_40ft, 0) : '') },
      ]
      : []),
    { key: 'total_pcs', label: 'Total Qty', width: 55, align: 'right', value: (it) => (it.total_pcs != null ? fmtNum(it.total_pcs, 0) : '') },
    // No Qty column: Total Qty already says how much is being quoted, and the
    // billing quantity restates it in whatever the rate basis is ("12 per
    // 1000"). It is still entered in the editor — qty x unit_price is the
    // amount — it just does not print.
    { key: 'color', label: 'Color', width: 48, align: 'center', value: (it) => String(it.color || '') },
    { key: 'unit_price', label: 'Unit Price', width: 48, align: 'right', always: true, value: (it) => fmtNum(it.unit_price, 3) },
    // A charge is priced outright, so it has no basis to state.
    { key: 'uom', label: 'UOM', width: 52, align: 'center', always: true, value: (it) => (it.is_charge ? '' : uomLabel(cur, it.unit)) },
    ...(showTax ? [{ key: 'tax', label: 'Tax %', width: 30, align: 'right' as const, value: (it: Row) => `${it.tax_pct ?? 0}%` }] : []),
    { key: 'amount', label: `Total (${cur})`, width: 62, align: 'right', always: true, value: (it) => (it.qty != null ? fmtMoney(it.amount, cur) : 'price only') },
  ];

  const grandLabel = q.inco_terms
    ? `TOTAL PRICE IN ${q.inco_terms}${q.container_count ? ` (${q.container_count})` : ''}`
    : 'GRAND TOTAL';

  const content: Content[] = [
    ...companyHeader(s, { isExport: !!q.is_export }),
    docTitle(s, 'QUOTATION'),
    meta,
    itemsTable(s, items, specs, cfg),
    // Nothing at all when the amounts are deliberately off — the page ends with
    // the items table and runs straight on to the notes. The note below stays
    // for the different case it was written for: a quotation carrying no
    // quantities at all, where saying so is the point.
    ...(showMoney
      ? [totalsBand(s, q, cur, grandLabel), amountWords(q, cur)]
      : hasQty
        ? []
        : [{ text: 'Note: Quantities to be confirmed by the customer. Prices are as stated above.', fontSize: 8, italics: true, margin: [0, 6, 0, 0] as any }]),
    ...notesAndTerms(s, q.notes),
    // No signature block: a quotation is an offer, not a document anyone
    // countersigns. The order confirmation and proforma still carry one. The
    // preparer's name is not a signature, so it stays on its own.
    ...(q.prepared_by
      ? [{ text: `Prepared By: ${q.prepared_by}`, fontSize: 7.5, color: '#666666', margin: [0, 18, 0, 0] as any }]
      : []),
  ];
  return baseDoc(content);
}

/* ------------------------------------------------------------------ */
/* ORDER CONFIRMATION                                                  */
/* ------------------------------------------------------------------ */
export function buildOrderPdf(id: number): TDocumentDefinitions {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Row;
  if (!o) throw new Error('Order not found');
  const s = companyProfile(o.company_id);
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(o.customer_id) as Row;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY sort_order, id').all(id) as Row[];
  const quotation = o.quotation_id
    ? (db.prepare('SELECT number FROM quotations WHERE id = ?').get(o.quotation_id) as Row | undefined)
    : undefined;
  // The proforma this order was booked from, resolved backwards: the link
  // lives on proforma_invoices.order_id, since an order has no pi_id of its
  // own. Earliest match, because two proformas can each claim one order.
  const proforma = db
    .prepare('SELECT number FROM proforma_invoices WHERE order_id = ? ORDER BY id LIMIT 1')
    .get(id) as Row | undefined;

  const cur = o.currency;
  const showTax = o.tax_type !== 'none';
  const cfg = forceColumns(JSON.parse(String(o.column_config || '{}')) as ColumnConfig, ORDER_FORCED);

  const specs: ColumnSpec[] = [
    { key: 'sl', label: 'SL', width: 18, align: 'center', always: true, value: (_it, i) => String(i + 1) },
    { key: 'description', label: 'Description of Goods', width: '*', always: true, value: (it) => it.description },
    { key: 'code', label: 'Code', width: 45, align: 'center', value: (it) => it.code || '' },
    { key: 'hsn', label: 'HSN', width: 45, align: 'center', value: (it) => it.hsn_code || '' },
    { key: 'color', label: 'Colour', width: 50, align: 'center', value: (it) => it.color || '' },
    // A charge line is a fee, not something to make: no quantity, no rate.
    { key: 'qty', label: 'Quantity', width: 58, align: 'right', value: (it) => (!it.is_charge && it.qty != null ? `${fmtNum(it.qty)} ${it.unit}` : '') },
    { key: 'unit_price', label: `Rate ${cur}`, width: 52, align: 'right', value: (it) => (it.is_charge ? '' : fmtNum(it.unit_price, 3)) },
    { key: 'supplier', label: 'Supplier', width: 48, align: 'center', value: (it) => it.supplier || '' },
    { key: 'tax', label: 'Tax %', width: 30, align: 'right', value: (it) => (showTax ? `${it.tax_pct ?? 0}%` : '') },
    { key: 'amount', label: `Amount (${cur})`, width: 62, align: 'right', always: true, value: (it) => fmtMoney(it.amount, cur) },
  ];

  const detail = (rows: [string, string][]): Cell => ({
    table: {
      widths: [110, '*'],
      body: rows.map(([l, v]) => [
        { text: l, fontSize: 7.5, bold: true, color: '#333333' },
        { text: v || '—', fontSize: 7.5 },
      ]),
    },
    layout: { ...gridLayout, hLineColor: '#dddddd', vLineColor: '#dddddd' },
  });

  const sectionHead = (t: string): Cell => ({ text: t, bold: true, fontSize: 8, color: '#ffffff', fillColor: s.theme });

  const orderInfo: [string, string][] = [
    ['Order Number', o.number],
    ['Order Date', fmtDate(o.date)],
    ...(quotation ? [['Ref. Quotation', quotation.number] as [string, string]] : []),
    ...(proforma ? [['Ref. Proforma', proforma.number] as [string, string]] : []),
    ...(o.po_number ? [['Your PO No. & Date', `${o.po_number}${o.po_date ? ` dt. ${fmtDate(o.po_date)}` : ''}`] as [string, string]] : []),
    ...(o.order_through ? [['Order Received Via', o.order_through] as [string, string]] : []),
    ...(o.spoc ? [['Handled By', o.spoc] as [string, string]] : []),
    ['Currency', currencyNames[cur] ?? cur],
    ...(o.payment_terms ? [['Payment Terms', o.payment_terms] as [string, string]] : []),
  ];

  const deliveryInfo: [string, string][] = [
    ...(o.promised_date ? [['Promised Despatch', fmtDate(o.promised_date)] as [string, string]] : []),
    ...(o.scheduled_date ? [['Production Scheduled', fmtDate(o.scheduled_date)] as [string, string]] : []),
    ...(o.destination ? [['Destination', o.destination] as [string, string]] : []),
    ...(o.transport ? [['Transport', o.transport] as [string, string]] : []),
    ...(o.freight_terms ? [['Freight Terms', o.freight_terms] as [string, string]] : []),
    ...(o.inco_terms ? [['INCO Terms', o.inco_terms] as [string, string]] : []),
    ...(o.container_count ? [['Containers', o.container_count] as [string, string]] : []),
    ...(Number(o.advance_due) ? [['Advance Due', fmtMoney(o.advance_due, cur)] as [string, string]] : []),
    ...(Number(o.advance_amount)
      ? [['Advance Received', `${fmtMoney(o.advance_amount, cur)}${o.advance_received_date ? ` on ${fmtDate(o.advance_received_date)}` : ''}`] as [string, string]]
      : []),
  ];

  const content: Content[] = [
    ...companyHeader(s, { isExport: !!o.is_export }),
    docTitle(s, 'ORDER CONFIRMATION'),
    {
      table: {
        widths: ['*', '*'],
        body: [
          [sectionHead('CUSTOMER'), sectionHead('ORDER DETAILS')],
          [{ stack: [{ text: customerAddress(c), fontSize: 8 }] }, detail(orderInfo)],
          ...(deliveryInfo.length
            ? [[sectionHead('DELIVERY & PRODUCTION'), sectionHead('')], [{ ...detail(deliveryInfo), colSpan: 2 }, {}]]
            : []),
        ] as any,
      },
      layout: boxedLayout,
      margin: [0, 0, 0, 8] as any,
    },
    itemsTable(s, items, specs, cfg),
    totalsBand(s, o, cur, 'ORDER VALUE'),
    amountWords(o, cur),
    ...(o.remarks ? [{ text: 'REMARKS:', fontSize: 9, bold: true, color: s.theme, margin: [0, 8, 0, 2] as any }, { text: o.remarks, fontSize: 8 }] : []),
    ...notesAndTerms(s, o.notes),
    signatureBlock(s, { preparedBy: o.spoc }),
  ];
  return baseDoc(content);
}

/* ------------------------------------------------------------------ */
/* PROFORMA INVOICE — modeled on the Emeraude sample                   */
/* ------------------------------------------------------------------ */
export function buildProformaPdf(id: number): TDocumentDefinitions {
  const pi = db.prepare('SELECT * FROM proforma_invoices WHERE id = ?').get(id) as Row;
  if (!pi) throw new Error('Proforma invoice not found');
  const s = companyProfile(pi.company_id);
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(pi.customer_id) as Row;
  const items = db.prepare('SELECT * FROM pi_items WHERE pi_id = ? ORDER BY sort_order, id').all(id) as Row[];
  const quotation = pi.quotation_id
    ? (db.prepare('SELECT number FROM quotations WHERE id = ?').get(pi.quotation_id) as Row | undefined)
    : undefined;

  const cur = pi.currency;
  const showTax = pi.tax_type !== 'none';
  const cfg = forceColumns(JSON.parse(String(pi.column_config || '{}')) as ColumnConfig, PROFORMA_FORCED);

  const sectionHead = (t: string): Cell => ({ text: t, bold: true, fontSize: 8, color: '#ffffff', fillColor: s.theme });

  const shipmentInfo: [string, string][] = [
    ['PI Number', pi.number],
    ['PI Date', fmtDate(pi.date)],
    ...(quotation ? [['Ref. Quotation', quotation.number] as [string, string]] : []),
    ...(pi.po_number ? [['Buyer PO No. & Date', `${pi.po_number}${pi.po_date ? ` dt. ${fmtDate(pi.po_date)}` : ''}`] as [string, string]] : []),
    ...(pi.payment_terms ? [['Payment Terms', pi.payment_terms] as [string, string]] : []),
    ...(pi.inco_terms ? [['Inco Term', pi.inco_terms] as [string, string]] : []),
    ...(pi.quantity_tolerance ? [['Quantity Tolerance', pi.quantity_tolerance] as [string, string]] : []),
    ...(pi.validity_date ? [['Valid Until', fmtDate(pi.validity_date)] as [string, string]] : []),
  ];

  const customsInfo: [string, string][] = [
    ...(pi.port_of_discharge ? [['Port of Discharge', pi.port_of_discharge] as [string, string]] : []),
    ...(pi.country_of_origin ? [['Country of Origin', pi.country_of_origin] as [string, string]] : []),
    ...(pi.final_destination ? [['Final Destination', pi.final_destination] as [string, string]] : []),
    ['Currency', currencyNames[cur] ?? cur],
    ...(pi.lead_time ? [['Production Lead Time', pi.lead_time] as [string, string]] : []),
    ...(pi.hs_code ? [['HS Code', pi.hs_code] as [string, string]] : []),
    ...(Number(pi.is_export) ? [['Partial Shipment', pi.partial_shipment || '—'] as [string, string]] : []),
    ...(pi.container_count ? [['Total No. of Containers', pi.container_count] as [string, string]] : []),
    ...(pi.port_of_loading ? [['Port of Loading', pi.port_of_loading] as [string, string]] : []),
    ...(pi.method_of_despatch ? [['Method of Despatch', pi.method_of_despatch] as [string, string]] : []),
    ...(pi.delivery_terms ? [['Delivery Terms', pi.delivery_terms] as [string, string]] : []),
  ];

  const kvTable = (rows: [string, string][]): Content => ({
    table: {
      widths: [92, '*'],
      body: rows.map(([l, v]) => [
        { text: l, fontSize: 7, bold: true, color: '#333333' },
        { text: v, fontSize: 7 },
      ]),
    },
    layout: {
      // The shipment and customs tables are the tall cells of the header grid
      // — sixteen rows between them on an export proforma — so their row
      // padding, not the buyer block, is what decides where the goods start.
      ...gridLayout, hLineColor: '#dddddd', vLineColor: '#dddddd',
      paddingTop: () => 0.9, paddingBottom: () => 0.9,
    },
  });

  /** A party under an inline heading — one line saved per party over stacking it. */
  const party = (label: string, value: string): Content => ({
    text: [{ text: `${label}: `, fontSize: 6.5, bold: true, color: '#333333' }, { text: value, fontSize: 7.5 }],
    margin: [0, 2, 0, 0] as any,
  });

  const buyerStack: Content[] = [
    { text: customerAddress(c), fontSize: 7.5, lineHeight: 1.05 } as Content,
    ...(pi.consignee ? [party('CONSIGNEE', pi.consignee)] : []),
    ...(pi.notify_party ? [party('NOTIFY PARTY 1', pi.notify_party)] : []),
    ...(pi.notify_party_2 ? [party('NOTIFY PARTY 2', pi.notify_party_2)] : []),
  ];

  // An empty block still costs a banner and a row, and "BANK DETAILS: —" tells
  // the reader nothing. Drop it and let customs run the full width instead.
  const hasBank = !!pi.bank_account;
  // Bank details are typed free-hand, so they arrive with blank lines and a
  // repeated company name. Both cost height in a block that has none to spare.
  const bankLines = `${s.company_name}\n${pi.bank_account}`
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l, i, a) => l.toLowerCase() !== a[i - 1]?.toLowerCase());
  const bankStack: Content[] = [
    { text: 'Beneficiary Bank details:', fontSize: 7, bold: true },
    { text: bankLines.join('\n'), fontSize: 7, lineHeight: 1.05, margin: [0, 1.5, 0, 0] as any },
  ];
  /**
   * Four blocks laid out whichever way is shorter.
   *
   * A row of a 2x2 grid is as tall as its taller cell, so the arrangement only
   * pays when the pairs are evenly matched. They often are not: the buyer block
   * runs to a dozen lines against three shipment rows, leaving dead space
   * beside it. Spanning the buyer cell down the side reclaims that — but it
   * loses when the right-hand blocks stacked end to end outgrow the buyer, and
   * then it pushes the goods *further* down.
   *
   * So estimate both and take the shorter. Line heights are approximate; only
   * the comparison matters, and the two forms differ by tens of points.
   */
  const LINE = 9.6;   // one line of 7.5pt body text
  const ROW = 10.5;   // one kvTable row at 7pt plus its padding
  const BANNER = 13;  // a filled section head

  // Count the lines each block will actually occupy. A consignee or notify
  // party is routinely two or three lines of address, and bank details run to
  // six; assuming one and three respectively made the estimate pick the taller
  // arrangement on exactly the documents that most needed the shorter one.
  const countLines = (t: string) => String(t ?? '').split('\n').filter(Boolean).length;
  const buyerH = (countLines(customerAddress(c))
    + countLines(pi.consignee) + countLines(pi.notify_party) + countLines(pi.notify_party_2)) * LINE;
  const shipH = shipmentInfo.length * ROW;
  const customsH = customsInfo.length * ROW;
  const bankH = hasBank ? (1 + bankLines.length) * LINE : 0;

  const gridH = BANNER + Math.max(buyerH, shipH) + BANNER + Math.max(customsH, bankH);
  const stackedRight = shipH + BANNER + customsH + (hasBank ? BANNER + bankH : 0);
  const spanH = BANNER + Math.max(buyerH, stackedRight);

  const rightRows: Cell[] = [
    kvTable(shipmentInfo) as Cell,
    sectionHead('ADDITIONAL INFORMATION FOR CUSTOMS'),
    kvTable(customsInfo) as Cell,
    ...(hasBank ? [sectionHead('BANK DETAILS'), { stack: bankStack } as Cell] : []),
  ];

  const body: Cell[][] = spanH < gridH
    ? [
      [sectionHead('NAME & ADDRESS OF BUYER'), sectionHead('SHIPMENT INFORMATION')],
      [{ stack: buyerStack, rowSpan: rightRows.length }, rightRows[0]],
      ...rightRows.slice(1).map((cell) => [{} as Cell, cell]),
    ]
    : [
      [sectionHead('NAME & ADDRESS OF BUYER'), sectionHead('SHIPMENT INFORMATION')],
      [{ stack: buyerStack }, kvTable(shipmentInfo) as Cell],
      [sectionHead('ADDITIONAL INFORMATION FOR CUSTOMS'),
        hasBank ? sectionHead('BANK DETAILS') : { text: '', fillColor: s.theme }],
      [kvTable(customsInfo) as Cell, hasBank ? { stack: bankStack } : { text: '' }],
    ];

  const infoGrid: Content = {
    table: { widths: ['*', '*'], body },
    // Tighter than the shared boxed layout: these four blocks sit above every
    // line item, so padding here is paid before the reader sees any goods.
    layout: { ...boxedLayout, paddingTop: () => 1.2, paddingBottom: () => 1.2 },
    margin: [0, 0, 0, 6] as any,
  };

  /**
   * The rate per 1000 pieces, the way the Emeraude proforma states it.
   *
   * Per single piece reads straight across as Total Qty x rate = amount, which
   * is tidier in principle, but Aglo's prices are small enough that rounding
   * eats it: ₹107.50 over 10,750 pieces prints as 0.01. The same rate per 1000
   * is 10. Derived from the line's own money rather than the unit price, so a
   * per-piece rate converts up instead of being restated. A line billed on some
   * other basis (kg) has no piece rate at all, so it shows its own unit price.
   */
  /**
   * A rate per 1000 pieces can only be *read off* a line that has at least a
   * thousand of them. Below that the division extrapolates: a one-off charge
   * entered as a line — "Indicative Freight (1 x 40FT HQ)", quantity 1 —
   * divides its whole value by one piece and prints 45,00,000 against a
   * $4,500 line. Such a line shows its own price instead. A line marked as a
   * charge says so outright; the threshold still catches the ones raised
   * before the flag existed.
   */
  const quotableInThousands = (it: Row) =>
    !it.is_charge && isPieceBasis(it.unit) && Number(it.total_pcs) >= 1000;

  const per1000Rate = (it: Row): string =>
    (quotableInThousands(it)
      ? fmtNum(round2((it.amount / it.total_pcs) * 1000), 2)
      // A charge has no rate — the amount beside it is the whole story, and
      // "4,500 /unit" only invites the reader to look for the missing quantity.
      : it.is_charge ? ''
      : `${fmtNum(it.unit_price, 3)}${it.unit ? ` /${it.unit}` : ''}`);
  // Only call the column "/1000 Pcs" when something on the document actually is
  // a piece rate — on a wholly weight-billed proforma that heading would lie.
  const rateLabel = items.some(quotableInThousands) ? `${cur}/1000 Pcs` : `Price ${cur}`;

  const specs: ColumnSpec[] = [
    { key: 'sl', label: 'SL No.', width: 20, align: 'center', always: true, value: (_it, i) => String(i + 1) },
    // No per-line HSN: Aglo's proformas carry the HS code once, in the customs
    // block above (`hs_code`). The value is still stored and still reaches the
    // commercial invoice, which prints it.
    { key: 'description', label: 'DESCRIPTION OF GOODS', width: '*', always: true, value: (it) => String(it.description) },
    // The photo says what the item *is*, so it belongs beside the description
    // rather than under QUANTITY, which is about how many there are.
    {
      key: 'image', label: 'IMAGE', width: 46, align: 'center',
      value: (it) => String(it.image || ''),
      cell: (it) => (it.image ? { image: String(it.image), fit: [40, 40] as [number, number] } : { text: '' }),
    },
    { key: 'color', label: 'COLOR', width: 38, align: 'center', value: (it) => String(it.color || '') },
    // How it packs, banded under one QUANTITY heading as the real document does.
    {
      key: 'packs', label: 'CTN.', width: 30, align: 'right', group: 'QUANTITY',
      value: (it) => (it.packs != null ? fmtNum(it.packs, 0) : ''),
      sum: (rows) => fmtNum(goodsOnly(rows).reduce((t, it) => t + (Number(it.packs) || 0), 0), 0),
    },
    // Pcs per carton is deliberately not summed: adding box sizes across
    // different products gives a number with no meaning.
    { key: 'pcs_per_pack', label: 'PCS. / CTN.', width: 40, align: 'right', group: 'QUANTITY', value: (it) => (it.pcs_per_pack != null ? fmtNum(it.pcs_per_pack, 0) : '') },
    // One quantity column, not two. Total Qty is what the form now captures —
    // pieces against a per-1000 rate, kilos against a per-kg one — but a
    // proforma raised before the Qty field went away has only `qty`, so fall
    // back to it (with its unit) rather than printing a blank quantity.
    {
      key: 'total_pcs', label: 'TOTAL QTY', width: 52, align: 'right', always: true,
      // Pieces are whole; a weight is not, so half a kilo must not round away
      // here while the closing total keeps it. A charge has no quantity to
      // state — its billed 1 is an artefact of the arithmetic, not a count.
      value: (it) => (it.is_charge ? ''
        : it.total_pcs != null ? fmtNum(it.total_pcs, isPieceBasis(it.unit) ? 0 : 3)
        : it.qty != null ? `${fmtNum(it.qty)} ${it.unit}` : '—'),
      // One figure per rate basis — see qtyTotal. Falls back to qty for the
      // same reason the cell does, so a proforma raised before Total Qty
      // existed still totals to something.
      sum: qtyTotal,
    },
    { key: 'unit_price', label: rateLabel, width: 50, align: 'right', always: true, value: per1000Rate },
    ...(showTax ? [{ key: 'tax', label: 'Tax %', width: 28, align: 'right' as const, value: (it: Row) => `${it.tax_pct ?? 0}%` }] : []),
    {
      key: 'amount', label: `TOTAL AMOUNT (${pi.inco_terms || cur})`, width: 58, align: 'right', always: true,
      value: (it) => fmtMoney(it.amount, cur),
      sum: (rows) => fmtMoney(round2(rows.reduce((t, it) => t + (Number(it.amount) || 0), 0)), cur),
    },
  ];

  const grandLabel = pi.inco_terms && pi.port_of_discharge
    ? `TOTAL PRICE ${cur} ${pi.inco_terms} ${pi.port_of_discharge.split(',')[0].toUpperCase()}`
    : 'GRAND TOTAL';

  /*
   * Freight, tax and the grand total ride inside the items table. The table's
   * own TOTAL row already states the subtotal, so drop the duplicate first line.
   *
   * Then what the customer has already paid, which is the point of sending a
   * proforma: the buyer pays the advance against *this* document, so a
   * proforma that states a grand total and says nothing about the money
   * already banked asks for the whole sum a second time. Only shown once there
   * is an advance — an untouched proforma prints exactly what it always did.
   *
   * `sums: true` stays on the grand total rather than defaulting to the last
   * row, for the reason the invoice states: what is still owed is not a
   * property of the boxes being shipped.
   */
  const advance = proformaAdvance(id);
  const money: MoneyRow[] = totalsRows(pi, cur, grandLabel)
    .slice(1)
    .map((r) => (r.label === grandLabel ? { ...r, sums: true } : r));
  if (advance.amount_received > 0) {
    money.push({ label: 'Advance Received', value: fmtMoney(advance.amount_received, cur) });
    money.push({ label: 'Balance Payable', value: fmtMoney(advance.balance_payable, cur), band: true });
  }

  const content: Content[] = [
    ...companyHeader(s, { isExport: !!pi.is_export }),
    docTitle(s, 'PROFORMA INVOICE'),
    infoGrid,
    itemsTable(s, items, specs, cfg, money),
    amountWords(pi, cur),
    // One block of prose, not two: the document's remarks lead the bullet list
    // and the company's default terms follow, all under TERMS & CONDITIONS.
    ...notesAndTerms(s, pi.remarks, 'TERMS & CONDITIONS:'),
    signatureBlock(s, { buyerSide: true, preparedBy: pi.prepared_by }),
  ];
  return baseDoc(content);
}

/* ------------------------------------------------------------------ */
/* Boxed export header shared by Commercial Invoice and Packing List   */
/* (modeled on the AP/EX-101 samples)                                  */
/* ------------------------------------------------------------------ */
function exportDocGrid(s: Row, opts: {
  refCells: Cell[];       // right-top: invoice no/date, order refs
  consignee: string;
  notify1: string;
  notify2: string;
  origin: string;
  finalDestination: string;
  currency: string;
  despatch: string;
  paymentTerms?: string;
  shipmentType?: string;
  portLoading: string;
  portDischarge: string;
  bankBlock?: string;     // invoice only
  weightBlock?: string;   // packing list only
  buyer: Row;
  /** Same rule as the letterhead: this block states the numbers a second time. */
  reg: HeaderOpts;
}): Content {
  const companyBlock = [
    s.company_name,
    s.address,
    [s.city, s.state, s.pincode].filter(Boolean).join(', '),
    s.country && `${s.country}`.toUpperCase(),
    // Not `s.gstin` and `s.iec` unconditionally: this exporter block repeats
    // what the letterhead says, so it has to follow the same rule, or an export
    // invoice would carry a GSTIN down here having dropped it at the top.
    registrationLine(s, opts.reg),
  ].filter(Boolean).join('\n');

  const rightBottom = opts.bankBlock
    ? lv('Bank Details', `BENEFICIARY NAME: ${s.company_name}\n${opts.bankBlock}`)
    : lv('Weights', opts.weightBlock || '—');

  return {
    table: {
      widths: ['*', '*', '*', '*'],
      body: [
        [
          { ...lv('Exporter / Beneficiary (Shipper)', companyBlock), colSpan: 2, rowSpan: 2 }, {},
          { ...lv('', ''), colSpan: 2, stack: opts.refCells }, {},
        ],
        [
          {}, {},
          lv('Country of Origin of Goods', opts.origin || '—'),
          lv('Country of Final Destination', opts.finalDestination || '—'),
        ],
        [
          { ...lv('Consignee', opts.consignee || customerAddress(opts.buyer, false)), colSpan: 2, rowSpan: 2 }, {},
          { ...lv('Notify 1', opts.notify1 || '—'), rowSpan: 2 },
          { ...lv('Notify 2', opts.notify2 || '—'), rowSpan: 2 },
        ],
        [{}, {}, {}, {}],
        [
          lv('Type of Shipment', opts.shipmentType || opts.despatch || '—'),
          lv('Method of Despatch', opts.despatch || '—'),
          lv('Currency', opts.currency),
          lv('Terms of Payment', opts.paymentTerms || '—'),
        ],
        [
          lv('Port of Loading', opts.portLoading || '—'),
          lv('Port of Discharge', opts.portDischarge || '—'),
          { ...rightBottom, colSpan: 2 }, {},
        ],
      ],
    },
    layout: boxedLayout,
    margin: [0, 0, 0, 8] as any,
  };
}

/* ------------------------------------------------------------------ */
/* COMMERCIAL INVOICE                                                  */
/* ------------------------------------------------------------------ */
export function buildInvoicePdf(id: number): TDocumentDefinitions {
  const inv = db.prepare('SELECT * FROM commercial_invoices WHERE id = ?').get(id) as Row;
  if (!inv) throw new Error('Invoice not found');
  const s = companyProfile(inv.company_id);
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(inv.customer_id) as Row;
  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id').all(id) as Row[];
  const pi = inv.pi_id ? (db.prepare('SELECT number, date, po_number, po_date FROM proforma_invoices WHERE id = ?').get(inv.pi_id) as Row | undefined) : undefined;

  const cur = inv.currency;
  const showTax = inv.tax_type !== 'none';
  const cfg = forceColumns(JSON.parse(String(inv.column_config || '{}')) as ColumnConfig, INVOICE_FORCED);

  // Own payments plus this invoice's share of any advance on the source PI.
  const received = invoiceReceivable(id).amount_received;

  const refCells: Cell[] = [
    lv('Invoice No.  /  Date', `${inv.number}   ${fmtDate(inv.date)}`),
    { text: ' ', fontSize: 3 },
    lv("Buyer's Order No. and Date",
      pi ? `P.I. NO: ${pi.number} DATED ${fmtDate(pi.date)}${pi.po_number ? `\nBUYER PO: ${pi.po_number}${pi.po_date ? ` DATED ${fmtDate(pi.po_date)}` : ''}` : ''}` : '—'),
    { text: ' ', fontSize: 3 },
    lv('Other Reference(s)', [inv.lot_no && `Lot No. ${inv.lot_no}`, inv.shipping_details].filter(Boolean).join('\n') || '—'),
  ];

  const grid = exportDocGrid(s, {
    // The one document that carries the IEC, and only when it is an export.
    reg: { isExport: !!inv.is_export, isCommercialInvoice: true },
    refCells,
    consignee: inv.consignee,
    notify1: inv.notify_party,
    notify2: inv.notify_party_2,
    origin: inv.country_of_origin || (Number(inv.is_export) ? 'INDIA' : s.country?.toUpperCase() || ''),
    finalDestination: inv.final_destination || (Number(inv.is_export) ? '—' : (c.country || '').toUpperCase()),
    currency: cur,
    despatch: inv.method_of_despatch,
    paymentTerms: inv.payment_terms,
    portLoading: inv.port_of_loading,
    portDischarge: inv.port_of_discharge,
    bankBlock: inv.bank_account || undefined,
    buyer: c,
  });

  const specs: ColumnSpec[] = [
    { key: 'sl', label: 'SL', width: 16, align: 'center', always: true, value: (_it, i) => String(i + 1) },
    { key: 'description', label: 'Description of Goods', width: '*', always: true, value: (it) => String(it.description) },
    // A charge line (freight, insurance) states its amount and nothing else —
    // its billed quantity of 1 is arithmetic, not a count of anything shipped.
    { key: 'qty', label: 'Quantity', width: 58, align: 'right', always: true, value: (it) => (it.is_charge ? '' : it.qty != null ? `${fmtNum(it.qty)} ${it.unit}` : '—') },
    { key: 'unit_price', label: 'Rate', width: 55, align: 'right', always: true, value: (it) => (it.is_charge ? '' : `${fmtNum(it.unit_price, 3)}/${it.unit === 'per 1000' ? '1000' : it.unit}`) },
    { key: 'color', label: 'Color', width: 46, align: 'center', value: (it) => String(it.color || '') },
    { key: 'packs', label: 'Boxes', width: 40, align: 'right', value: (it) => (it.packs != null ? fmtNum(it.packs, 0) : '') },
    { key: 'hsn', label: 'HSN Code', width: 45, align: 'center', value: (it) => String(it.hsn_code || '') },
    ...(showTax ? [{ key: 'tax', label: 'Tax %', width: 28, align: 'right' as const, value: (it: Row) => `${it.tax_pct ?? 0}%` }] : []),
    { key: 'amount', label: `Amount ${cur}${inv.inco_terms ? ` (${String(inv.inco_terms).split(' ')[0]})` : ''}`, width: 62, align: 'right', always: true, value: (it) => fmtMoney(it.amount, cur) },
  ];

  const grandLabel = inv.inco_terms && inv.port_of_discharge
    ? `AMOUNT IN ${inv.inco_terms} ${inv.port_of_discharge.split(',')[0].toUpperCase()}`
    : 'GRAND TOTAL';

  /**
   * The money rides inside the items table, as it does on the proforma.
   *
   * It used to sit below as two floating right-hand blocks — the totals band,
   * then a second one for the payment lines. Those bars are taller than a
   * table row (four points of padding top and bottom, plus a rule between
   * each) and the two blocks carried their own top margins, so five lines of
   * figures cost about half an inch more than the same five rows in the table.
   * On an invoice that already runs to two pages that is worth having.
   *
   * The subtotal is kept, unlike on the proforma, because a domestic invoice
   * shows CGST and SGST beneath it and the taxable value they are charged on
   * has to be legible. The sums stay on the grand total: what is still owed is
   * not a property of the boxes that went out.
   */
  const money: MoneyRow[] = totalsRows(inv, cur, grandLabel).map((r) => (
    r.label === grandLabel ? { ...r, sums: true } : r
  ));
  if (received > 0) {
    money.push({ label: 'Amount Received', value: fmtMoney(received, cur) });
    money.push({
      label: 'Balance Due',
      value: fmtMoney(Math.max(0, round2(inv.grand_total - received)), cur),
      band: true,
    });
  }

  const certFooter: Content = {
    table: {
      widths: ['*', 200],
      body: [[
        {
          stack: [
            { text: `We certify that the merchandise is of ${(inv.country_of_origin || s.country || 'Indian').replace(/ia$/i, 'ian')} Origin`, fontSize: 8, bold: true },
            ...(inv.inco_terms ? [{ text: `Incoterms® 2020: ${inv.inco_terms}${inv.port_of_discharge ? ` ${inv.port_of_discharge.split(',')[0].toUpperCase()}` : ''}`, fontSize: 8, margin: [0, 2, 0, 0] as any }] : []),
            // The consignment's own LUT/ARN, falling back to the company's while
            // an older invoice has none of its own — so nothing already raised
            // changes what it prints.
            ...(Number(inv.is_export) && (inv.arn_ref || s.arn_ref)
              ? [{ text: `Application Reference No. (ARN): ${inv.arn_ref || s.arn_ref}`, fontSize: 8, margin: [0, 2, 0, 0] as any }]
              : []),
            // Remarks used to sit here as a loose italic line. They are part of
            // the TERMS & CONDITIONS list below now, so this cell keeps only
            // the certifications it exists for.
            ...(inv.prepared_by ? [{ text: `Prepared By: ${inv.prepared_by}`, fontSize: 7.5, color: '#666666', margin: [0, 3, 0, 0] as any }] : []),
          ],
        },
        {
          stack: [
            { text: `Signatory Company: ${s.company_name}`, fontSize: 8, bold: true },
            ...(s.signature
              ? [{ image: s.signature, fit: [100, 38] as [number, number], margin: [0, 3, 0, 3] as any }]
              : [{ text: ' ', margin: [0, 22, 0, 0] as any }]),
            { text: 'Name & Signature of Authorised Signatory', fontSize: 7.5 },
          ],
        },
      ]],
    },
    layout: boxedLayout,
    margin: [0, 10, 0, 0] as any,
  };

  const content: Content[] = [
    ...companyHeader(s, { isExport: !!inv.is_export, isCommercialInvoice: true }),
    docTitle(s, 'COMMERCIAL INVOICE'),
    grid,
    itemsTable(s, items, specs, cfg, money),
    amountWords(inv, cur),
    // One block of prose, as on the proforma: the invoice's own remarks lead
    // the list and the company's default terms follow. The AP/EX-101 sample
    // has no such block — its footer is only the origin certificate, Incoterms
    // and ARN — so this is a deliberate departure from it.
    ...notesAndTerms(s, inv.remarks, 'TERMS & CONDITIONS:'),
    certFooter,
  ];
  return baseDoc(content);
}

/* ------------------------------------------------------------------ */
/* PACKING LIST                                                        */
/* ------------------------------------------------------------------ */
export function buildPackingListPdf(id: number): TDocumentDefinitions {
  const pl = db.prepare('SELECT * FROM packing_lists WHERE id = ?').get(id) as Row;
  if (!pl) throw new Error('Packing list not found');
  const s = companyProfile(pl.company_id);
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(pl.customer_id) as Row;
  // Charge lines are stored so the list keeps its index alignment with the
  // invoice, but nothing is packed against freight — they are not printed.
  const items = goodsOnly(
    db.prepare('SELECT * FROM packing_list_items WHERE packing_list_id = ? ORDER BY sort_order, id').all(id) as Row[]
  );
  const inv = pl.invoice_id
    ? (db.prepare('SELECT * FROM commercial_invoices WHERE id = ?').get(pl.invoice_id) as Row | undefined)
    : undefined;
  const pi = inv?.pi_id ? (db.prepare('SELECT number, date FROM proforma_invoices WHERE id = ?').get(inv.pi_id) as Row | undefined) : undefined;

  const totalGross = round2(items.reduce((sum, it) => sum + (it.gross_weight || 0), 0));
  const totalNet = round2(items.reduce((sum, it) => sum + (it.net_weight || 0), 0));
  // Quantities here are in each line's own billing unit, so they are totalled
  // per basis for the same reason the proforma's are — 1,785 (per 1000) and
  // 5 tonne do not make 1,790 of anything.
  const totalQty = qtyTotal(items);

  const refCells: Cell[] = [
    lv('Packing List No.  /  Date', `${pl.number}   ${fmtDate(pl.date)}`),
    { text: ' ', fontSize: 3 },
    lv('Invoice Reference', inv ? `${inv.number} DATED ${fmtDate(inv.date)}${pi ? `\nP.I. NO: ${pi.number} DATED ${fmtDate(pi.date)}` : ''}` : '—'),
    { text: ' ', fontSize: 3 },
    lv('Other Reference(s)', pl.lot_no ? `Lot No. ${pl.lot_no}` : '—'),
  ];

  const grid = exportDocGrid(s, {
    refCells,
    consignee: inv?.consignee || c.consignee || '',
    notify1: inv?.notify_party || c.notify_party || '',
    notify2: inv?.notify_party_2 || c.notify_party_2 || '',
    // The packing list is not a commercial invoice, so it never carries the IEC.
    reg: { isExport: !!inv?.is_export },
    origin: inv?.country_of_origin || '',
    finalDestination: inv?.final_destination || (c.country || '').toUpperCase(),
    currency: inv?.currency || c.currency,
    despatch: inv?.method_of_despatch || '',
    shipmentType: inv?.method_of_despatch || '',
    portLoading: inv?.port_of_loading || '',
    portDischarge: inv?.port_of_discharge || '',
    weightBlock: `TOTAL GROSS WEIGHT: ${fmtNum(totalGross)} KGS\nTOTAL NET WEIGHT: ${fmtNum(totalNet)} KGS`,
    buyer: c,
  });

  const cfg: ColumnConfig = JSON.parse(String(pl.column_config || '{}'));
  const inPieces = (it: Row) => it.qty != null && ['unit', 'pcs'].includes(String(it.unit || '').toLowerCase());
  const totalThousands = items.reduce((sum, it) => sum + (inPieces(it) ? it.qty / 1000 : 0), 0);

  const specs: ColumnSpec[] = [
    { key: 'sl', label: 'SL', width: 16, align: 'center', always: true, value: (_it, i) => String(i + 1) },
    { key: 'description', label: 'Description of Goods', width: '*', always: true, value: (it) => it.description + (it.dimensions ? `\nDim: ${it.dimensions}` : '') },
    { key: 'packages', label: 'Qty in Boxes', width: 55, align: 'center', value: (it) => String(it.packages || '') },
    { key: 'hsn', label: 'HSN Code', width: 45, align: 'center', value: (it) => String(it.hsn_code || '') },
    { key: 'qty', label: 'Quantity', width: 55, align: 'right', always: true, value: (it) => (it.qty != null ? `${fmtNum(it.qty, 0)} ${it.unit === 'unit' ? 'pcs' : it.unit}` : '—') },
    { key: 'thousand_pcs', label: 'Thousand Pcs', width: 48, align: 'right', value: (it) => (inPieces(it) ? fmtNum(it.qty / 1000, 2) : '') },
    { key: 'net_weight', label: 'Net Wt (kg)', width: 48, align: 'right', value: (it) => (it.net_weight ? fmtNum(it.net_weight) : '') },
    { key: 'gross_weight', label: 'Gross Wt (kg)', width: 48, align: 'right', value: (it) => (it.gross_weight ? fmtNum(it.gross_weight) : '') },
  ];

  const table = itemsTable(s, items, specs, cfg) as any;
  // Append a totals row matching whichever columns survived.
  const headerCells = table.table.body[0] as Cell[];
  const totalsRow = headerCells.map((h: Cell) => {
    const label = String(h.text);
    const cell = (text: string, align: string = 'right') => ({ text, fontSize: 8, bold: true, alignment: align, fillColor: '#efe9e7' });
    if (label === 'Description of Goods') return cell('TOTAL', 'left');
    if (label === 'Quantity') return cell(totalQty);
    // Only the lines that actually show a thousand-pieces figure are in it.
    if (label === 'Thousand Pcs') return cell(totalThousands ? fmtNum(totalThousands, 2) : '');
    if (label === 'Net Wt (kg)') return cell(fmtNum(totalNet));
    if (label === 'Gross Wt (kg)') return cell(fmtNum(totalGross));
    return cell('');
  });
  table.table.body.push(totalsRow);

  const certFooter: Content = {
    table: {
      widths: ['*', 200],
      body: [[
        {
          stack: [
            { text: `We certify that the merchandise is of ${(inv?.country_of_origin || s.country || 'Indian').replace(/ia$/i, 'ian')} Origin`, fontSize: 8, bold: true },
            ...(inv?.inco_terms ? [{ text: `Incoterms® 2020: ${inv.inco_terms}${inv.port_of_discharge ? ` ${String(inv.port_of_discharge).split(',')[0].toUpperCase()}` : ''}`, fontSize: 8, margin: [0, 2, 0, 0] as any }] : []),
            // Same reference as the invoice this list travels with.
            ...(Number(inv?.is_export) && (inv?.arn_ref || s.arn_ref)
              ? [{ text: `Application Reference No. (ARN): ${inv?.arn_ref || s.arn_ref}`, fontSize: 8, margin: [0, 2, 0, 0] as any }]
              : []),
            ...(pl.remarks ? [{ text: pl.remarks, fontSize: 7.5, italics: true, margin: [0, 3, 0, 0] as any }] : []),
          ],
        },
        {
          stack: [
            { text: `Signatory Company: ${s.company_name}`, fontSize: 8, bold: true },
            ...(s.signature
              ? [{ image: s.signature, fit: [100, 38] as [number, number], margin: [0, 3, 0, 3] as any }]
              : [{ text: ' ', margin: [0, 22, 0, 0] as any }]),
            { text: 'Name & Signature of Authorised Signatory', fontSize: 7.5 },
          ],
        },
      ]],
    },
    layout: boxedLayout,
    margin: [0, 10, 0, 0] as any,
  };

  const content: Content[] = [
    ...companyHeader(s, { isExport: !!inv?.is_export }),
    docTitle(s, 'PACKING LIST'),
    grid,
    table,
    ...(pl.shipping_marks ? [{ text: `MARKS & NO.: ${pl.shipping_marks}`, fontSize: 8, bold: true, margin: [0, 8, 0, 0] as any }] : []),
    certFooter,
  ];
  return baseDoc(content);
}

/**
 * Commercial invoice followed by its packing list in one file — the pair that
 * customs and the freight forwarder expect to receive together.
 */
export function buildInvoiceWithPackingPdf(invoiceId: number): TDocumentDefinitions {
  const pl = db.prepare('SELECT id FROM packing_lists WHERE invoice_id = ?').get(invoiceId) as { id: number } | undefined;
  const invoice = buildInvoicePdf(invoiceId);
  if (!pl) return invoice;
  const packing = buildPackingListPdf(pl.id);
  return {
    ...invoice,
    content: [
      ...(invoice.content as Content[]),
      { text: '', pageBreak: 'after' },
      ...(packing.content as Content[]),
    ],
  };
}

/**
 * The purchase order Aglo sends a supplier.
 *
 * Modelled on `buildProformaPdf` — the same header/title/items/terms/signature
 * spine and the same `itemsTable` — and on Aglo's own reference order in
 * `D:\Quotation Doc\`, which is the spec here exactly as the Sanya and Emeraude
 * samples are the spec for the quotation and the proforma.
 *
 * Three things differ from every other builder in this file, and each is the
 * document being a *purchase* rather than a sale:
 *
 * - **The party is a supplier**, so there is no customer, no `is_export`, and
 *   `canAccessCustomer` is the wrong question — the whole module is
 *   manager-only, which `routes/pdf.ts` enforces for this entry.
 * - **`registrationLine`'s rules do not transfer.** They were written for an
 *   export *sale*: GSTIN domestic-only, IEC on the export commercial invoice.
 *   Here we are the buyer, so the letterhead carries the GSTIN on both the
 *   domestic and the import variant and never the IEC.
 * - **TCS closes the totals**, which no selling document carries.
 */
export function buildPurchaseOrderPdf(id: number): TDocumentDefinitions {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id) as Row;
  if (!po) throw new Error('Purchase order not found');
  const s = companyProfile(po.company_id);
  const sup = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(po.supplier_id) as Row | undefined;
  const loc = po.location_id
    ? (db.prepare('SELECT * FROM locations WHERE id = ?').get(po.location_id) as Row | undefined)
    : undefined;
  const items = db.prepare(
    `SELECT i.*, m.name AS material_name, m.hsn_code AS material_hsn,
            p.name AS product_name, p.hsn_code AS product_hsn
     FROM po_items i
     LEFT JOIN materials m ON m.id = i.material_id
     LEFT JOIN products p ON p.id = i.product_id
     WHERE i.po_id = ? ORDER BY i.sort_order, i.id`
  ).all(id) as Row[];

  const cur = String(po.currency);
  const showTax = po.tax_type !== 'none';
  const hsnOf = (it: Row) => String(it.material_hsn || it.product_hsn || '');

  const specs: ColumnSpec[] = [
    { key: 'sl', label: 'SL', width: 18, align: 'center', always: true, value: (_it, i) => String(i + 1) },
    { key: 'description', label: 'DESCRIPTION', width: '*', always: true, value: (it) => String(it.description || it.material_name || it.product_name || '') },
    { key: 'hsn', label: 'HSN', width: 44, align: 'center', value: hsnOf },
    // The reference order's QUANTITY banner sits over these two. The banner
    // shrinks with its run if either auto-hides, which is what makes it safe
    // on an order that states no packing at all.
    { key: 'packs', label: 'NO. OF CART./BAGS', width: 46, align: 'right', group: 'QUANTITY', value: (it) => fmtNum(it.packs, 0), sum: (rows) => fmtNum(rows.reduce((t, r) => t + (Number(r.packs) || 0), 0), 0) },
    { key: 'pcs_per_pack', label: 'PCS./KGS. IN CART.', width: 48, align: 'right', group: 'QUANTITY', value: (it) => fmtNum(it.pcs_per_pack, 0) },
    { key: 'qty', label: 'TOTAL QUANTITY', width: 60, align: 'right', always: true, value: (it) => (it.qty != null ? `${fmtNum(it.qty)} ${it.unit ?? ''}`.trim() : '') },
    { key: 'rate', label: `UNIT PRICE (${cur})`, width: 56, align: 'right', always: true, value: (it) => fmtNum(it.rate, 3) },
    { key: 'tax', label: 'TAX %', width: 28, align: 'right', value: (it) => (showTax ? `${it.tax_pct ?? 0}%` : '') },
    { key: 'amount', label: `TOTAL (${cur})`, width: 64, align: 'right', always: true, value: (it) => fmtMoney(Number(it.amount), cur), sum: (rows) => fmtMoney(rows.reduce((t, r) => t + (Number(r.amount) || 0), 0), cur) },
  ];

  /*
   * Round off is derived here rather than through `roundOffOf`, which does not
   * know about TCS and would report it as a rounding difference of a hundred
   * rupees. A purchase order carries no header freight or insurance.
   */
  const tcs = Number(po.tcs_amount) || 0;
  const roundOff = round2(
    Number(po.grand_total) - (Number(po.subtotal) + Number(po.tax_total) + tcs)
  );

  const money: MoneyRow[] = [
    ...taxRows(po, cur).map(([label, value]) => ({ label, value })),
    ...(tcs ? [{ label: `TCS @ ${fmtNum(po.tcs_pct, 3)}%`, value: fmtMoney(tcs, cur) }] : []),
    ...(po.inco_terms ? [{ label: `Incoterms: ${String(po.inco_terms)}`, value: '' }] : []),
    ...(roundOff !== 0 ? [{ label: 'Round off', value: (roundOff > 0 ? '' : '(') + Math.abs(roundOff).toFixed(2) + (roundOff > 0 ? '' : ')') }] : []),
    { label: 'TOTAL', value: fmtMoney(Number(po.grand_total), cur), band: true, sums: true },
  ];

  const vendorLines = [
    String(sup?.name ?? ''),
    ...String(sup?.address ?? '').split('\n'),
    sup?.gstin ? `GSTIN: ${String(sup.gstin)}` : '',
    sup?.phone ? `Ph: ${String(sup.phone)}` : '',
  ].filter(Boolean);

  // Kind Attn falls back to whoever the supplier record names, which is the
  // person the office already deals with there.
  const attn = String(po.attn || sup?.contact_person || '');

  const shipLines = String(po.ship_to || '').split('\n').filter(Boolean);
  if (!shipLines.length) {
    // Nothing typed, so the plant it is being delivered to stands in — which
    // is what the receipts default to anyway.
    shipLines.push(String(s.company_name || ''), loc ? String(loc.name) : '');
  }

  const stack = (title: string, lines: string[]): Cell => ({
    stack: [
      { text: title, fontSize: 6.5, bold: true, color: '#333333' },
      ...lines.filter(Boolean).map((t) => ({ text: t, fontSize: 8, margin: [0, 1, 0, 0] as [number, number, number, number] })),
    ],
  });

  const header: Content = {
    table: {
      widths: ['*', '*', 78, 78],
      body: [
        [
          stack('VENDOR', vendorLines.length ? vendorLines : ['—']),
          stack('SHIP TO', shipLines.length ? shipLines : ['—']),
          lv('PO No.', String(po.number)),
          lv('Date', fmtDate(String(po.date))),
        ],
        [
          lv('Kind Attn', attn),
          lv('Vendor ID', String(po.vendor_ref || '')),
          lv('Expected', po.expected_date ? fmtDate(String(po.expected_date)) : ''),
          lv('Currency', cur),
        ],
        [
          lv('Terms (FOB)', String(po.inco_terms || '')),
          lv('Payment Terms', String(po.payment_terms || '')),
          lv('Transport', String(po.transport || '')),
          lv('Ship Via', String(po.ship_via || '')),
        ],
      ],
    },
    layout: boxedLayout,
    margin: [0, 6, 0, 0] as [number, number, number, number],
  };

  const content: Content[] = [
    ...companyHeader(s, {}),
    docTitle(s, 'PURCHASE ORDER'),
    header,
    {
      text: 'Dear Sir, as per your offer we are pleased to place the order for the following:',
      fontSize: 8.5,
      margin: [0, 8, 0, 4] as [number, number, number, number],
    },
    itemsTable(s, items, specs, {}, money),
    amountWords(po, cur),
    ...(po.packing
      ? [{ text: `Packing: ${String(po.packing)}`, fontSize: 8, margin: [0, 6, 0, 0] as [number, number, number, number] }]
      : []),
    ...notesAndTerms(s, String(po.notes || ''), 'TERMS & CONDITIONS:'),
    signatureBlock(s, {}),
  ];
  return baseDoc(content);
}

/* ------------------------------------------------------------------ *
 * The QC report
 * ------------------------------------------------------------------ */

interface QcJob {
  id: number;
  number: string;
  product_id: number | null;
  product_name: string | null;
  description: string;
  order_id: number;
  order_number: string;
  order_line: number;
  customer_id: number;
  customer_name: string;
  process_name: string | null;
  machine_name: string | null;
}

const QC_JOB_SQL = `
  SELECT w.id, w.number, w.product_id, w.description, w.order_id, w.order_line,
         p.name AS product_name, o.number AS order_number,
         o.customer_id, c.name AS customer_name,
         pr.name AS process_name, m.name AS machine_name
    FROM work_orders w
    JOIN orders o ON o.id = w.order_id
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN products p ON p.id = w.product_id
    LEFT JOIN processes pr ON pr.id = w.process_id
    LEFT JOIN machines m ON m.id = w.machine_id`;

/**
 * The jobs a commercial invoice covers.
 *
 * The same walk `dispatchProgress()` does — an invoice reaches its order
 * directly or through the proforma that carries the link — and then the same
 * **index rule** the whole chain uses: an invoice line at position *i* bills
 * the order line at position *i*, and `work_orders.order_line` is that
 * position. Positions count charge lines, so nothing is compacted first.
 */
function jobsForInvoice(invoiceId: number): QcJob[] {
  const inv = db.prepare(
    `SELECT COALESCE(i.order_id, pi.order_id) AS order_id
       FROM commercial_invoices i
       LEFT JOIN proforma_invoices pi ON pi.id = i.pi_id
      WHERE i.id = ?`
  ).get(invoiceId) as { order_id: number | null } | undefined;
  if (!inv?.order_id) return [];

  const billed = db.prepare(
    'SELECT qty FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id'
  ).all(invoiceId) as { qty: number | null }[];
  const positions = billed
    .map((it, i) => ({ i, qty: Number(it.qty) || 0 }))
    .filter((r) => r.qty > 0)
    .map((r) => r.i);
  if (!positions.length) return [];

  return db.prepare(
    `${QC_JOB_SQL} WHERE w.order_id = ? AND w.order_line IN (${positions.map(() => '?').join(',')})
      ORDER BY w.order_line, w.id`
  ).all(inv.order_id, ...(positions as never[])) as unknown as QcJob[];
}

const jobsForOrder = (orderId: number) =>
  db.prepare(`${QC_JOB_SQL} WHERE w.order_id = ? ORDER BY w.order_line, w.id`)
    .all(orderId) as unknown as QcJob[];

const jobById = (workOrderId: number) =>
  db.prepare(`${QC_JOB_SQL} WHERE w.id = ?`).all(workOrderId) as unknown as QcJob[];

/**
 * The body of a QC report: every job, its specification, and every inspection
 * against it **grouped by date and shift** — which is what "shift wise details"
 * asks for, and the first thing in this app to group by a field that has always
 * been free text.
 *
 * The specification printed is the one *in force for that job's customer*, and
 * the readings are judged against the tolerance **copied onto the result** when
 * the check was saved — not against today's spec. A batch that met the spec of
 * the day still reads as passing after the spec moves, which is the whole
 * reason `qc_results` carries its own copy.
 */
function qcReportContent(s: Row, jobs: QcJob[]): Content[] {
  if (!jobs.length) {
    return [{ text: 'No quality checks have been recorded against this.', fontSize: 9, margin: [0, 10, 0, 0] as any }];
  }

  const out: Content[] = [];
  for (const [n, job] of jobs.entries()) {
    const params = paramsFor(job.product_id, job.customer_id);
    const owner = specOwner(job.product_id, job.customer_id);
    const checks = checksForWorkOrder(job.id);

    out.push({
      table: {
        widths: ['*', '*', '*'],
        body: [[
          lv('Job', job.number),
          lv('Product', String(job.product_name || job.description || '')),
          lv('Order', `${job.order_number} · line ${job.order_line + 1}`),
        ], [
          lv('Customer', job.customer_name),
          lv('Process', String(job.process_name || '')),
          lv('Machine', String(job.machine_name || '')),
        ]],
      },
      layout: boxedLayout,
      margin: [0, n === 0 ? 8 : 14, 0, 0] as any,
    });

    // Which specification was applied, said out loud — "these are the
    // tolerances" and "these are *your* tolerances" are different sentences.
    out.push({
      text: owner === 'customer'
        ? `Specification: ${job.customer_name}'s own`
        : owner === 'default' ? 'Specification: the product’s standard' : 'No specification recorded for this product',
      fontSize: 8,
      italics: true,
      color: '#555555',
      margin: [0, 3, 0, 3] as any,
    });

    if (params.length) {
      out.push({
        table: {
          headerRows: 1,
          widths: ['*', 55, 55, 45],
          body: [
            ['Parameter', 'Min', 'Max', 'Unit'].map((t) => ({ text: t, fontSize: 7.5, bold: true, color: '#ffffff', fillColor: s.theme })),
            ...params.map((p) => [
              { text: p.name, fontSize: 8 },
              { text: p.kind === 'boolean' ? '—' : (p.min_value ?? '—').toString(), fontSize: 8, alignment: 'right' as const },
              { text: p.kind === 'boolean' ? '—' : (p.max_value ?? '—').toString(), fontSize: 8, alignment: 'right' as const },
              { text: p.unit || '', fontSize: 8, alignment: 'center' as const },
            ]),
          ],
        },
        layout: gridLayout,
      });
    }

    if (!checks.length) {
      out.push({ text: 'No inspection recorded against this job.', fontSize: 8, italics: true, margin: [0, 4, 0, 0] as any });
      continue;
    }

    // Grouped by the day and the shift it was inspected on.
    const groups = new Map<string, typeof checks>();
    for (const c of checks) {
      const key = `${c.date}|${c.shift || ''}`;
      const list = groups.get(key) ?? [];
      list.push(c);
      groups.set(key, list);
    }

    for (const [key, list] of groups) {
      const [date, shift] = key.split('|');
      out.push({
        text: `${fmtDate(date)}${shift ? ` · Shift ${shift}` : ''}`,
        fontSize: 8.5, bold: true, color: s.theme, margin: [0, 6, 0, 2] as any,
      });
      const body: any[][] = [
        ['Parameter', 'Spec', 'Reading', 'Result', 'Inspector'].map((t) => ({ text: t, fontSize: 7.5, bold: true })),
      ];
      for (const c of list) {
        for (const r of c.results) {
          const spec = r.kind === 'boolean'
            ? 'pass / fail'
            : [r.min_value ?? '', r.max_value ?? ''].some((v) => v !== '')
              ? `${r.min_value ?? ''} – ${r.max_value ?? ''}`
              : '—';
          body.push([
            { text: r.name, fontSize: 8 },
            { text: spec, fontSize: 8, alignment: 'center' as const },
            { text: r.value === null || r.value === undefined ? '—' : String(r.value), fontSize: 8, alignment: 'right' as const },
            // Never recomputed here: `ok` is the arithmetic `resultOk` did, and
            // a blank reading is *not measured* rather than a pass.
            {
              text: r.ok === null ? 'not measured' : r.ok ? 'Pass' : 'Fail',
              fontSize: 8, alignment: 'center' as const, bold: r.ok === false,
              color: r.ok === false ? '#a11' : r.ok ? '#186a3b' : '#888888',
            },
            { text: c.inspector || '', fontSize: 8 },
          ]);
        }
        if (c.notes) body.push([{ text: `Note: ${c.notes}`, fontSize: 7.5, italics: true, colSpan: 5, color: '#555555' }, {}, {}, {}, {}]);
      }
      out.push({ table: { headerRows: 1, widths: ['*', 70, 55, 55, 70], body }, layout: gridLayout });
    }
  }
  return out;
}

function qcDocument(s: Row, title: string, subject: string, jobs: QcJob[]): TDocumentDefinitions {
  return baseDoc([
    ...companyHeader(s, {}),
    docTitle(s, title),
    { text: subject, fontSize: 9, bold: true, margin: [0, 2, 0, 0] as any },
    ...qcReportContent(s, jobs),
    signatureBlock(s, {}),
  ]);
}

/** One job's quality record. */
export function buildQcReportPdf(workOrderId: number): TDocumentDefinitions {
  const jobs = jobById(workOrderId);
  if (!jobs.length) throw new Error('Work order not found');
  const wo = db.prepare('SELECT company_id FROM work_orders WHERE id = ?').get(workOrderId) as Row;
  return qcDocument(companyProfile(wo?.company_id), 'QUALITY REPORT', `Job ${jobs[0].number} — ${jobs[0].customer_name}`, jobs);
}

/** Every job raised from one sales order. */
export function buildOrderQcReportPdf(orderId: number): TDocumentDefinitions {
  const o = db.prepare('SELECT number, company_id, customer_id FROM orders WHERE id = ?').get(orderId) as Row;
  if (!o) throw new Error('Order not found');
  const c = db.prepare('SELECT name FROM customers WHERE id = ?').get(o.customer_id) as Row | undefined;
  return qcDocument(
    companyProfile(o.company_id), 'QUALITY REPORT',
    `Order ${String(o.number)} — ${String(c?.name ?? '')}`, jobsForOrder(orderId)
  );
}

/** The quality record behind one commercial invoice — the summary that ships with it. */
export function buildInvoiceQcReportPdf(invoiceId: number): TDocumentDefinitions {
  const inv = db.prepare('SELECT number, company_id, customer_id FROM commercial_invoices WHERE id = ?').get(invoiceId) as Row;
  if (!inv) throw new Error('Invoice not found');
  const c = db.prepare('SELECT name FROM customers WHERE id = ?').get(inv.customer_id) as Row | undefined;
  return qcDocument(
    companyProfile(inv.company_id), 'QUALITY REPORT',
    `Invoice ${String(inv.number)} — ${String(c?.name ?? '')}`, jobsForInvoice(invoiceId)
  );
}

/**
 * The invoice and its quality summary in one file.
 *
 * The same mechanism as `buildInvoiceWithPackingPdf` — two builders,
 * concatenated with a page break, keeping the first document's page settings —
 * including its behaviour when the second half has nothing to say: an invoice
 * whose jobs carry no checks comes back as the invoice alone, rather than as an
 * invoice followed by a page saying nothing.
 */
export function buildInvoiceWithQcPdf(invoiceId: number): TDocumentDefinitions {
  const invoice = buildInvoicePdf(invoiceId);
  const jobs = jobsForInvoice(invoiceId);
  if (!jobs.some((j) => checksForWorkOrder(j.id).length > 0)) return invoice;
  const qc = buildInvoiceQcReportPdf(invoiceId);
  return {
    ...invoice,
    content: [
      ...(invoice.content as Content[]),
      { text: '', pageBreak: 'after' },
      ...(qc.content as Content[]),
    ],
  };
}

/** Optional diagonal watermark for documents that have not been approved. */
export function renderPdf(docDefinition: TDocumentDefinitions, watermark?: string): Promise<Buffer> {
  const def: TDocumentDefinitions = watermark
    ? { ...docDefinition, watermark: { text: watermark, color: '#b00020', opacity: 0.12, bold: true, angle: -35 } }
    : docDefinition;
  return new Promise((resolve, reject) => {
    try {
      const doc = printer.createPdfKitDocument(def);
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
