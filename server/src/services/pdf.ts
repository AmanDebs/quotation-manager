import PdfPrinter from 'pdfmake';
import pdfFonts from 'pdfmake/build/vfs_fonts.js';
import type { TDocumentDefinitions, Content } from 'pdfmake/interfaces';
import { inflateSync } from 'node:zlib';
import { db } from '../db/connection.js';
import { amountInWords } from './amountInWords.js';
import { round2 } from './totals.js';
import { invoiceReceivable } from './receivables.js';
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
function companyHeader(s: Row): Content[] {
  const right: any = {
    stack: [
      { text: s.company_name || 'Company Name', fontSize: 14, bold: true, color: s.theme, alignment: 'right' },
      { text: [s.address, [s.city, s.state ? s.state : '', s.pincode].filter(Boolean).join(', '), s.country].filter(Boolean).join(', '), fontSize: 8, color: '#555555', alignment: 'right', margin: [0, 2, 0, 0] },
      { text: [s.phone && `Sales cell: ${s.phone}`, s.email && `Email: ${s.email}`, s.website].filter(Boolean).join('  |  '), fontSize: 8, color: '#555555', alignment: 'right', margin: [0, 1.5, 0, 0] },
      { text: [s.gstin && `GSTIN: ${s.gstin}`, s.pan && `PAN: ${s.pan}`, s.iec && `IEC: ${s.iec}`].filter(Boolean).join('  |  '), fontSize: 7.5, color: '#777777', alignment: 'right', margin: [0, 1.5, 0, 0] },
    ],
    width: '*',
  };
  // The logo column eats into the right block, which gets the rest of the
  // 515pt content width. At 150 the company lines still fit on one line each
  // with ~40pt to spare — the longest, the contact row, measures ~316pt.
  const cols: Content = s.logo
    ? { columns: [{ image: s.logo, fit: [140, 72] as [number, number], width: 150 }, right], columnGap: 10 }
    : right;
  return [
    cols,
    { canvas: [{ type: 'line', x1: 0, y1: 6, x2: 515, y2: 6, lineWidth: 2, lineColor: s.theme }], margin: [0, 0, 0, 4] as any },
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
    decoration: 'underline', margin: [0, 8, 0, 10] as any,
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

function signatureBlock(s: Row, opts: { buyerSide?: boolean; preparedBy?: string } = {}): Content {
  const supplier: any = {
    stack: [
      { text: `For ${s.company_name || 'Company'}`, fontSize: 8, bold: true },
      ...(s.signature
        ? [{ image: s.signature, fit: [110, 42] as [number, number], margin: [0, 4, 0, 4] as any }]
        : [{ text: ' ', margin: [0, 26, 0, 0] as any }]),
      { text: 'Authorised Signatory', fontSize: 8 },
    ],
    width: 170,
  };
  return {
    columns: [
      {
        stack: [
          ...(opts.buyerSide
            ? [{ text: "BUYER'S SIGNATURE & STAMP", fontSize: 8, bold: true, margin: [0, 30, 0, 0] as any }]
            : []),
          ...(opts.preparedBy ? [{ text: `Prepared By: ${opts.preparedBy}`, fontSize: 7.5, color: '#666666', margin: [0, opts.buyerSide ? 8 : 34, 0, 0] as any }] : []),
        ],
        width: '*',
      },
      supplier,
    ],
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
function totalsBand(s: Row, doc: Row, currency: string, grandLabel: string): Content {
  const bandRows: { label: string; value: string; band?: boolean }[] = [];
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
  return [c.name, c.contact_person && `Attn: ${c.contact_person}`, c.address, [c.city, c.country].filter(Boolean).join(', '),
    c.gstin && `GSTIN: ${c.gstin}`, withContact && c.phone && `Phone: ${c.phone}`, withContact && c.email && `Email: ${c.email}`]
    .filter(Boolean).join('\n');
}

function baseDoc(content: Content[]): TDocumentDefinitions {
  return {
    pageSize: 'A4',
    pageMargins: [40, 34, 40, 42],
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
}

export interface ColumnConfig {
  hidden?: string[];
  custom?: string[];
}

/**
 * Builds the line-items table honouring the document's column_config:
 * explicitly hidden columns are dropped, columns with no data anywhere are
 * dropped automatically, and up to three named custom columns are appended.
 */
function itemsTable(s: Row, items: Row[], specs: ColumnSpec[], cfg: ColumnConfig) {
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

  const body: Cell[][] = [
    columns.map((c) => ({ ...th(s, c.label), alignment: c.key === 'description' ? 'left' : 'center' })),
    ...items.map((it, i) =>
      columns.map((c) => ({
        ...(c.cell ? c.cell(it, i) : { text: c.value(it, i) }),
        fontSize: 8,
        alignment: c.align ?? 'left',
        fillColor: i % 2 ? '#f7f5f4' : undefined,
      }))
    ),
  ];

  return {
    table: { headerRows: 1, widths: columns.map((c) => c.width), body },
    layout: gridLayout,
  } as Content;
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
    { key: 'uom', label: 'UOM', width: 52, align: 'center', always: true, value: (it) => uomLabel(cur, it.unit) },
    ...(showTax ? [{ key: 'tax', label: 'Tax %', width: 30, align: 'right' as const, value: (it: Row) => `${it.tax_pct ?? 0}%` }] : []),
    { key: 'amount', label: `Total (${cur})`, width: 62, align: 'right', always: true, value: (it) => (it.qty != null ? fmtMoney(it.amount, cur) : 'price only') },
  ];

  const grandLabel = q.inco_terms
    ? `TOTAL PRICE IN ${q.inco_terms}${q.container_count ? ` (${q.container_count})` : ''}`
    : 'GRAND TOTAL';

  const content: Content[] = [
    ...companyHeader(s),
    docTitle(s, 'QUOTATION'),
    meta,
    itemsTable(s, items, specs, cfg),
    ...(hasQty
      ? [totalsBand(s, q, cur, grandLabel), amountWords(q, cur)]
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

  const cur = o.currency;
  const showTax = o.tax_type !== 'none';
  const cfg: ColumnConfig = JSON.parse(String(o.column_config || '{}'));

  const specs: ColumnSpec[] = [
    { key: 'sl', label: 'SL', width: 18, align: 'center', always: true, value: (_it, i) => String(i + 1) },
    { key: 'description', label: 'Description of Goods', width: '*', always: true, value: (it) => it.description },
    { key: 'code', label: 'Code', width: 45, align: 'center', value: (it) => it.code || '' },
    { key: 'hsn', label: 'HSN', width: 45, align: 'center', value: (it) => it.hsn_code || '' },
    { key: 'color', label: 'Colour', width: 50, align: 'center', value: (it) => it.color || '' },
    { key: 'qty', label: 'Quantity', width: 58, align: 'right', value: (it) => (it.qty != null ? `${fmtNum(it.qty)} ${it.unit}` : '') },
    { key: 'unit_price', label: `Rate ${cur}`, width: 52, align: 'right', value: (it) => fmtNum(it.unit_price, 3) },
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
    ...companyHeader(s),
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
  const cfg: ColumnConfig = JSON.parse(String(pi.column_config || '{}'));

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
      widths: [105, '*'],
      body: rows.map(([l, v]) => [
        { text: l, fontSize: 7.5, bold: true, color: '#333333' },
        { text: v, fontSize: 7.5 },
      ]),
    },
    layout: { ...gridLayout, hLineColor: '#dddddd', vLineColor: '#dddddd' },
  });

  const buyerStack: Content[] = [
    { text: customerAddress(c), fontSize: 8 },
    ...(pi.consignee ? [{ text: 'CONSIGNEE', fontSize: 6.5, bold: true, color: '#333333', margin: [0, 5, 0, 1] as any }, { text: pi.consignee, fontSize: 7.5 }] : []),
    ...(pi.notify_party ? [{ text: 'NOTIFY PARTY 1', fontSize: 6.5, bold: true, color: '#333333', margin: [0, 5, 0, 1] as any }, { text: pi.notify_party, fontSize: 7.5 }] : []),
    ...(pi.notify_party_2 ? [{ text: 'NOTIFY PARTY 2', fontSize: 6.5, bold: true, color: '#333333', margin: [0, 5, 0, 1] as any }, { text: pi.notify_party_2, fontSize: 7.5 }] : []),
  ];

  const bankStack: Content[] = pi.bank_account
    ? [{ text: 'Beneficiary Bank details:', fontSize: 7.5, bold: true }, { text: `${s.company_name}\n${pi.bank_account}`, fontSize: 7.5, margin: [0, 2, 0, 0] as any }]
    : [{ text: '—', fontSize: 7.5 }];

  const infoGrid: Content = {
    table: {
      widths: ['*', '*'],
      body: [
        [sectionHead('NAME & ADDRESS OF BUYER'), sectionHead('SHIPMENT INFORMATION')],
        [{ stack: buyerStack }, kvTable(shipmentInfo)],
        [sectionHead('ADDITIONAL INFORMATION FOR CUSTOMS'), sectionHead('BANK DETAILS')],
        [kvTable(customsInfo), { stack: bankStack }],
      ],
    },
    layout: boxedLayout,
    margin: [0, 0, 0, 8] as any,
  };

  const specs: ColumnSpec[] = [
    { key: 'sl', label: 'SL', width: 16, align: 'center', always: true, value: (_it, i) => String(i + 1) },
    // No per-line HSN: Aglo's proformas carry the HS code once, in the customs
    // block above (`hs_code`), the way the Emeraude sample does. The value is
    // still stored and still reaches the commercial invoice, which prints it.
    { key: 'description', label: 'Description of Goods', width: '*', always: true, value: (it) => String(it.description) },
    // Qty stays, unlike on the quotation: a proforma is often billed by weight
    // (KGS x price/kg), and then this is the only quantity on the document.
    { key: 'qty', label: 'Qty', width: 52, align: 'right', always: true, value: (it) => (it.qty != null ? `${fmtNum(it.qty)} ${it.unit}` : '—') },
    { key: 'unit_price', label: `Price ${cur}`, width: 46, align: 'right', always: true, value: (it) => `${fmtNum(it.unit_price, 3)} /${it.unit === 'per 1000' ? '1000' : it.unit}` },
    { key: 'color', label: 'Color', width: 48, align: 'center', value: (it) => String(it.color || '') },
    { key: 'packs', label: 'Boxes', width: 40, align: 'right', value: (it) => (it.packs != null ? fmtNum(it.packs, 0) : '') },
    { key: 'total_pcs', label: 'Total Qty (Pcs)', width: 52, align: 'right', value: (it) => (it.total_pcs != null ? fmtNum(it.total_pcs, 0) : '') },
    { key: 'per_1000', label: `${cur}/1000 Pcs`, width: 46, align: 'right', value: (it) => (it.total_pcs ? fmtNum(round2((it.amount / it.total_pcs) * 1000), 2) : '') },
    ...(showTax ? [{ key: 'tax', label: 'Tax %', width: 28, align: 'right' as const, value: (it: Row) => `${it.tax_pct ?? 0}%` }] : []),
    { key: 'amount', label: `Amount (${cur})`, width: 60, align: 'right', always: true, value: (it) => fmtMoney(it.amount, cur) },
  ];

  const grandLabel = pi.inco_terms && pi.port_of_discharge
    ? `TOTAL PRICE ${cur} ${pi.inco_terms} ${pi.port_of_discharge.split(',')[0].toUpperCase()}`
    : 'GRAND TOTAL';

  const content: Content[] = [
    ...companyHeader(s),
    docTitle(s, 'PROFORMA INVOICE'),
    infoGrid,
    itemsTable(s, items, specs, cfg),
    totalsBand(s, pi, cur, grandLabel),
    amountWords(pi, cur),
    ...(pi.remarks ? [{ text: 'REMARKS:', fontSize: 9, bold: true, color: s.theme, margin: [0, 8, 0, 2] as any }, { text: pi.remarks, fontSize: 8 }] : []),
    ...notesAndTerms(s, '', 'TERMS & CONDITIONS:'),
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
}): Content {
  const companyBlock = [
    s.company_name,
    s.address,
    [s.city, s.state, s.pincode].filter(Boolean).join(', '),
    s.country && `${s.country}`.toUpperCase(),
    s.gstin && `GSTIN: ${s.gstin}`,
    s.iec && `IEC: ${s.iec}`,
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
  const cfg: ColumnConfig = JSON.parse(String(inv.column_config || '{}'));

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
    { key: 'qty', label: 'Quantity', width: 58, align: 'right', always: true, value: (it) => (it.qty != null ? `${fmtNum(it.qty)} ${it.unit}` : '—') },
    { key: 'unit_price', label: 'Rate', width: 55, align: 'right', always: true, value: (it) => `${fmtNum(it.unit_price, 3)}/${it.unit === 'per 1000' ? '1000' : it.unit}` },
    { key: 'color', label: 'Color', width: 46, align: 'center', value: (it) => String(it.color || '') },
    { key: 'packs', label: 'Boxes', width: 40, align: 'right', value: (it) => (it.packs != null ? fmtNum(it.packs, 0) : '') },
    { key: 'hsn', label: 'HSN Code', width: 45, align: 'center', value: (it) => String(it.hsn_code || '') },
    ...(showTax ? [{ key: 'tax', label: 'Tax %', width: 28, align: 'right' as const, value: (it: Row) => `${it.tax_pct ?? 0}%` }] : []),
    { key: 'amount', label: `Amount ${cur}${inv.inco_terms ? ` (${String(inv.inco_terms).split(' ')[0]})` : ''}`, width: 62, align: 'right', always: true, value: (it) => fmtMoney(it.amount, cur) },
  ];

  // Payment status rows appended to the band via a second small table
  const paymentBand: Content[] = received > 0
    ? [{
        columns: [
          { text: '', width: '*' },
          {
            table: {
              widths: ['*', 95],
              body: [
                [{ text: 'Amount Received', fontSize: 8, fillColor: '#f4f2f0' }, { text: fmtMoney(received, cur), fontSize: 8, alignment: 'right', fillColor: '#f4f2f0' }],
                [{ text: 'Balance Due', fontSize: 8, bold: true, fillColor: '#f4f2f0' }, { text: fmtMoney(Math.max(0, round2(inv.grand_total - received)), cur), fontSize: 8, bold: true, alignment: 'right', fillColor: '#f4f2f0' }],
              ],
            },
            layout: { hLineColor: '#ffffff', vLineColor: '#ffffff', hLineWidth: () => 1.5, vLineWidth: () => 0, paddingTop: () => 4, paddingBottom: () => 4, paddingLeft: () => 6, paddingRight: () => 6 },
            width: 300,
          },
        ],
        margin: [0, 2, 0, 0] as any,
      }]
    : [];

  const grandLabel = inv.inco_terms && inv.port_of_discharge
    ? `AMOUNT IN ${inv.inco_terms} ${inv.port_of_discharge.split(',')[0].toUpperCase()}`
    : 'GRAND TOTAL';

  const certFooter: Content = {
    table: {
      widths: ['*', 200],
      body: [[
        {
          stack: [
            { text: `We certify that the merchandise is of ${(inv.country_of_origin || s.country || 'Indian').replace(/ia$/i, 'ian')} Origin`, fontSize: 8, bold: true },
            ...(inv.inco_terms ? [{ text: `Incoterms® 2020: ${inv.inco_terms}${inv.port_of_discharge ? ` ${inv.port_of_discharge.split(',')[0].toUpperCase()}` : ''}`, fontSize: 8, margin: [0, 2, 0, 0] as any }] : []),
            ...(s.arn_ref ? [{ text: `Application Reference No. (ARN): ${s.arn_ref}`, fontSize: 8, margin: [0, 2, 0, 0] as any }] : []),
            ...(inv.remarks ? [{ text: inv.remarks, fontSize: 7.5, italics: true, margin: [0, 3, 0, 0] as any }] : []),
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
    ...companyHeader(s),
    docTitle(s, 'COMMERCIAL INVOICE'),
    grid,
    itemsTable(s, items, specs, cfg),
    totalsBand(s, inv, cur, grandLabel),
    ...paymentBand,
    amountWords(inv, cur),
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
  const items = db.prepare('SELECT * FROM packing_list_items WHERE packing_list_id = ? ORDER BY sort_order, id').all(id) as Row[];
  const inv = pl.invoice_id
    ? (db.prepare('SELECT * FROM commercial_invoices WHERE id = ?').get(pl.invoice_id) as Row | undefined)
    : undefined;
  const pi = inv?.pi_id ? (db.prepare('SELECT number, date FROM proforma_invoices WHERE id = ?').get(inv.pi_id) as Row | undefined) : undefined;

  const totalGross = round2(items.reduce((sum, it) => sum + (it.gross_weight || 0), 0));
  const totalNet = round2(items.reduce((sum, it) => sum + (it.net_weight || 0), 0));
  const totalQty = items.reduce((sum, it) => sum + (it.qty || 0), 0);

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
    if (label === 'Quantity') return cell(totalQty ? fmtNum(totalQty, 0) : '');
    if (label === 'Thousand Pcs') return cell(totalQty ? fmtNum(totalQty / 1000, 2) : '');
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
            ...(s.arn_ref ? [{ text: `Application Reference No. (ARN): ${s.arn_ref}`, fontSize: 8, margin: [0, 2, 0, 0] as any }] : []),
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
    ...companyHeader(s),
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
