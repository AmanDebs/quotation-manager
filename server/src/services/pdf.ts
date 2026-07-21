import PdfPrinter from 'pdfmake';
import pdfFonts from 'pdfmake/build/vfs_fonts.js';
import type { TDocumentDefinitions, Content, ContentTable } from 'pdfmake/interfaces';
import { db } from '../db/connection.js';
import { amountInWords } from './amountInWords.js';

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

const currencySymbols: Record<string, string> = { INR: '₹', USD: '$', EUR: '€' };

function fmtMoney(n: number, currency: string): string {
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  return `${currencySymbols[currency] ?? currency + ' '}${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n || 0)}`;
}

function fmtQty(n: number | null): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 }).format(n);
}

function fmtDate(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function getSettings(): Row {
  const s = db.prepare('SELECT * FROM settings WHERE id = 1').get() as Row;
  s.bank_accounts = JSON.parse(s.bank_accounts || '[]');
  return s;
}

const line = (label: string, value: string): Content => ({
  columns: [
    { text: label, width: 95, bold: true, fontSize: 8 },
    { text: value || '—', fontSize: 8 },
  ],
  margin: [0, 1, 0, 1] as [number, number, number, number],
});

function companyHeader(s: Row, title: string): Content[] {
  const left: Content[] = [
    { text: s.company_name || 'Company Name', fontSize: 16, bold: true, color: '#1a3a5c' },
    { text: [s.address, [s.city, s.state, s.pincode].filter(Boolean).join(', '), s.country].filter(Boolean).join('\n'), fontSize: 8, margin: [0, 2, 0, 0] },
    { text: [s.phone && `Phone: ${s.phone}`, s.email && `Email: ${s.email}`, s.website].filter(Boolean).join('  |  '), fontSize: 8, margin: [0, 2, 0, 0] },
    { text: [s.gstin && `GSTIN: ${s.gstin}`, s.pan && `PAN: ${s.pan}`, s.iec && `IEC: ${s.iec}`].filter(Boolean).join('  |  '), fontSize: 8, margin: [0, 2, 0, 0] },
  ];
  const cols: Content = s.logo
    ? { columns: [{ stack: left, width: '*' }, { image: s.logo, fit: [90, 55], alignment: 'right', width: 100 }] }
    : { stack: left };
  return [
    cols,
    { canvas: [{ type: 'line', x1: 0, y1: 4, x2: 515, y2: 4, lineWidth: 1.5, lineColor: '#1a3a5c' }] },
    { text: title, fontSize: 13, bold: true, alignment: 'center', margin: [0, 10, 0, 8], color: '#1a3a5c' },
  ];
}

function partiesBlock(blocks: { title: string; body: string }[]): Content {
  const widths = blocks.map(() => '*');
  return {
    table: {
      widths,
      body: [
        blocks.map((b) => ({ text: b.title, bold: true, fontSize: 8, fillColor: '#eef2f7' })),
        blocks.map((b) => ({ text: b.body || '—', fontSize: 8 })),
      ],
    },
    layout: { hLineColor: '#b9c4d0', vLineColor: '#b9c4d0', hLineWidth: () => 0.5, vLineWidth: () => 0.5 },
    margin: [0, 0, 0, 8] as [number, number, number, number],
  };
}

function itemsTable(items: Row[], currency: string, opts: { showTax: boolean; showHsn: boolean }): ContentTable {
  const header = ['#', 'Description', ...(opts.showHsn ? ['HSN'] : []), 'Qty', 'Unit', 'Unit Price', ...(opts.showTax ? ['Tax %'] : []), 'Amount'];
  const widths = [16, '*', ...(opts.showHsn ? [40] : []), 45, 38, 62, ...(opts.showTax ? [32] : []), 68];
  const body: any[][] = [
    header.map((h) => ({ text: h, bold: true, fontSize: 8, fillColor: '#1a3a5c', color: '#ffffff' })),
    ...items.map((it, i) => [
      { text: String(i + 1), fontSize: 8, alignment: 'center' },
      { text: it.description, fontSize: 8 },
      ...(opts.showHsn ? [{ text: it.hsn_code || '—', fontSize: 8, alignment: 'center' }] : []),
      { text: fmtQty(it.qty), fontSize: 8, alignment: 'right' },
      { text: it.unit, fontSize: 8, alignment: 'center' },
      { text: fmtMoney(it.unit_price, currency), fontSize: 8, alignment: 'right' },
      ...(opts.showTax ? [{ text: `${it.tax_pct ?? 0}%`, fontSize: 8, alignment: 'right' }] : []),
      { text: it.qty != null ? fmtMoney(it.amount, currency) : '—', fontSize: 8, alignment: 'right' },
    ]),
  ];
  return {
    table: { headerRows: 1, widths, body },
    layout: {
      hLineColor: '#b9c4d0', vLineColor: '#b9c4d0', hLineWidth: () => 0.5, vLineWidth: () => 0.5,
      paddingTop: () => 3, paddingBottom: () => 3,
    },
  } as ContentTable;
}

function totalsBlock(doc: Row, currency: string, extraRows: [string, string][] = []): Content {
  const rows: [string, string][] = [['Subtotal', fmtMoney(doc.subtotal, currency)]];
  if (Number(doc.freight)) rows.push(['Freight', fmtMoney(doc.freight, currency)]);
  if (Number(doc.insurance)) rows.push(['Insurance', fmtMoney(doc.insurance, currency)]);
  if (doc.tax_type === 'cgst_sgst' && doc.tax_total > 0) {
    rows.push(['CGST', fmtMoney(doc.tax_total / 2, currency)], ['SGST', fmtMoney(doc.tax_total / 2, currency)]);
  } else if (doc.tax_type === 'igst' && doc.tax_total > 0) {
    rows.push(['IGST', fmtMoney(doc.tax_total, currency)]);
  }
  rows.push(['Grand Total', fmtMoney(doc.grand_total, currency)]);
  rows.push(...extraRows);
  return {
    columns: [
      { text: '', width: '*' },
      {
        table: {
          widths: [90, 80],
          body: rows.map(([label, value]) => {
            const emphasized = label === 'Grand Total' || label === 'Balance Due';
            return [
              { text: label, bold: emphasized, fontSize: 8, fillColor: emphasized ? '#eef2f7' : undefined },
              { text: value, bold: emphasized, fontSize: 8, alignment: 'right' as const, fillColor: emphasized ? '#eef2f7' : undefined },
            ];
          }),
        },
        layout: { hLineColor: '#b9c4d0', vLineColor: '#b9c4d0', hLineWidth: () => 0.5, vLineWidth: () => 0.5 },
        width: 'auto',
      },
    ],
    margin: [0, 6, 0, 0] as [number, number, number, number],
  };
}

function signatureBlock(s: Row, forCompany = true): Content {
  return {
    columns: [
      { text: '', width: '*' },
      {
        stack: [
          { text: `For ${s.company_name || 'Company'}`, fontSize: 8, bold: true, margin: [0, 20, 0, 0] as [number, number, number, number] },
          ...(s.signature
            ? [{ image: s.signature, fit: [110, 45] as [number, number], margin: [0, 4, 0, 4] as [number, number, number, number] }]
            : [{ text: ' ', margin: [0, 28, 0, 0] as [number, number, number, number] }]),
          { text: 'Authorised Signatory', fontSize: 8 },
        ],
        width: 160,
        alignment: 'left' as const,
      },
    ],
    margin: [0, 14, 0, 0] as [number, number, number, number],
  };
}

function bankBlock(bankAccount: string): Content[] {
  if (!bankAccount) return [];
  return [
    { text: 'Bank Details', bold: true, fontSize: 9, margin: [0, 8, 0, 2], color: '#1a3a5c' },
    { text: bankAccount, fontSize: 8 },
  ];
}

function notesBlock(title: string, text: string): Content[] {
  if (!text) return [];
  return [
    { text: title, bold: true, fontSize: 9, margin: [0, 8, 0, 2], color: '#1a3a5c' },
    { text, fontSize: 8 },
  ];
}

function customerAddress(c: Row): string {
  return [c.name, c.contact_person && `Attn: ${c.contact_person}`, c.address, [c.city, c.country].filter(Boolean).join(', '),
    c.gstin && `GSTIN: ${c.gstin}`, c.phone && `Phone: ${c.phone}`, c.email && `Email: ${c.email}`]
    .filter(Boolean).join('\n');
}

function baseDoc(content: Content[]): TDocumentDefinitions {
  return {
    pageSize: 'A4',
    pageMargins: [40, 36, 40, 44],
    content,
    footer: (currentPage, pageCount) => ({
      text: `Page ${currentPage} of ${pageCount}`, alignment: 'center', fontSize: 7, color: '#8899aa',
    }),
    defaultStyle: { fontSize: 9 },
  };
}

export function buildQuotationPdf(id: number): TDocumentDefinitions {
  const s = getSettings();
  const q = db.prepare('SELECT * FROM quotations WHERE id = ?').get(id) as Row;
  if (!q) throw new Error('Quotation not found');
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(q.customer_id) as Row;
  const items = db.prepare('SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY sort_order, id').all(id) as Row[];
  const showTax = q.tax_type !== 'none';
  const hasQty = items.some((it) => it.qty != null);

  const content: Content[] = [
    ...companyHeader(s, 'QUOTATION'),
    partiesBlock([
      { title: 'To', body: customerAddress(c) },
      { title: 'Quotation Details', body: [
        `Number: ${q.number}${q.revision ? ` (Rev. ${q.revision})` : ''}`,
        `Date: ${fmtDate(q.date)}`,
        q.validity_date && `Valid Until: ${fmtDate(q.validity_date)}`,
        `Currency: ${q.currency}`,
      ].filter(Boolean).join('\n') },
    ]),
    itemsTable(items, q.currency, { showTax, showHsn: items.some((i) => i.hsn_code) }),
    ...(hasQty ? [totalsBlock(q, q.currency),
      { text: `Amount in Words: ${amountInWords(q.grand_total, q.currency)}`, fontSize: 8, italics: true, margin: [0, 4, 0, 0] as [number, number, number, number] }]
      : [{ text: 'Note: Quantities to be confirmed by the customer. Prices are per unit as stated above.', fontSize: 8, italics: true, margin: [0, 6, 0, 0] as [number, number, number, number] }]),
    { columns: [
      { stack: [
        ...(q.payment_terms ? [line('Payment Terms', q.payment_terms)] : []),
        ...(q.delivery_terms ? [line('Delivery Timeline', q.delivery_terms)] : []),
        ...(q.validity_date ? [line('Validity', `This quotation is valid until ${fmtDate(q.validity_date)}`)] : []),
      ], width: '*', margin: [0, 8, 0, 0] as [number, number, number, number] },
    ] },
    ...notesBlock('Notes', q.notes),
    ...notesBlock('Terms & Conditions', s.default_terms),
    signatureBlock(s),
  ];
  return baseDoc(content);
}

function exportMeta(doc: Row): Content[] {
  if (!Number(doc.is_export)) return [];
  return [{
    table: {
      widths: ['*', '*', '*'],
      body: [
        [
          { text: `Country of Origin: ${doc.country_of_origin || '—'}`, fontSize: 8 },
          { text: `Port of Loading: ${doc.port_of_loading || '—'}`, fontSize: 8 },
          { text: `Port of Discharge: ${doc.port_of_discharge || '—'}`, fontSize: 8 },
        ],
        [
          { text: `Final Destination: ${doc.final_destination || '—'}`, fontSize: 8 },
          { text: doc.container_count != null ? `Containers: ${doc.container_count || '—'}` : `INCO Terms: ${doc.inco_terms || '—'}`, fontSize: 8 },
          { text: doc.partial_shipment != null ? `Partial Shipment: ${doc.partial_shipment}` : '', fontSize: 8 },
        ],
      ],
    },
    layout: { hLineColor: '#b9c4d0', vLineColor: '#b9c4d0', hLineWidth: () => 0.5, vLineWidth: () => 0.5 },
    margin: [0, 0, 0, 8] as [number, number, number, number],
  }];
}

export function buildProformaPdf(id: number): TDocumentDefinitions {
  const s = getSettings();
  const pi = db.prepare('SELECT * FROM proforma_invoices WHERE id = ?').get(id) as Row;
  if (!pi) throw new Error('Proforma invoice not found');
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(pi.customer_id) as Row;
  const items = db.prepare('SELECT * FROM pi_items WHERE pi_id = ? ORDER BY sort_order, id').all(id) as Row[];
  const quotation = pi.quotation_id
    ? (db.prepare('SELECT number FROM quotations WHERE id = ?').get(pi.quotation_id) as Row | undefined)
    : undefined;

  const parties: { title: string; body: string }[] = [{ title: 'Buyer', body: customerAddress(c) }];
  if (pi.consignee) parties.push({ title: 'Consignee', body: pi.consignee });
  if (pi.notify_party) parties.push({ title: 'Notify Party', body: pi.notify_party });

  const content: Content[] = [
    ...companyHeader(s, 'PROFORMA INVOICE'),
    partiesBlock(parties),
    partiesBlock([
      { title: 'Proforma Invoice Details', body: [
        `Number: ${pi.number}`, `Date: ${fmtDate(pi.date)}`,
        quotation && `Ref. Quotation: ${quotation.number}`,
        pi.po_number && `Buyer PO: ${pi.po_number}${pi.po_date ? ` dt. ${fmtDate(pi.po_date)}` : ''}`,
        pi.validity_date && `Valid Until: ${fmtDate(pi.validity_date)}`,
      ].filter(Boolean).join('\n') },
      { title: 'Commercial Terms', body: [
        `Currency: ${pi.currency}`,
        pi.inco_terms && `INCO Terms: ${pi.inco_terms}`,
        pi.payment_terms && `Payment: ${pi.payment_terms}`,
        pi.delivery_terms && `Delivery: ${pi.delivery_terms}`,
        pi.lead_time && `Production Lead Time: ${pi.lead_time}`,
      ].filter(Boolean).join('\n') },
    ]),
    ...exportMeta(pi),
    itemsTable(items, pi.currency, { showTax: pi.tax_type !== 'none', showHsn: true }),
    totalsBlock(pi, pi.currency),
    { text: `Amount in Words: ${amountInWords(pi.grand_total, pi.currency)}`, fontSize: 8, italics: true, margin: [0, 4, 0, 0] },
    ...bankBlock(pi.bank_account),
    ...notesBlock('Remarks', pi.remarks),
    ...notesBlock('Terms & Conditions', s.default_terms),
    { columns: [
      { stack: [
        { text: 'Accepted by Buyer', fontSize: 8, bold: true, margin: [0, 34, 0, 0] as [number, number, number, number] },
        { text: '(Signature & Stamp)', fontSize: 7, color: '#8899aa' },
      ], width: 160 },
      signatureBlock(s),
    ] },
  ];
  return baseDoc(content);
}

export function buildInvoicePdf(id: number): TDocumentDefinitions {
  const s = getSettings();
  const inv = db.prepare('SELECT * FROM commercial_invoices WHERE id = ?').get(id) as Row;
  if (!inv) throw new Error('Invoice not found');
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(inv.customer_id) as Row;
  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id').all(id) as Row[];
  const pi = inv.pi_id ? (db.prepare('SELECT number FROM proforma_invoices WHERE id = ?').get(inv.pi_id) as Row | undefined) : undefined;

  const parties: { title: string; body: string }[] = [{ title: 'Buyer', body: customerAddress(c) }];
  if (inv.consignee) parties.push({ title: 'Consignee', body: inv.consignee });
  if (inv.notify_party) parties.push({ title: 'Notify Party', body: inv.notify_party });

  // Advances on the source PI plus payments on this invoice reduce the balance due.
  const paymentRows = (inv.pi_id
    ? db.prepare('SELECT amount FROM payments WHERE invoice_id = ? OR pi_id = ?').all(id, Number(inv.pi_id))
    : db.prepare('SELECT amount FROM payments WHERE invoice_id = ?').all(id)) as { amount: number }[];
  const received = Math.round(paymentRows.reduce((sum, p) => sum + p.amount, 0) * 100) / 100;
  const extraRows: [string, string][] = received > 0
    ? [
        ['Amount Received', fmtMoney(received, inv.currency)],
        ['Balance Due', fmtMoney(Math.max(0, Math.round((inv.grand_total - received) * 100) / 100), inv.currency)],
      ]
    : [];

  const content: Content[] = [
    ...companyHeader(s, 'COMMERCIAL INVOICE'),
    partiesBlock(parties),
    partiesBlock([
      { title: 'Invoice Details', body: [
        `Number: ${inv.number}`, `Date: ${fmtDate(inv.date)}`,
        pi && `Ref. Proforma Invoice: ${pi.number}`,
      ].filter(Boolean).join('\n') },
      { title: 'Terms & Shipping', body: [
        `Currency: ${inv.currency}`,
        inv.inco_terms && `INCO Terms: ${inv.inco_terms}`,
        inv.payment_terms && `Payment: ${inv.payment_terms}`,
        inv.shipping_details && `Shipping: ${inv.shipping_details}`,
      ].filter(Boolean).join('\n') },
    ]),
    ...exportMeta({ ...inv, container_count: null, partial_shipment: null }),
    itemsTable(items, inv.currency, { showTax: inv.tax_type !== 'none', showHsn: true }),
    totalsBlock(inv, inv.currency, extraRows),
    { text: `Amount in Words: ${amountInWords(inv.grand_total, inv.currency)}`, fontSize: 8, italics: true, margin: [0, 4, 0, 0] },
    ...bankBlock(inv.bank_account),
    ...notesBlock('Remarks', inv.remarks),
    ...notesBlock('Terms & Conditions', s.default_terms),
    signatureBlock(s),
  ];
  return baseDoc(content);
}

export function buildPackingListPdf(id: number): TDocumentDefinitions {
  const s = getSettings();
  const pl = db.prepare('SELECT * FROM packing_lists WHERE id = ?').get(id) as Row;
  if (!pl) throw new Error('Packing list not found');
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(pl.customer_id) as Row;
  const items = db.prepare('SELECT * FROM packing_list_items WHERE packing_list_id = ? ORDER BY sort_order, id').all(id) as Row[];
  const inv = pl.invoice_id ? (db.prepare('SELECT number FROM commercial_invoices WHERE id = ?').get(pl.invoice_id) as Row | undefined) : undefined;

  const totalGross = items.reduce((sum, it) => sum + (it.gross_weight || 0), 0);
  const totalNet = items.reduce((sum, it) => sum + (it.net_weight || 0), 0);

  const body: any[][] = [
    ['#', 'Description', 'Qty', 'Unit', 'Packages', 'Dimensions', 'Net Wt (kg)', 'Gross Wt (kg)'].map((h) => ({
      text: h, bold: true, fontSize: 8, fillColor: '#1a3a5c', color: '#ffffff',
    })),
    ...items.map((it, i) => [
      { text: String(i + 1), fontSize: 8, alignment: 'center' },
      { text: it.description, fontSize: 8 },
      { text: fmtQty(it.qty), fontSize: 8, alignment: 'right' },
      { text: it.unit, fontSize: 8, alignment: 'center' },
      { text: it.packages || '—', fontSize: 8, alignment: 'center' },
      { text: it.dimensions || '—', fontSize: 8, alignment: 'center' },
      { text: fmtQty(it.net_weight), fontSize: 8, alignment: 'right' },
      { text: fmtQty(it.gross_weight), fontSize: 8, alignment: 'right' },
    ]),
    [
      { text: 'Total', bold: true, fontSize: 8, colSpan: 6 }, {}, {}, {}, {}, {},
      { text: fmtQty(totalNet), bold: true, fontSize: 8, alignment: 'right' },
      { text: fmtQty(totalGross), bold: true, fontSize: 8, alignment: 'right' },
    ],
  ];

  const content: Content[] = [
    ...companyHeader(s, 'PACKING LIST'),
    partiesBlock([
      { title: 'Buyer', body: customerAddress(c) },
      { title: 'Packing List Details', body: [
        `Number: ${pl.number}`, `Date: ${fmtDate(pl.date)}`,
        inv && `Ref. Invoice: ${inv.number}`,
      ].filter(Boolean).join('\n') },
    ]),
    {
      table: { headerRows: 1, widths: [16, '*', 40, 34, 50, 60, 52, 52], body },
      layout: {
        hLineColor: '#b9c4d0', vLineColor: '#b9c4d0', hLineWidth: () => 0.5, vLineWidth: () => 0.5,
        paddingTop: () => 3, paddingBottom: () => 3,
      },
    },
    ...(pl.shipping_marks ? notesBlock('Shipping Marks', pl.shipping_marks) : []),
    ...notesBlock('Remarks', pl.remarks),
    signatureBlock(s),
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
