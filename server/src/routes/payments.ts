import { Router } from 'express';
import { db } from '../db/connection.js';

export const paymentsRouter = Router();

paymentsRouter.post('/', (req, res) => {
  const body = req.body ?? {};
  const amount = Number(body.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero' });
  if (!body.pi_id && !body.invoice_id) return res.status(400).json({ error: 'Payment must be linked to a proforma or an invoice' });

  // Inherit customer/currency from the linked document.
  let customerId: number | null = null;
  let currency = 'INR';
  if (body.invoice_id) {
    const inv = db.prepare('SELECT customer_id, currency FROM commercial_invoices WHERE id = ?').get(Number(body.invoice_id)) as
      | { customer_id: number; currency: string } | undefined;
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    customerId = inv.customer_id;
    currency = inv.currency;
  } else if (body.pi_id) {
    const pi = db.prepare('SELECT customer_id, currency FROM proforma_invoices WHERE id = ?').get(Number(body.pi_id)) as
      | { customer_id: number; currency: string } | undefined;
    if (!pi) return res.status(404).json({ error: 'Proforma invoice not found' });
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
  res.status(201).json(db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(info.lastInsertRowid)));
});

paymentsRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM payments WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});
