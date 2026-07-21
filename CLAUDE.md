# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An order-to-dispatch document management app for a manufacturing/export business. The core domain is a chain of four documents, each created from the previous one with data carried forward:

**Enquiry → Quotation (revisions R1, R2… for negotiation) → Proforma Invoice → Commercial Invoice → Packing List**

Plus payment tracking (advances against the PI, balance against the invoice), follow-up reminders, and a dashboard. Multi-currency (INR/USD/EUR), GST (`tax_type`: `none` for exports / `cgst_sgst` / `igst`), and export fields (INCO terms, ports, containers).

## Commands

```
cd server && npm run dev     # API on :4000 (tsx watch — auto-restarts on change)
cd client && npm run dev     # Vite on :5173 (proxies /api → :4000)
npx tsc --noEmit             # type-check (run in server/ and client/ separately; no tests exist)
```

`start-app.bat` launches both and opens the browser. Node lives at `C:\Program Files\nodejs` — it was installed mid-session, so fresh shells may need it prepended to PATH.

**Testing against real data is forbidden** — the user has live business data in `server/data/app.db` since 2026-07-21. To verify changes end-to-end, run an isolated instance:

```powershell
$env:PORT='4100'; $env:DATA_DIR='<scratch dir>'; npx tsx src/index.ts
```

then register a throwaway user and drive the API with curl (auth is a `qm_token` httpOnly cookie; use a cookie jar).

## Hard constraints

- **No native npm modules.** The machine has no C++ toolchain (better-sqlite3 failed to build). The DB is Node's built-in `node:sqlite` (`DatabaseSync`, synchronous API) — keep it that way.
- **All money math lives in `server/src/services/totals.ts`** (`computeTotals`, `round2`). The client's line-item totals are display-only previews; the server recomputes on every save. Never persist client-computed amounts.
- **Schema changes must be additive**: extend `server/src/db/schema.sql` (fresh installs) *and* add an `addColumnIfMissing(...)` call in `server/src/db/connection.ts` (existing DBs). There is no migration framework.

## Architecture

**Server** (`server/src/`, Express + TypeScript, ESM with `.js` import suffixes):

- `routes/` — one router per entity. The three money documents (quotations, proformas, invoices) share the same shape: `listSql` join with customer name, `getFull(id)` returning header + items (+ payments/variance), a `saveItems()` that deletes-and-reinserts items inside `transaction()` and stamps server-computed totals onto the header row, a `POST /:id/status` endpoint with a per-type allowed list, and delete guards that 409 if downstream documents or payments reference the row.
- **Carry-forward pattern**: each conversion is a `GET /prefill/from-<source>/:id` endpoint returning a draft payload (never writes). The client form loads it via `?from_quotation=` / `?from_proforma=` / `?from_invoice=` query params and the user saves normally. Follow this pattern for new conversions.
- Quotation **revisions**: same `number`, incremented `revision`; old row gets `superseded_by` pointing at the new one and becomes read-only in the UI. List views hide superseded rows unless `?all=1`.
- **Payments** (`payments` table) link to *either* a PI (`pi_id`, advance) or an invoice (`invoice_id`). An invoice's `amount_received`/`balance_due` counts both its own payments and those on its source PI — this double-source logic appears in `routes/invoices.ts` `getFull`, `routes/dashboard.ts` receivables, and `services/pdf.ts` `buildInvoicePdf`; keep them consistent.
- **Numbering** (`services/numbering.ts`): per-type, per-year sequences (`QT-2026-0001`), prefixes configurable in settings. Numbers are consumed inside the create transaction.
- **PDFs** (`services/pdf.ts`): pdfmake with fonts decoded from its bundled vfs (no font files, no browser). Shared helpers (`companyHeader`, `partiesBlock`, `itemsTable`, `totalsBlock`, `signatureBlock`) + one builder per document type. Served by `routes/pdf.ts` at `/api/pdf/<type>/:id`.
- `settings` is a single-row table (id=1); `bank_accounts` is a JSON string column, parsed at the route boundary.

**Client** (`client/src/`, React 18 + Vite + Tailwind v4 + TanStack Query):

- Document pages come in pairs: a list page and a form page that doubles as the detail view (`/quotations/:id` etc.), with status pills, PDF link, follow-up button, and convert button in the header. `pages/QuotationForm.tsx` is the reference implementation.
- Shared pieces: `components/LineItemsEditor.tsx` (used by all three money documents), `PaymentsCard.tsx`, `FollowupButton.tsx`, `components/ui.tsx` (Button/Input/Field/Card/Modal/StatusBadge primitives — use these, don't hand-roll).
- Query keys: lists are `['quotations', statusFilter]`-style; details are `[<singular>, String(id)]` (e.g. `['proforma', '3']`). Mutations invalidate both plus `['dashboard']` when money/followups change.
- Auth: `App.tsx` gates on `GET /api/auth/me`; first-run registration only appears while the `users` table is empty (`/api/auth/status` → `needsSetup`). There is currently **no UI to add users after the first** — known gap.
- Dashboard chart colors follow a validated palette (blue `#2a78d6`, green `#008300`, ordinal blue ramp for the funnel) — reuse those constants in `pages/Dashboard.tsx` rather than inventing new hues.

**Conventions**: dates are `YYYY-MM-DD` strings; money is REAL rounded via `round2`; `qty` may be NULL (price-only quotations — PDFs then hide amounts); INR formats with lakh grouping and Indian-system amount-in-words (`services/amountInWords.ts`).
