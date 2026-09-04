import { Router } from 'express';
import { db } from '../db/connection.js';
import { buildQuotationPdf, buildOrderPdf, buildProformaPdf, buildInvoicePdf, buildPackingListPdf, buildInvoiceWithPackingPdf, renderPdf } from '../services/pdf.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { canAccessCustomer } from '../middleware/scope.js';

export const pdfRouter = Router();

const builders = {
  quotation: { build: buildQuotationPdf, table: 'quotations', approvable: true },
  // Orders record the customer's commitment rather than an outgoing offer,
  // so they carry no approval gate and no watermark.
  order: { build: buildOrderPdf, table: 'orders', approvable: false },
  proforma: { build: buildProformaPdf, table: 'proforma_invoices', approvable: true },
  invoice: { build: buildInvoicePdf, table: 'commercial_invoices', approvable: true },
  'packing-list': { build: buildPackingListPdf, table: 'packing_lists', approvable: false },
  // Invoice + its packing list in one file; approval follows the invoice.
  'invoice-with-packing': { build: buildInvoiceWithPackingPdf, table: 'commercial_invoices', approvable: true },
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

pdfRouter.get('/:type/:id', async (req: AuthedRequest, res) => {
  const type = req.params.type as DocType;
  const entry = builders[type];
  if (!entry) return res.status(404).json({ error: 'Unknown document type' });
  const id = Number(req.params.id);
  const row = db.prepare(`
    SELECT d.number, d.customer_id, c.name AS customer_name
      FROM ${entry.table} d LEFT JOIN customers c ON c.id = d.customer_id
     WHERE d.id = ?`).get(id) as
    | { number: string; customer_id: number; customer_name: string | null }
    | undefined;
  if (!row || !canAccessCustomer(req, row.customer_id)) return res.status(404).json({ error: 'Document not found' });

  // Documents that have not been approved are watermarked, so an unapproved
  // draft can be previewed but never passed off as a final document.
  let watermark: string | undefined;
  if (entry.approvable) {
    const appr = db.prepare(`SELECT approval_status FROM ${entry.table} WHERE id = ?`).get(id) as { approval_status: string };
    if (appr.approval_status !== 'approved') {
      watermark = appr.approval_status === 'pending' ? 'PENDING APPROVAL' : 'DRAFT — NOT APPROVED';
    }
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

  try {
    const buffer = await renderPdf(entry.build(id), watermark);
    const filename = pdfFilename([DOC_LABEL[type], row.customer_name ?? undefined, row.number, revision]);
    res.setHeader('Content-Type', 'application/pdf');
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', contentDisposition(disposition, filename));
    res.send(buffer);
  } catch (err) {
    console.error('PDF generation failed:', err);
    res.status(500).json({ error: 'PDF generation failed' });
  }
});
