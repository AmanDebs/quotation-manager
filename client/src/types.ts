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

export interface Customer {
  id: number; name: string; contact_person: string; email: string; phone: string;
  address: string; city: string; country: string; gstin: string; currency: string;
  consignee: string; notify_party: string; notify_party_2: string; notes: string;
  owner_id?: number | null; owner_name?: string | null; is_export?: number;
}

export interface Product {
  id: number; name: string; description: string; hsn_code: string;
  unit: string; unit_price: number; country_of_origin: string;
  image: string; color: string;
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
  custom1?: string; custom2?: string; custom3?: string;
  /** Order lines carry these too; harmless elsewhere. */
  code?: string; supplier?: string;
}

export type TaxType = 'none' | 'cgst_sgst' | 'igst';

export interface Quotation {
  id: number; number: string; revision: number; date: string;
  enquiry_id: number | null; customer_id: number; currency: string;
  validity_date: string; payment_terms: string; delivery_terms: string; notes: string;
  freight: number; insurance: number; inco_terms: string; container_count: string; prepared_by: string;
  tax_type: TaxType; status: string; is_export: number;
  subtotal: number; tax_total: number; grand_total: number;
  superseded_by: number | null;
  customer_name?: string; customer_country?: string;
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
}

export interface Order {
  id: number; number: string; date: string;
  quotation_id: number | null; customer_id: number; is_export: number;
  order_through: string; spoc: string; po_number: string; po_date: string;
  currency: string; tax_type: TaxType; payment_terms: string;
  freight: number; insurance: number; inco_terms: string; container_count: string;
  advance_due: number; advance_amount: number; advance_received_date: string;
  destination: string; transport: string; freight_terms: string;
  promised_date: string; scheduled_date: string; revised_date: string; actual_production_date: string;
  status: OrderStatus; remarks: string; notes: string;
  subtotal: number; tax_total: number; grand_total: number;
  customer_name?: string; quotation_number?: string; created_by_name?: string | null;
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
}

export interface Proforma {
  id: number; number: string; date: string; quotation_id: number | null; customer_id: number;
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
  customer_name?: string; quotation_number?: string;
  items?: LineItem[];
  payments?: Payment[];
  amount_received?: number;
  approval_status: ApprovalStatus;
  approved_at?: string; approval_note?: string;
  approved_by_name?: string | null; created_by_name?: string | null;
  column_config?: ColumnConfig;
}

export interface Invoice {
  id: number; number: string; date: string; pi_id: number | null; customer_id: number;
  consignee: string; notify_party: string; currency: string; freight: number; insurance: number;
  shipping_details: string; bank_account: string; inco_terms: string; payment_terms: string;
  is_export: number; country_of_origin: string; port_of_loading: string; port_of_discharge: string;
  final_destination: string;
  notify_party_2: string; method_of_despatch: string; lot_no: string; prepared_by: string;
  remarks: string; tax_type: TaxType; status: string;
  subtotal: number; tax_total: number; grand_total: number;
  customer_name?: string; pi_number?: string;
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
  id: number; number: string; date: string; invoice_id: number | null; customer_id: number;
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
