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

### Moving to the cloud later

The app is a standard Express API + static React build: deploy the server to any Node host, run `npm run build` in `client/` and serve `client/dist`, and swap SQLite for PostgreSQL when multi-user concurrency demands it.
