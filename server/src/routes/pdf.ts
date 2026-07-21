import { Router } from 'express';
import { db } from '../db/connection.js';
import { buildQuotationPdf, buildProformaPdf, buildInvoicePdf, buildPackingListPdf, renderPdf } from '../services/pdf.js';

export const pdfRouter = Router();

const builders = {
  quotation: { build: buildQuotationPdf, table: 'quotations' },
  proforma: { build: buildProformaPdf, table: 'proforma_invoices' },
  invoice: { build: buildInvoicePdf, table: 'commercial_invoices' },
  'packing-list': { build: buildPackingListPdf, table: 'packing_lists' },
} as const;

pdfRouter.get('/:type/:id', async (req, res) => {
  const entry = builders[req.params.type as keyof typeof builders];
  if (!entry) return res.status(404).json({ error: 'Unknown document type' });
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT number FROM ${entry.table} WHERE id = ?`).get(id) as { number: string } | undefined;
  if (!row) return res.status(404).json({ error: 'Document not found' });
  try {
    const buffer = await renderPdf(entry.build(id));
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
