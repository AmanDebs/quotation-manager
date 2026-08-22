/**
 * Turning a stored diff into a sentence.
 *
 * The server records what the database calls things — `grand_total`,
 * `approval_status`, `pcs_per_pack` — because that is what it can be sure of,
 * and because a log that stores prose cannot be filtered or compared. The
 * translation into English belongs here, on the side that is showing it to
 * somebody, and an unknown field falls back to its own name rather than being
 * hidden: a change nobody has named yet is still a change that happened.
 */

export interface AuditChange {
  field: string;
  from?: unknown;
  to?: unknown;
  /** The value was withheld — a password, an image, a set of line items. */
  truncated?: true;
}

export interface AuditEntry {
  id: number;
  at: string;
  user_id: number | null;
  user_name: string;
  entity: string;
  entity_id: number | null;
  action: string;
  label: string;
  changes: AuditChange[];
  note: string;
}

export const ACTION_LABEL: Record<string, string> = {
  create: 'Created',
  update: 'Edited',
  delete: 'Deleted',
  status: 'Status changed',
  submit: 'Submitted for approval',
  approve: 'Approved',
  reject: 'Rejected',
  revise: 'Revised',
  entries: 'Production booked',
  'entries delete': 'Production entry removed',
  'qc-checks': 'Quality check recorded',
  'qc-checks delete': 'Quality check removed',
  receipts: 'Goods received',
  materials: 'Recipe changed',
  'qc-params': 'Quality specification changed',
  sequence: 'Numbering counter moved',
  import: 'Catalogue imported',
  login: 'Signed in',
  login_failed: 'Sign-in refused — wrong password',
  login_refused: 'Sign-in refused — account deactivated',
  register: 'Account created',
  'change-password': 'Password changed',
};

/** Where a database column has a name a person would use. */
const FIELD_LABEL: Record<string, string> = {
  grand_total: 'Total',
  tax_total: 'Tax',
  subtotal: 'Subtotal',
  approval_status: 'Approval',
  status_before_paid: 'Status before paid',
  status_before_completed: 'Status before completed',
  customer_id: 'Customer',
  company_id: 'Company',
  owner_id: 'Owner',
  is_export: 'Export',
  tax_type: 'Tax type',
  password_hash: 'Password',
  items: 'Line items',
  column_config: 'Columns',
  pcs_per_pack: 'Pieces per box',
  qty_20ft: 'Boxes per 20ft',
  qty_40ft: 'Boxes per 40ft',
  po_number: 'Their PO number',
  next_number: 'Next number',
  qty_planned: 'Planned quantity',
  invoice_id: 'Invoice',
  pi_id: 'Proforma',
  order_id: 'Order',
  quotation_id: 'Quotation',
  enquiry_id: 'Enquiry',
  superseded_by: 'Superseded by',
  bank_accounts: 'Bank accounts',
  note_presets: 'Note presets',
  theme_color: 'Theme colour',
};

export const fieldLabel = (field: string) =>
  FIELD_LABEL[field]
  // "Supplier id" reads like a typo. A column ending in _id names the thing,
  // not the number, and the number is shown as an id by `show` below.
  ?? field.replace(/_id$/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const show = (v: unknown, field = ''): string => {
  if (v === null || v === undefined || v === '') return 'blank';
  // A foreign key is a reference, not a quantity. "Customer: 1" reads as one
  // customer; "Customer #1" reads as which one.
  if (/_id$/.test(field) && typeof v === 'number') return `#${v}`;
  if (typeof v === 'number') return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(v);
  const s = String(v);
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
};

/**
 * One change, as a line of text.
 *
 * A withheld value says so rather than pretending to nothing: "Password
 * changed" is the whole point of recording it, and "Line items changed" is
 * the honest amount to say about rows that live on the document itself.
 */
export function describeChange(c: AuditChange): string {
  const name = fieldLabel(c.field);
  if (c.truncated) return `${name} changed`;
  if (c.from === null || c.from === undefined) return `${name}: ${show(c.to, c.field)}`;
  if (c.to === null || c.to === undefined) return `${name} was ${show(c.from, c.field)}`;
  return `${name}: ${show(c.from, c.field)} → ${show(c.to, c.field)}`;
}

/**
 * How many changes to print before folding the rest away.
 *
 * A create and a delete carry the whole row — twenty-odd fields on an invoice
 * — and printing all of them buries the two that a reader came for. An edit
 * is naturally short and is never folded.
 */
export const CHANGES_SHOWN = 6;

export function splitChanges(changes: AuditChange[]): { shown: AuditChange[]; hidden: number } {
  return changes.length > CHANGES_SHOWN + 1
    ? { shown: changes.slice(0, CHANGES_SHOWN), hidden: changes.length - CHANGES_SHOWN }
    : { shown: changes, hidden: 0 };
}
