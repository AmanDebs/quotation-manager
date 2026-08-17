export type Role = 'manager' | 'employee';

export interface User {
  id: number; name: string; email: string; role: Role;
  active?: number; customer_count?: number; created_at?: string;
}

export interface BankAccount { label: string; details: string }

export interface NotePreset { label: string; body: string }

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
  type: 'quotation' | 'proforma' | 'invoice';
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
  planned_start: string; planned_end: string;
  status: WorkOrderStatus;
  notes: string;
  order_number?: string; customer_id?: number; customer_name?: string;
  product_name?: string | null;
  location_name?: string | null; machine_name?: string | null; mould_name?: string | null;
  created_by_name?: string | null;
  progress?: Progress;
  entries?: ProductionEntry[];
  /** `has_recipe: false` means unanswerable — show "not costed", never zero. */
  material?: {
    has_recipe: boolean;
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
  material_id: number | null;
  description: string;
  qty: number | null;
  unit: string;
  rate: number;
  tax_pct?: number;
  amount?: number;
  material_name?: string | null;
  /** Both derived from the ledger on read. */
  qty_received?: number;
  qty_pending?: number;
}

export interface PurchaseOrder {
  id: number; number: string; company_id?: number;
  supplier_id: number; location_id: number | null;
  date: string; expected_date: string;
  currency: string; tax_type: TaxType; status: PoStatus;
  payment_terms: string; notes: string;
  subtotal: number; tax_total: number; grand_total: number;
  supplier_name?: string; location_name?: string | null; created_by_name?: string | null;
  items?: PoItem[];
  receipts?: MaterialMove[];
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
  tentative_delivery: string;
  freight_terms: string;
  /** Nullable: goods can leave before the invoice is raised. */
  invoice_id: number | null;
  notes: string;
  order_number?: string; customer_id?: number; customer_name?: string;
  location_name?: string | null; transporter_name?: string | null;
  invoice_number?: string | null; created_by_name?: string | null;
  items?: DespatchItem[];
}

/* ---------------- The order book, per line ---------------- */

/** All derived from what has been made, sent and billed — never typed. */
export type LineState = 'not_started' | 'in_production' | 'made' | 'part_shipped' | 'shipped';

export interface OrderLine {
  order_id: number; order_number: string; date: string; promised_date: string;
  customer_id: number; customer_name: string; company_name: string | null;
  is_export: number; order_status: string; currency: string;
  order_line: number;
  product_id: number | null;
  description: string; code: string; color: string; unit: string;
  ordered: number; amount: number;
  made: number; sent: number; billed: number;
  state: LineState;
}

/** The same lines folded up: how much of this product is on order altogether. */
export interface ProductDemand {
  key: string;
  product_id: number | null;
  description: string; code: string; color: string; unit: string;
  ordered: number; made: number; shipped: number; to_ship: number;
  orders: number;
  next_due: string;
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

export interface Enquiry {
  id: number; customer_id: number; date: string; notes: string;
  status: 'open' | 'quoted' | 'lost';
  customer_name?: string; customer_country?: string;
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
  column_config?: ColumnConfig;
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
  destination: string; transport: string; freight_terms: string;
  promised_date: string; scheduled_date: string; revised_date: string; actual_production_date: string;
  status: OrderStatus; remarks: string; notes: string;
  subtotal: number; tax_total: number; grand_total: number;
  customer_name?: string; quotation_number?: string; company_name?: string; created_by_name?: string | null;
  column_config?: ColumnConfig;
  items?: OrderItem[];
  dispatched_value?: number; pending_value?: number;
  fully_dispatched?: boolean; any_dispatched?: boolean;
  proformas?: { id: number; number: string; date: string; status: string; grand_total: number }[];
  invoices?: { id: number; number: string; date: string; status: string; grand_total: number }[];
}

export interface Payment {
  id: number; pi_id: number | null; invoice_id: number | null; customer_id: number | null;
  date: string; amount: number; currency: string; method: string; reference: string; notes: string;
  /** On an invoice, the slice of this payment credited here — a PI advance is shared across shipments. */
  applied_amount?: number;
}

export interface Proforma {
  id: number; number: string; date: string; quotation_id: number | null; customer_id: number; company_id?: number;
  /** The order this proforma belongs to — set either way round, whichever was raised first. */
  order_id?: number | null; order_number?: string | null;
  consignee: string; notify_party: string; currency: string; freight: number; insurance: number;
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
  approval_status: ApprovalStatus;
  approved_at?: string; approval_note?: string;
  approved_by_name?: string | null; created_by_name?: string | null;
  column_config?: ColumnConfig;
}

export interface Invoice {
  id: number; number: string; date: string; pi_id: number | null; customer_id: number; company_id?: number;
  consignee: string; notify_party: string; currency: string; freight: number; insurance: number;
  shipping_details: string; bank_account: string; inco_terms: string; payment_terms: string;
  is_export: number; country_of_origin: string; port_of_loading: string; port_of_discharge: string;
  final_destination: string;
  notify_party_2: string; method_of_despatch: string; lot_no: string; prepared_by: string;
  remarks: string; tax_type: TaxType; status: string;
  subtotal: number; tax_total: number; grand_total: number;
  customer_name?: string; pi_number?: string; company_name?: string;
  items?: LineItem[];
  variance?: { description: string; pi_qty: number; invoice_qty: number; variance_pct: number }[];
  payments?: Payment[];
  amount_received?: number;
  balance_due?: number;
  approval_status: ApprovalStatus;
  approved_at?: string; approval_note?: string;
  approved_by_name?: string | null; created_by_name?: string | null;
  column_config?: ColumnConfig;
  /** The paired packing list, created and kept in sync with this invoice. */
  packing?: PackingList;
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
