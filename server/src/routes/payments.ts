import { Router } from 'express';
import { db } from '../db/connection.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { canAccessCustomer } from '../middleware/scope.js';
import { syncInvoicesForPayment } from '../services/invoiceStatus.js';

export const paymentsRouter = Router();

paymentsRouter.post('/', (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  const amount = Number(body.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero' });
  if (!body.pi_id && !body.invoice_id) return res.status(400).json({ error: 'Payment must be linked to a proforma or an invoice' });

  // Inherit customer/currency from the linked document. A payment is only
  // recordable by someone who may see that document, so out-of-scope ids read
  // as "not found" exactly like the document routes.
  let customerId: number | null = null;
  let currency = 'INR';
  if (body.invoice_id) {
    const inv = db.prepare('SELECT customer_id, currency FROM commercial_invoices WHERE id = ?').get(Number(body.invoice_id)) as
      | { customer_id: number; currency: string } | undefined;
    if (!inv || !canAccessCustomer(req, inv.customer_id)) return res.status(404).json({ error: 'Invoice not found' });
    customerId = inv.customer_id;
    currency = inv.currency;
  } else if (body.pi_id) {
    const pi = db.prepare('SELECT customer_id, currency FROM proforma_invoices WHERE id = ?').get(Number(body.pi_id)) as
      | { customer_id: number; currency: string } | undefined;
    if (!pi || !canAccessCustomer(req, pi.customer_id)) return res.status(404).json({ error: 'Proforma invoice not found' });
    customerId = pi.customer_id;
    currency = pi.currency;
  }

  const info = db.prepare(
    `INSERT INTO payments (pi_id, invoice_id, customer_id, date, amount, currency, method, reference, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    body.pi_id ? Number(body.pi_id) : null,
    body.invoice_id ? Number(body.invoice_id) : null,
    customerId,
    String(body.date ?? new Date().toISOString().slice(0, 10)),
    amount,
    currency,
    String(body.method ?? ''),
    String(body.reference ?? ''),
    String(body.notes ?? '')
  );
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(info.lastInsertRowid)) as
    { invoice_id: number | null; pi_id: number | null };
  // Being paid is a fact about the invoice, so its status follows it. An
  // advance moves every invoice raised from that proforma, not just one.
  syncInvoicesForPayment(payment);
  res.status(201).json(payment);
});

paymentsRouter.delete('/:id', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const payment = db.prepare('SELECT customer_id, invoice_id, pi_id FROM payments WHERE id = ?').get(id) as
    | { customer_id: number | null; invoice_id: number | null; pi_id: number | null } | undefined;
  if (!payment || !canAccessCustomer(req, payment.customer_id)) return res.status(404).json({ error: 'Payment not found' });
  db.prepare('DELETE FROM payments WHERE id = ?').run(id);
  // Deleting a mis-keyed payment reopens the balance, so anything it had marked
  // paid goes back to what it was. Read the links before the row is gone.
  syncInvoicesForPayment(payment);
  res.json({ ok: true });
});
