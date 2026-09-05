import { Router } from 'express';
import { db } from '../db/connection.js';
import {
  buildQuotationPdf, buildOrderPdf, buildProformaPdf, buildInvoicePdf, buildPackingListPdf,
  buildInvoiceWithPackingPdf, buildPurchaseOrderPdf,
  buildQcReportPdf, buildOrderQcReportPdf, buildInvoiceQcReportPdf, buildInvoiceWithQcPdf,
  renderPdf,
} from '../services/pdf.js';
import { allows, type AuthedRequest } from '../middleware/auth.js';
import { canAccessCustomer } from '../middleware/scope.js';

export const pdfRouter = Router();

/*
 * Every entry names the **function** it belongs to, and that is not decoration.
 *
 * Until the five roles arrived, the only thing standing between somebody and
 * a quotation PDF was customer scope — this router has no list, no filter and
 * no guard of its own beyond `canAccessCustomer`. Scope was quietly doing
 * document-type duty. The moment Production and Logistics became unscoped,
 * `/api/pdf/quotation/:id` would have rendered every price the company has
 * ever quoted for anyone who could guess an id.
 */
const builders = {
  quotation: { build: buildQuotationPdf, table: 'quotations', approvable: true, fn: 'quotation' },
  // Orders record the customer's commitment rather than an outgoing offer,
  // so they carry no approval gate and no watermark.
  order: { build: buildOrderPdf, table: 'orders', approvable: false, fn: 'order' },
  proforma: { build: buildProformaPdf, table: 'proforma_invoices', approvable: true, fn: 'proforma' },
  invoice: { build: buildInvoicePdf, table: 'commercial_invoices', approvable: true, fn: 'invoice' },
  'packing-list': { build: buildPackingListPdf, table: 'packing_lists', approvable: false, fn: 'packing_list' },
  // Invoice + its packing list in one file; approval follows the invoice.
  'invoice-with-packing': { build: buildInvoiceWithPackingPdf, table: 'commercial_invoices', approvable: true, fn: 'invoice' },
  /*
   * The one document here addressed to a supplier rather than a customer.
   *
   * Both fields are load-bearing. `purchase_orders` has no `customer_id`, so
   * the customer join below would throw on it; and `/api/pdf` is mounted with
   * `requireAuth` alone while the purchase order module is mounted behind
   * `purchasing` — registering this without its own `fn` would publish every
   * supplier rate through a route nobody thinks of as part of that module.
   */
  'purchase-order': {
    build: buildPurchaseOrderPdf, table: 'purchase_orders', approvable: false,
    party: 'supplier', fn: 'purchasing',
  },
  /*
   * The quality reports, and the one place `partySql` earns its keep.
   *
   * These hang off a work order rather than off a document with a
   * `customer_id` of its own, so neither the customer join nor the supplier
   * one fits. Naming the query per entry generalises what `party: 'supplier'`
   * was already doing by hand, instead of adding a third special case — and it
   * still has to return `number`, `customer_id` and `party_name`, because the
   * filename and the scope check are built from those three.
   */
  'qc-report': {
    build: buildQcReportPdf, table: 'work_orders', approvable: false, fn: 'qc',
    partySql: `SELECT w.number, o.customer_id, c.name AS party_name
                 FROM work_orders w
                 JOIN orders o ON o.id = w.order_id
                 JOIN customers c ON c.id = o.customer_id
                WHERE w.id = ?`,
  },
  'order-qc-report': {
    build: buildOrderQcReportPdf, table: 'orders', approvable: false, fn: 'qc',
  },
  'invoice-qc-report': {
    build: buildInvoiceQcReportPdf, table: 'commercial_invoices', approvable: false, fn: 'qc',
  },
  // The invoice and its quality summary in one file. Approval follows the
  // invoice, as it does for the invoice-and-packing-list pair.
  'invoice-with-qc': {
    build: buildInvoiceWithQcPdf, table: 'commercial_invoices', approvable: true, fn: 'invoice',
  },
} as const;

type DocType = keyof typeof builders;

/**
 * What the file is called once it leaves the app.
 *
 * It used to be the document number with every punctuation mark flattened —
 * `AGLO_PI_26-27_001.pdf` — which is unambiguous inside the office and opaque
 * everywhere else, the customer's inbox included. The name now leads with what
 * the document *is* and who it is for, and keeps the number, which is the part
 * that has to stay unique.
 */
const DOC_LABEL: Record<DocType, string> = {
  quotation: 'Quotation',
  order: 'Order',
  proforma: 'Proforma Invoice',
  invoice: 'Commercial Invoice',
  'packing-list': 'Packing List',
  'invoice-with-packing': 'Commercial Invoice & Packing List',
  'purchase-order': 'Purchase Order',
  'qc-report': 'Quality Report',
  'order-qc-report': 'Quality Report',
  'invoice-qc-report': 'Quality Report',
  'invoice-with-qc': 'Commercial Invoice & Quality Report',
};

/*
 * Windows refuses \ / : * ? " < > | in a filename outright, and a name ending
 * in a dot or a space quietly loses its extension — so those are stripped
 * rather than substituted. A slash becomes a hyphen, so AGLO/PI/26-27/001 is
 * still legible as one number. Spaces are kept, since the header quotes the
 * name and the office writes these with spaces anyway.
 */
function safePart(v: string): string {
  return v
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
}

function pdfFilename(parts: (string | undefined)[]): string {
  // Capped, because a long customer name beside a long number can outrun what
  // some mail clients will accept as an attachment.
  const name = parts.map((p) => safePart(p ?? '')).filter(Boolean).join('_').slice(0, 150);
  return `${name || 'document'}.pdf`;
}

/*
 * A customer's name may carry anything — an accent, a Devanagari word — and a
 * bare `filename=` is ASCII only. So that one gets a lossy fallback and the
 * real name rides in `filename*` (RFC 5987), which browsers have preferred
 * over it for a decade.
 */
function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\u0020-\u007e]/g, '_').replace(/"/g, '');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/*
 * The name is in the **URL** as well as in the header, and the optional last
 * segment is why.
 *
 * `Content-Disposition` is the right answer and every browser honours it on a
 * download. But these open *inline*, in a tab, and a PDF viewer that builds its
 * Save name from the address bar instead sees `/api/pdf/quotation/5` — whose
 * last segment is a bare id. That is the "file name is coming as a number" the
 * user reported, and no amount of getting the header right fixes it.
 *
 * So a request with no name segment is redirected to one that has it. The
 * redirect rather than a filename built by the client, because the name is
 * assembled here from the customer and the number, and a second copy of that
 * on the client is how the two come to disagree. It costs one round trip and
 * happens *before* the document is rendered, which is the expensive part.
 */
pdfRouter.get('/:type/:id/:name?', async (req: AuthedRequest, res) => {
  const type = req.params.type as DocType;
  const entry = builders[type];
  if (!entry) return res.status(404).json({ error: 'Unknown document type' });
  const id = Number(req.params.id);
  // 404 rather than 403 throughout, so an id cannot be probed for — the rule
  // every out-of-scope read in this app follows. A supplier document has no
  // customer to join or to scope by, and is guarded by its function alone.
  const supplierSide = 'party' in entry && entry.party === 'supplier';
  if (!allows(req, entry.fn)) return res.status(404).json({ error: 'Document not found' });
  const row = db.prepare(
    'partySql' in entry && entry.partySql
      ? entry.partySql
      : supplierSide
        ? `SELECT d.number, NULL AS customer_id, s.name AS party_name
             FROM ${entry.table} d LEFT JOIN suppliers s ON s.id = d.supplier_id
            WHERE d.id = ?`
        : `SELECT d.number, d.customer_id, c.name AS party_name
             FROM ${entry.table} d LEFT JOIN customers c ON c.id = d.customer_id
            WHERE d.id = ?`
  ).get(id) as { number: string; customer_id: number | null; party_name: string | null } | undefined;
  if (!row) return res.status(404).json({ error: 'Document not found' });
  if (!supplierSide && !canAccessCustomer(req, row.customer_id as number)) {
    return res.status(404).json({ error: 'Document not found' });
  }

  // Revisions share one number, so without this the second one saved to a
  // folder overwrites the first. Only quotations have the column.
  let revision: string | undefined;
  if (type === 'quotation') {
    const r = db.prepare('SELECT revision FROM quotations WHERE id = ?').get(id) as { revision: number };
    // Numbered the way the list labels them: the first round is 0 and prints
    // nothing, the first renegotiation is R1.
    if (r && r.revision > 0) revision = `R${r.revision}`;
  }

  const filename = pdfFilename([DOC_LABEL[type], row.party_name ?? undefined, row.number, revision]);

  // Put the name in the address bar, then render on the way back. Done here,
  // before the document is built, so the extra hop costs a query and not a
  // render — and after the access checks, so it cannot confirm that an id
  // exists to somebody who may not see it.
  if (!req.params.name) {
    const query = req.originalUrl.split('?')[1];
    return res.redirect(302, `/api/pdf/${type}/${id}/${encodeURIComponent(filename)}${query ? `?${query}` : ''}`);
  }

  // Documents that have not been approved are watermarked, so an unapproved
  // draft can be previewed but never passed off as a final document.
  let watermark: string | undefined;
  if (entry.approvable) {
    const appr = db.prepare(`SELECT approval_status FROM ${entry.table} WHERE id = ?`).get(id) as { approval_status: string };
    if (appr.approval_status !== 'approved') {
      watermark = appr.approval_status === 'pending' ? 'PENDING APPROVAL' : 'DRAFT — NOT APPROVED';
    }
  }

  try {
    const buffer = await renderPdf(entry.build(id), watermark);
    res.setHeader('Content-Type', 'application/pdf');
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', contentDisposition(disposition, filename));
    res.send(buffer);
  } catch (err) {
    console.error('PDF generation failed:', err);
    res.status(500).json({ error: 'PDF generation failed' });
  }
});
