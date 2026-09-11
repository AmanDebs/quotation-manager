/** The legacy role, still sent and still meaning "is the super admin". */
export type Role = 'manager' | 'employee';

/** The five teams. Mirrors `services/permissions.ts` on the server. */
export type TeamRole = 'super_admin' | 'sys_admin' | 'sales' | 'logistics' | 'production' | 'quality';

export const TEAM_ROLES: { value: TeamRole; label: string }[] = [
  { value: 'super_admin', label: 'Super Admin' },
  { value: 'sys_admin', label: 'System Administrator' },
  { value: 'sales', label: 'Sales' },
  { value: 'logistics', label: 'Logistics' },
  { value: 'production', label: 'Production' },
  { value: 'quality', label: 'Quality' },
];

export const teamRoleLabel = (v: string | undefined | null): string =>
  TEAM_ROLES.find((r) => r.value === v)?.label ?? '—';

export type Level = 'none' | 'view' | 'full';

/**
 * What this user may do, computed by the server and sent with `/auth/me`.
 *
 * **Not** a copy of the access table: there is no shared package between the
 * two halves, and a copy would be a second policy that drifts from the one
 * actually enforced. Sent this way it is a fact about this user, and the
 * client's only use for it is deciding what to draw.
 */
export type Capabilities = Record<string, Level>;

/**
 * Which dashboard cards this person keeps, and in what order. Ids not in
 * `order` fall in after the ones that are, in the built-in order, so a card
 * added in a later release appears rather than silently going missing.
 */
export interface DashboardLayout { hidden: string[]; order: string[] }

export interface User {
  id: number; name: string; email: string; role: Role;
  team_role?: TeamRole;
  /** Only sent by /api/auth/me. */
  can?: Capabilities;
  active?: number; customer_count?: number; created_at?: string;
  /** Only sent by /api/auth/me — the team list has no use for it. */
  dashboard_layout?: DashboardLayout;
}

/**
 * A line of "what we are short of", ready to become a purchase order line.
 * `shortfall` and the `last_*` fields are working detail for the screen — they
 * are not part of the document and are dropped when it is saved.
 */
export interface ShortfallDraftLine {
  material_id: number;
  description: string;
  unit: string;
  qty: number;
  rate: number;
  tax_pct: number;
  shortfall: { required: number; on_hand: number; on_order: number; short: number };
  last_supplier_id: number | null;
  last_supplier_name: string;
  last_rate: number | null;
  last_rate_currency: string;
  last_purchase_date: string;
  last_purchase_number: string;
}

export interface ShortfallDraft {
  supplier_id: number | null;
  location_id: number | null;
  date: string;
  currency: string;
  tax_type: 'none' | 'cgst_sgst' | 'igst';
  items: ShortfallDraftLine[];
  /** Jobs or order lines whose product has no recipe: unknown, not zero. */
  uncosted: { id: number; number: string; description: string }[];
  filtered: boolean;
  /**
   * Which question the figures answer: `orders` is what the customers have
   * ordered and nobody has made yet, `jobs` what the work orders raised so far
   * are short of. Alternatives, never added.
   */
  basis?: 'jobs' | 'orders';
}

export interface BankAccount { label: string; details: string }

/**
 * A reusable clause. `use_by_default` means it is written into a new document's
 * notes straight away, so the standard terms are already there to edit rather
 * than something to remember to insert. Absent means no — a preset that has
 * never been ticked must not start appearing on documents by itself.
 */
export interface NotePreset { label: string; body: string; use_by_default?: boolean }

/** The clauses ticked as standard, as one block of text for a new document. */
export const defaultNotes = (presets: NotePreset[] | undefined): string =>
  (presets ?? []).filter((p) => p.use_by_default && p.body.trim()).map((p) => p.body.trim()).join('\n');

export type ApprovalStatus = 'not_submitted' | 'pending' | 'approved' | 'rejected';

/** Per-document column visibility and custom column names. */
export interface ColumnConfig {
  hidden?: string[];
  custom?: string[];
}

export interface ApprovalFields {
  approval_status: ApprovalStatus;
  approved_at?: string;
  approval_note?: string;
  approved_by_name?: string | null;
  created_by_name?: string | null;
  column_config?: ColumnConfig;
}

export interface PendingApproval {
  type: 'quotation' | 'proforma' | 'invoice' | 'credit-note';
  id: number; number: string; date: string; currency: string;
  grand_total: number; approval_status: ApprovalStatus; is_export: number;
  customer_name: string; created_by_name: string | null;
}

export interface Settings {
  company_name: string; address: string; city: string; state: string; country: string; pincode: string;
  phone: string; email: string; website: string; gstin: string; pan: string; iec: string;
  logo: string; signature: string; default_terms: string;
  quote_prefix: string; pi_prefix: string; inv_prefix: string; pl_prefix: string;
  arn_ref: string; theme_color: string;
  quote_pattern: string; pi_pattern: string; pi_export_pattern: string;
  inv_pattern: string; inv_export_pattern: string; pl_pattern: string;
  order_pattern: string; order_export_pattern: string;
  /**
   * The two internal series. They were missing from this type and from the
   * companies route's field list, so every entity in the group issued
   * WO/26-27/001 with no way to change it.
   */
  wo_pattern: string; po_pattern: string; challan_pattern: string;
  cn_pattern?: string; cn_export_pattern?: string;
  bank_accounts: BankAccount[];
  note_presets: NotePreset[];
}

/**
 * One selling entity in the group. Same shape as Settings — Settings is now
 * just the view of whichever company is the default, kept so the parts of the
 * app that only mean "us" did not all have to change at once.
 */
export interface Company extends Settings {
  id: number;
  is_default?: number;
  active?: number;
}

export interface Customer {
  id: number; name: string; contact_person: string; email: string; phone: string;
  address: string; city: string; country: string; gstin: string; currency: string;
  consignee: string; notify_party: string; notify_party_2: string; notes: string;
  owner_id?: number | null; owner_name?: string | null; is_export?: number;
  /** Which group entity usually invoices them; null = the group default. */
  company_id?: number | null;
}

export interface Product {
  id: number; name: string; description: string; hsn_code: string;
  unit: string; unit_price: number; country_of_origin: string;
  image: string; color: string;
  /** Packing defaults, used by the line-item editor and the container planner. */
  pcs_per_pack: number | null; qty_20ft: number | null; qty_40ft: number | null;
  /** cap | preform | handle | semi_finished | other. See PRODUCT_TYPES. */
  product_type: string;
  /**
   * 1 = moulded here (a sales order line raises a job, the QC gate applies);
   * 0 = bought in and sold on (neither). Optional: a server not yet redeployed
   * omits it, and absent reads as made here — what every product used to be.
   */
  made_here?: number;
  /**
   * Grams per piece, which is the same number as kilograms per 1000 pieces —
   * the basis this catalogue is quoted, priced and recipe'd on. Null means not
   * recorded, which is a different claim from 0 g.
   */
  weight_grams: number | null;
}

/* ---------------- Production masters ---------------- */

/** Fields every master shares. Retiring beats deleting — history keeps its row. */
interface MasterBase { id: number; name: string; notes: string; active: number }

export interface Location extends MasterBase { code: string; address: string }
export interface Supplier extends MasterBase {
  contact_person: string; phone: string; email: string;
  address: string; gstin: string; payment_terms: string;
}
export interface Transporter extends MasterBase { phone: string }
export type MaterialCategory = 'resin' | 'masterbatch' | 'packing' | 'other';
export interface Material extends MasterBase {
  category: MaterialCategory; unit: string; hsn_code: string; reorder_level: number;
}
export interface Machine extends MasterBase {
  code: string; location_id: number | null; type: 'moulding' | 'assembly' | 'other';
}
export interface Mould extends MasterBase { code: string; cavities: number | null }
/**
 * A step a job passes through — Assembly, Camera inspection. The seventh
 * master, and the fourth nullable master a work order names.
 */
export interface Process extends MasterBase { code: string }

/**
 * One line of a product's recipe — what it consumes per 1000 pieces, because
 * that is the basis the catalogue is quoted on. A product with no lines has no
 * recipe, which is not the same as needing nothing.
 */
export interface RecipeLine {
  material_id: number;
  qty_per_1000: number;
  wastage_pct: number;
  /** Filled by the server from the material master; read-only here. */
  name?: string;
  category?: string;
  unit?: string;
}

/* ---------------- Production ---------------- */

export type WorkOrderStatus = 'planned' | 'released' | 'running' | 'paused' | 'done' | 'cancelled';

/** All derived on the server from the shift entries — never stored. */
export interface Progress {
  produced: number;
  rejected: number;
  balance: number;
  reject_pct: number | null;
  entry_count: number;
}

export interface ProductionEntry {
  id: number;
  work_order_id: number;
  date: string;
  shift: string;
  qty_ok: number;
  qty_reject: number;
  operator: string;
  notes: string;
  created_by_name?: string | null;
}

/**
 * A production run, and the certificate that clears it.
 *
 * Everything but the certificate is derived on the server: `made` and
 * `rejected` are the shift entries booked into the lot, and `qc` is the latest
 * *final* check's verdict — `none` meaning nobody has finalised it, which is
 * not the same as a failure. `cleared` is the specification's *QC_PASSED with
 * a valid COA attached*, and it is what the invoice gate looks for.
 */
export interface Batch {
  id: number;
  number: string;
  work_order_id: number;
  date: string;
  notes: string;
  coa_no: string;
  coa_date: string;
  coa_issued_by_name?: string | null;
  made: number;
  rejected: number;
  entries: number;
  final_checks: QcCheck[];
  qc: 'none' | 'passed' | 'failed';
  cleared: boolean;
  /** '' | 'rework' | 'scrapped' — the spec's two words, and nothing decided yet. */
  disposition: '' | 'rework' | 'scrapped';
  disposition_date: string;
  disposition_by_name?: string | null;
  disposition_note: string;
  /**
   * Failed its final check and nobody has said what to do about it. Derived,
   * not a third stored value — a "quarantined" state would be a second name
   * for the absence of a decision.
   */
  held: boolean;
  /** Condemned: the goods no longer exist, so no roll-up counts them. */
  scrapped: boolean;
  /**
   * The trips this lot travelled on. Empty means only that nobody has named it
   * on one — naming lots on a dispatch is optional, so it can never be read as
   * *this lot has not shipped*.
   */
  trips: BatchTrip[];
  /** The credit notes this lot was named as returned on, whatever their approval. */
  returns?: BatchReturn[];
  /** Named on an **approved** return — physically back, so it may be scrapped. */
  returned?: boolean;
}

/** A credit note one lot came back on — the trips read the other way. */
export interface BatchReturn {
  credit_note_id: number;
  number: string;
  date: string;
  approval_status: string;
  invoice_number: string;
}

/** A lot on the order behind an invoice, as the credit note's picker needs it. */
export interface ReturnableBatch extends OrderBatch {
  trips: BatchTrip[];
}

/** A lot named on one trip. Everything but the ids is read back through the job. */
export interface DespatchBatch {
  id: number;
  number: string;
  date: string;
  coa_no: string;
  coa_date: string;
  order_line: number;
  work_order_id: number;
  work_order_number: string;
  product_name: string;
}

/** A lot on the order, as the dispatch form's picker needs it. */
export interface OrderBatch extends DespatchBatch {
  /** A certificate has been issued, so this lot may actually go. */
  cleared: boolean;
}

/** One trip a lot travelled on — the reverse question, which a recall asks. */
export interface BatchTrip {
  despatch_id: number;
  order_id: number;
  order_number: string;
  customer_name: string;
  date: string;
  destination: string;
  /** The challan number, or the consignment note on a trip that predates it. */
  reference: string;
}

export interface WorkOrder {
  id: number; number: string; company_id?: number;
  order_id: number;
  /** Position of the order line this job is against. */
  order_line: number;
  product_id: number | null;
  description: string;
  /** Pieces to make — the floor counts pieces whatever the line is billed in. */
  qty_planned: number;
  location_id: number | null; machine_id: number | null; mould_id: number | null;
  process_id: number | null;
  planned_start: string; planned_end: string;
  status: WorkOrderStatus;
  /**
   * What the material issued to this job has cost, at the moving average in
   * force when each issue was made. 0 means nothing issued yet — a real answer,
   * unlike an uncosted product whose need is unknown. Only sent by GET /:id.
   */
  material_cost?: number;
  /**
   * Specification, inspections and their verdicts. GET /:id only.
   * `spec_owner` says **whose** tolerances these are — this customer's own, the
   * product's default, or none at all, which is not the same as passing.
   */
  qc?: {
    params: QcParam[];
    spec_owner?: QcSpecOwner;
    checks: QcCheck[];
    summary: QcSummary;
  };
  /** The lots this job has made — see `Batch`. Optional: an older server omits it. */
  batches?: Batch[];
  notes: string;
  order_number?: string; customer_id?: number; customer_name?: string;
  product_name?: string | null;
  location_name?: string | null; machine_name?: string | null; mould_name?: string | null;
  process_name?: string | null;
  created_by_name?: string | null;
  progress?: Progress;
  entries?: ProductionEntry[];
  /** `has_recipe: false` means unanswerable — show "not costed", never zero. */
  material?: {
    has_recipe: boolean;
    /**
     * The figures came from the recipe stamped on this job when it was raised,
     * rather than from the product's live one. False means the job never had
     * one taken — which is not staleness, it is every job raised before
     * snapshots existed and every job whose product had no recipe at the time.
     */
    snapshot?: boolean;
    /** Stamped, and the product's recipe has moved since. */
    recipe_differs?: boolean;
    lines: { material_id: number; name: string; unit: string; qty: number; issued: number }[];
    /** Issued but not in the recipe — still has to be visible. */
    extra: { material_id: number; issued: number }[];
  };
}

/** Production against one order line, summed over its work orders. */
export interface LineProduction {
  planned: number;
  produced: number;
  rejected: number;
  balance: number;
  work_orders: number;
}

/* ---------------- Material ---------------- */

export type MoveSource = 'opening' | 'po_receipt' | 'issue' | 'return' | 'adjustment' | 'transfer';

/** One row of the ledger. Signed: positive in, negative out. */
export interface MaterialMove {
  id: number;
  material_id: number; location_id: number;
  date: string; qty: number; source: MoveSource;
  po_id: number | null; work_order_id: number | null;
  note: string;
  material_name?: string; unit?: string; location_name?: string;
  po_number?: string | null; work_order_number?: string | null;
  created_by_name?: string | null;
}

/** On hand at one plant, derived by summing the ledger — never stored. */
export interface StockRow {
  material_id: number; location_id: number;
  material_name: string; unit: string; category: string; location_name: string;
  qty: number;
  on_order: number;
  reorder_level: number;
  below_reorder: boolean;
  /**
   * Moving-average cost and value. Group-wide per material — a kilo is worth
   * the same at either plant. `unpriced_qty` is how much arrived with no rate
   * recorded, so `value` is extrapolating onto it; optional because a server
   * that has not been redeployed yet does not send any of this.
   */
  avg_rate?: number;
  value?: number;
  unpriced_qty?: number;
  unpriced_receipts?: number;
}

export type EnquiryStatus = 'open' | 'quoted' | 'lost';

/**
 * Somebody asked before there was anything to quote — the front of the funnel.
 * `quotation_count` is derived and excludes superseded revisions, so a
 * renegotiated quote does not read as two answers.
 */
export interface Enquiry {
  id: number;
  customer_id: number;
  date: string;
  notes: string;
  status: EnquiryStatus;
  created_at?: string;
  quotation_count?: number;
  /** Joined from the customer, never stored on the enquiry — a contact detail
   *  is corrected on the customer, and a copy taken when the enquiry was
   *  logged would quietly go stale. `owner_name` is the team member the
   *  customer is assigned to, the same field scoping already works from. */
  customer_name?: string;
  customer_city?: string;
  customer_country?: string;
  customer_contact?: string;
  customer_phone?: string;
  customer_email?: string;
  owner_name?: string | null;
}

export type QcKind = 'numeric' | 'boolean';

/**
 * Whose tolerances are in force: this customer's own, the product's default,
 * or nobody's. `none` is **no opinion**, never "everything passed" — the same
 * distinction `has_recipe: false` draws about material.
 */
export type QcSpecOwner = 'customer' | 'default' | 'none';

/**
 * `GET`/`PUT /api/products/:id/qc-params`. It answers with the list *and* whose
 * it is, because "these are the tolerances" and "these are *your* tolerances"
 * are different sentences and the list alone cannot tell them apart.
 */
export interface QcSpecResponse {
  items: QcParam[];
  owner: QcSpecOwner;
  customer_id: number | null;
}

/** What to measure on a product, and what passes. Rewritten whole, like a recipe. */
export interface QcParam {
  id?: number;
  product_id?: number;
  /** NULL is the product's default; a customer's rows replace it, never merge. */
  customer_id?: number | null;
  name: string;
  kind: QcKind;
  unit: string;
  /** Either end may be open — a wall can be too thin but never too thick. */
  min_value: number | null;
  max_value: number | null;
  notes: string;
  sort_order?: number;
}

/**
 * One measurement. `min_value`/`max_value` are the tolerance **as it stood when
 * the check was taken**, copied from the parameter, so tightening a spec later
 * cannot retroactively fail a batch. `ok` is derived and never stored.
 */
export interface QcResult {
  id: number;
  check_id: number;
  param_id: number | null;
  name: string;
  kind: QcKind;
  unit: string;
  value: number | null;
  min_value: number | null;
  max_value: number | null;
  notes: string;
  ok: boolean | null;
}

export interface QcCheck {
  id: number;
  work_order_id: number;
  date: string;
  shift: string;
  sample_size: number | null;
  inspector: string;
  notes: string;
  results: QcResult[];
  /** null when nothing was measured — which is not a pass. */
  passed: boolean | null;
  failed_count: number;
}

export interface QcSummary {
  /** False when nobody has said what to measure. Not "everything passed". */
  has_spec: boolean;
  checks: number;
  passed: number;
  failed: number;
  last_result: boolean | null;
  last_date: string;
}

export interface OrderCosting {
  material_cost: number;
  jobs_issued: number;
  /** Open jobs that have drawn nothing yet, so the cost so far is not the final one. */
  jobs_without_issues: number;
}

export interface ShortfallRow {
  material_id: number; material_name: string; unit: string; category: string;
  required: number; on_hand: number; on_order: number; short: number;
}

export interface Shortfall {
  rows: ShortfallRow[];
  /** Open jobs whose product has no recipe — listed, never counted as zero. */
  uncosted: { id: number; number: string; description: string }[];
}

export type PoStatus = 'draft' | 'sent' | 'part_received' | 'received' | 'cancelled';

export interface PoItem {
  id?: number;
  /**
   * What is being bought: at most one of these, and neither is a free-text
   * line. A product because Aglo buys finished and semi-finished goods in as
   * well as resin.
   */
  material_id: number | null;
  product_id?: number | null;
  description: string;
  qty: number | null;
  unit: string;
  /** Packing as the supplier states it — cartons/bags, and what is in one. */
  packs?: number | null;
  pcs_per_pack?: number | null;
  total_pcs?: number | null;
  rate: number;
  tax_pct?: number;
  amount?: number;
  material_name?: string | null;
  product_name?: string | null;
  /** Both derived from the receipts on read, per line. */
  qty_received?: number;
  qty_pending?: number;
}

/** A delivery, against one line of the order. */
export interface PoReceipt {
  id: number;
  po_id: number;
  po_line: number;
  date: string;
  qty: number;
  location_id: number | null;
  note: string;
  location_name?: string | null;
  created_by_name?: string | null;
}

export interface PurchaseOrder {
  id: number; number: string; company_id?: number;
  supplier_id: number; location_id: number | null;
  date: string; expected_date: string;
  currency: string; tax_type: TaxType; status: PoStatus;
  payment_terms: string; notes: string;
  /**
   * Bought from abroad — not `is_export`: on a purchase the foreign party is
   * the seller. It picks the import numbering series and is fixed once a
   * number has been issued.
   */
  is_import?: number;
  /** The header this document's own paperwork prints. */
  attn?: string; vendor_ref?: string; ship_to?: string;
  inco_terms?: string; transport?: string; ship_via?: string; packing?: string;
  /** Tax collected at source: a percentage of the whole, not of a line. */
  tcs_pct?: number; tcs_amount?: number;
  subtotal: number; tax_total: number; grand_total: number;
  supplier_name?: string; location_name?: string | null; created_by_name?: string | null;
  items?: PoItem[];
  receipts?: PoReceipt[];
}

/* ---------------- Despatch ---------------- */

export interface DespatchItem {
  id?: number;
  /** Position of the order line, matching the rest of the chain. */
  order_line: number;
  description: string;
  qty: number | null;
  packs: number | null;
  notes?: string;
}

export interface Despatch {
  id: number;
  order_id: number;
  location_id: number | null;
  date: string;
  destination: string;
  transporter_id: number | null;
  cn_no: string;
  vehicle_no: string;
  /** The delivery challan's own number, claimed when the trip is recorded.
   *  Blank on a trip recorded before the challan existed. */
  challan_no?: string;
  tentative_delivery: string;
  freight_terms: string;
  /**
   * The sea leg. Blank on a domestic lorry, which states `cn_no` and
   * `vehicle_no` instead; an export container states these and usually not
   * those. `etd`/`eta` are real dates, unlike `tentative_delivery`.
   */
  bl_no: string;
  container_no: string;
  etd: string;
  eta: string;
  /** '' (not sent) | 'sent' | 'received', and how it travelled. */
  docs_status: string;
  docs_method: string;
  docs_date: string;
  /** Nullable: goods can leave before the invoice is raised. */
  invoice_id: number | null;
  notes: string;
  order_number?: string; customer_id?: number; customer_name?: string;
  location_name?: string | null; transporter_name?: string | null;
  invoice_number?: string | null; created_by_name?: string | null;
  items?: DespatchItem[];
  /** Which identified lots went — read back on every despatch. */
  batches?: DespatchBatch[];
  /**
   * What to save. Sent separately from `batches` because the two are different
   * things: one is the resolved rows, the other the caller's choice — and a
   * PUT that omits this leaves the lots on file alone, the rule `items`
   * follows.
   */
  batch_ids?: number[];
}

/* ---------------- The order book, per line ---------------- */

/** All derived from what has been made, sent and billed — never typed. */
export type LineState = 'not_started' | 'in_production' | 'made' | 'part_shipped' | 'shipped';

export interface OrderLine {
  order_id: number; order_number: string; date: string; promised_date: string;
  customer_id: number; customer_name: string; company_name: string | null;
  /** Who booked the order. Null on one whose author has since been removed. */
  created_by_name: string | null;
  is_export: number; order_status: string; currency: string;
  /** Where the goods discharge, from the order. Blank on a domestic one. */
  port_of_discharge: string;
  order_line: number;
  product_id: number | null;
  description: string; code: string; color: string; unit: string;
  ordered: number; amount: number;
  made: number; sent: number; billed: number;
  state: LineState;
  /**
   * Finished goods on the shelf for this line's product, across every plant —
   * the same figure on every line of that product. `null` on a custom line;
   * absent for a caller without `fg`.
   */
  in_stock?: number | null;
}

/** The same lines folded up: how much of this product is on order altogether. */
export interface ProductDemand {
  key: string;
  product_id: number | null;
  description: string; code: string; color: string; unit: string;
  ordered: number; made: number; shipped: number; to_ship: number;
  orders: number;
  next_due: string;
  /** On the shelf for this product; `null` for a custom line, absent without `fg`. */
  in_stock?: number | null;
}

/** Physically sent per order line — the counterpart to the invoiced figure. */
export interface LineDespatch {
  qty: number;
  packs: number;
  trips: number;
}

export interface ImportField { key: string; label: string; required: boolean }

export interface ImportPreviewRow {
  row: number;
  product: Omit<Product, 'id' | 'image'>;
  action: 'create' | 'update' | 'skip';
  note?: string;
  existingId?: number;
}

export interface ImportPreview {
  sheetNames: string[];
  sheet: string;
  headerRow: number;
  headers: string[];
  mapping: Record<string, number>;
  rows: ImportPreviewRow[];
  summary: { create: number; update: number; skip: number; total: number };
}

export interface LineItem {
  id?: number; product_id?: number | null; description: string; hsn_code?: string;
  qty: number | null; unit: string; unit_price: number; tax_pct?: number; amount?: number;
  color?: string; packs?: number | null; pcs_per_pack?: number | null; total_pcs?: number | null;
  /** Boxes that fill each container size. Copied from the catalogue when a
   *  product is picked, then owned by the document; printed on export quotations. */
  qty_20ft?: number | null; qty_40ft?: number | null;
  custom1?: string; custom2?: string; custom3?: string;
  /** Optional photo as a base64 data URL. Stored on every document type so it
   *  survives the carry-forward chain, but only printed on the quotation. */
  image?: string;
  /** Order lines carry these too; harmless elsewhere. */
  code?: string; supplier?: string;
  /**
   * A charge rather than goods — freight, insurance, tooling, a testing fee.
   * It bills at its own price and stays out of every quantity total.
   */
  is_charge?: number;
}

export type TaxType = 'none' | 'cgst_sgst' | 'igst';

export interface Quotation {
  id: number; number: string; revision: number; date: string;
  enquiry_id: number | null; customer_id: number; company_id?: number; currency: string;
  validity_date: string; payment_terms: string; delivery_terms: string;
  /** Printed on the quotation as the NOTES & TERMS bullets. */
  notes: string;
  /** Never printed — the team's own record. Saved through its own endpoint. */
  internal_notes?: string;
  freight: number; insurance: number; inco_terms: string; container_count: string; prepared_by: string;
  tax_type: TaxType; status: string; is_export: number;
  subtotal: number; tax_total: number; grand_total: number;
  superseded_by: number | null;
  customer_name?: string; customer_country?: string; company_name?: string;
  items?: LineItem[];
  revisions?: { id: number; revision: number; status: string; grand_total: number; date: string }[];
  approval_status: ApprovalStatus;
  approved_at?: string; approval_note?: string;
  approved_by_name?: string | null; created_by_name?: string | null;
  /**
   * The proforma raised from this quotation, when there is one. Its presence
   * is what makes the quotation read-only — delete that proforma to unlock it.
   */
  converted_pi_id?: number | null;
  converted_pi_number?: string | null;
  column_config?: ColumnConfig;
  /** What is still missing before approval — see `DocumentFinding`. */
  checks?: DocumentFinding[];
}

export type OrderStatus =
  | 'pending' | 'confirmed' | 'scheduled' | 'in_production'
  | 'ready' | 'partially_dispatched' | 'completed' | 'cancelled';

export interface OrderItem extends LineItem {
  code?: string;
  supplier?: string;
  scheduled_date?: string;
  dispatched_date?: string;
  /** Derived on the server from downstream invoices. */
  qty_dispatched?: number;
  qty_pending?: number;
  /** Derived from the work orders raised against this line. */
  production?: LineProduction;
  /** Derived from the despatch records — what physically left the plant. */
  despatched?: LineDespatch;
}

export interface Order {
  id: number; number: string; date: string;
  quotation_id: number | null; customer_id: number; company_id?: number; is_export: number;
  order_through: string; spoc: string; po_number: string; po_date: string;
  currency: string; tax_type: TaxType; payment_terms: string;
  freight: number; insurance: number; inco_terms: string; container_count: string;
  advance_due: number; advance_amount: number; advance_received_date: string;
  /**
   * What the proforma this order was booked from has actually taken in.
   * Derived on every read, never stored; absent until the order is saved.
   */
  advance?: {
    pi_id: number | null;
    pi_number: string;
    amount_received: number;
    last_date: string;
    currency_mismatch: { currency: string; amount: number }[];
  };
  destination: string; transport: string; freight_terms: string;
  /** Export only: where the goods discharge. Named as on the proforma. */
  port_of_discharge: string;
  promised_date: string; scheduled_date: string; revised_date: string; actual_production_date: string;
  /** Material issued against this order's jobs, at moving average. GET /:id only. */
  material_cost?: number;
  costing?: OrderCosting;
  status: OrderStatus; remarks: string; notes: string;
  subtotal: number; tax_total: number; grand_total: number;
  customer_name?: string; quotation_number?: string; company_name?: string; created_by_name?: string | null;
  column_config?: ColumnConfig;
  items?: OrderItem[];
  dispatched_value?: number; pending_value?: number;
  fully_dispatched?: boolean; any_dispatched?: boolean;
  /**
   * The lots made against this order, for the dispatch form's picker.
   * **Absent, not empty, for a caller who may not read them** — the server
   * decides against the access table, so the client renders what it was handed
   * rather than keeping a second copy of the policy.
   */
  batches?: OrderBatch[];
  proformas?: { id: number; number: string; date: string; status: string; grand_total: number }[];
  invoices?: { id: number; number: string; date: string; status: string; grand_total: number }[];
}

export interface Payment {
  id: number; pi_id: number | null; invoice_id: number | null; customer_id: number | null;
  date: string; amount: number; currency: string; method: string; reference: string; notes: string;
  /** On an invoice, the slice of this payment credited here — a PI advance is shared across shipments. */
  applied_amount?: number;
}

/**
 * A payment as the register lists it: the record, plus the document it was
 * banked against and whether its currency agrees with that document's.
 */
export interface PaymentRow extends Payment {
  customer_name: string | null;
  against_number: string | null;
  against_type: 'invoice' | 'proforma' | '';
  doc_currency: string | null;
  /** 1 when the money is credited to nothing — see `receivables.ts`. */
  mismatched: number;
}

/** The register's figures, over the whole filtered set rather than the page. */
export interface PaymentRegisterSummary {
  payments: number;
  /** Never a single total: money only adds up within one currency. */
  by_currency: { currency: string; count: number; amount: number }[];
  mismatched: number;
}

export interface Proforma {
  id: number; number: string; date: string; quotation_id: number | null; customer_id: number; company_id?: number;
  /** The order this proforma belongs to — set either way round, whichever was raised first. */
  order_id?: number | null; order_number?: string | null;
  consignee: string; ship_to_name: string; ship_to_gstin: string;
  notify_party: string; currency: string; freight: number; insurance: number;
  lead_time: string; bank_account: string; inco_terms: string; payment_terms: string;
  delivery_terms: string; validity_date: string; is_export: number;
  country_of_origin: string; port_of_loading: string; port_of_discharge: string;
  final_destination: string; container_count: string; partial_shipment: string;
  po_number: string; po_date: string;
  notify_party_2: string; method_of_despatch: string; quantity_tolerance: string;
  hs_code: string; prepared_by: string;
  remarks: string; tax_type: TaxType; status: string;
  subtotal: number; tax_total: number; grand_total: number;
  customer_name?: string; quotation_number?: string; company_name?: string;
  items?: LineItem[];
  payments?: Payment[];
  amount_received?: number;
  /** Never printed — the team's own record. Quotations have had one all along. */
  internal_notes?: string;
  // Both come off the list query. Optional so a server that has not been
  // redeployed yet yields "—" rather than NaN, the way the dashboard's
  // factory counts are typed.
  advance_received?: number;
  currency_mismatch_count?: number;
  approval_status: ApprovalStatus;
  approved_at?: string; approval_note?: string;
  approved_by_name?: string | null; created_by_name?: string | null;
  column_config?: ColumnConfig;
  /** What is still missing before approval — see `DocumentFinding`. */
  checks?: DocumentFinding[];
}

/** One trip that was billed under an invoice, as its page reports it. */
export interface InvoiceDespatch {
  id: number; date: string; destination: string;
  cn_no: string; vehicle_no: string;
  bl_no: string; container_no: string; etd: string; eta: string;
  docs_status: string; docs_method: string;
  order_id: number; order_number: string;
  location_name: string | null; transporter_name: string | null;
  pieces: number; boxes: number;
}

export interface Invoice {
  id: number; number: string; date: string; pi_id: number | null; customer_id: number; company_id?: number;
  consignee: string; ship_to_name: string; ship_to_gstin: string;
  notify_party: string; currency: string; freight: number; insurance: number;
  shipping_details: string; bank_account: string; inco_terms: string; payment_terms: string;
  is_export: number; country_of_origin: string; port_of_loading: string; port_of_discharge: string;
  final_destination: string;
  notify_party_2: string; method_of_despatch: string; lot_no: string; prepared_by: string;
  /** This consignment's own LUT/ARN; falls back to the company default. */
  arn_ref?: string;
  remarks: string; tax_type: TaxType; status: string;
  subtotal: number; tax_total: number; grand_total: number;
  customer_name?: string; pi_number?: string; company_name?: string;
  items?: LineItem[];
  /**
   * Quantity variance against the source proforma, matched **by line position**
   * like everything else in the chain. `pi_description` is the proforma's
   * wording at that same position — when it differs from `description`, the
   * two lines may not be the same thing and the pairing is worth a look.
   */
  variance?: {
    description: string; pi_description?: string;
    pi_qty: number; invoice_qty: number; variance_pct: number;
  }[];
  payments?: Payment[];
  amount_received?: number;
  balance_due?: number;
  /**
   * How much of `amount_received` came from the advance on the source proforma
   * — see `services/receivables.ts`, which allocates one advance across the
   * invoices raised from that PI.
   */
  advance_applied?: number;
  /**
   * What approved credit notes have taken off this bill. Not money received
   * and deliberately reported beside it rather than inside it — only
   * `balance_due` nets the two. See `services/receivables.ts`.
   */
  credited?: number;
  /** Every credit note raised against this invoice, whatever its approval. */
  credit_notes?: CreditNoteSummary[];
  /**
   * Money recorded against this invoice or its proforma in a currency it is not
   * billed in, so credited to nothing. Optional: a server that has not been
   * redeployed yet simply omits it.
   */
  currency_mismatch?: { currency: string; amount: number }[];
  approval_status: ApprovalStatus;
  approved_at?: string; approval_note?: string;
  approved_by_name?: string | null; created_by_name?: string | null;
  column_config?: ColumnConfig;
  /** The paired packing list, created and kept in sync with this invoice. */
  packing?: PackingList;
  /** What is still missing before approval — see `DocumentFinding`. */
  checks?: DocumentFinding[];
  /**
   * The trips billed under this invoice, newest last. **Absent — not empty —
   * for a caller who may not read despatches**, which is how Sales (`invoice:
   * view`, `dispatch: none`) sees an invoice without the despatch register
   * arriving with it. Render the card only when the key is present.
   */
  despatches?: InvoiceDespatch[];
}

/** One product at one plant on the finished-goods ledger. Every column but `adjusted` is derived. */
export interface FgRow {
  product_id: number; product_name: string; color: string;
  location_id: number | null; location_name: string | null;
  made: number; dispatched: number; returned: number; adjusted: number; on_hand: number;
}
export interface FgReport {
  rows: FgRow[];
  /** Pieces on lines naming no product, which the ledger cannot place. Reported, not dropped. */
  unplaced: { dispatched: number; returned: number };
}
/** A count or an opening balance — the one thing the ledger stores. Signed. */
export interface FgAdjustment {
  id: number; product_id: number; location_id: number | null; date: string; qty: number;
  reason: string; notes: string;
  product_name: string; location_name: string | null; created_by_name: string | null;
}

/** A credit note as the invoice page lists it. */
export interface CreditNoteSummary {
  id: number; number: string; date: string; kind: CreditKind; reason: string;
  grand_total: number; approval_status: ApprovalStatus;
}

/**
 * Why there is a credit. A **return** means goods came back and its quantities
 * come off what the order line counts as dispatched; an **adjustment** is
 * money alone and touches nothing physical.
 */
export type CreditKind = 'return' | 'adjustment';

/** One of the invoice's lines, with how much of it is still open to credit. */
export interface CreditableLine {
  sort_order: number; description: string; qty: number | null; unit: string;
  is_charge: number; already_credited: number;
}

/**
 * The credit note: the invoice being partly taken back. Currency, tax type,
 * export flag, customer and company are all copied from that invoice on the
 * server and are read-only here.
 */
export interface CreditNote {
  id: number; number: string; date: string; invoice_id: number; customer_id: number; company_id?: number;
  kind: CreditKind; reason: string; notes: string; prepared_by: string;
  /** Where returned goods arrived, for the finished-goods ledger. Null on an adjustment. */
  location_id?: number | null; location_name?: string | null;
  currency: string; tax_type: TaxType; is_export: number;
  subtotal: number; tax_total: number; grand_total: number;
  approval_status: ApprovalStatus;
  approved_at?: string; approval_note?: string;
  approved_by_name?: string | null; created_by_name?: string | null;
  customer_name?: string; company_name?: string;
  invoice_number?: string; invoice_date?: string; invoice_total?: number;
  items?: LineItem[];
  column_config?: ColumnConfig;
  checks?: DocumentFinding[];
  invoice_lines?: CreditableLine[];
  /** The lots named as returned on this note. */
  batches?: DespatchBatch[];
  /**
   * The lots on the order behind the invoice, for the picker. **Absent, not
   * empty, for a caller without `qc`** — the order's own rule for its picker.
   */
  order_batches?: ReturnableBatch[];
}

export interface PackingListItem {
  id?: number; description: string; hsn_code?: string; qty: number | null; unit: string;
  packages: string; dimensions: string; gross_weight: number; net_weight: number;
  custom1?: string; custom2?: string; custom3?: string;
}

export interface PackingList {
  id: number; number: string; date: string; invoice_id: number | null; customer_id: number; company_id?: number;
  shipping_marks: string; lot_no: string; remarks: string;
  invoice?: Record<string, unknown>;
  customer_name?: string; invoice_number?: string;
  total_gross?: number; total_net?: number;
  items?: PackingListItem[];
  column_config?: ColumnConfig;
  created_by_name?: string | null;
}

export interface Followup {
  id: number; doc_type: string; doc_id: number | null; customer_id: number | null;
  due_date: string; note: string; done: number;
  customer_name?: string; doc_number?: string;
}

/**
 * One row of the QC register (`GET /api/work-orders/qc-checks`) — every
 * inspection recorded, newest first, with the job and customer it was taken
 * against. `passed` is derived from the readings and is **null when nothing
 * was measured**, which is not a pass.
 */
export interface QcCheckRow {
  id: number;
  work_order_id: number;
  work_order_number: string;
  date: string;
  shift: string;
  sample_size: number | null;
  inspector: string;
  notes: string;
  order_id: number;
  order_number: string;
  order_line: number;
  customer_id: number;
  customer_name: string;
  product_id: number | null;
  product_name: string | null;
  description: string;
  process_name: string | null;
  readings: number;
  measured: number;
  failed_count: number;
  passed: boolean | null;
}

/** The register's figures, measured over the whole filtered set, never a page. */
export interface QcRegisterSummary {
  checks: number;
  passed: number;
  failed: number;
  unmeasured: number;
}

/* ------------------------------------------------------------ the customer page */

/**
 * A money document as the customer page lists it.
 *
 * One type for all four, with the per-type extras optional, because they are
 * all rendered by one `DocRows` — four near-identical tables is how four
 * document lists come to disagree about how a date is formatted.
 */
export interface CustomerDocRow {
  id: number;
  number: string;
  date: string;
  status: string;
  currency: string;
  grand_total: number;
  /** Quotations only. */
  revision?: number;
  superseded?: boolean;
  /** Orders only — the customer's own reference. */
  po_number?: string;
  /** Commercial invoices only. */
  balance_due?: number;
}

/** What this customer owes, in one currency. Rows are never added across currencies. */
export interface CustomerMoneyRow {
  currency: string;
  invoiced: number;
  received: number;
  outstanding: number;
  overdue: number;
  advance_held: number;
}

export interface CustomerSection<T> {
  total: number;
  rows: T[];
}

/**
 * Everything about one customer.
 *
 * **Every section is optional, and an absent one means the caller's team may
 * not read it** — the server assembles the map against its own access table
 * rather than the client filtering by `useCan()`, so there is only ever one
 * copy of the policy.
 */
export interface CustomerSummary {
  money?: {
    rows: CustomerMoneyRow[];
    currency_mismatch: { currency: string; amount: number }[];
  };
  enquiries?: CustomerSection<{ id: number; date: string; status: string; notes: string }>;
  quotations?: CustomerSection<CustomerDocRow>;
  proformas?: CustomerSection<CustomerDocRow>;
  orders?: CustomerSection<CustomerDocRow>;
  invoices?: CustomerSection<CustomerDocRow>;
  followups?: CustomerSection<{ id: number; due_date: string; note: string; done: number; overdue: boolean }>;
  payments?: CustomerSection<{
    id: number; date: string; amount: number; currency: string;
    method: string; reference: string; against: string;
  }>;
  qc?: { products: { product_id: number; product_name: string; params: number }[] };
}

/**
 * One thing a document is missing before it can be approved.
 *
 * `block` refuses the approval; `warn` is shown and refuses nothing. The rule
 * table is `server/src/services/documentChecks.ts` — promoting a warning to a
 * block is a one-word change there, and this side needs no edit for it.
 */
export interface DocumentFinding {
  key: string;
  level: 'block' | 'warn';
  message: string;
}
