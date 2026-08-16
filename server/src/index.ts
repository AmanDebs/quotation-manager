import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAuth, requireManager } from './middleware/auth.js';
import { isDuplicateNumberError } from './db/connection.js';
import { healthRouter } from './routes/health.js';
import { backupRouter } from './routes/backup.js';
import { startBackupSchedule } from './services/backup.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { approvalsRouter } from './routes/approvals.js';
import { settingsRouter } from './routes/settings.js';
import { companiesRouter } from './routes/companies.js';
import { customersRouter } from './routes/customers.js';
import { productsRouter } from './routes/products.js';
import { mountMasters } from './routes/masters.js';
import { quotationsRouter } from './routes/quotations.js';
import { ordersRouter } from './routes/orders.js';
import { workOrdersRouter } from './routes/workOrders.js';
import { purchaseOrdersRouter } from './routes/purchaseOrders.js';
import { stockRouter } from './routes/stock.js';
import { proformasRouter } from './routes/proformas.js';
import { invoicesRouter } from './routes/invoices.js';
import { packingListsRouter } from './routes/packingLists.js';
import { followupsRouter } from './routes/followups.js';
import { paymentsRouter } from './routes/payments.js';
import { dashboardRouter } from './routes/dashboard.js';
import { pdfRouter } from './routes/pdf.js';

const app = express();
const PORT = Number(process.env.PORT ?? 4000);
const isProduction = process.env.NODE_ENV === 'production';

// Behind Render's TLS terminator, so req.protocol reflects the original scheme
// and `secure` cookies are actually sent.
if (isProduction) app.set('trust proxy', 1);

// In production the API and the web app share one origin, so no cross-origin
// access is needed — or wanted. In development Vite is on another port.
if (!isProduction) app.use(cors({ origin: true, credentials: true }));
// Logo/signature images and spreadsheet uploads both arrive base64-encoded in
// the JSON body, and base64 inflates a file by a third.
app.use(express.json({ limit: '12mb' }));
app.use(cookieParser());

app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
// Deliberately NOT under /api/settings: that router lets any GET through, which
// would make the whole database downloadable by every employee.
app.use('/api/backup', requireAuth, requireManager, backupRouter);
app.use('/api/users', requireAuth, requireManager, usersRouter);
app.use('/api/approvals', requireAuth, requireManager, approvalsRouter);
// Settings are readable by everyone (documents need the company profile) but
// only a manager may change them.
app.use('/api/settings', requireAuth, (req, res, next) =>
  req.method === 'GET' ? next() : requireManager(req, res, next), settingsRouter);
// Guards its own writes with requireManager, since reads must stay open —
// every document form needs the list of who can be selling.
app.use('/api/companies', requireAuth, companiesRouter);
app.use('/api/customers', requireAuth, customersRouter);
app.use('/api/products', requireAuth, productsRouter);
// Locations, suppliers, transporters, materials, machines, moulds — described
// once in routes/masters.ts and mounted here under their own paths.
mountMasters((path, router) => app.use(path, requireAuth, router));
app.use('/api/quotations', requireAuth, quotationsRouter);
app.use('/api/orders', requireAuth, ordersRouter);
app.use('/api/work-orders', requireAuth, workOrdersRouter);
// Purchasing is manager-only in full: supplier rates are not everyone's
// business, and committing a spend is not a shop-floor action.
app.use('/api/purchase-orders', requireAuth, requireManager, purchaseOrdersRouter);
// The stock ledger guards its own writes — reads are open because anyone
// planning a job needs to know whether there is material for it.
app.use('/api/stock', requireAuth, stockRouter);
app.use('/api/proformas', requireAuth, proformasRouter);
app.use('/api/invoices', requireAuth, invoicesRouter);
app.use('/api/packing-lists', requireAuth, packingListsRouter);
app.use('/api/followups', requireAuth, followupsRouter);
app.use('/api/payments', requireAuth, paymentsRouter);
app.use('/api/dashboard', requireAuth, dashboardRouter);
app.use('/api/pdf', requireAuth, pdfRouter);

// Anything under /api that reached here is a genuine 404 — answer in JSON so
// the client never has to parse an HTML error page.
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Serve the built web app from the same origin, when it has been built. In
// development this directory does not exist and Vite serves the client instead.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, '../../client/dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // Client-side routing: any non-API path falls back to the app shell so a deep
  // link like /orders/3 works on a cold page load.
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
} else if (isProduction) {
  console.warn(`No client build found at ${clientDist} — run "npm run build" first.`);
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  // A number the database refuses is a conflict the user can fix, not a fault.
  // Handled centrally so every document type behaves the same on create, on
  // update and on manual override.
  if (isDuplicateNumberError(err)) {
    return res.status(409).json({
      error: 'That document number is already in use. Choose a different one.',
    });
  }
  // Safety net: a delete blocked by a foreign key is a conflict the user can
  // act on, not a server fault. Routes still guard explicitly with a specific
  // message — this only stops a missed guard from reading as a crash.
  if (/FOREIGN KEY constraint failed/i.test(err.message)) {
    return res.status(409).json({
      error: 'This record is still referenced by another document and cannot be deleted.',
    });
  }
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Quotation server running on http://localhost:${PORT}${isProduction ? ' (production)' : ''}`);
  startBackupSchedule();
});
