PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('manager','employee')),
  active INTEGER NOT NULL DEFAULT 1,
  -- Which dashboard cards this person keeps, and in what order. JSON
  -- {"hidden":[],"order":[]} of card ids; blank means the built-in layout.
  -- A display preference, so it lives on the user rather than in the browser:
  -- the same desk gets used from more than one machine.
  dashboard_layout TEXT NOT NULL DEFAULT '',
  -- Bumped whenever this account's password changes. Every token carries the
  -- version it was signed under, so raising it makes every session issued
  -- before the change stop verifying. Without it a stolen login survived the
  -- password reset meant to end it: requireAuth caught a deactivated account
  -- but had nothing to check a reset against.
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The group's selling entities. Every document records the one that issued it,
-- so a reprint years later still carries the right name, GSTIN and letterhead.
-- Each company numbers its own documents: a GST-registered entity keeps one
-- consecutive series per GSTIN.
--
-- On an existing database this is seeded once from the old single `settings`
-- row (see db/connection.ts), which is why the columns mirror it.
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT 'India',
  pincode TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  gstin TEXT NOT NULL DEFAULT '',
  pan TEXT NOT NULL DEFAULT '',
  iec TEXT NOT NULL DEFAULT '',
  logo TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL DEFAULT '',
  default_terms TEXT NOT NULL DEFAULT '',
  bank_accounts TEXT NOT NULL DEFAULT '[]',
  note_presets TEXT NOT NULL DEFAULT '[]',
  arn_ref TEXT NOT NULL DEFAULT '',
  theme_color TEXT NOT NULL DEFAULT '#8b1a1a',
  quote_prefix TEXT NOT NULL DEFAULT 'QT',
  pi_prefix TEXT NOT NULL DEFAULT 'PI',
  inv_prefix TEXT NOT NULL DEFAULT 'INV',
  pl_prefix TEXT NOT NULL DEFAULT 'PL',
  quote_pattern TEXT NOT NULL DEFAULT 'QT/{FY}/{SEQ}',
  pi_pattern TEXT NOT NULL DEFAULT 'AGLO/PI/{FY}/{SEQ}',
  pi_export_pattern TEXT NOT NULL DEFAULT 'AGLO/EX/{FY}/{SEQ}',
  inv_pattern TEXT NOT NULL DEFAULT 'AP/{SEQ4}/{FY}',
  inv_export_pattern TEXT NOT NULL DEFAULT 'AP/EX/{SEQ}/{FY}',
  pl_pattern TEXT NOT NULL DEFAULT 'PL/{FY}/{SEQ}',
  order_pattern TEXT NOT NULL DEFAULT 'SO/{FY}/{SEQ}',
  order_export_pattern TEXT NOT NULL DEFAULT 'SO-EX/{FY}/{SEQ}',
  wo_pattern TEXT NOT NULL DEFAULT 'WO/{FY}/{SEQ}',
  po_pattern TEXT NOT NULL DEFAULT 'PO/{FY}/{SEQ}',
  po_import_pattern TEXT NOT NULL DEFAULT 'PO-IMP/{FY}/{SEQ}',
  -- The one a document falls back to when neither it nor its customer names one.
  is_default INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Superseded by `companies` above, and no longer read by anything. Kept so a
-- database migrated to multi-company can still be rolled back.
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  company_name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT 'India',
  pincode TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  gstin TEXT NOT NULL DEFAULT '',
  pan TEXT NOT NULL DEFAULT '',
  iec TEXT NOT NULL DEFAULT '',
  logo TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL DEFAULT '',
  default_terms TEXT NOT NULL DEFAULT '',
  quote_prefix TEXT NOT NULL DEFAULT 'QT',
  pi_prefix TEXT NOT NULL DEFAULT 'PI',
  inv_prefix TEXT NOT NULL DEFAULT 'INV',
  pl_prefix TEXT NOT NULL DEFAULT 'PL',
  bank_accounts TEXT NOT NULL DEFAULT '[]',
  arn_ref TEXT NOT NULL DEFAULT '',
  theme_color TEXT NOT NULL DEFAULT '#8b1a1a',
  quote_pattern TEXT NOT NULL DEFAULT 'QT/{FY}/{SEQ}',
  pi_pattern TEXT NOT NULL DEFAULT 'AGLO/PI/{FY}/{SEQ}',
  pi_export_pattern TEXT NOT NULL DEFAULT 'AGLO/EX/{FY}/{SEQ}',
  inv_pattern TEXT NOT NULL DEFAULT 'AP/{SEQ4}/{FY}',
  inv_export_pattern TEXT NOT NULL DEFAULT 'AP/EX/{SEQ}/{FY}',
  pl_pattern TEXT NOT NULL DEFAULT 'PL/{FY}/{SEQ}',
  order_pattern TEXT NOT NULL DEFAULT 'SO/{FY}/{SEQ}',
  order_export_pattern TEXT NOT NULL DEFAULT 'SO-EX/{FY}/{SEQ}',
  wo_pattern TEXT NOT NULL DEFAULT 'WO/{FY}/{SEQ}',
  po_pattern TEXT NOT NULL DEFAULT 'PO/{FY}/{SEQ}',
  po_import_pattern TEXT NOT NULL DEFAULT 'PO-IMP/{FY}/{SEQ}',
  note_presets TEXT NOT NULL DEFAULT '[]'
);
INSERT OR IGNORE INTO settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_person TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT 'India',
  gstin TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'INR',
  consignee TEXT NOT NULL DEFAULT '',
  notify_party TEXT NOT NULL DEFAULT '',
  notify_party_2 TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  owner_id INTEGER REFERENCES users(id),
  -- Which group entity normally invoices this customer; NULL = the default.
  company_id INTEGER REFERENCES companies(id),
  is_export INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  hsn_code TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT 'unit',
  unit_price REAL NOT NULL DEFAULT 0,
  country_of_origin TEXT NOT NULL DEFAULT 'India',
  image TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  -- Packing defaults: how the product ships and how much fills a container.
  -- The same product can exist at more than one box count, so name alone does
  -- not identify a catalogue entry — see productImport.ts.
  pcs_per_pack REAL,
  qty_20ft REAL,
  qty_40ft REAL,
  -- The shape of the goods (cap/preform/handle/other). No CHECK: SQLite
  -- cannot ALTER one, and a list whose fourth entry is "other" expects to
  -- grow. Enforced in routes/products.ts, like unit, which has none either.
  product_type TEXT NOT NULL DEFAULT 'other',
  -- Grams per piece, which is also kilograms per 1000 pieces -- the basis
  -- the catalogue is quoted, priced and recipe'd on. Nullable: blank means
  -- not recorded, which is a different claim from 0 g.
  weight_grams REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS enquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  date TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','quoted','lost')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  enquiry_id INTEGER REFERENCES enquiries(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  -- The group entity issuing this document. Fixed at creation.
  company_id INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id),
  currency TEXT NOT NULL DEFAULT 'INR',
  validity_date TEXT NOT NULL DEFAULT '',
  payment_terms TEXT NOT NULL DEFAULT '',
  delivery_terms TEXT NOT NULL DEFAULT '',
  -- Printed, as the NOTES & TERMS bullets at the foot of the quotation.
  notes TEXT NOT NULL DEFAULT '',
  -- Never printed. The team's own record of how the negotiation is going.
  internal_notes TEXT NOT NULL DEFAULT '',
  freight REAL NOT NULL DEFAULT 0,
  insurance REAL NOT NULL DEFAULT 0,
  inco_terms TEXT NOT NULL DEFAULT '',
  container_count TEXT NOT NULL DEFAULT '',
  prepared_by TEXT NOT NULL DEFAULT '',
  tax_type TEXT NOT NULL DEFAULT 'none' CHECK (tax_type IN ('none','cgst_sgst','igst')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','negotiating','accepted','rejected','expired')),
  -- Where to put a quotation back if its validity is extended. Filled only
  -- when services/quotationExpiry.ts expires it, so one marked expired by hand
  -- has nothing remembered and stays expired. Same mechanism, same reasoning,
  -- as status_before_paid on an invoice and status_before_completed on an order.
  status_before_expired TEXT NOT NULL DEFAULT '',
  is_export INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  approval_status TEXT NOT NULL DEFAULT 'not_submitted' CHECK (approval_status IN ('not_submitted','pending','approved','rejected')),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT NOT NULL DEFAULT '',
  approval_note TEXT NOT NULL DEFAULT '',
  column_config TEXT NOT NULL DEFAULT '{}',
  subtotal REAL NOT NULL DEFAULT 0,
  tax_total REAL NOT NULL DEFAULT 0,
  grand_total REAL NOT NULL DEFAULT 0,
  superseded_by INTEGER REFERENCES quotations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quotation_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL DEFAULT '',
  hsn_code TEXT NOT NULL DEFAULT '',
  qty REAL,
  unit TEXT NOT NULL DEFAULT 'unit',
  unit_price REAL NOT NULL DEFAULT 0,
  tax_pct REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '',
  packs REAL,
  pcs_per_pack REAL,
  total_pcs REAL,
  -- Loadability, copied from the catalogue when the product is picked so an
  -- old document keeps the figures it was quoted on.
  qty_20ft REAL,
  qty_40ft REAL,
  -- A charge, not goods: freight, insurance, tooling, a testing fee. It bills at
  -- its own price and is left out of every quantity column and total.
  is_charge INTEGER NOT NULL DEFAULT 0,
  custom1 TEXT NOT NULL DEFAULT '',
  custom2 TEXT NOT NULL DEFAULT '',
  custom3 TEXT NOT NULL DEFAULT '',
  -- Optional photo for this line (base64 data URL); printed on quotations.
  image TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- The order book: what the customer has committed to buy, tracked from intake
-- through production to dispatch. Sits between quotation and proforma invoice.
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  quotation_id INTEGER REFERENCES quotations(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  -- The group entity issuing this document. Fixed at creation.
  company_id INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id),
  is_export INTEGER NOT NULL DEFAULT 0,
  order_through TEXT NOT NULL DEFAULT '',
  spoc TEXT NOT NULL DEFAULT '',
  po_number TEXT NOT NULL DEFAULT '',
  po_date TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'INR',
  tax_type TEXT NOT NULL DEFAULT 'none' CHECK (tax_type IN ('none','cgst_sgst','igst')),
  payment_terms TEXT NOT NULL DEFAULT '',
  freight REAL NOT NULL DEFAULT 0,
  insurance REAL NOT NULL DEFAULT 0,
  inco_terms TEXT NOT NULL DEFAULT '',
  container_count TEXT NOT NULL DEFAULT '',
  advance_due REAL NOT NULL DEFAULT 0,
  advance_amount REAL NOT NULL DEFAULT 0,
  advance_received_date TEXT NOT NULL DEFAULT '',
  destination TEXT NOT NULL DEFAULT '',
  transport TEXT NOT NULL DEFAULT '',
  freight_terms TEXT NOT NULL DEFAULT '',
  promised_date TEXT NOT NULL DEFAULT '',
  scheduled_date TEXT NOT NULL DEFAULT '',
  revised_date TEXT NOT NULL DEFAULT '',
  actual_production_date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','scheduled','in_production','ready','partially_dispatched','completed','cancelled')),
  -- What the status was when the shipping record closed the order, so that
  -- deleting an invoice re-opens it to where it was. Empty when a human closed
  -- it, which is what keeps a deliberately short-shipped order closed.
  -- See services/orderStatus.ts.
  status_before_completed TEXT NOT NULL DEFAULT '',
  remarks TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  column_config TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id),
  subtotal REAL NOT NULL DEFAULT 0,
  tax_total REAL NOT NULL DEFAULT 0,
  grand_total REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL DEFAULT '',
  hsn_code TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL DEFAULT '',
  qty REAL,
  unit TEXT NOT NULL DEFAULT 'unit',
  unit_price REAL NOT NULL DEFAULT 0,
  tax_pct REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '',
  packs REAL,
  pcs_per_pack REAL,
  total_pcs REAL,
  -- Loadability, copied from the catalogue when the product is picked so an
  -- old document keeps the figures it was quoted on.
  qty_20ft REAL,
  qty_40ft REAL,
  -- A charge, not goods: freight, insurance, tooling, a testing fee. It bills at
  -- its own price and is left out of every quantity column and total.
  is_charge INTEGER NOT NULL DEFAULT 0,
  supplier TEXT NOT NULL DEFAULT '',
  scheduled_date TEXT NOT NULL DEFAULT '',
  dispatched_date TEXT NOT NULL DEFAULT '',
  custom1 TEXT NOT NULL DEFAULT '',
  custom2 TEXT NOT NULL DEFAULT '',
  custom3 TEXT NOT NULL DEFAULT '',
  -- Optional photo for this line (base64 data URL); printed on quotations.
  image TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS proforma_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  quotation_id INTEGER REFERENCES quotations(id),
  order_id INTEGER REFERENCES orders(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  -- The group entity issuing this document. Fixed at creation.
  company_id INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id),
  consignee TEXT NOT NULL DEFAULT '',
  notify_party TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'INR',
  freight REAL NOT NULL DEFAULT 0,
  insurance REAL NOT NULL DEFAULT 0,
  lead_time TEXT NOT NULL DEFAULT '',
  bank_account TEXT NOT NULL DEFAULT '',
  inco_terms TEXT NOT NULL DEFAULT '',
  payment_terms TEXT NOT NULL DEFAULT '',
  delivery_terms TEXT NOT NULL DEFAULT '',
  validity_date TEXT NOT NULL DEFAULT '',
  is_export INTEGER NOT NULL DEFAULT 0,
  country_of_origin TEXT NOT NULL DEFAULT '',
  port_of_loading TEXT NOT NULL DEFAULT '',
  port_of_discharge TEXT NOT NULL DEFAULT '',
  final_destination TEXT NOT NULL DEFAULT '',
  container_count TEXT NOT NULL DEFAULT '',
  partial_shipment TEXT NOT NULL DEFAULT 'Not Allowed',
  po_number TEXT NOT NULL DEFAULT '',
  po_date TEXT NOT NULL DEFAULT '',
  notify_party_2 TEXT NOT NULL DEFAULT '',
  method_of_despatch TEXT NOT NULL DEFAULT '',
  quantity_tolerance TEXT NOT NULL DEFAULT '',
  hs_code TEXT NOT NULL DEFAULT '',
  prepared_by TEXT NOT NULL DEFAULT '',
  -- Printed, as the remarks on the proforma itself.
  remarks TEXT NOT NULL DEFAULT '',
  -- Never printed. The team's own record, the same field quotations have had
  -- from the beginning and proformas never did.
  internal_notes TEXT NOT NULL DEFAULT '',
  tax_type TEXT NOT NULL DEFAULT 'none' CHECK (tax_type IN ('none','cgst_sgst','igst')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','order_confirmed','advance_received','in_production','cancelled')),
  -- Where to put the proforma back if the order booked from it is deleted.
  -- Filled only when syncProformaOrdered sets 'in_production', so an empty
  -- value means somebody put it there themselves and it stays.
  status_before_ordered TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  approval_status TEXT NOT NULL DEFAULT 'not_submitted' CHECK (approval_status IN ('not_submitted','pending','approved','rejected')),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT NOT NULL DEFAULT '',
  approval_note TEXT NOT NULL DEFAULT '',
  column_config TEXT NOT NULL DEFAULT '{}',
  subtotal REAL NOT NULL DEFAULT 0,
  tax_total REAL NOT NULL DEFAULT 0,
  grand_total REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pi_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pi_id INTEGER NOT NULL REFERENCES proforma_invoices(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL DEFAULT '',
  hsn_code TEXT NOT NULL DEFAULT '',
  qty REAL,
  unit TEXT NOT NULL DEFAULT 'unit',
  unit_price REAL NOT NULL DEFAULT 0,
  tax_pct REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '',
  packs REAL,
  pcs_per_pack REAL,
  total_pcs REAL,
  -- Loadability, copied from the catalogue when the product is picked so an
  -- old document keeps the figures it was quoted on.
  qty_20ft REAL,
  qty_40ft REAL,
  -- A charge, not goods: freight, insurance, tooling, a testing fee. It bills at
  -- its own price and is left out of every quantity column and total.
  is_charge INTEGER NOT NULL DEFAULT 0,
  custom1 TEXT NOT NULL DEFAULT '',
  custom2 TEXT NOT NULL DEFAULT '',
  custom3 TEXT NOT NULL DEFAULT '',
  -- Optional photo for this line (base64 data URL); printed on quotations.
  image TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS commercial_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  pi_id INTEGER REFERENCES proforma_invoices(id),
  order_id INTEGER REFERENCES orders(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  -- The group entity issuing this document. Fixed at creation.
  company_id INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id),
  consignee TEXT NOT NULL DEFAULT '',
  notify_party TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'INR',
  freight REAL NOT NULL DEFAULT 0,
  insurance REAL NOT NULL DEFAULT 0,
  shipping_details TEXT NOT NULL DEFAULT '',
  bank_account TEXT NOT NULL DEFAULT '',
  inco_terms TEXT NOT NULL DEFAULT '',
  payment_terms TEXT NOT NULL DEFAULT '',
  is_export INTEGER NOT NULL DEFAULT 0,
  country_of_origin TEXT NOT NULL DEFAULT '',
  port_of_loading TEXT NOT NULL DEFAULT '',
  port_of_discharge TEXT NOT NULL DEFAULT '',
  final_destination TEXT NOT NULL DEFAULT '',
  notify_party_2 TEXT NOT NULL DEFAULT '',
  method_of_despatch TEXT NOT NULL DEFAULT '',
  lot_no TEXT NOT NULL DEFAULT '',
  prepared_by TEXT NOT NULL DEFAULT '',
  -- The LUT/ARN this shipment was cleared under. Per invoice, not per company:
  -- a fresh reference is obtained for each export consignment.
  arn_ref TEXT NOT NULL DEFAULT '',
  remarks TEXT NOT NULL DEFAULT '',
  tax_type TEXT NOT NULL DEFAULT 'none' CHECK (tax_type IN ('none','cgst_sgst','igst')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final','dispatched','paid')),
  -- What the status was when the payment record promoted it to 'paid', so that
  -- deleting a mis-keyed payment puts back what was there rather than guessing.
  -- See services/invoiceStatus.ts.
  status_before_paid TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  approval_status TEXT NOT NULL DEFAULT 'not_submitted' CHECK (approval_status IN ('not_submitted','pending','approved','rejected')),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT NOT NULL DEFAULT '',
  approval_note TEXT NOT NULL DEFAULT '',
  column_config TEXT NOT NULL DEFAULT '{}',
  subtotal REAL NOT NULL DEFAULT 0,
  tax_total REAL NOT NULL DEFAULT 0,
  grand_total REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES commercial_invoices(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL DEFAULT '',
  hsn_code TEXT NOT NULL DEFAULT '',
  qty REAL,
  unit TEXT NOT NULL DEFAULT 'unit',
  unit_price REAL NOT NULL DEFAULT 0,
  tax_pct REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '',
  packs REAL,
  pcs_per_pack REAL,
  total_pcs REAL,
  -- Loadability, copied from the catalogue when the product is picked so an
  -- old document keeps the figures it was quoted on.
  qty_20ft REAL,
  qty_40ft REAL,
  -- A charge, not goods: freight, insurance, tooling, a testing fee. It bills at
  -- its own price and is left out of every quantity column and total.
  is_charge INTEGER NOT NULL DEFAULT 0,
  custom1 TEXT NOT NULL DEFAULT '',
  custom2 TEXT NOT NULL DEFAULT '',
  custom3 TEXT NOT NULL DEFAULT '',
  -- Optional photo for this line (base64 data URL); printed on quotations.
  image TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS packing_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  invoice_id INTEGER REFERENCES commercial_invoices(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  -- The group entity issuing this document. Fixed at creation.
  company_id INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id),
  shipping_marks TEXT NOT NULL DEFAULT '',
  lot_no TEXT NOT NULL DEFAULT '',
  remarks TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  column_config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS packing_list_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  packing_list_id INTEGER NOT NULL REFERENCES packing_lists(id) ON DELETE CASCADE,
  hsn_code TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  qty REAL,
  unit TEXT NOT NULL DEFAULT 'unit',
  packages TEXT NOT NULL DEFAULT '',
  dimensions TEXT NOT NULL DEFAULT '',
  gross_weight REAL NOT NULL DEFAULT 0,
  net_weight REAL NOT NULL DEFAULT 0,
  -- Mirrors the invoice line. Nothing is packed against a freight charge, so
  -- the row is kept (the two lists match by index) but never printed.
  is_charge INTEGER NOT NULL DEFAULT 0,
  custom1 TEXT NOT NULL DEFAULT '',
  custom2 TEXT NOT NULL DEFAULT '',
  custom3 TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('enquiry','quotation','proforma','invoice','general')),
  doc_id INTEGER,
  customer_id INTEGER REFERENCES customers(id),
  due_date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pi_id INTEGER REFERENCES proforma_invoices(id),
  invoice_id INTEGER REFERENCES commercial_invoices(id),
  customer_id INTEGER REFERENCES customers(id),
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  method TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One running series per company, doc type and fiscal year. An existing
-- database keyed only on (doc_type, year) is rebuilt into this shape by
-- db/connection.ts — SQLite cannot alter a primary key in place.
CREATE TABLE IF NOT EXISTS sequences (
  company_id INTEGER NOT NULL DEFAULT 1,
  doc_type TEXT NOT NULL,
  year INTEGER NOT NULL,
  next_num INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, doc_type, year)
);

-- The unique indexes on document numbers are created in db/connection.ts, not
-- here: this file runs first on every boot, so an existing database holding
-- duplicates would fail to start before anything could clean them up.

/* ==================================================================
   Production masters
   ------------------------------------------------------------------
   The factory side of the app. Everything physical — stock, work
   orders, despatches — names a location, because the real order desk
   despatches from two plants (Jungalpur and PACK SKRL).
   ================================================================== */

-- A plant or godown. Stock is held per location, never pooled.
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  -- Retired rather than deleted, so old work orders keep their plant.
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Who we buy from. order_items.supplier stays free text; purchase orders
-- point here.
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_person TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  gstin TEXT NOT NULL DEFAULT '',
  payment_terms TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Who carries it. "Self" is nearly half of the real despatches, so it is
-- seeded rather than typed every time.
CREATE TABLE IF NOT EXISTS transporters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Raw material and packing. Unit is the stock unit (kg for resin, pcs for
-- cartons) and is what every ledger entry for this material is read in.
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'resin' CHECK (category IN ('resin','masterbatch','packing','other')),
  unit TEXT NOT NULL DEFAULT 'kg',
  hsn_code TEXT NOT NULL DEFAULT '',
  -- Below this, the material wants reordering. 0 = no level set.
  reorder_level REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Moulding machines, belonging to a plant.
CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  location_id INTEGER REFERENCES locations(id),
  type TEXT NOT NULL DEFAULT 'moulding' CHECK (type IN ('moulding','assembly','other')),
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Moulds. `cavities` is recorded because it is worth knowing, and is
-- deliberately not used for any capacity arithmetic.
CREATE TABLE IF NOT EXISTS moulds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  cavities INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The recipe: what one product consumes, per 1000 pieces.
--
-- Per 1000 because that is the basis the whole catalogue is priced and
-- quoted on. A 119 g preform is 119000 g — i.e. 119 kg — per 1000 pieces.
-- A product with no rows here has *no recipe*, which is not the same as
-- needing nothing; every reader must say so rather than showing zero.
CREATE TABLE IF NOT EXISTS product_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  qty_per_1000 REAL NOT NULL DEFAULT 0,
  -- Expected process loss, added on top of the requirement.
  wastage_pct REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_product_materials_product ON product_materials(product_id);

/* What to measure on this product, and what counts as good. The QC spec the
   demo made the case for: dimensions per SKU, plus the visual checks a
   multicolour range needs. Like the recipe, it is a short list rewritten
   whole. */
CREATE TABLE IF NOT EXISTS product_qc_params (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- 'numeric' takes a measurement and compares it to the tolerance below.
  -- 'boolean' is the eye: colour match, flash, short shot — pass or fail.
  kind TEXT NOT NULL DEFAULT 'numeric' CHECK (kind IN ('numeric','boolean')),
  unit TEXT NOT NULL DEFAULT '',
  -- Either end may be open: a wall thickness can have a floor and no ceiling.
  min_value REAL,
  max_value REAL,
  notes TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_product_qc_params_product ON product_qc_params(product_id);

/* One inspection of a job: a few pieces off the machine, measured. */
CREATE TABLE IF NOT EXISTS qc_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  shift TEXT NOT NULL DEFAULT '',
  -- How many pieces were looked at. Not a quantity of production; a sample.
  sample_size REAL,
  inspector TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_qc_checks_wo ON qc_checks(work_order_id);

/* One measurement. The tolerance is copied here from the parameter as the
   check is recorded, for the same reason material_moves.rate is stamped at
   receipt: tightening a spec next month must not retroactively fail a batch
   that passed against the spec in force at the time. Pass/fail is derived
   from these two columns and never stored. */
CREATE TABLE IF NOT EXISTS qc_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id INTEGER NOT NULL REFERENCES qc_checks(id) ON DELETE CASCADE,
  -- ON DELETE SET NULL, not a hard reference: the spec is rewritten whole
  -- every time it is edited, and a result must survive that. Everything
  -- needed to read one is copied below, so the link is a convenience for
  -- grouping and nothing depends on it still pointing somewhere.
  param_id INTEGER REFERENCES product_qc_params(id) ON DELETE SET NULL,
  -- Kept so a result still reads after its parameter is renamed or removed.
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'numeric',
  unit TEXT NOT NULL DEFAULT '',
  -- The measurement: a dimension, or 1/0 for a visual check.
  value REAL,
  min_value REAL,
  max_value REAL,
  notes TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_qc_results_check ON qc_results(check_id);

/* ==================================================================
   Production
   ------------------------------------------------------------------
   A work order is one job on the floor: make this much of this line
   of this sales order. Progress is never stored — it is the sum of
   the day entries below, the same rule dispatch and receivables use.
   ================================================================== */

CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL,
  company_id INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id),
  -- Every job belongs to a sales order, which is also what decides who may
  -- see it: the scope rules run through the order's customer. Make-to-stock
  -- would need its own answer to that and is deliberately not modelled yet.
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- Position of the order line this job is against — the same index-matching
  -- rule syncPackingList() and dispatchProgress() use.
  order_line INTEGER NOT NULL DEFAULT 0,
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL DEFAULT '',
  -- Pieces to make. Pieces, not billing units: the floor counts pieces.
  qty_planned REAL NOT NULL DEFAULT 0,
  location_id INTEGER REFERENCES locations(id),
  machine_id INTEGER REFERENCES machines(id),
  mould_id INTEGER REFERENCES moulds(id),
  planned_start TEXT NOT NULL DEFAULT '',
  planned_end TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','released','running','paused','done','cancelled')),
  notes TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_work_orders_order ON work_orders(order_id);

-- One shift's output. Several rows a day is normal, and deleting one has to
-- reduce the progress — which it does, because progress is only ever a sum.
CREATE TABLE IF NOT EXISTS production_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  shift TEXT NOT NULL DEFAULT '',
  qty_ok REAL NOT NULL DEFAULT 0,
  qty_reject REAL NOT NULL DEFAULT 0,
  operator TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_production_entries_wo ON production_entries(work_order_id);

/* ==================================================================
   Material
   ------------------------------------------------------------------
   One ledger, signed. Stock on hand is the sum of the moves for a
   material at a location — there is no stock column anywhere, so a
   figure can never disagree with the movements that produced it, and
   every kilo is traceable to a receipt, an issue or an adjustment.
   ================================================================== */

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL,
  company_id INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  -- Where it is to be delivered; receipts default here.
  location_id INTEGER REFERENCES locations(id),
  date TEXT NOT NULL,
  expected_date TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'INR',
  tax_type TEXT NOT NULL DEFAULT 'igst' CHECK (tax_type IN ('none','cgst_sgst','igst')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','part_received','received','cancelled')),
  payment_terms TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  -- Bought from abroad. Not `is_export`: on a purchase the foreign party is
  -- the seller, so the word would name the wrong side of the table. It picks
  -- the import numbering series, and is fixed once a number has been issued.
  is_import INTEGER NOT NULL DEFAULT 0,
  -- The header the supplier reads, off Aglo's own purchase order. `ship_to`
  -- is text rather than the location alone: the plant says where it goes, the
  -- address says who signs for it, and the two are not always the same words.
  attn TEXT NOT NULL DEFAULT '',
  vendor_ref TEXT NOT NULL DEFAULT '',
  ship_to TEXT NOT NULL DEFAULT '',
  inco_terms TEXT NOT NULL DEFAULT '',
  transport TEXT NOT NULL DEFAULT '',
  ship_via TEXT NOT NULL DEFAULT '',
  packing TEXT NOT NULL DEFAULT '',
  subtotal REAL NOT NULL DEFAULT 0,
  tax_total REAL NOT NULL DEFAULT 0,
  -- Tax collected at source: a percentage of the whole, not of a line, which
  -- is why it is a header field and not a line's tax_pct. computeTotals owns
  -- the arithmetic; 0 means the document does not carry it and nothing prints.
  tcs_pct REAL NOT NULL DEFAULT 0,
  tcs_amount REAL NOT NULL DEFAULT 0,
  grand_total REAL NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS po_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  -- What is being bought. At most one of these is set; neither is a free-text
  -- line, which has always been legal. A product because Aglo buys finished
  -- and semi-finished goods in as well as resin — the reference purchase order
  -- this was built against is for preforms.
  material_id INTEGER REFERENCES materials(id),
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL DEFAULT '',
  qty REAL,
  unit TEXT NOT NULL DEFAULT 'kg',
  -- Packing, as the supplier states it: cartons/bags, and what is in one.
  -- Same three columns and the same meaning as every other item table, so
  -- billedQty derives the quantity for a piece-priced line exactly as it does
  -- on a quotation.
  packs REAL,
  pcs_per_pack REAL,
  total_pcs REAL,
  rate REAL NOT NULL DEFAULT 0,
  tax_pct REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_po_items_po ON po_items(po_id);

/* What arrived against one purchase order line.

   Two records, one transaction, two different questions: this is *what came in
   against this order*, and material_moves is *what that did to the stock*.
   Received is derived from here alone, so the two can never disagree about the
   first question — and a line naming a product can have progress at all, which
   it could not while received was a sum over a materials-only ledger.

   Keyed by line **position**, not po_items.id: saving a purchase order deletes
   and reinserts every line, so a row id does not survive an edit. Position
   matching is this codebase's rule everywhere else — work_orders.order_line,
   dispatchProgress, syncPackingList. */
CREATE TABLE IF NOT EXISTS po_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  po_line INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  qty REAL NOT NULL,
  location_id INTEGER REFERENCES locations(id),
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_po_receipts_po ON po_receipts(po_id);

-- The ledger. `qty` is signed: positive in, negative out. How much has been
-- received against a purchase order is therefore a sum over these rows, not a
-- column on the order that someone has to remember to update.
CREATE TABLE IF NOT EXISTS material_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  date TEXT NOT NULL,
  qty REAL NOT NULL,
  -- What a unit was worth **coming in**, stamped at the time of the movement.
  -- NULL on the way out: an issue is valued at the running average, which is a
  -- reading of the ledger and so is derived, never stored. NULL is also what a
  -- receipt booked before costing existed carries — unknown, not free.
  --
  -- Stamped rather than read back through `po_id` later, because editing a
  -- purchase order after delivery would otherwise rewrite what the stock in
  -- the shed cost.
  rate REAL,
  source TEXT NOT NULL DEFAULT 'adjustment'
    CHECK (source IN ('opening','po_receipt','issue','return','adjustment','transfer')),
  -- What caused it, where there is something to point at. A transfer between
  -- plants is two rows, out of one and into the other.
  po_id INTEGER REFERENCES purchase_orders(id),
  work_order_id INTEGER REFERENCES work_orders(id),
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/* ==================================================================
   Despatch
   ------------------------------------------------------------------
   The physical record of goods leaving a plant — the Despatch sheet
   the order desk keeps, roughly 465 lines a month. Separate from the
   invoice on purpose: a lorry can leave before the invoice is raised,
   and the sheet shows that it regularly does.

   The invoice remains the money truth. These rows say what went out
   the gate, and the Dispatch tab shows both so a mismatch is visible
   rather than quietly reconciled.
   ================================================================== */

CREATE TABLE IF NOT EXISTS despatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- Which plant it left from. The sheet's "From" column: Jungalpur, PACK SKRL.
  location_id INTEGER REFERENCES locations(id),
  date TEXT NOT NULL,
  destination TEXT NOT NULL DEFAULT '',
  transporter_id INTEGER REFERENCES transporters(id),
  -- Consignment note / LR number, and the vehicle. Filled on 33 of 465 real
  -- lines, so both are optional by design rather than by omission.
  cn_no TEXT NOT NULL DEFAULT '',
  vehicle_no TEXT NOT NULL DEFAULT '',
  -- Free text: the real sheet says things like "5-6 Days".
  tentative_delivery TEXT NOT NULL DEFAULT '',
  freight_terms TEXT NOT NULL DEFAULT '',
  -- Nullable: the goods can go before the paperwork catches up.
  invoice_id INTEGER REFERENCES commercial_invoices(id),
  notes TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_despatches_order ON despatches(order_id);

CREATE TABLE IF NOT EXISTS despatch_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  despatch_id INTEGER NOT NULL REFERENCES despatches(id) ON DELETE CASCADE,
  -- Position of the order line, the index-matching rule used throughout.
  order_line INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  -- Pieces, and the boxes they went in — the sheet records both.
  qty REAL,
  packs REAL,
  notes TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_despatch_items_despatch ON despatch_items(despatch_id);

CREATE INDEX IF NOT EXISTS idx_material_moves_material ON material_moves(material_id, location_id);
CREATE INDEX IF NOT EXISTS idx_material_moves_po ON material_moves(po_id);
CREATE INDEX IF NOT EXISTS idx_material_moves_wo ON material_moves(work_order_id);

-- Who changed what, and when (2026-08). Append-only: nothing updates or
-- deletes a row here, which is the whole point of keeping one.
--
-- `user_name` is stored beside `user_id` on purpose. A user can be deleted,
-- and "someone who no longer works here raised this credit note" is exactly
-- the sentence the log exists to be able to say — the same reason a document
-- LEFT JOINs its company rather than requiring one.
--
-- `changes` is a JSON array of {field, from, to}, holding only the fields that
-- actually differed. A password hash is never read, and a value too long to be
-- worth keeping (a base64 logo) is recorded as changed without its content.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name TEXT NOT NULL DEFAULT '',
  -- The URL segment: 'quotations', 'work-orders', 'payments'. The client's
  -- vocabulary, so a link back to the record needs no translation table.
  entity TEXT NOT NULL,
  entity_id INTEGER,
  -- create | update | delete | login | login_failed | or the verb of a
  -- POST /:id/<verb> route: status, submit, approve, reject, revise, entries…
  action TEXT NOT NULL,
  -- The document number or name at the time, so the log reads without a join
  -- to a row that may since have been deleted.
  label TEXT NOT NULL DEFAULT '',
  changes TEXT NOT NULL DEFAULT '[]',
  -- Kept for the rare case where the record was not a table row.
  note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(id DESC);
