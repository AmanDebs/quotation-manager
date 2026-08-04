# Quotation Manager

A complete order-to-dispatch document management system for a manufacturing/export business.

**Quotation → Order → Proforma Invoice → Commercial Invoice + Packing List**

Each document is created from the previous one with all details carried forward, so nothing is retyped and totals are always computed by the system — no manual math, no missed follow-ups, and every data point stored for analysis.

## Features

- **Quotations** with revisions (R1, R2…) to track negotiation history, validity dates, and a status workflow (draft → sent → negotiating → accepted/rejected/expired)
- **Proforma Invoices** with HSN codes, freight & insurance, INCO terms (CIF/FOB/…), bank details, production lead time, and full export block (country of origin, ports, containers, partial shipment)
- **Commercial Invoices** created from a PI at dispatch — final quantities are checked against the 10% variance clause automatically
- **The packing list is made with the invoice**, on the same screen: fill in cartons, dimensions and weights beside each invoice line, and the packing list is created and kept in sync automatically. Download them separately or as one **Invoice + Packing List** file, the way customs and freight forwarders expect them
- **Branded PDFs** for all four documents (logo, signature/stamp, amount in words, GST or export layout)
- **Order book** — every confirmed order in one place: how it came in and who took it, the customer's own PO reference, advance due vs received, the production plan (promised → scheduled → revised → actual), and **how much of each line has actually shipped**, calculated automatically from the invoices raised against it. Overdue orders are flagged
- **Team roles** — the manager sees everything, approves documents and controls Settings; employees see only the customers assigned to them
- **Manager approval** before any quotation, proforma or invoice can be marked as sent; unapproved PDFs carry a "Pending Approval" watermark
- **Export or domestic chosen up front**, driving tax treatment, numbering series, form fields and PDF layout
- **Flexible columns** — hide any column you don't need per document, and add up to three custom columns (e.g. Mould No., Cavity)
- **Reusable note & term presets**, editable per document
- **Buyer PO capture** on the proforma invoice (PO number/date, printed on the PI PDF)
- **Payment tracking** — record advances against the PI and balance payments against the invoice; balance due appears on screen, on the invoice PDF, and as receivables per currency on the dashboard
- **Follow-up reminders** on any document — overdue/today/upcoming on the dashboard
- **Dashboard** — conversion funnel, quotations by status, monthly quoted vs invoiced value per currency, top customers and products
- **Multi-currency** (INR/USD/EUR at the customer's option) and **GST support** (CGST+SGST / IGST / no tax for exports)
- **Import your product catalogue from Excel** — drop in an .xlsx or .csv, check the columns it detected, and see exactly which products will be added and which updated before anything is saved. Re-importing the same sheet updates in place instead of duplicating
- **Container planner** — work out the mix of products that fills a 20ft or 40ft container, or how many containers an order needs. Uses each product's pieces-per-box and boxes-per-container, so it knows that a box of handles and a box of caps take different amounts of space
- Customer & product catalogs, simple team login

## Running the app

Double-click **`start-app.bat`** — it starts both servers and opens the app at http://localhost:5173.

Or manually, in two terminals:

```
cd server && npm run dev     # API on http://localhost:4000
cd client && npm run dev     # Web app on http://localhost:5173
```

On first launch the app asks you to create the first account — this becomes the **manager**. Then head to **Settings** to fill in your company profile, logo, bank accounts and GSTIN (these appear on every PDF), and to **Team** to add employees. Employees cannot sign themselves up.

To load realistic demo data on an empty database: `npm run seed` in `server/`.

## Tech notes

- **Server:** Node.js + Express + TypeScript. Data is stored in SQLite at `server/data/app.db` (uses Node's built-in `node:sqlite`, no database install needed). Set the `DATA_DIR` environment variable to relocate the data folder.
- **Backing up:** copy **all** of `server/data/app.db*` — the database runs in WAL mode, so recent changes live in the `app.db-wal` sidecar file. Copying `app.db` on its own can give you an almost-empty backup.
- **Client:** React + Vite + TypeScript + Tailwind CSS + TanStack Query, charts with Recharts.
- **PDFs:** generated server-side with pdfmake.
- **Auth:** email + password (bcrypt), JWT in an httpOnly cookie.
- All money math happens server-side in `server/src/services/totals.ts` (single source of truth).
- Document numbers (QT-2026-0001, PI-…, INV-…, PL-…) are per-type yearly sequences; prefixes configurable in Settings.

## Deploying it for your team

The app is one service: Express serves both the API and the built React app on a single origin. It needs a host with a **persistent disk**, because the database is a file. That rules out serverless platforms (Vercel, Netlify, Lambda) — their filesystems are wiped between requests, so the database would disappear.

**On Render**, which is what `render.yaml` is written for:

1. Push this repository to GitHub.
2. Render dashboard → **New → Blueprint** → pick the repository. It reads `render.yaml` and creates the service, the 1 GB disk mounted at `/data`, and a generated `JWT_SECRET`.
3. Wait for the first deploy, then open the URL. The first visit asks you to create an account — **that account becomes the manager**.
4. Go to **Settings** and fill in the company profile, logo, signature and bank details (these appear on every PDF), then **Team** to add your colleagues. Employees cannot sign themselves up.

Roughly $7/month for the instance plus a little for the disk.

**Keep it on one instance.** SQLite is a file on that disk; a second instance would quietly get its own copy.

Any other Node host with a disk works the same way — set `DATA_DIR` to the mount path, `NODE_ENV=production`, and a stable `JWT_SECRET` (at least 32 characters; `openssl rand -hex 32` generates one). Without a stable secret everyone is signed out on each deploy.

### Backups

The server writes a snapshot to `$DATA_DIR/backups/` when it starts and once a day after, keeping the last 14. A manager can also download the whole database at any time from **Settings → Backup**. Do that occasionally and keep the file somewhere off the server — a single disk is a single point of failure.

Snapshots use SQLite's `VACUUM INTO`, so each one is a complete, consistent file you can open directly or drop back into `$DATA_DIR/app.db` to restore.

### If you outgrow SQLite

For one office and a few thousand documents a year it will not be the bottleneck. If a second location appears, the migration path is PostgreSQL: the schema translates directly, and the honest cost is that every database call in `server/src/routes/` becomes asynchronous.
