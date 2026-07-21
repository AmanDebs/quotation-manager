import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { requireAuth } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { settingsRouter } from './routes/settings.js';
import { customersRouter } from './routes/customers.js';
import { productsRouter } from './routes/products.js';
import { enquiriesRouter } from './routes/enquiries.js';
import { quotationsRouter } from './routes/quotations.js';
import { proformasRouter } from './routes/proformas.js';
import { invoicesRouter } from './routes/invoices.js';
import { packingListsRouter } from './routes/packingLists.js';
import { followupsRouter } from './routes/followups.js';
import { paymentsRouter } from './routes/payments.js';
import { dashboardRouter } from './routes/dashboard.js';
import { pdfRouter } from './routes/pdf.js';

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' })); // logo/signature images arrive as data URLs
app.use(cookieParser());

app.use('/api/auth', authRouter);
app.use('/api/settings', requireAuth, settingsRouter);
app.use('/api/customers', requireAuth, customersRouter);
app.use('/api/products', requireAuth, productsRouter);
app.use('/api/enquiries', requireAuth, enquiriesRouter);
app.use('/api/quotations', requireAuth, quotationsRouter);
app.use('/api/proformas', requireAuth, proformasRouter);
app.use('/api/invoices', requireAuth, invoicesRouter);
app.use('/api/packing-lists', requireAuth, packingListsRouter);
app.use('/api/followups', requireAuth, followupsRouter);
app.use('/api/payments', requireAuth, paymentsRouter);
app.use('/api/dashboard', requireAuth, dashboardRouter);
app.use('/api/pdf', requireAuth, pdfRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Quotation server running on http://localhost:${PORT}`);
});
