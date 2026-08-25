/**
 * Demo data for a sample run: customers, products, enquiries, quotations in
 * every status (including a negotiation revision), a proforma with PO and
 * advance payment, a dispatched commercial invoice, a packing list and
 * follow-ups — spread over recent months so the dashboard charts have shape.
 *
 * Usage:  npm run seed          (refuses to touch a database that already has customers)
 *         npm run seed -- --force   (adds demo data anyway)
 *
 * It does NOT create or modify user accounts, except when the database has no
 * users at all — then it creates demo@example.com / demo1234 so reviewers can
 * log straight in. Company settings are filled only if empty.
 */
import bcrypt from 'bcryptjs';
import { db, transaction } from './connection.js';
import { nextNumber } from '../services/numbering.js';
import { computeTotals, type LineItemInput } from '../services/totals.js';
import { defaultCompanyId } from '../services/companies.js';

/** Demo data belongs to the group's default company. */
const seedCompanyId = defaultCompanyId();

const force = process.argv.includes('--force');

const existing = db.prepare('SELECT COUNT(*) AS c FROM customers').get() as { c: number };
if (existing.c > 0 && !force) {
  console.log('Database already has data — refusing to seed. Run with --force to add demo data anyway.');
  process.exit(1);
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => iso(new Date(Date.now() + n * 86400000));

const users = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
let managerId: number;
let employeeId: number;
if (users.c === 0) {
  const mk = (name: string, email: string, pw: string, role: string) =>
    Number(db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(name, email, bcrypt.hashSync(pw, 10), role).lastInsertRowid);
  managerId = mk('Demo Manager', 'manager@example.com', 'demo1234', 'manager');
  employeeId = mk('Demo Employee', 'employee@example.com', 'demo1234', 'employee');
  console.log('Created logins →  manager@example.com / demo1234   and   employee@example.com / demo1234');
} else {
  managerId = Number((db.prepare("SELECT id FROM users WHERE role = 'manager' ORDER BY id LIMIT 1").get() as { id: number } | undefined)?.id
    ?? (db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number }).id);
  employeeId = Number((db.prepare("SELECT id FROM users WHERE role = 'employee' ORDER BY id LIMIT 1").get() as { id: number } | undefined)?.id ?? managerId);
}

const seedCompany = db.prepare('SELECT company_name FROM companies WHERE id = ?').get(seedCompanyId) as { company_name: string };
if (!seedCompany.company_name) {
  db.prepare(
    `UPDATE companies SET company_name = ?, address = ?, city = ?, state = ?, country = ?, pincode = ?,
     phone = ?, email = ?, website = ?, gstin = ?, pan = ?, iec = ?, default_terms = ?, bank_accounts = ? WHERE id = ?`
  ).run(
    'Demo Metals & Alloys Pvt. Ltd.',
    'Plot 42, Industrial Area Phase II',
    'Kolkata', 'West Bengal', 'India', '700088',
    '+91 98300 12345', 'sales@demometals.example', 'www.demometals.example',
    '19AABCD1234F1Z5', 'AABCD1234F', '0212345678',
    '1. Prices are ex-works unless stated otherwise. 2. Statutory levies at the time of supply will be charged extra. 3. Subject to Kolkata jurisdiction.',
    JSON.stringify([
      { label: 'HDFC Bank — INR', details: 'HDFC Bank, Park Street Branch\nA/C 5020 0012 3456 78\nIFSC: HDFC0000123' },
      { label: 'HDFC Bank — Export (USD/EUR)', details: 'HDFC Bank, Park Street Branch\nA/C 5020 0098 7654 32\nSWIFT: HDFCINBBXXX' },
    ]),
    seedCompanyId
  );
  console.log('Filled in demo company profile (Settings)');
}

// Customers are split between the manager and the employee so the access rules are visible.
const insertCustomer = db.prepare(
  `INSERT INTO customers (name, contact_person, email, phone, address, city, country, gstin, currency, consignee, notify_party, notify_party_2, owner_id, is_export)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const customers = {
  bharat: Number(insertCustomer.run('Bharat Engineering Works', 'Rajesh Kumar', 'purchase@bharatengg.example', '+91 99887 66554',
    '14 MIDC Industrial Estate, Andheri East', 'Mumbai', 'India', '27AAACB9876K1Z3', 'INR', '', '', '', employeeId, 0).lastInsertRowid),
  shakti: Number(insertCustomer.run('Shakti Fabricators', 'Priya Nair', 'priya@shaktifab.example', '+91 98765 43210',
    '7 Howrah Industrial Belt', 'Howrah', 'India', '19AABCS5432L1Z8', 'INR', '', '', '', employeeId, 0).lastInsertRowid),
  acme: Number(insertCustomer.run('Acme Maschinenbau GmbH', 'Stefan Weber', 'einkauf@acme-mb.example', '+49 30 1234567',
    'Industriestrasse 12', 'Berlin', 'Germany', '', 'EUR', 'Acme Warehouse GmbH\nHafenstrasse 8, Hamburg, Germany',
    'Global Freight Forwarders, Hamburg', 'Nordbank Trade Services, Ebene Cybercity, Mauritius', managerId, 1).lastInsertRowid),
  titan: Number(insertCustomer.run('Titan Industrial Supply LLC', 'Mike Ross', 'mike@titansupply.example', '+1 713 555 0142',
    '2400 Port Rd, Houston, TX', 'Houston', 'USA', '', 'USD', '', '', '', managerId, 1).lastInsertRowid),
};

const insertProduct = db.prepare(
  'INSERT INTO products (name, description, hsn_code, unit, unit_price, country_of_origin) VALUES (?, ?, ?, ?, ?, ?)'
);
insertProduct.run('MS Forged Flange DN100', 'MS Forged Flange, DIN 2633, DN 100 PN16', '7307', 'unit', 485, 'India');
insertProduct.run('MS Forged Flange DN150', 'MS Forged Flange, DIN 2633, DN 150 PN16', '7307', 'unit', 710, 'India');
insertProduct.run('EN8 Round Bar 63mm', 'Carbon Steel Round Bar, EN8, 63mm dia', '7214', 'tonne', 62500, 'India');
insertProduct.run('SS304 Hex Bolt M16', 'Stainless Steel 304 Hex Bolt M16x60 with nut', '7318', 'per 1000', 8200, 'India');
insertProduct.run('Alloy Steel Forging', 'Alloy Steel Die Forging, EN19, machined', '7326', 'kg', 210, 'India');

type Item = LineItemInput;

function createQuotation(opts: {
  customer: number; date: string; currency: string; taxType: 'none' | 'cgst_sgst' | 'igst';
  status: string; validity?: string; payment?: string; delivery?: string; items: Item[];
  number?: string; revision?: number; isExport?: boolean; createdBy?: number; approval?: string;
}): { id: number; number: string } {
  return transaction(() => {
    const number = opts.number ?? nextNumber('quotation', { companyId: seedCompanyId });
    const totals = computeTotals(opts.items, opts.taxType, 0, 0, opts.currency);
    const approval = opts.approval ?? (opts.status === 'draft' ? 'not_submitted' : 'approved');
    const info = db.prepare(
      `INSERT INTO quotations (number, revision, date, customer_id, currency, validity_date, payment_terms, delivery_terms, tax_type, status, is_export, created_by, approval_status, subtotal, tax_total, grand_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(number, opts.revision ?? 0, opts.date, opts.customer, opts.currency,
      opts.validity ?? daysFromNow(30), opts.payment ?? '50% advance, balance before dispatch',
      opts.delivery ?? '4-6 weeks from advance', opts.taxType, opts.status,
      opts.isExport ? 1 : 0, opts.createdBy ?? managerId, approval,
      totals.subtotal, totals.tax_total, totals.grand_total);
    const id = Number(info.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO quotation_items (quotation_id, product_id, description, hsn_code, qty, unit, unit_price, tax_pct, amount, color, packs, pcs_per_pack, total_pcs, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    totals.items.forEach((it, i) => ins.run(id, it.product_id ?? null, it.description, it.hsn_code ?? '',
      it.qty ?? null, it.unit ?? 'unit', it.unit_price, it.tax_pct ?? 0, it.amount,
      it.color ?? '', it.packs ?? null, it.pcs_per_pack ?? null, it.total_pcs ?? null, i));
    return { id, number };
  });
}

const flangeSmall: Item = { description: 'MS Forged Flange, DIN 2633, DN 100 PN16', hsn_code: '7307', qty: 500, unit: 'unit', unit_price: 485, tax_pct: 18 };
const flangeBig: Item = { description: 'MS Forged Flange, DIN 2633, DN 150 PN16', hsn_code: '7307', qty: 300, unit: 'unit', unit_price: 710, tax_pct: 18 };
const bar: Item = { description: 'Carbon Steel Round Bar, EN8, 63mm dia', hsn_code: '7214', qty: 2.4, unit: 'tonne', unit_price: 62500, tax_pct: 18 };
const bolts: Item = { description: 'SS304 Hex Bolt M16x60 with nut', hsn_code: '7318', qty: 12, unit: 'per 1000', unit_price: 8200, tax_pct: 18 };
const forgingEUR: Item = { description: 'Alloy Steel Die Forging, EN19, machined (2.1 ±0.1) kg', hsn_code: '7326', qty: 8500, unit: 'kg', unit_price: 2.6, color: 'Natural', packs: 18, pcs_per_pack: 225, total_pcs: 4050 };
const flangeEUR: Item = { description: 'MS Forged Flange, DIN 2633, DN 100 PN16', hsn_code: '7307', qty: 2000, unit: 'unit', unit_price: 5.4, color: 'Silver', packs: 6, pcs_per_pack: 334, total_pcs: 2000 };
const barUSD: Item = { description: 'Carbon Steel Round Bar, EN8, 63mm dia', hsn_code: '7214', qty: 18, unit: 'tonne', unit_price: 780 };

// Quotations across months, statuses, owners and export/domestic
createQuotation({ customer: customers.bharat, date: daysFromNow(-65), currency: 'INR', taxType: 'igst', status: 'accepted', createdBy: employeeId, items: [flangeSmall, flangeBig, bar] });
const qAcme = createQuotation({ customer: customers.acme, date: daysFromNow(-88), currency: 'EUR', taxType: 'none', status: 'sent', isExport: true, items: [forgingEUR, flangeEUR] });
// Negotiation: Acme pushed price from 2.60 to 2.45 — revision 1 accepted
const qAcmeR1 = createQuotation({
  customer: customers.acme, date: daysFromNow(-80), currency: 'EUR', taxType: 'none', status: 'accepted', isExport: true,
  number: qAcme.number, revision: 1, items: [{ ...forgingEUR, unit_price: 2.45 }, flangeEUR],
});
db.prepare('UPDATE quotations SET superseded_by = ?, status = ? WHERE id = ?').run(qAcmeR1.id, 'negotiating', qAcme.id);
createQuotation({ customer: customers.titan, date: daysFromNow(-35), currency: 'USD', taxType: 'none', status: 'negotiating', isExport: true, items: [barUSD] });
// Waiting on the manager — shows the approval queue in action.
createQuotation({ customer: customers.shakti, date: daysFromNow(-20), currency: 'INR', taxType: 'cgst_sgst', status: 'draft', createdBy: employeeId, approval: 'pending', items: [bolts] });
createQuotation({ customer: customers.bharat, date: daysFromNow(-4), currency: 'INR', taxType: 'igst', status: 'draft', createdBy: employeeId, approval: 'pending', items: [bar, bolts] });
createQuotation({ customer: customers.shakti, date: daysFromNow(-100), currency: 'INR', taxType: 'cgst_sgst', status: 'expired', createdBy: employeeId, items: [{ ...bolts, qty: 5 }] });
createQuotation({ customer: customers.titan, date: daysFromNow(-58), currency: 'USD', taxType: 'none', status: 'rejected', isExport: true, items: [{ ...barUSD, qty: 10, unit_price: 815 }] });

// Proforma from the accepted Acme revision — export order with PO and advance
const piTotals = computeTotals([{ ...forgingEUR, unit_price: 2.45 }, flangeEUR], 'none', 1800, 420);
const piId = transaction(() => {
  const number = nextNumber('proforma', { companyId: seedCompanyId });
  const info = db.prepare(
    `INSERT INTO proforma_invoices (number, date, quotation_id, customer_id, consignee, notify_party, currency, freight, insurance,
       lead_time, bank_account, inco_terms, payment_terms, delivery_terms, validity_date, is_export,
       country_of_origin, port_of_loading, port_of_discharge, final_destination, container_count, partial_shipment,
       po_number, po_date, notify_party_2, method_of_despatch, quantity_tolerance, hs_code, prepared_by,
       remarks, tax_type, status, created_by, approval_status, subtotal, tax_total, grand_total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    number, daysFromNow(-72), qAcmeR1.id, customers.acme,
    'Acme Warehouse GmbH\nHafenstrasse 8, Hamburg, Germany', 'Global Freight Forwarders, Hamburg',
    'EUR', 1800, 420, '5 weeks from advance',
    'HDFC Bank, Park Street Branch\nA/C 5020 0098 7654 32\nSWIFT: HDFCINBBXXX',
    'CIF', '30% advance, balance against BL copy', 'CIF Hamburg', daysFromNow(-42), 1,
    'India', 'Nhava Sheva, India', 'Hamburg, Germany', 'Berlin, Germany', '1 x 40ft HC', 'Not Allowed',
    'ACME-PO-2311', daysFromNow(-74),
    'Nordbank Trade Services\nEbene Cybercity, Mauritius', 'By Sea', '(±) 10% in value and quantity', '7326', 'Meisha',
    'Material test certificates (EN 10204 3.1) to accompany shipment.',
    'none', 'in_production', managerId, 'approved', piTotals.subtotal, piTotals.tax_total, piTotals.grand_total
  );
  const id = Number(info.lastInsertRowid);
  const ins = db.prepare(
    `INSERT INTO pi_items (pi_id, product_id, description, hsn_code, qty, unit, unit_price, tax_pct, amount, color, packs, pcs_per_pack, total_pcs, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  piTotals.items.forEach((it, i) => ins.run(id, null, it.description, it.hsn_code ?? '', it.qty ?? null, it.unit ?? 'unit', it.unit_price, it.tax_pct ?? 0, it.amount,
    it.color ?? '', it.packs ?? null, it.pcs_per_pack ?? null, it.total_pcs ?? null, i));
  return id;
});
db.prepare('INSERT INTO payments (pi_id, customer_id, date, amount, currency, method, reference) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
  piId, customers.acme, daysFromNow(-68), Math.round(piTotals.grand_total * 0.3 * 100) / 100, 'EUR', 'Bank Transfer', 'SWIFT REF 8842013'
);

// Dispatched commercial invoice for that order (qty +2% variance on forgings) with a further payment
const invItems: Item[] = [{ ...forgingEUR, qty: 8670, unit_price: 2.45 }, flangeEUR];
const invTotals = computeTotals(invItems, 'none', 1800, 420);
const invId = transaction(() => {
  const number = nextNumber('invoice', { companyId: seedCompanyId });
  const info = db.prepare(
    `INSERT INTO commercial_invoices (number, date, pi_id, customer_id, consignee, notify_party, currency, freight, insurance,
       shipping_details, bank_account, inco_terms, payment_terms, is_export, country_of_origin, port_of_loading,
       port_of_discharge, final_destination, notify_party_2, method_of_despatch, lot_no, prepared_by,
       remarks, tax_type, status, created_by, approval_status, subtotal, tax_total, grand_total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    number, daysFromNow(-15), piId, customers.acme,
    'Acme Warehouse GmbH\nHafenstrasse 8, Hamburg, Germany', 'Global Freight Forwarders, Hamburg',
    'EUR', 1800, 420, 'MV Nordwind V.114 / BL HLCUBO1240815',
    'HDFC Bank, Park Street Branch\nA/C 5020 0098 7654 32\nSWIFT: HDFCINBBXXX',
    'CIF', '30% advance, balance against BL copy', 1, 'India', 'Nhava Sheva, India', 'Hamburg, Germany', 'Berlin, Germany',
    'Nordbank Trade Services\nEbene Cybercity, Mauritius', 'By Sea', '42/2026', 'Meisha',
    'Quantity variance within agreed 10% clause.', 'none', 'dispatched', managerId, 'approved',
    invTotals.subtotal, invTotals.tax_total, invTotals.grand_total
  );
  const id = Number(info.lastInsertRowid);
  const ins = db.prepare(
    `INSERT INTO invoice_items (invoice_id, product_id, description, hsn_code, qty, unit, unit_price, tax_pct, amount, color, packs, pcs_per_pack, total_pcs, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  invTotals.items.forEach((it, i) => ins.run(id, null, it.description, it.hsn_code ?? '', it.qty ?? null, it.unit ?? 'unit', it.unit_price, it.tax_pct ?? 0, it.amount,
    it.color ?? '', it.packs ?? null, it.pcs_per_pack ?? null, it.total_pcs ?? null, i));
  return id;
});
db.prepare('INSERT INTO payments (invoice_id, customer_id, date, amount, currency, method, reference) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
  invId, customers.acme, daysFromNow(-2), 10000, 'EUR', 'Bank Transfer', 'SWIFT REF 8842544'
);

// Packing list for the dispatch
transaction(() => {
  const number = nextNumber('packing_list', { companyId: seedCompanyId });
  const info = db.prepare(
    `INSERT INTO packing_lists (number, date, invoice_id, customer_id, shipping_marks, lot_no, remarks, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(number, daysFromNow(-15), invId, customers.acme, 'ACME / HAMBURG / PO-2311 / 1-24', '42/2026', 'Seaworthy wooden crates, VCI wrapped.', managerId);
  const id = Number(info.lastInsertRowid);
  const ins = db.prepare(
    `INSERT INTO packing_list_items (packing_list_id, description, hsn_code, qty, unit, packages, dimensions, gross_weight, net_weight, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  ins.run(id, 'Alloy Steel Die Forging, EN19, machined', '7326', 8670, 'kg', '18 crates', '120 x 80 x 60 cm', 9250, 8670, 0);
  ins.run(id, 'MS Forged Flange, DIN 2633, DN 100 PN16', '7307', 2000, 'unit', '6 crates', '100 x 80 x 50 cm', 2380, 2210, 1);
});

/*
 * Enquiries: the front of the funnel. The summary below claimed five of these
 * for a long time while the seed wrote none — the router was unmounted, so
 * nothing ever looked.
 */
const insertEnquiry = db.prepare(
  'INSERT INTO enquiries (customer_id, date, notes, status) VALUES (?, ?, ?, ?)'
);
insertEnquiry.run(customers.shakti, daysFromNow(-6), 'Rang about 20L handles — wants a price for 50,000 pcs', 'open');
insertEnquiry.run(customers.titan, daysFromNow(-12), 'Email asking whether we can hold 3.2mm wall on the bar', 'open');
// One that was answered, and the quotation that answered it.
const quotedEnquiry = Number(insertEnquiry.run(
  customers.acme, daysFromNow(-92), 'Introduced by the Dubai agent; asked for forging pricing', 'quoted'
).lastInsertRowid);
// Both the original and the revision that superseded it: `POST /:id/revise`
// carries enquiry_id forward, and linking only the original left the enquiry
// reading "quoted" with no quotation against it — quotation_count counts live
// revisions only, and the live one is the revision.
db.prepare('UPDATE quotations SET enquiry_id = ? WHERE id IN (?, ?)')
  .run(quotedEnquiry, qAcme.id, qAcmeR1.id);
insertEnquiry.run(customers.bharat, daysFromNow(-40), 'Wanted seal caps in a colour we do not run', 'lost');

// Follow-ups: one overdue, one today, one upcoming
const insertFollowup = db.prepare('INSERT INTO followups (doc_type, doc_id, customer_id, due_date, note) VALUES (?, ?, ?, ?, ?)');
insertFollowup.run('invoice', invId, customers.acme, daysFromNow(-3), 'Chase balance payment against BL copy');
insertFollowup.run('quotation', 5, customers.shakti, daysFromNow(0), 'Call Priya — quote sent, confirm bolt grade');
insertFollowup.run('quotation', 4, customers.titan, daysFromNow(3), 'Titan negotiating bar price — follow up with revised offer');

console.log('Demo data created: 4 customers, 5 products, 4 enquiries, 8 quotations (incl. 1 revision),');
console.log('1 proforma (PO + 30% advance, in production), 1 dispatched invoice (partly paid), 1 packing list, 3 follow-ups.');
