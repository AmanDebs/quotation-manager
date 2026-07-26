# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An order-to-dispatch document management app for **Aglo Polymers Pvt Ltd** (Kolkata) — plastic preforms/caps/handles exported to Africa via Dubai/Mauritius intermediaries, plus domestic GST sales. The core domain is a chain of four documents, each created from the previous one with data carried forward:

**Enquiry → Quotation (revisions R1, R2… for negotiation) → Proforma Invoice → Commercial Invoice → Packing List**

**Team model:** `manager` sees everything, approves documents, and owns Settings/Team/Approvals; `employee` sees only customers where `customers.owner_id` matches them. Every outgoing document (quotation/PI/invoice) must reach `approval_status = 'approved'` before its status can move to an outgoing value — see `server/src/services/approval.ts`, which owns that rule; unapproved PDFs get a watermark. Editing an approved document resets it to `not_submitted`.

Plus payment tracking (advances against the PI, balance against the invoice), follow-up reminders, and a dashboard. Multi-currency (INR/USD/EUR), GST (`tax_type`: `none` for exports / `cgst_sgst` / `igst`), and export fields (INCO terms, ports, containers, two notify parties, method of despatch, quantity tolerance, ARN).

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

then register a throwaway user and drive the API with curl (auth is a `qm_token` httpOnly cookie; use a cookie jar).

## Hard constraints

- **No native npm modules.** The machine has no C++ toolchain (better-sqlite3 failed to build). The DB is Node's built-in `node:sqlite` (`DatabaseSync`, synchronous API) — keep it that way.
- **All money math lives in `server/src/services/totals.ts`** (`computeTotals`, `round2`). The client's line-item totals are display-only previews; the server recomputes on every save. Never persist client-computed amounts.
- **Schema changes must be additive**: extend `server/src/db/schema.sql` (fresh installs) *and* add an `addColumnIfMissing(...)` call in `server/src/db/connection.ts` (existing DBs). There is no migration framework.

## Architecture

**Server** (`server/src/`, Express + TypeScript, ESM with `.js` import suffixes):

- `routes/` — one router per entity. The three money documents (quotations, proformas, invoices) share the same shape: `listSql` join with customer name, `getFull(id)` returning header + items (+ payments/variance), a `saveItems()` that deletes-and-reinserts items inside `transaction()` and stamps server-computed totals onto the header row, a `POST /:id/status` endpoint with a per-type allowed list, and delete guards that 409 if downstream documents or payments reference the row.
- **The commercial invoice owns its packing list.** `syncPackingList()` in `routes/invoices.ts` runs inside the create/update transaction: it creates the packing list on first save and always rewrites its items from `invoice_items`, taking only packing values (packages, dimensions, weights, custom1..3) from `body.packing.items` matched **by index**. Deleting the invoice cascades to it. `routes/packingLists.ts` `saveItems()` honours the same rule for linked lists, so descriptions/qty can never drift. `/api/pdf/invoice-with-packing/:id` emits both documents in one file (invoice pages, page break, packing pages) with the invoice's approval watermark.
- **Carry-forward pattern**: each conversion is a `GET /prefill/from-<source>/:id` endpoint returning a draft payload (never writes). The client form loads it via `?from_quotation=` / `?from_proforma=` / `?from_invoice=` query params and the user saves normally. Follow this pattern for new conversions.
- **Line items are packaging-aware**: besides `qty × unit_price` (the billing basis — e.g. KGS × price/kg), items carry display-only `color`, `packs` (boxes/ctns), `pcs_per_pack`, `total_pcs`, plus `custom1..3`. The per-1000-pcs rate shown on PDFs is derived (`amount / total_pcs × 1000`), never stored.
- **Data scoping is cross-cutting**: `server/src/middleware/scope.ts` (`scopeClause`, `canAccessCustomer`) must be applied in every list/detail/mutation route for customers, documents, follow-ups and the dashboard. Out-of-scope ids return 404, never 403, so employees can't probe for other owners' records.
- **Columns are per-document**: `column_config` JSON (`{hidden:[], custom:[]}`) drives both `LineItemsEditor` and the PDF. PDFs build their items table from a `ColumnSpec[]` passed to `itemsTable()` in `services/pdf.ts` — a column with no data anywhere auto-hides unless marked `always`. Add new columns to the spec list, never with ad-hoc `if (hasX)` branches.
- Quotation **revisions**: same `number`, incremented `revision`; old row gets `superseded_by` pointing at the new one and becomes read-only in the UI. List views hide superseded rows unless `?all=1`.
- **Payments** (`payments` table) link to *either* a PI (`pi_id`, advance) or an invoice (`invoice_id`). An invoice's `amount_received`/`balance_due` counts both its own payments and those on its source PI — this double-source logic appears in `routes/invoices.ts` `getFull`, `routes/dashboard.ts` receivables, and `services/pdf.ts` `buildInvoicePdf`; keep them consistent.
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

**Conventions**: dates are `YYYY-MM-DD` strings; money is REAL rounded via `round2`; `qty` may be NULL (price-only quotations — PDFs then hide amounts); INR formats with lakh grouping and Indian-system amount-in-words (`services/amountInWords.ts`).
