import PdfPrinter from 'pdfmake';
import pdfFonts from 'pdfmake/build/vfs_fonts.js';
import type { TDocumentDefinitions, Content } from 'pdfmake/interfaces';
import { db } from '../db/connection.js';
import { amountInWords } from './amountInWords.js';
import { round2 } from './totals.js';

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

function getSettings(): Row {
  const s = db.prepare('SELECT * FROM settings WHERE id = 1').get() as Row;
  s.bank_accounts = JSON.parse(s.bank_accounts || '[]');
  s.theme = s.theme_color || '#8b1a1a';
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
  const cols: Content = s.logo
    ? { columns: [{ image: s.logo, fit: [95, 52] as [number, number], width: 110 }, right], columnGap: 10 }
    : right;
  return [
    cols,
    { canvas: [{ type: 'line', x1: 0, y1: 6, x2: 515, y2: 6, lineWidth: 2, lineColor: s.theme }], margin: [0, 0, 0, 4] as any },
  ];
}

function docTitle(s: Row, title: string): Content {
  return {
    text: title.split('').join(' '),
    fontSize: 13, bold: true, alignment: 'center', color: s.theme,
    decoration: 'underline', margin: [0, 8, 0, 10] as any,
  };
}

/** "NOTES & TERMS" bullet list from notes + default terms. */
function notesAndTerms(s: Row, docNotes: string, title = 'NOTES & TERMS:'): Content[] {
  const bullets = [docNotes, s.default_terms]
    .filter(Boolean)
    .flatMap((t: string) => t.split('\n'))
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
  return { text: `Amount in Words: ${amountInWords(doc.grand_total, currency)}`, fontSize: 8, italics: true, margin: [0, 5, 0, 0] as any };
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
/* QUOTATION — modeled on the Sanya Industries sample                  */
/* ------------------------------------------------------------------ */
export function buildQuotationPdf(id: number): TDocumentDefinitions {
  const s = getSettings();
  const q = db.prepare('SELECT * FROM quotations WHERE id = ?').get(id) as Row;
  if (!q) throw new Error('Quotation not found');
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(q.customer_id) as Row;
  const items = db.prepare('SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY sort_order, id').all(id) as Row[];

  const cur = q.currency;
  const showTax = q.tax_type !== 'none';
  const hasPacking = items.some((it) => it.packs != null || it.pcs_per_pack != null || it.total_pcs != null);
  const hasQty = items.some((it) => it.qty != null);

  const meta: Content = {
    columns: [
      {
        table: {
          widths: [92, '*'],
          body: [
            [{ text: 'Quotation No:', bold: true, color: s.theme, fontSize: 8.5, border: [false, false, false, false] }, { text: `${q.number}${q.revision ? ` (Rev. ${q.revision})` : ''}`, fontSize: 8.5, bold: true, border: [false, false, false, false] }],
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

  const header: Cell[] = [th(s, 'SL'), { ...th(s, 'Product Description'), alignment: 'left' }, th(s, 'Unit Price'), th(s, 'UOM')];
  const widths: any[] = [18, '*', 48, 52];
  if (hasPacking) { header.push(th(s, 'Pcs/Box'), th(s, 'Boxes'), th(s, 'Total Qty')); widths.push(42, 40, 55); }
  if (items.some((i) => i.color)) { header.push(th(s, 'Color')); widths.push(48); }
  if (showTax) { header.push(th(s, 'Tax %')); widths.push(30); }
  header.push(th(s, `Total (${cur})`)); widths.push(62);

  const body: Cell[][] = [header];
  items.forEach((it, i) => {
    const row: Cell[] = [
      { text: String(i + 1), fontSize: 8, alignment: 'center' },
      { text: it.description + (it.hsn_code ? `\nHSN: ${it.hsn_code}` : ''), fontSize: 8 },
      { text: fmtNum(it.unit_price, 3), fontSize: 8, alignment: 'right' },
      { text: uomLabel(cur, it.unit), fontSize: 8, alignment: 'center' },
    ];
    if (hasPacking) {
      row.push(
        { text: fmtNum(it.pcs_per_pack, 0), fontSize: 8, alignment: 'right' },
        { text: fmtNum(it.packs, 0), fontSize: 8, alignment: 'right' },
        { text: fmtNum(it.total_pcs, 0), fontSize: 8, alignment: 'right' },
      );
    }
    if (items.some((x) => x.color)) row.push({ text: it.color || '—', fontSize: 8, alignment: 'center' });
    if (showTax) row.push({ text: `${it.tax_pct ?? 0}%`, fontSize: 8, alignment: 'right' });
    row.push({ text: it.qty != null ? fmtMoney(it.amount, cur) : 'price only', fontSize: 8, alignment: 'right' });
    body.push(row.map((cell, ci) => ({ ...cell, fillColor: i % 2 ? '#f7f5f4' : undefined })));
  });

  const grandLabel = q.inco_terms
    ? `TOTAL PRICE IN ${q.inco_terms}${q.container_count ? ` (${q.container_count})` : ''}`
    : 'GRAND TOTAL';

  const content: Content[] = [
    ...companyHeader(s),
    docTitle(s, 'QUOTATION'),
    meta,
    { table: { headerRows: 1, widths, body }, layout: gridLayout },
    ...(hasQty
      ? [totalsBand(s, q, cur, grandLabel), amountWords(q, cur)]
      : [{ text: 'Note: Quantities to be confirmed by the customer. Prices are as stated above.', fontSize: 8, italics: true, margin: [0, 6, 0, 0] as any }]),
    ...notesAndTerms(s, q.notes),
    signatureBlock(s, { preparedBy: q.prepared_by }),
  ];
  return baseDoc(content);
}

/* ------------------------------------------------------------------ */
/* PROFORMA INVOICE — modeled on the Emeraude sample                   */
/* ------------------------------------------------------------------ */
export function buildProformaPdf(id: number): TDocumentDefinitions {
  const s = getSettings();
  const pi = db.prepare('SELECT * FROM proforma_invoices WHERE id = ?').get(id) as Row;
  if (!pi) throw new Error('Proforma invoice not found');
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(pi.customer_id) as Row;
  const items = db.prepare('SELECT * FROM pi_items WHERE pi_id = ? ORDER BY sort_order, id').all(id) as Row[];
  const quotation = pi.quotation_id
    ? (db.prepare('SELECT number FROM quotations WHERE id = ?').get(pi.quotation_id) as Row | undefined)
    : undefined;

  const cur = pi.currency;
  const showTax = pi.tax_type !== 'none';
  const hasColor = items.some((i) => i.color);
  const hasPcs = items.some((i) => i.total_pcs != null);

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

  const header: Cell[] = [th(s, 'SL'), { ...th(s, 'Description of Goods'), alignment: 'left' }, th(s, 'Qty'), th(s, `Price ${cur}`)];
  const widths: any[] = [16, '*', 52, 46];
  if (hasColor) { header.push(th(s, 'Color')); widths.push(48); }
  if (hasPcs) { header.push(th(s, 'Total Qty (Pcs)'), th(s, `${cur}/1000 Pcs`)); widths.push(52, 46); }
  if (showTax) { header.push(th(s, 'Tax %')); widths.push(28); }
  header.push(th(s, `Amount (${cur})`)); widths.push(60);

  const body: Cell[][] = [header];
  items.forEach((it, i) => {
    const per1000 = it.total_pcs ? round2((it.amount / it.total_pcs) * 1000) : null;
    const row: Cell[] = [
      { text: String(i + 1), fontSize: 8, alignment: 'center' },
      { text: it.description + (it.hsn_code ? `\nHSN: ${it.hsn_code}` : ''), fontSize: 8 },
      { text: it.qty != null ? `${fmtNum(it.qty)} ${it.unit}` : '—', fontSize: 8, alignment: 'right' },
      { text: `${fmtNum(it.unit_price, 3)} /${it.unit === 'per 1000' ? '1000' : it.unit}`, fontSize: 8, alignment: 'right' },
    ];
    if (hasColor) row.push({ text: it.color || '—', fontSize: 8, alignment: 'center' });
    if (hasPcs) row.push(
      { text: fmtNum(it.total_pcs, 0), fontSize: 8, alignment: 'right' },
      { text: per1000 != null ? fmtNum(per1000, 2) : '—', fontSize: 8, alignment: 'right' },
    );
    if (showTax) row.push({ text: `${it.tax_pct ?? 0}%`, fontSize: 8, alignment: 'right' });
    row.push({ text: fmtMoney(it.amount, cur), fontSize: 8, alignment: 'right' });
    body.push(row.map((cell) => ({ ...cell, fillColor: i % 2 ? '#f7f5f4' : undefined })));
  });

  const grandLabel = pi.inco_terms && pi.port_of_discharge
    ? `TOTAL PRICE ${cur} ${pi.inco_terms} ${pi.port_of_discharge.split(',')[0].toUpperCase()}`
    : 'GRAND TOTAL';

  const content: Content[] = [
    ...companyHeader(s),
    docTitle(s, 'PROFORMA INVOICE'),
    infoGrid,
    { table: { headerRows: 1, widths, body }, layout: gridLayout },
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
  const s = getSettings();
  const inv = db.prepare('SELECT * FROM commercial_invoices WHERE id = ?').get(id) as Row;
  if (!inv) throw new Error('Invoice not found');
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(inv.customer_id) as Row;
  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id').all(id) as Row[];
  const pi = inv.pi_id ? (db.prepare('SELECT number, date, po_number, po_date FROM proforma_invoices WHERE id = ?').get(inv.pi_id) as Row | undefined) : undefined;

  const cur = inv.currency;
  const showTax = inv.tax_type !== 'none';
  const hasColor = items.some((i) => i.color);

  const paymentRows = (inv.pi_id
    ? db.prepare('SELECT amount FROM payments WHERE invoice_id = ? OR pi_id = ?').all(id, Number(inv.pi_id))
    : db.prepare('SELECT amount FROM payments WHERE invoice_id = ?').all(id)) as { amount: number }[];
  const received = round2(paymentRows.reduce((sum, p) => sum + p.amount, 0));

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

  const header: Cell[] = [th(s, 'SL'), { ...th(s, 'Description of Goods'), alignment: 'left' }, th(s, 'Quantity'), th(s, `Rate`)];
  const widths: any[] = [16, '*', 58, 55];
  if (hasColor) { header.push(th(s, 'Color')); widths.push(46); }
  header.push(th(s, 'HSN Code'));
  widths.push(45);
  if (showTax) { header.push(th(s, 'Tax %')); widths.push(28); }
  header.push(th(s, `Amount ${cur}${inv.inco_terms ? ` (${inv.inco_terms.split(' ')[0]})` : ''}`));
  widths.push(62);

  const body: Cell[][] = [header];
  items.forEach((it, i) => {
    const row: Cell[] = [
      { text: String(i + 1), fontSize: 8, alignment: 'center' },
      { text: it.description, fontSize: 8 },
      { text: it.qty != null ? `${fmtNum(it.qty)} ${it.unit}` : '—', fontSize: 8, alignment: 'right' },
      { text: `${fmtNum(it.unit_price, 3)}/${it.unit === 'per 1000' ? '1000' : it.unit}`, fontSize: 8, alignment: 'right' },
    ];
    if (hasColor) row.push({ text: it.color || '—', fontSize: 8, alignment: 'center' });
    row.push({ text: it.hsn_code || '—', fontSize: 8, alignment: 'center' });
    if (showTax) row.push({ text: `${it.tax_pct ?? 0}%`, fontSize: 8, alignment: 'right' });
    row.push({ text: fmtMoney(it.amount, cur), fontSize: 8, alignment: 'right' });
    body.push(row.map((cell) => ({ ...cell, fillColor: i % 2 ? '#f7f5f4' : undefined })));
  });

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
    { table: { headerRows: 1, widths, body }, layout: gridLayout },
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
  const s = getSettings();
  const pl = db.prepare('SELECT * FROM packing_lists WHERE id = ?').get(id) as Row;
  if (!pl) throw new Error('Packing list not found');
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

  const showThousand = items.some((it) => it.qty != null && ['unit', 'pcs'].includes((it.unit || '').toLowerCase()));

  const header: Cell[] = [
    th(s, 'SL'), { ...th(s, 'Description of Goods'), alignment: 'left' }, th(s, 'Qty in Boxes'), th(s, 'HSN Code'), th(s, 'Quantity'),
  ];
  const widths: any[] = [16, '*', 55, 45, 55];
  if (showThousand) { header.push(th(s, 'Thousand Pcs')); widths.push(48); }
  header.push(th(s, 'Net Wt (kg)'), th(s, 'Gross Wt (kg)'));
  widths.push(48, 48);

  const body: Cell[][] = [header];
  items.forEach((it, i) => {
    const row: Cell[] = [
      { text: String(i + 1), fontSize: 8, alignment: 'center' },
      { text: it.description + (it.dimensions ? `\nDim: ${it.dimensions}` : ''), fontSize: 8 },
      { text: it.packages || '—', fontSize: 8, alignment: 'center' },
      { text: it.hsn_code || '—', fontSize: 8, alignment: 'center' },
      { text: it.qty != null ? `${fmtNum(it.qty, 0)} ${it.unit === 'unit' ? 'pcs' : it.unit}` : '—', fontSize: 8, alignment: 'right' },
    ];
    if (showThousand) row.push({ text: it.qty != null && ['unit', 'pcs'].includes((it.unit || '').toLowerCase()) ? fmtNum(it.qty / 1000, 2) : '—', fontSize: 8, alignment: 'right' });
    row.push(
      { text: fmtNum(it.net_weight), fontSize: 8, alignment: 'right' },
      { text: fmtNum(it.gross_weight), fontSize: 8, alignment: 'right' },
    );
    body.push(row.map((cell) => ({ ...cell, fillColor: i % 2 ? '#f7f5f4' : undefined })));
  });

  // Totals row
  const totalRow: Cell[] = [
    { text: '', fontSize: 8 },
    { text: 'TOTAL', fontSize: 8, bold: true },
    { text: '', fontSize: 8 },
    { text: '', fontSize: 8 },
    { text: totalQty ? fmtNum(totalQty, 0) : '—', fontSize: 8, bold: true, alignment: 'right' },
  ];
  if (showThousand) totalRow.push({ text: totalQty ? fmtNum(totalQty / 1000, 2) : '—', fontSize: 8, bold: true, alignment: 'right' });
  totalRow.push(
    { text: fmtNum(totalNet), fontSize: 8, bold: true, alignment: 'right' },
    { text: fmtNum(totalGross), fontSize: 8, bold: true, alignment: 'right' },
  );
  body.push(totalRow.map((cell) => ({ ...cell, fillColor: '#efe9e7' })));

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
    { table: { headerRows: 1, widths, body }, layout: gridLayout },
    ...(pl.shipping_marks ? [{ text: `MARKS & NO.: ${pl.shipping_marks}`, fontSize: 8, bold: true, margin: [0, 8, 0, 0] as any }] : []),
    certFooter,
  ];
  return baseDoc(content);
}

export function renderPdf(docDefinition: TDocumentDefinitions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = printer.createPdfKitDocument(docDefinition);
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
