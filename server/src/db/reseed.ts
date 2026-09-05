/**
 * Rebuild the demo data around the catalogue that is already here.
 *
 * `npm run seed` fills an empty database with a generic steel-trading example.
 * This does something different and destructive: it **clears every transaction**
 * — customers, the four documents, and everything on the factory side — and
 * seeds an Aglo-shaped example in their place, built on the products already in
 * the catalogue so recipes and work orders read like the real business.
 *
 * What survives:
 *   - user accounts and their passwords
 *   - the companies (name, GSTIN, logo, numbering patterns)
 *   - every product that records pieces per box — i.e. a real catalogue entry
 *
 * What goes:
 *   - all customers, quotations, orders, proformas, invoices, packing lists,
 *     payments, follow-ups and enquiries
 *   - all production, material, purchasing and despatch records
 *   - products with no pieces-per-box, which is how the generic seeder's
 *     entries are told apart from an imported catalogue
 *
 * Usage:  npx tsx src/db/reseed.ts --confirm
 *
 * There is no undo. Copy `app.db*` — including the -wal, which usually holds
 * most of the data — before running it.
 */
import { db, transaction } from './connection.js';
import { nextNumber } from '../services/numbering.js';
import { computeTotals, type LineItemInput } from '../services/totals.js';
import { defaultCompanyId } from '../services/companies.js';

if (!process.argv.includes('--confirm')) {
  console.log('This deletes every customer and document in the database.');
  console.log('Re-run with --confirm once you have a copy of app.db, app.db-wal and app.db-shm.');
  process.exit(1);
}

const companyId = defaultCompanyId();
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (n: number) => iso(new Date(Date.now() + n * 86400000));
const one = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...(p as never[])) as { c: number }).c;

/* ------------------------------------------------------------------ */
/* What is about to be destroyed                                       */
/* ------------------------------------------------------------------ */

const keptProducts = one('SELECT COUNT(*) AS c FROM products WHERE pcs_per_pack IS NOT NULL');
const droppedProducts = one('SELECT COUNT(*) AS c FROM products WHERE pcs_per_pack IS NULL');
console.log('Clearing:');
for (const t of [
  'customers', 'enquiries', 'quotations', 'orders', 'proforma_invoices', 'commercial_invoices',
  'packing_lists', 'payments', 'followups', 'work_orders', 'production_entries',
  'despatches', 'material_moves', 'purchase_orders',
]) {
  const c = one(`SELECT COUNT(*) AS c FROM ${t}`);
  if (c) console.log(`  ${String(c).padStart(5)}  ${t}`);
}
console.log(`  ${String(droppedProducts).padStart(5)}  products with no pieces-per-box`);
console.log(`Keeping ${keptProducts} catalogue products, the companies and every login.\n`);

/* ------------------------------------------------------------------ */
/* Clear                                                               */
/* ------------------------------------------------------------------ */

transaction(() => {
  // Children before parents: there are real foreign keys here, and getting the
  // order wrong fails loudly rather than half-clearing — the whole thing runs
  // in one transaction.
  for (const t of [
    // Things that point at documents, before the documents themselves.
    'payments', 'followups',
    'production_entries', 'work_orders',
    'despatch_items', 'despatches',
    'material_moves',
    'po_items', 'purchase_orders',
    'packing_list_items', 'packing_lists',
    'invoice_items', 'commercial_invoices',
    'pi_items', 'proforma_invoices',
    'order_items', 'orders',
    'quotation_items', 'quotations',
    'enquiries', 'customers',
    'product_materials',
    'locations', 'suppliers', 'transporters', 'materials', 'machines', 'moulds',
    // Numbering restarts with the data it was counting.
    'sequences',
  ]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare('DELETE FROM products WHERE pcs_per_pack IS NULL').run();
});

const managerId = Number((db.prepare("SELECT id FROM users WHERE team_role = 'super_admin' ORDER BY id LIMIT 1").get() as { id: number } | undefined)?.id
  ?? (db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number }).id);
const employeeId = Number((db.prepare("SELECT id FROM users WHERE team_role = 'sales' ORDER BY id LIMIT 1").get() as { id: number } | undefined)?.id ?? managerId);

/* ------------------------------------------------------------------ */
/* Masters                                                             */
/* ------------------------------------------------------------------ */

const insert = (sql: string) => db.prepare(sql);
const newId = (sql: string, ...p: unknown[]) => Number(insert(sql).run(...(p as never[])).lastInsertRowid);

// The two plants that despatch in the real order desk sheet.
const jungalpur = newId(
  'INSERT INTO locations (name, code, address) VALUES (?, ?, ?)',
  'Jungalpur', 'JGP', 'Jungalpur, West Bengal'
);
const packSkrl = newId(
  'INSERT INTO locations (name, code, address) VALUES (?, ?, ?)',
  'PACK SKRL', 'SKRL', 'Serakole, West Bengal'
);

const transporters = {
  self: newId('INSERT INTO transporters (name, notes) VALUES (?, ?)', 'Self', 'Own vehicle'),
  tci: newId('INSERT INTO transporters (name, phone) VALUES (?, ?)', 'TCI Xpress', '1800-200-0977'),
  rajkamal: newId('INSERT INTO transporters (name) VALUES (?)', 'Rajkamal Transport'),
  vrl: newId('INSERT INTO transporters (name) VALUES (?)', 'VRL Logistics'),
};

const suppliers = {
  reliance: newId(
    'INSERT INTO suppliers (name, contact_person, phone, gstin, payment_terms) VALUES (?, ?, ?, ?, ?)',
    'Reliance Industries Ltd', 'Polymer Desk', '+91 22 3555 5000', '27AAACR5055K1Z7', '30 days from invoice'
  ),
  colour: newId(
    'INSERT INTO suppliers (name, contact_person, phone, payment_terms) VALUES (?, ?, ?, ?)',
    'Plastiblends India Ltd', 'S. Menon', '+91 22 6193 4000', 'Against delivery'
  ),
  carton: newId(
    'INSERT INTO suppliers (name, contact_person, phone, payment_terms) VALUES (?, ?, ?, ?)',
    'Howrah Packaging Works', 'Amit Ghosh', '+91 98300 44556', '15 days'
  ),
};

const materials = {
  pet: newId(
    'INSERT INTO materials (name, category, unit, hsn_code, reorder_level) VALUES (?, ?, ?, ?, ?)',
    'PET Resin — bottle grade', 'resin', 'kg', '3907', 8000
  ),
  hdpe: newId(
    'INSERT INTO materials (name, category, unit, hsn_code, reorder_level) VALUES (?, ?, ?, ?, ?)',
    'HDPE — injection grade', 'resin', 'kg', '3901', 6000
  ),
  pp: newId(
    'INSERT INTO materials (name, category, unit, hsn_code, reorder_level) VALUES (?, ?, ?, ?, ?)',
    'PP Copolymer', 'resin', 'kg', '3902', 4000
  ),
  blue: newId(
    'INSERT INTO materials (name, category, unit, reorder_level) VALUES (?, ?, ?, ?)',
    'Masterbatch — Bisleri Blue', 'masterbatch', 'kg', 250
  ),
  green: newId(
    'INSERT INTO materials (name, category, unit, reorder_level) VALUES (?, ?, ?, ?)',
    'Masterbatch — Green', 'masterbatch', 'kg', 200
  ),
  carton: newId(
    'INSERT INTO materials (name, category, unit, reorder_level) VALUES (?, ?, ?, ?)',
    'Carton 57x50x40 cm', 'packing', 'pcs', 500
  ),
};

const machines = {
  m1: newId('INSERT INTO machines (name, code, location_id, type) VALUES (?, ?, ?, ?)', 'Husky 300T', 'M1', jungalpur, 'moulding'),
  m2: newId('INSERT INTO machines (name, code, location_id, type) VALUES (?, ?, ?, ?)', 'Husky 200T', 'M2', jungalpur, 'moulding'),
  m3: newId('INSERT INTO machines (name, code, location_id, type) VALUES (?, ?, ?, ?)', 'Ferromatik 150T', 'M3', packSkrl, 'moulding'),
};

const moulds = {
  cap48: newId('INSERT INTO moulds (name, code, cavities) VALUES (?, ?, ?)', '48mm Seal Cap', 'MD-48SC', 24),
  cap26: newId('INSERT INTO moulds (name, code, cavities) VALUES (?, ?, ?)', '26/22 Cap', 'MD-2622', 48),
  handle: newId('INSERT INTO moulds (name, code, cavities) VALUES (?, ?, ?)', 'Deluxe Handle 2Ltr', 'MD-DH2', 16),
};

/* ------------------------------------------------------------------ */
/* Recipes, on whatever the catalogue actually holds                   */
/* ------------------------------------------------------------------ */

interface Prod { id: number; name: string; unit: string; unit_price: number; pcs_per_pack: number | null; hsn_code: string }
const catalogue = db.prepare(
  'SELECT id, name, unit, unit_price, pcs_per_pack, hsn_code FROM products WHERE pcs_per_pack IS NOT NULL ORDER BY id'
).all() as unknown as Prod[];

if (catalogue.length === 0) {
  console.error('No catalogue products with pieces-per-box — nothing to build a demo around.');
  process.exit(1);
}

/** Prefer a product whose name contains `hint`; fall back to position so this
 *  works whatever the catalogue happens to hold. */
const pick = (hint: string, fallback: number): Prod =>
  catalogue.find((p) => p.name.toLowerCase().includes(hint.toLowerCase()))
  ?? catalogue[Math.min(fallback, catalogue.length - 1)];

const cap = pick('26/22 Cap', 0);
const neck = pick('PCO 1810', 1);
const flip = pick('Flip Top Cap', 2);
const handle = pick('Handle', 3);

const recipe = db.prepare(
  'INSERT INTO product_materials (product_id, material_id, qty_per_1000, wastage_pct, sort_order) VALUES (?, ?, ?, ?, ?)'
);
// Per 1000 pieces, in the material's own stock unit — a 2.6 g cap is 2.6 kg.
recipe.run(cap.id, materials.hdpe, 2.6, 2, 0);
recipe.run(cap.id, materials.green, 0.05, 2, 1);
recipe.run(cap.id, materials.carton, cap.pcs_per_pack ? 1000 / cap.pcs_per_pack : 0.1, 0, 2);
recipe.run(neck.id, materials.pet, 21.5, 2, 0);
recipe.run(neck.id, materials.carton, neck.pcs_per_pack ? 1000 / neck.pcs_per_pack : 0.15, 0, 1);
recipe.run(flip.id, materials.pp, 3.4, 3, 0);
recipe.run(flip.id, materials.blue, 0.06, 3, 1);
// `handle` is deliberately left without a recipe, so "not costed" is visible
// somewhere in the demo rather than only in the tests.

/* ------------------------------------------------------------------ */
/* Customers                                                           */
/* ------------------------------------------------------------------ */

const insertCustomer = insert(
  `INSERT INTO customers (name, contact_person, email, phone, address, city, country, gstin, currency,
     consignee, notify_party, notify_party_2, owner_id, is_export, company_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const customers = {
  bisleri: Number(insertCustomer.run('Bisleri International Pvt Ltd', 'Procurement Desk', 'po@bisleri.example', '+91 22 6666 1000',
    'Western Express Highway, Andheri East', 'Mumbai', 'India', '27AAACB1234M1Z9', 'INR', '', '', '', managerId, 0, companyId).lastInsertRowid),
  orient: Number(insertCustomer.run('Orient Beverages Ltd', 'Sujoy Das', 'purchase@orientbev.example', '+91 33 2287 4455',
    'Salap More, NH-6', 'Howrah', 'India', '19AAACO4567P1Z2', 'INR', '', '', '', employeeId, 0, companyId).lastInsertRowid),
  gayatri: Number(insertCustomer.run('Gayatri Beverages', 'R. Prasad', 'gayatri.bev@example.com', '+91 94300 11223',
    'Industrial Area, Phase 2', 'Ranchi', 'India', '20AABCG7788Q1Z4', 'INR', '', '', '', employeeId, 0, companyId).lastInsertRowid),
  emeraude: Number(insertCustomer.run('Emeraude Trading Ltd', 'Jean-Paul Rivet', 'orders@emeraude.example', '+230 5 987 6543',
    'Ebene Cybercity', 'Ebene', 'Mauritius', '', 'USD',
    'Emeraude Warehouse\nPort Louis, Mauritius', 'Indian Ocean Freight, Port Louis',
    'MCB Trade Services, Ebene Cybercity, Mauritius', managerId, 1, companyId).lastInsertRowid),
  sanya: Number(insertCustomer.run('Sanya Industries Ltd', 'Peter Mwangi', 'procurement@sanya.example', '+254 20 555 0110',
    'Mombasa Road, Industrial Area', 'Nairobi', 'Kenya', '', 'USD',
    'Sanya Industries Ltd\nMombasa, Kenya', 'East Africa Clearing Agents, Mombasa', '', managerId, 1, companyId).lastInsertRowid),
};

/* ------------------------------------------------------------------ */
/* Line-item helpers built from the real catalogue                     */
/* ------------------------------------------------------------------ */

const line = (p: Prod, boxes: number, price: number, colour: string, tax = 18): LineItemInput => ({
  product_id: p.id,
  description: p.name,
  hsn_code: p.hsn_code || '3923',
  unit: 'per 1000',
  unit_price: price,
  tax_pct: tax,
  color: colour,
  packs: boxes,
  pcs_per_pack: p.pcs_per_pack,
  total_pcs: boxes * (p.pcs_per_pack ?? 1000),
});

/* ------------------------------------------------------------------ */
/* Quotations                                                          */
/* ------------------------------------------------------------------ */

function createQuotation(o: {
  customer: number; date: string; currency: string; taxType: 'none' | 'cgst_sgst' | 'igst';
  status: string; items: LineItemInput[]; isExport?: boolean; createdBy?: number; approval?: string;
}) {
  return transaction(() => {
    const number = nextNumber('quotation', { companyId });
    const t = computeTotals(o.items, o.taxType, 0, 0, o.currency);
    const info = insert(
      `INSERT INTO quotations (number, revision, date, customer_id, company_id, currency, validity_date, payment_terms,
         delivery_terms, tax_type, status, is_export, created_by, approval_status, subtotal, tax_total, grand_total)
       VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(number, o.date, o.customer, companyId, o.currency, day(30),
      '50% advance, balance before dispatch', '3-4 weeks from advance', o.taxType, o.status,
      o.isExport ? 1 : 0, o.createdBy ?? managerId, o.approval ?? (o.status === 'draft' ? 'not_submitted' : 'approved'),
      t.subtotal, t.tax_total, t.grand_total);
    const id = Number(info.lastInsertRowid);
    const ins = insert(
      `INSERT INTO quotation_items (quotation_id, product_id, description, hsn_code, qty, unit, unit_price, tax_pct,
         amount, color, packs, pcs_per_pack, total_pcs, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    t.items.forEach((it, i) => ins.run(id, it.product_id ?? null, it.description, it.hsn_code ?? '',
      it.qty ?? null, it.unit ?? 'unit', it.unit_price, it.tax_pct ?? 0, it.amount,
      it.color ?? '', it.packs ?? null, it.pcs_per_pack ?? null, it.total_pcs ?? null, i));
    return { id, number };
  });
}

createQuotation({ customer: customers.orient, date: day(-52), currency: 'INR', taxType: 'igst', status: 'accepted', createdBy: employeeId, items: [line(cap, 40, 0.28, 'Green'), line(flip, 12, 1.02, 'White')] });
createQuotation({ customer: customers.gayatri, date: day(-28), currency: 'INR', taxType: 'cgst_sgst', status: 'sent', createdBy: employeeId, items: [line(cap, 20, 0.29, 'Purple')] });
createQuotation({ customer: customers.sanya, date: day(-19), currency: 'USD', taxType: 'none', status: 'negotiating', isExport: true, items: [line(neck, 100, 12.9, 'Natural', 0)] });
createQuotation({ customer: customers.bisleri, date: day(-9), currency: 'INR', taxType: 'igst', status: 'draft', createdBy: employeeId, approval: 'pending', items: [line(cap, 60, 0.28, 'Green'), line(handle, 15, 0.65, 'Bisleri')] });
const qEmeraude = createQuotation({ customer: customers.emeraude, date: day(-40), currency: 'USD', taxType: 'none', status: 'accepted', isExport: true, items: [line(neck, 120, 13.4, 'Natural', 0), line(cap, 90, 0.31, 'Blue', 0)] });

/* ------------------------------------------------------------------ */
/* Orders                                                              */
/* ------------------------------------------------------------------ */

function createOrder(o: {
  customer: number; date: string; currency: string; taxType: 'none' | 'cgst_sgst' | 'igst';
  items: LineItemInput[]; isExport?: boolean; status?: string; po?: string; promised?: string;
  spoc?: string; through?: string; destination?: string; quotationId?: number;
}) {
  return transaction(() => {
    const number = nextNumber('order', { isExport: !!o.isExport, companyId });
    const t = computeTotals(o.items, o.taxType, 0, 0, o.currency);
    const info = insert(
      `INSERT INTO orders (number, date, quotation_id, customer_id, company_id, is_export, order_through, spoc,
         po_number, po_date, currency, tax_type, payment_terms, destination, transport, promised_date,
         status, created_by, subtotal, tax_total, grand_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(number, o.date, o.quotationId ?? null, o.customer, companyId, o.isExport ? 1 : 0,
      o.through ?? 'Phone', o.spoc ?? 'Rumela', o.po ?? '', o.po ? o.date : '',
      o.currency, o.taxType, '30% advance, balance before dispatch',
      o.destination ?? '', 'Self', o.promised ?? day(12), o.status ?? 'confirmed', managerId,
      t.subtotal, t.tax_total, t.grand_total);
    const id = Number(info.lastInsertRowid);
    const ins = insert(
      `INSERT INTO order_items (order_id, product_id, description, hsn_code, code, qty, unit, unit_price, tax_pct,
         amount, color, packs, pcs_per_pack, total_pcs, is_charge, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    t.items.forEach((it, i) => ins.run(id, it.product_id ?? null, it.description, it.hsn_code ?? '', '',
      it.qty ?? null, it.unit ?? 'unit', it.unit_price, it.tax_pct ?? 0, it.amount,
      it.color ?? '', it.packs ?? null, it.pcs_per_pack ?? null, it.total_pcs ?? null,
      it.is_charge ? 1 : 0, i));
    return { id, number, total: t.grand_total };
  });
}

const orderOrient = createOrder({
  customer: customers.orient, date: day(-30), currency: 'INR', taxType: 'igst',
  po: 'OBL/26-27/0114', spoc: 'Rumela', promised: day(-2), destination: 'Salap More, Howrah',
  status: 'in_production',
  items: [line(cap, 40, 0.28, 'Green'), line(flip, 12, 1.02, 'White')],
});

const orderBisleri = createOrder({
  customer: customers.bisleri, date: day(-16), currency: 'INR', taxType: 'igst',
  po: 'PON270002036', spoc: 'Tannistha', through: 'Mail', promised: day(6), destination: 'BIPL Chennai Plant',
  items: [line(handle, 15, 0.65, 'Bisleri'), line(cap, 30, 0.29, 'Green')],
});

const orderEmeraude = createOrder({
  customer: customers.emeraude, date: day(-24), currency: 'USD', taxType: 'none', isExport: true,
  po: 'EMR-2026-88', spoc: 'Sanjib', through: 'Mail', promised: day(9), destination: 'Port Louis, Mauritius',
  quotationId: qEmeraude.id,
  items: [
    line(neck, 120, 13.4, 'Natural', 0),
    line(cap, 90, 0.31, 'Blue', 0),
    // A charge line, so the flag is visible somewhere in the demo.
    { description: 'Indicative Freight (1 x 40FT HQ)', unit: 'unit', unit_price: 1850, tax_pct: 0, is_charge: 1 },
  ],
});

const orderGayatri = createOrder({
  customer: customers.gayatri, date: day(-5), currency: 'INR', taxType: 'cgst_sgst',
  spoc: 'Sanjib', promised: day(20), destination: 'Ranchi', status: 'pending',
  items: [line(cap, 20, 0.29, 'Purple')],
});

/* ------------------------------------------------------------------ */
/* Production                                                          */
/* ------------------------------------------------------------------ */

function createWorkOrder(o: {
  orderId: number; line: number; productId: number | null; description: string; qty: number;
  location: number; machine?: number; mould?: number; start: string; end: string; status?: string;
}) {
  const number = nextNumber('work_order', { companyId });
  return newId(
    `INSERT INTO work_orders (number, company_id, order_id, order_line, product_id, description, qty_planned,
       location_id, machine_id, mould_id, planned_start, planned_end, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    number, companyId, o.orderId, o.line, o.productId, o.description, o.qty,
    o.location, o.machine ?? null, o.mould ?? null, o.start, o.end, o.status ?? 'running', managerId
  );
}

const entry = insert(
  `INSERT INTO production_entries (work_order_id, date, shift, qty_ok, qty_reject, operator, created_by)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);

// Orient's caps: made in full, ready to go out.
const woOrientCap = createWorkOrder({
  orderId: orderOrient.id, line: 0, productId: cap.id, description: cap.name,
  qty: 40 * (cap.pcs_per_pack ?? 10000), location: jungalpur, machine: machines.m1, mould: moulds.cap26,
  start: day(-26), end: day(-20), status: 'done',
});
entry.run(woOrientCap, day(-25), 'A', 40 * (cap.pcs_per_pack ?? 10000) * 0.6, 1200, 'Sk. Rahim', managerId);
entry.run(woOrientCap, day(-24), 'B', 40 * (cap.pcs_per_pack ?? 10000) * 0.4, 800, 'D. Mondal', managerId);

// Orient's flip tops: still running, and overdue.
const woOrientFlip = createWorkOrder({
  orderId: orderOrient.id, line: 1, productId: flip.id, description: flip.name,
  qty: 12 * (flip.pcs_per_pack ?? 5000), location: jungalpur, machine: machines.m2,
  start: day(-18), end: day(-3),
});
entry.run(woOrientFlip, day(-17), 'A', 12 * (flip.pcs_per_pack ?? 5000) * 0.35, 400, 'Sk. Rahim', managerId);

// Emeraude's necks: part made at the second plant.
const woEmeraude = createWorkOrder({
  orderId: orderEmeraude.id, line: 0, productId: neck.id, description: neck.name,
  qty: 120 * (neck.pcs_per_pack ?? 7000), location: packSkrl, machine: machines.m3,
  start: day(-12), end: day(4),
});
entry.run(woEmeraude, day(-10), 'A', 120 * (neck.pcs_per_pack ?? 7000) * 0.5, 2500, 'A. Sardar', managerId);

// Bisleri's handles: planned only, and the product has no recipe — so the
// Material tab has something to report as "not costed".
createWorkOrder({
  orderId: orderBisleri.id, line: 0, productId: handle.id, description: handle.name,
  qty: 15 * (handle.pcs_per_pack ?? 15000), location: jungalpur, mould: moulds.handle,
  start: day(3), end: day(8), status: 'planned',
});

/* ------------------------------------------------------------------ */
/* Material: opening stock, a purchase order, a receipt and issues     */
/* ------------------------------------------------------------------ */

const move = insert(
  `INSERT INTO material_moves (material_id, location_id, date, qty, source, po_id, work_order_id, note, created_by)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const opening: [number, number, number][] = [
  [materials.pet, jungalpur, 12000], [materials.pet, packSkrl, 6000],
  [materials.hdpe, jungalpur, 9000], [materials.pp, jungalpur, 3500],
  [materials.blue, jungalpur, 180], [materials.green, jungalpur, 320],
  [materials.carton, jungalpur, 1400],
];
for (const [m, l, q] of opening) move.run(m, l, day(-45), q, 'opening', null, null, 'Opening balance', managerId);

// A purchase order, part received — so the PO list shows both states.
const poId = transaction(() => {
  const number = nextNumber('purchase_order', { companyId });
  const items: LineItemInput[] = [
    { description: 'PET Resin — bottle grade', qty: 10000, unit: 'kg', unit_price: 92, tax_pct: 18 },
  ];
  const t = computeTotals(items, 'igst', 0, 0, 'INR');
  const id = newId(
    `INSERT INTO purchase_orders (number, company_id, supplier_id, location_id, date, expected_date, currency,
       tax_type, status, payment_terms, created_by, subtotal, tax_total, grand_total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    number, companyId, suppliers.reliance, jungalpur, day(-14), day(-4), 'INR', 'igst',
    'part_received', '30 days from invoice', managerId, t.subtotal, t.tax_total, t.grand_total
  );
  insert(
    `INSERT INTO po_items (po_id, material_id, description, qty, unit, rate, tax_pct, amount, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(id, materials.pet, 'PET Resin — bottle grade', 10000, 'kg', 92, 18, t.items[0].amount);
  return id;
});
move.run(materials.pet, jungalpur, day(-6), 6000, 'po_receipt', poId, null, 'Part delivery', managerId);

// A second PO still open, so "on order" is not zero everywhere.
transaction(() => {
  const number = nextNumber('purchase_order', { companyId });
  const items: LineItemInput[] = [
    { description: 'HDPE — injection grade', qty: 8000, unit: 'kg', unit_price: 88, tax_pct: 18 },
    { description: 'Carton 57x50x40 cm', qty: 2000, unit: 'pcs', unit_price: 34, tax_pct: 18 },
  ];
  const t = computeTotals(items, 'igst', 0, 0, 'INR');
  const id = newId(
    `INSERT INTO purchase_orders (number, company_id, supplier_id, location_id, date, expected_date, currency,
       tax_type, status, created_by, subtotal, tax_total, grand_total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    number, companyId, suppliers.reliance, jungalpur, day(-3), day(9), 'INR', 'igst', 'sent',
    managerId, t.subtotal, t.tax_total, t.grand_total
  );
  const ins = insert(
    `INSERT INTO po_items (po_id, material_id, description, qty, unit, rate, tax_pct, amount, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  ins.run(id, materials.hdpe, 'HDPE — injection grade', 8000, 'kg', 88, 18, t.items[0].amount, 0);
  ins.run(id, materials.carton, 'Carton 57x50x40 cm', 2000, 'pcs', 34, 18, t.items[1].amount, 1);
});

// Material drawn against the jobs that have run.
move.run(materials.hdpe, jungalpur, day(-25), -1080, 'issue', null, woOrientCap, '', managerId);
move.run(materials.green, jungalpur, day(-25), -22, 'issue', null, woOrientCap, '', managerId);
move.run(materials.carton, jungalpur, day(-24), -40, 'issue', null, woOrientCap, '', managerId);
move.run(materials.pet, packSkrl, day(-10), -9030, 'issue', null, woEmeraude, '', managerId);
// A stock check that found less than the ledger said.
move.run(materials.pp, jungalpur, day(-8), -45, 'adjustment', null, null, 'Stock check shortfall', managerId);

/* ------------------------------------------------------------------ */
/* Despatch                                                            */
/* ------------------------------------------------------------------ */

function despatch(o: {
  orderId: number; date: string; location: number; destination: string; transporter: number;
  cn?: string; vehicle?: string; eta?: string; items: { line: number; description: string; qty: number; packs: number }[];
}) {
  const id = newId(
    `INSERT INTO despatches (order_id, location_id, date, destination, transporter_id, cn_no, vehicle_no,
       tentative_delivery, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    o.orderId, o.location, o.date, o.destination, o.transporter, o.cn ?? '', o.vehicle ?? '', o.eta ?? '', managerId
  );
  const ins = insert(
    'INSERT INTO despatch_items (despatch_id, order_line, description, qty, packs, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
  );
  o.items.forEach((it, i) => ins.run(id, it.line, it.description, it.qty, it.packs, i));
  return id;
}

// Orient's caps went out in two lorries, and are not yet invoiced — the
// "despatched but not billed" case the register exists to show.
despatch({
  orderId: orderOrient.id, date: day(-18), location: jungalpur, destination: 'Salap More, Howrah',
  transporter: transporters.self, vehicle: 'WB11E9648',
  items: [{ line: 0, description: cap.name, qty: 25 * (cap.pcs_per_pack ?? 10000), packs: 25 }],
});
despatch({
  orderId: orderOrient.id, date: day(-11), location: jungalpur, destination: 'Salap More, Howrah',
  transporter: transporters.rajkamal, cn: '1002003204', eta: '2-3 Days',
  items: [{ line: 0, description: cap.name, qty: 15 * (cap.pcs_per_pack ?? 10000), packs: 15 }],
});

/* ------------------------------------------------------------------ */
/* Follow-ups                                                          */
/* ------------------------------------------------------------------ */

const followup = insert(
  'INSERT INTO followups (doc_type, doc_id, customer_id, due_date, note, done) VALUES (?, ?, ?, ?, ?, 0)'
);
followup.run('general', orderGayatri.id, customers.gayatri, day(-3), 'Confirm artwork for the purple cap before scheduling');
followup.run('quotation', 0, customers.sanya, day(0), 'Sanya to revert on the 12.90 price');
followup.run('general', orderBisleri.id, customers.bisleri, day(4), 'Chase despatch instruction for the Chennai plant');

/* ------------------------------------------------------------------ */

const summary = (t: string) => `${String(one(`SELECT COUNT(*) AS c FROM ${t}`)).padStart(4)}  ${t}`;
console.log('Seeded:');
for (const t of [
  'customers', 'quotations', 'orders', 'work_orders', 'production_entries',
  'material_moves', 'purchase_orders', 'despatches', 'followups', 'product_materials',
]) console.log(`  ${summary(t)}`);
console.log(`\nCatalogue kept: ${catalogue.length} products.`);
console.log(`Recipes on: ${cap.name}, ${neck.name}, ${flip.name}. "${handle.name}" deliberately has none.`);
console.log('Plants: Jungalpur, PACK SKRL. Log in with your existing account.');
