# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An order-to-dispatch document management app for **Aglo Polymers Pvt Ltd** (Kolkata) — plastic preforms/caps/handles exported to Africa via Dubai/Mauritius intermediaries, plus domestic GST sales. The core domain is a chain of four documents, each created from the previous one with data carried forward:

**Quotation (revisions R1, R2… for negotiation) → Order → Proforma Invoice → Commercial Invoice → Packing List**

**Team model:** `manager` sees everything, approves documents, and owns Settings/Team/Approvals; `employee` sees only customers where `customers.owner_id` matches them. Every outgoing document (quotation/PI/invoice) must reach `approval_status = 'approved'` before its status can move to an outgoing value — see `server/src/services/approval.ts`, which owns that rule; unapproved PDFs get a watermark. Editing an approved document resets it to `not_submitted`.

Plus payment tracking (advances against the PI, balance against the invoice), follow-up reminders, and a dashboard. Multi-currency (INR/USD/EUR), GST (`tax_type`: `none` for exports / `cgst_sgst` / `igst`), and export fields (INCO terms, ports, containers, two notify parties, method of despatch, quantity tolerance, ARN).

The **product catalogue carries packing and loadability** — `pcs_per_pack` (pieces per box), `qty_20ft` and `qty_40ft` (boxes that fill each container size) — mirroring the user's own catalogue sheet. Those three columns are what make the catalogue importable from Excel and the Container Planner possible; they are not decoration.

**The four PDFs are modeled on real Aglo documents in `D:\Quotation Doc\`** (quotation → Sanya sample; PI → Emeraude sample; invoice + packing list → AP/EX-101 samples). When changing a PDF layout, compare against those files — they are the spec.

## Commands

```
cd server && npm run dev     # API on :4000 (tsx watch — auto-restarts on change)
cd client && npm run dev     # Vite on :5173 (proxies /api → :4000)
npx tsc --noEmit             # type-check (run in server/ and client/ separately; no tests exist)
```

`start-app.bat` launches both and opens the browser. Node lives at `C:\Program Files\nodejs` — it was installed mid-session, so fresh shells may need it prepended to PATH.

**Testing against real data is forbidden** — the user has live business data in `server/data/app.db` since 2026-07-21. The DB runs in WAL mode, so **copying `app.db` alone gets you an empty database** — copy `app.db*` (including `-wal`). To verify changes end-to-end, run an isolated instance:

```powershell
$env:PORT='4100'; $env:DATA_DIR='<scratch dir>'; npx tsx src/index.ts
```

`npm run seed` in `server/` fills an empty DB with demo data and prints two logins (manager/employee) — the fastest way to get a scratch instance you can drive with curl. Auth is a `qm_token` httpOnly cookie; use a cookie jar.

**Verification is API-driven, not browser-driven.** The in-app preview browser has no session, and Claude must not type passwords into it, so the app's own UI cannot be exercised end-to-end. Verify server behaviour with curl against a scratch instance, and cover the client with `npx tsc --noEmit` plus `npx vite build` (which catches import and syntax errors). Say plainly in the summary when a visual change went unrendered rather than implying it was seen.

Kill scratch servers via the port, not by name — a stale `tsx` process keeps the WAL files locked and will silently serve old code:

```powershell
Stop-Process -Id (Get-NetTCPConnection -LocalPort 4100 -State Listen).OwningProcess -Force
```

## Hard constraints

- **No native npm modules.** The machine has no C++ toolchain (better-sqlite3 failed to build). The DB is Node's built-in `node:sqlite` (`DatabaseSync`, synchronous API) — keep it that way. The bar for *any* new dependency is high: the .xlsx reader was written by hand (~200 lines over `node:zlib`) rather than adding a spreadsheet package, because the npm-hosted ones carry known advisories. Reach for Node's standard library first.
- **All money math lives in `server/src/services/totals.ts`** (`computeTotals`, `round2`). The client's line-item totals are display-only previews; the server recomputes on every save. Never persist client-computed amounts.
- **Schema changes must be additive**: extend `server/src/db/schema.sql` (fresh installs) *and* add an `addColumnIfMissing(...)` call in `server/src/db/connection.ts` (existing DBs). There is no migration framework.

## Architecture

**Server** (`server/src/`, Express + TypeScript, ESM with `.js` import suffixes):

- `routes/` — one router per entity. The three money documents (quotations, proformas, invoices) share the same shape: `listSql` join with customer name, `getFull(id)` returning header + items (+ payments/variance), a `saveItems()` that deletes-and-reinserts items inside `transaction()` and stamps server-computed totals onto the header row, a `POST /:id/status` endpoint with a per-type allowed list, and delete guards that 409 if downstream documents or payments reference the row.
- **Orders are the order book** (`routes/orders.ts`), modelled on the user's real tracking spreadsheets in `D:\Quotation Doc\*.xlsx`: intake fields (order_through, spoc, the customer's own po_number/po_date), a production plan (promised → scheduled → revised → actual), advance tracking, and per-line `code`/`supplier`/`scheduled_date`/`dispatched_date`. **Dispatch progress is derived, never stored** — `dispatchProgress()` walks every invoice reachable from the order (`commercial_invoices.order_id`, or via a PI with that `order_id`) and sums `invoice_items` **by line index**, the same index-matching rule `syncPackingList()` uses. Orders carry **no approval workflow** (they record the customer's commitment, not an outgoing offer) so their PDFs are never watermarked.
- **The commercial invoice owns its packing list.** `syncPackingList()` in `routes/invoices.ts` runs inside the create/update transaction: it creates the packing list on first save and always rewrites its items from `invoice_items`, taking only packing values (packages, dimensions, weights, custom1..3) from `body.packing.items` matched **by index**. Deleting the invoice cascades to it. `routes/packingLists.ts` `saveItems()` honours the same rule for linked lists, so descriptions/qty can never drift. `/api/pdf/invoice-with-packing/:id` emits both documents in one file (invoice pages, page break, packing pages) with the invoice's approval watermark.
- **Carry-forward pattern**: each conversion is a `GET /prefill/from-<source>/:id` endpoint returning a draft payload (never writes). The client form loads it via `?from_quotation=` / `?from_proforma=` / `?from_invoice=` query params and the user saves normally. Follow this pattern for new conversions.
- **Line items are packaging-aware**: besides `qty × unit_price` (the billing basis — e.g. KGS × price/kg), items carry display-only `color`, `packs` (boxes/ctns), `pcs_per_pack`, `total_pcs`, plus `custom1..3`. The per-1000-pcs rate shown on PDFs is derived (`amount / total_pcs × 1000`), never stored. Picking a catalogue product fills `pcs_per_pack` from `products.pcs_per_pack`, so the packing defaults only have to be maintained in one place.
- **Uploads arrive base64 in the JSON body** (logos, signatures, spreadsheets) — hence `express.json({ limit: '12mb' })` in `index.ts`; base64 inflates a file by a third. There is no multipart handling anywhere, deliberately: no multer, no temp files.
- **Data scoping is cross-cutting**: `server/src/middleware/scope.ts` (`scopeClause`, `canAccessCustomer`) must be applied in every list/detail/mutation route for customers, documents, follow-ups and the dashboard. Out-of-scope ids return 404, never 403, so employees can't probe for other owners' records.
- **Columns are per-document**: `column_config` JSON (`{hidden:[], custom:[]}`) drives both `LineItemsEditor` and the PDF. PDFs build their items table from a `ColumnSpec[]` passed to `itemsTable()` in `services/pdf.ts` — a column with no data anywhere auto-hides unless marked `always`. Add new columns to the spec list, never with ad-hoc `if (hasX)` branches.
- Quotation **revisions**: same `number`, incremented `revision`; old row gets `superseded_by` pointing at the new one and becomes read-only in the UI. List views hide superseded rows unless `?all=1`.
- **Payments** (`payments` table) link to *either* a PI (`pi_id`, advance) or an invoice (`invoice_id`). **`services/receivables.ts` owns the "how much has this invoice been credited" rule** and is the only place that may answer it: a payment on an invoice belongs to that invoice, while a PI advance is a pool **allocated across the invoices raised from that PI** (earliest first, capped at each invoice's remaining balance) because partial shipments are normal. Counting the whole advance against every invoice credits the customer several times over. `routes/invoices.ts` `getFull`, `routes/dashboard.ts` receivables and `services/pdf.ts` `buildInvoicePdf` all call it — never recompute payment totals inline. The allocation is derived on read, never stored.
- **Payments are scoped like documents**: `routes/payments.ts` resolves the linked PI/invoice and applies `canAccessCustomer` on create, and checks the payment's own `customer_id` on delete. Out-of-scope ids return 404.
- **Delete guards must cover every foreign key** pointing at the row, not just the obvious downstream document — a missed reference reaches the user as "Internal server error". Quotations are referenced by both `orders.quotation_id` and `proforma_invoices.quotation_id`; customers by quotations, orders, PIs, invoices, packing lists, follow-ups, payments and enquiries. The error handler in `index.ts` converts any remaining `FOREIGN KEY constraint failed` into a 409, but that is a backstop, not a substitute for a specific message.
- **Spreadsheet import** is two services. `services/spreadsheet.ts` is a dependency-free reader: an .xlsx is a ZIP of XML parts, so it walks the central directory, `inflateRawSync`s each part, and pulls cell text out of `sharedStrings.xml` + the sheet XML (shared/inline strings, sparse cells, multiple sheets; **dates come back as Excel serial numbers** — nothing interprets styles). It also parses CSV with delimiter sniffing. `splitHeader()` *scores* candidate rows on width and wordiness instead of taking the first plausible one, because real sheets have titles and merged two-tier banners above the real headings. `services/productImport.ts` maps columns to catalogue fields by heading synonyms and produces a per-row create/update/skip plan. **Preview and import run the identical pipeline** (`buildImport`) over the same re-uploaded file, so what the user confirms is exactly what gets written — keep it that way rather than trusting client-sent rows.
- **A product is identified by name + colour + pcs/box**, not name alone (`identityKey()`): the same item is genuinely stocked at two box counts, and those are separate things to quote and load. This key governs both in-file repeat detection and matching against the existing catalogue, so re-importing a sheet updates in place instead of duplicating. Imports never touch `image` — a spreadsheet has no photo to offer.
- **Numbering** (`services/numbering.ts`): pattern-based with `{FY}` (Indian fiscal year Apr–Mar, "26-27") and `{SEQ}` (3-digit) tokens, configurable per doc type in settings (e.g. `AGLO/EX/{FY}/{SEQ}`). Proformas and invoices have **separate export vs domestic patterns and sequences** (`isExport` option; sequence keys like `proforma_export`). Numbers are consumed inside the create transaction, and every document's `number` can be manually overridden via PUT (forms expose an editable Number field on existing documents).
- **Totals** (`services/totals.ts`): `computeTotals(items, taxType, freight, insurance, currency)` — INR grand totals round to the whole rupee; PDFs derive the "Round off" line as `grand_total − (subtotal + freight + insurance + tax_total)`. Quotations carry freight/insurance too (the "Indicative Freight & Insurance" band).
- **PDFs** (`services/pdf.ts`): pdfmake with fonts decoded from its bundled vfs (no font files, no browser). Theme color comes from `settings.theme_color` (default maroon `#8b1a1a`). Shared helpers: `companyHeader` (logo left, company right), `docTitle` (letter-spaced underlined), `totalsBand` (theme-filled emphasis bars), `exportDocGrid` (the boxed customs header shared by invoice + packing list), `signatureBlock`, `notesAndTerms`. One builder per document type; served by `routes/pdf.ts` at `/api/pdf/<type>/:id`. The packing list pulls parties/ports from its linked invoice at render time.
- `settings` is a single-row table (id=1); `bank_accounts` is a JSON string column, parsed at the route boundary.

**Client** (`client/src/`, React 18 + Vite + Tailwind v4 + TanStack Query):

- Document pages come in pairs: a list page and a form page that doubles as the detail view (`/quotations/:id` etc.), with status pills, PDF link, follow-up button, and convert button in the header. `pages/QuotationForm.tsx` is the reference implementation.
- Shared pieces: `components/LineItemsEditor.tsx` (used by all three money documents; renders **two rows per item** — billing row + lighter packaging row), `PaymentsCard.tsx`, `FollowupButton.tsx`, `components/ui.tsx` (Button/Input/Field/Card/Modal/StatusBadge primitives — use these, don't hand-roll).
- Query keys: lists are `['quotations', statusFilter]`-style; details are `[<singular>, String(id)]` (e.g. `['proforma', '3']`). Mutations invalidate both plus `['dashboard']` when money/followups change.
- Auth: `App.tsx` gates on `GET /api/auth/me` and exposes `useUser()` / `useIsManager()`. First-run registration creates the manager and is refused once any user exists; further accounts come from the manager-only Team page.
- Dashboard chart colors follow a validated palette (blue `#2a78d6`, green `#008300`, ordinal blue ramp for the funnel) — reuse those constants in `pages/Dashboard.tsx` rather than inventing new hues.
- **The dashboard is ordered by urgency**: a "Needs attention" strip (overdue follow-ups/orders/invoices, lapsed quotation validity, pending approvals), then money tiles, then charts and tables. The attention strip and the receivables ageing **deliberately ignore the date-range filter** — an overdue item from months ago is the most urgent kind, not the least. The currency selector in the page header drives every money figure on the page. Ageing buckets (0-30/31-60/61-90/90+ by invoice age) must always sum to the receivables outstanding total; that cross-check is the quickest way to catch a regression. `?company=N` narrows every figure to one selling entity, and the invariant that proves it is that **each company's figures partition the unfiltered whole** — nothing dropped, nothing double-counted. A follow-up has no company column, so it inherits one from its document, then the customer, then the group default; note that `doc_type` has no `'order'` value, so order reminders are stored as `'general'` **with the order's id** and the dashboard resolves them that way. The PI-advance allocation stays group-wide even when filtered — narrowing it would over-credit whichever invoices remained on screen.
- **Container Planner** (`pages/ContainerPlanner.tsx` + `lib/containerPlan.ts`) answers the loading question. Capacity is not a single number — different products box up differently, so one box of product *i* occupies `1/Cᵢ` of a container (`Cᵢ` = its `qty_20ft`/`qty_40ft`) and any mix must satisfy `Σ(boxesᵢ/Cᵢ) ≤ containers`. Two modes solve that in opposite directions: *fill* scales a requested ratio until the containers are exactly full, floors to whole boxes, then hands the rounding remainder back largest-deficit-first; *requirement* rounds pieces up to whole boxes and reports containers needed plus leftover room. The ratio basis (boxes vs pieces) changes the answer dramatically — an equal *piece* split of caps and handles is ~94% handles by volume — so keep both bases available. **One plan covers one container size**, since space is expressed as a fraction of its own container type. Products with no loadability recorded are flagged, never silently dropped. This is the one piece of derived business logic that lives client-side; it feeds no document, so it never became a server service.

**Conventions**: dates are `YYYY-MM-DD` strings; money is REAL rounded via `round2`; `qty` may be NULL (price-only quotations — PDFs then hide amounts); INR formats with lakh grouping and Indian-system amount-in-words (`services/amountInWords.ts`).

## Deployment

Production is **one service on one origin**: Express serves `/api` and, when `client/dist` exists, the built React app plus an SPA fallback. The root `package.json` is the deploy entry point (`build` → client build + production install; `start` → the server); `render.yaml` is a working blueprint for Render with a disk at `/data`.

- **`tsx` is a runtime dependency, not a dev one** — the server runs TypeScript directly in production. Compiling would need an emitting tsconfig *and* an asset copy for `schema.sql`, which `db/connection.ts` loads relative to `__dirname`. Don't "fix" this by moving tsx back.
- **Env vars that matter**: `DATA_DIR` (the disk mount), `NODE_ENV=production` (switches on `trust proxy`, `secure` cookies, and switches *off* CORS since it's same-origin), and `JWT_SECRET` (≥32 chars, enforced at boot — without it every redeploy signs everyone out).
- **Never scale past one instance.** SQLite is a file on that disk.
- **Backups** (`services/backup.ts`): `VACUUM INTO` on boot and daily into `$DATA_DIR/backups/`, 14-day retention, plus manager-only `GET /api/backup/download`. That route is mounted at `/api/backup`, **not** under `/api/settings`, whose guard lets any GET through — putting it there would make the whole database downloadable by every employee.

## Known gaps

Recorded from a review; **not yet fixed** — don't rediscover them as new, and don't assume the invariant holds:

- Nothing auto-expires a quotation past its `validity_date`; `expired` is only ever set by hand. The dashboard counts these under `attention.expiringQuotations` but does not change the status.
- Order status is manual even though dispatch is derived — `partially_dispatched`/`completed` never set themselves, though `getFull` already computes `any_dispatched`/`fully_dispatched`.
- The invoice's 10% qty-variance check matches PI lines **by description**, while packing lists and dispatch progress match **by index**. Editing a description on the invoice silently empties the variance report.
- There is no audit trail (who changed what, when) and no pagination on any list.

Fixed while making the app deployable, and worth knowing the shape of:

- **Document numbers are unique**, enforced by indexes created in `db/connection.ts` — deliberately *not* in `schema.sql`, which runs first on every boot and would refuse to start on a database that already held duplicates. The migration de-duplicates (suffixing `-DUPn`) and then creates the index. Quotations key on `(number, revision)` since revisions share a number. `services/numbering.ts` claims the next number in one `INSERT … ON CONFLICT DO UPDATE … RETURNING` statement; the old read-then-update was only safe because SQLite serialises writes. A rejected number surfaces as a 409 from the central handler in `index.ts`, so every document type behaves the same.
- **Products**: read and create are open (an employee meeting a new product mid-quotation must not be blocked); `PUT`, `DELETE` and both import endpoints are manager-only, and delete now 409s when line items reference the product.
- **Follow-ups**: `POST` and `DELETE` are scoped like `PUT` already was.
- **Login is rate-limited** (`middleware/rateLimit.ts`) — in-memory by IP + email, which is correct for a single-instance deployment and is the piece to replace if that ever changes.
