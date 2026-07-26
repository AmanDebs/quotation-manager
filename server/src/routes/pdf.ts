import { Router } from 'express';
import { db } from '../db/connection.js';
import { buildQuotationPdf, buildProformaPdf, buildInvoicePdf, buildPackingListPdf, buildInvoiceWithPackingPdf, renderPdf } from '../services/pdf.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { canAccessCustomer } from '../middleware/scope.js';

export const pdfRouter = Router();

const builders = {
  quotation: { build: buildQuotationPdf, table: 'quotations', approvable: true },
  proforma: { build: buildProformaPdf, table: 'proforma_invoices', approvable: true },
  invoice: { build: buildInvoicePdf, table: 'commercial_invoices', approvable: true },
  'packing-list': { build: buildPackingListPdf, table: 'packing_lists', approvable: false },
  // Invoice + its packing list in one file; approval follows the invoice.
  'invoice-with-packing': { build: buildInvoiceWithPackingPdf, table: 'commercial_invoices', approvable: true },
} as const;

pdfRouter.get('/:type/:id', async (req: AuthedRequest, res) => {
  const entry = builders[req.params.type as keyof typeof builders];
  if (!entry) return res.status(404).json({ error: 'Unknown document type' });
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT number, customer_id FROM ${entry.table} WHERE id = ?`).get(id) as
    | { number: string; customer_id: number }
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

  try {
    const buffer = await renderPdf(entry.build(id), watermark);
    const filename = `${row.number.replace(/[^\w\-]/g, '_')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('PDF generation failed:', err);
    res.status(500).json({ error: 'PDF generation failed' });
  }
});
