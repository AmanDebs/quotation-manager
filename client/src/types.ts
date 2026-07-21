export interface User { id: number; name: string; email: string }

export interface BankAccount { label: string; details: string }

export interface Settings {
  company_name: string; address: string; city: string; state: string; country: string; pincode: string;
  phone: string; email: string; website: string; gstin: string; pan: string; iec: string;
  logo: string; signature: string; default_terms: string;
  quote_prefix: string; pi_prefix: string; inv_prefix: string; pl_prefix: string;
  bank_accounts: BankAccount[];
}

export interface Customer {
  id: number; name: string; contact_person: string; email: string; phone: string;
  address: string; city: string; country: string; gstin: string; currency: string;
  consignee: string; notify_party: string; notes: string;
}

export interface Product {
  id: number; name: string; description: string; hsn_code: string;
  unit: string; unit_price: number; country_of_origin: string;
}

export interface Enquiry {
  id: number; customer_id: number; date: string; notes: string;
  status: 'open' | 'quoted' | 'lost';
  customer_name?: string; customer_country?: string;
}

export interface LineItem {
  id?: number; product_id?: number | null; description: string; hsn_code?: string;
  qty: number | null; unit: string; unit_price: number; tax_pct?: number; amount?: number;
}

export type TaxType = 'none' | 'cgst_sgst' | 'igst';

export interface Quotation {
  id: number; number: string; revision: number; date: string;
  enquiry_id: number | null; customer_id: number; currency: string;
  validity_date: string; payment_terms: string; delivery_terms: string; notes: string;
  tax_type: TaxType; status: string;
  subtotal: number; tax_total: number; grand_total: number;
  superseded_by: number | null;
  customer_name?: string; customer_country?: string;
  items?: LineItem[];
  revisions?: { id: number; revision: number; status: string; grand_total: number; date: string }[];
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
  remarks: string; tax_type: TaxType; status: string;
  subtotal: number; tax_total: number; grand_total: number;
  customer_name?: string; quotation_number?: string;
  items?: LineItem[];
  payments?: Payment[];
  amount_received?: number;
}

export interface Invoice {
  id: number; number: string; date: string; pi_id: number | null; customer_id: number;
  consignee: string; notify_party: string; currency: string; freight: number; insurance: number;
  shipping_details: string; bank_account: string; inco_terms: string; payment_terms: string;
  is_export: number; country_of_origin: string; port_of_loading: string; port_of_discharge: string;
  final_destination: string; remarks: string; tax_type: TaxType; status: string;
  subtotal: number; tax_total: number; grand_total: number;
  customer_name?: string; pi_number?: string;
  items?: LineItem[];
  variance?: { description: string; pi_qty: number; invoice_qty: number; variance_pct: number }[];
  payments?: Payment[];
  amount_received?: number;
  balance_due?: number;
}

export interface PackingListItem {
  id?: number; description: string; qty: number | null; unit: string;
  packages: string; dimensions: string; gross_weight: number; net_weight: number;
}

export interface PackingList {
  id: number; number: string; date: string; invoice_id: number | null; customer_id: number;
  shipping_marks: string; remarks: string;
  customer_name?: string; invoice_number?: string;
  total_gross?: number; total_net?: number;
  items?: PackingListItem[];
}

export interface Followup {
  id: number; doc_type: string; doc_id: number | null; customer_id: number | null;
  due_date: string; note: string; done: number;
  customer_name?: string; doc_number?: string;
}
