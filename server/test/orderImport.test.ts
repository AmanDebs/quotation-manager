import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrderImport, autoMapOrders, parseDate, parseNum, rateFromCell, guessStatusAction,
  type Lookups } from '../src/services/orderImport.js';
import { billedQty } from '../src/services/totals.js';

/**
 * The order importer is pure — it takes the workbook and the books it matches
 * against, and writes nothing — so every rule below is testable without a
 * database or an HTTP harness. That is the point of the `Lookups` argument.
 *
 * The sheets here are CSV, which `parseWorkbook` reads through the same
 * `splitHeader` the .xlsx path uses, so the grouping and mapping under test
 * are exactly the ones a real file meets.
 */

const CUSTOMERS: Lookups['customers'] = [
  { id: 1, name: 'Bharat Engineering Works', currency: 'INR', country: 'India', is_export: 0 },
  { id: 2, name: 'Acme Maschinenbau GmbH', currency: 'EUR', country: 'Germany', is_export: 0 },
  { id: 3, name: 'Northern Traders Pvt Ltd', currency: 'INR', country: 'India', is_export: 0 },
  { id: 4, name: 'Southern Traders Pvt Ltd', currency: 'INR', country: 'India', is_export: 0 },
];

const PRODUCTS: Lookups['products'] = [
  { id: 10, name: '28mm Alaska Preform', color: 'Natural', pcs_per_pack: 8500, hsn_code: '39235010', unit: 'per 1000', unit_price: 1.2 },
  { id: 11, name: '28mm Alaska Preform', color: 'Blue', pcs_per_pack: 9000, hsn_code: '39235010', unit: 'per 1000', unit_price: 1.3 },
  { id: 12, name: 'Handle 5L', color: '', pcs_per_pack: 500, hsn_code: '39235090', unit: 'per 1000', unit_price: 4 },
];

const lookups = (over: Partial<Lookups> = {}): Lookups => ({
  customers: CUSTOMERS,
  products: PRODUCTS,
  orderNumbers: new Map(),
  ...over,
});

const build = (csv: string, over: Partial<Lookups> = {}, opts = {}) =>
  buildOrderImport(Buffer.from(csv, 'utf8'), 'orders.csv', lookups(over), opts);

const HEAD = 'Order No.,Date,Party Name,Item,Colour,Quantity,Basic price,Pcs per box,Tentative Date of Desp,Payment Terms';
const SHEET = [
  HEAD,
  'SO/001,15-08-2026,Bharat Engineering Works,28mm Alaska Preform,Natural,120000,1.20,8500,20-09-2026,30% Advance',
  ',,,Handle 5L,,50000,4.00,500,25-09-2026,',
  'SO/002,16-08-2026,Acme Maschinenbau GmbH,28mm Alaska Preform,Blue,90000,1.30,9000,30-09-2026,50-50',
].join('\n');

describe('reading the cells', () => {
  test('a numeric date cell is an Excel serial, which is how every .xlsx date arrives', () => {
    // 46280 is 2026-09-15; `spreadsheet.ts` never interprets styles, so this
    // is the shape a real workbook hands over.
    assert.equal(parseDate('46280'), '2026-09-15');
  });

  test('a day-first date is read day first, the convention on this desk', () => {
    assert.equal(parseDate('05/09/2026'), '2026-09-05');
    assert.equal(parseDate('15-9-26'), '2026-09-15');
  });

  test('a named month and an ISO date both read', () => {
    assert.equal(parseDate('15-Sep-2026'), '2026-09-15');
    assert.equal(parseDate('2026-09-15'), '2026-09-15');
  });

  test('a number that is not a date, and nonsense, read as no date rather than a guess', () => {
    assert.equal(parseDate('5'), '');
    assert.equal(parseDate('2026'), '');
    assert.equal(parseDate('next week'), '');
    assert.equal(parseDate(''), '');
  });

  test('Indian grouping and a currency symbol are read as the number they are', () => {
    assert.equal(parseNum('1,20,000'), 120000);
    assert.equal(parseNum('₹ 10.50'), 10.5);
    assert.equal(parseNum(''), null);
    assert.equal(parseNum('n/a'), null);
  });

  test('the first number in the cell is the figure, not what is left after stripping', () => {
    // The live book writes prices as notes: stripping everything but digits
    // leaves "0.90-" from "(Ex-works)", which is not a number at all.
    assert.equal(parseNum('@0.90+GST(Ex-works)'), 0.9);
    assert.equal(parseNum('@ 16.54+FOR'), 16.54);
    assert.equal(parseNum('WO PLUG'), null);
  });

  test('a rate is not rounded on the way in — money is rounded once, by computeTotals', () => {
    assert.equal(parseNum('0.8555'), 0.8555);
  });
});

describe('mapping the columns', () => {
  test("the desk sheet's own headings map themselves", () => {
    const m = autoMapOrders(HEAD.split(','));
    assert.equal(m.number, 0);
    assert.equal(m.date, 1);
    assert.equal(m.customer, 2);
    assert.equal(m.item, 3);
    assert.equal(m.qty, 5);
    assert.equal(m.rate, 6);
    assert.equal(m.promised_date, 8);
    assert.equal(m.payment_terms, 9);
  });

  test('PO Date does not steal the order date, and Item Code does not steal the item', () => {
    const m = autoMapOrders(['Order No', 'PO No', 'PO Date', 'Order Date', 'Item Code', 'Item', 'Qty']);
    assert.equal(m.po_date, 2);
    assert.equal(m.date, 3);
    assert.equal(m.code, 4);
    assert.equal(m.item, 5);
  });

  test('Unit Price is a rate, not a unit', () => {
    const m = autoMapOrders(['Order No', 'Customer', 'Item', 'Qty', 'Unit Price', 'Unit']);
    assert.equal(m.rate, 4);
    assert.equal(m.unit, 5);
  });
});

describe('grouping rows into orders', () => {
  test('a blank order number continues the order above it — a merged cell in Excel', () => {
    const r = build(SHEET);
    assert.equal(r.orders.length, 2);
    assert.equal(r.orders[0].number, 'SO/001');
    assert.equal(r.orders[0].lines.length, 2);
    assert.equal(r.orders[1].lines.length, 1);
  });

  test('one number reused for two customers stays two orders', () => {
    const r = build([
      HEAD,
      'SO/009,15-08-2026,Bharat Engineering Works,Handle 5L,,1000,4,500,,',
      'SO/009,15-08-2026,Acme Maschinenbau GmbH,Handle 5L,,2000,4,500,,',
    ].join('\n'));
    assert.equal(r.orders.length, 2);
  });

  test('a header field is taken from the first row of the group that states one', () => {
    const r = build(SHEET);
    assert.equal(r.orders[0].date, '2026-08-15');
    assert.equal(r.orders[0].payment_terms, '30% Advance');
    // The order takes the first line's promised date; each line keeps its own.
    assert.equal(r.orders[0].promised_date, '2026-09-20');
    assert.equal(r.orders[0].lines[1].scheduled_date, '2026-09-25');
  });
});

describe('matching the books', () => {
  test('a product is matched on name, colour and pcs per box, so two rows of one name stay apart', () => {
    const r = build(SHEET);
    assert.equal(r.orders[0].lines[0].product_id, 10);
    assert.equal(r.orders[1].lines[0].product_id, 11);
  });

  test('a product not in the catalogue is imported as a custom line, never created', () => {
    const r = build([HEAD, 'SO/003,15-08-2026,Bharat Engineering Works,Mystery Widget,,1000,5,,,'].join('\n'));
    const line = r.orders[0].lines[0];
    assert.equal(line.product_id, null);
    assert.equal(line.description, 'Mystery Widget');
    assert.match(String(line.note), /custom line/);
    assert.equal(r.orders[0].action, 'create');
  });

  test('a customer is matched through "Pvt. Ltd." against "Pvt Ltd"', () => {
    const r = build([HEAD, 'SO/004,15-08-2026,Northern Traders Pvt. Ltd.,Handle 5L,,1000,4,500,,'].join('\n'));
    assert.equal(r.orders[0].customer_id, 3);
  });

  test('a customer nobody can identify refuses that order by name rather than creating one', () => {
    const r = build([HEAD, 'SO/005,15-08-2026,Somebody Else Ltd,Handle 5L,,1000,4,500,,'].join('\n'));
    assert.equal(r.orders[0].action, 'skip');
    assert.match(String(r.orders[0].note), /No customer called "Somebody Else Ltd"/);
  });

  test('a loose match that fits two customers is refused, not guessed', () => {
    const two = [
      { id: 3, name: 'Traders Pvt Ltd', currency: 'INR', country: 'India', is_export: 0 },
      { id: 4, name: 'Traders Ltd', currency: 'INR', country: 'India', is_export: 0 },
    ];
    // Both names reduce to the same loose key, so a spelling matching neither
    // exactly could only be guessed at — and is refused instead.
    const vague = build([HEAD, 'SO/006,15-08-2026,Traders Private Limited,Handle 5L,,1000,4,500,,'].join('\n'), { customers: two });
    assert.equal(vague.orders[0].action, 'skip');
    assert.match(String(vague.orders[0].note), /More than one customer/);
    // The exact spelling still settles it.
    const exact = build([HEAD, 'SO/006,15-08-2026,Traders Ltd,Handle 5L,,1000,4,500,,'].join('\n'), { customers: two });
    assert.equal(exact.orders[0].customer_id, 4);
  });

  test('scope is the caller’s: a customer not in the lookups cannot be booked onto', () => {
    const r = build([HEAD, 'SO/007,15-08-2026,Acme Maschinenbau GmbH,Handle 5L,,1000,4,500,,'].join('\n'),
      { customers: [CUSTOMERS[0]] });
    assert.equal(r.orders[0].action, 'skip');
  });
});

describe('what the order comes out as', () => {
  test('currency, export and tax all follow the customer record', () => {
    const r = build(SHEET);
    assert.equal(r.orders[0].is_export, 0);
    assert.equal(r.orders[0].currency, 'INR');
    assert.equal(r.orders[0].tax_type, 'igst');
    assert.equal(r.orders[1].is_export, 1);
    assert.equal(r.orders[1].currency, 'EUR');
    assert.equal(r.orders[1].tax_type, 'none');
    // An export line is zero-rated whatever the sheet says about tax.
    assert.equal(r.orders[1].lines[0].tax_pct, 0);
    assert.equal(r.orders[0].lines[0].tax_pct, 18);
  });

  test('the quantity is read as pieces, and the billing quantity is derived by the basis', () => {
    const line = build(SHEET).orders[0].lines[0];
    assert.equal(line.total_pcs, 120000);
    assert.equal(line.qty, null);
    assert.equal(line.unit, 'per 1000');
    // Which is what the form itself would have produced for that line.
    assert.equal(billedQty(line), 120);
  });

  test('on the billing basis the figure is taken exactly as typed', () => {
    const r = build([
      'Order No.,Date,Party Name,Item,Qty,Unit,Rate',
      'SO/008,15-08-2026,Bharat Engineering Works,Resin Blend,2500,kg,95',
    ].join('\n'), {}, { quantityBasis: 'billing' });
    const line = r.orders[0].lines[0];
    assert.equal(line.qty, 2500);
    assert.equal(line.unit, 'kg');
    assert.equal(line.total_pcs, null);
  });

  test('boxes times pcs per box is the piece count where nothing states one', () => {
    const r = build([
      'Order No.,Date,Party Name,Item,Qty,Unit,Rate,Boxes,Pcs per box',
      'SO/010,15-08-2026,Bharat Engineering Works,Resin Blend,2500,kg,95,20,500',
    ].join('\n'), {}, { quantityBasis: 'billing' });
    assert.equal(r.orders[0].lines[0].total_pcs, 10000);
  });
});

describe('what is refused', () => {
  test('a number already on file is skipped by name and never rewritten', () => {
    const r = build(SHEET, { orderNumbers: new Map([['so/001', 42]]) });
    assert.equal(r.orders[0].action, 'skip');
    assert.equal(r.orders[0].existingId, 42);
    assert.match(String(r.orders[0].note), /Already on file/);
    assert.equal(r.orders[1].action, 'create');
  });

  test('a line with no quantity is dropped with its reason, not imported at zero', () => {
    const r = build([
      HEAD,
      'SO/011,15-08-2026,Bharat Engineering Works,Handle 5L,,1000,4,500,,',
      ',,,28mm Alaska Preform,Natural,,1.2,8500,,',
    ].join('\n'));
    assert.equal(r.orders[0].lines.length, 1);
    assert.equal(r.orders[0].dropped.length, 1);
    assert.match(r.orders[0].dropped[0].note, /No quantity/);
  });

  test('an order left with no lines at all is skipped', () => {
    const r = build([HEAD, 'SO/012,15-08-2026,Bharat Engineering Works,Handle 5L,,,4,500,,'].join('\n'));
    assert.equal(r.orders[0].action, 'skip');
    assert.equal(r.orders[0].note, 'No line with a quantity');
  });

  test('the summary counts orders and the lines of the ones being booked', () => {
    const r = build(SHEET, { orderNumbers: new Map([['so/002', 7]]) });
    assert.deepEqual(r.summary, { create: 1, skip: 1, lines: 2, rows: 3 });
  });
});


describe('reading a price cell', () => {
  test('an unmarked figure takes the chosen basis', () => {
    assert.equal(rateFromCell('@0.65++', 'per_piece').pieceRate, 0.65);
    assert.equal(rateFromCell('650', 'per_1000').pieceRate, 0.65);
  });

  test('a marker in the cell beats the setting, both ways', () => {
    assert.equal(rateFromCell('@3.017/PC', 'per_1000').pieceRate, 3.017);
    assert.equal(rateFromCell('₹ 275.00 per 1000 pcs', 'per_piece').pieceRate, 0.275);
  });

  test('a price per kilo is not a rate for the goods, and is refused rather than guessed', () => {
    // Aglo's own sheet states @128.40/KG beside @3.017/PC for one line — the
    // second being the first times the piece weight. Converting would need the
    // catalogue's weight to be right, and a rate is money.
    const r = rateFromCell('@128.40/KG', 'per_piece');
    assert.equal(r.pieceRate, null);
    assert.match(String(r.note), /per kilo/);
  });

  test('a cell with no figure in it says so', () => {
    assert.match(String(rateFromCell('WO PLUG', 'per_piece').note), /states no figure/);
  });
});

describe('the sheet’s own status word', () => {
  const SHEET_S = [
    'Order No.,Date,Party Name,Item,Quantity,Rate,Status',
    'SO/501,15-08-2026,Bharat Engineering Works,Handle 5L,1000,4,Pending',
    'SO/502,15-08-2026,Bharat Engineering Works,Handle 5L,1000,4,Delivered',
    'SO/503,15-08-2026,Bharat Engineering Works,Handle 5L,1000,4,Cancelled',
  ].join('\n');

  test('delivered means finished and cancelled means cancelled, before anybody says otherwise', () => {
    assert.equal(guessStatusAction('Delivered'), 'completed');
    assert.equal(guessStatusAction('Despatched'), 'completed');
    assert.equal(guessStatusAction('Cancelled'), 'cancelled');
    assert.equal(guessStatusAction('Pending'), 'open');
    assert.equal(guessStatusAction('Awaiting artwork'), 'open');
  });

  test('every distinct word is reported with its count, so the dialog can offer it', () => {
    const r = build(SHEET_S);
    assert.deepEqual(r.statuses, [
      { text: 'Pending', count: 1, action: 'open' },
      { text: 'Delivered', count: 1, action: 'completed' },
      { text: 'Cancelled', count: 1, action: 'cancelled' },
    ]);
  });

  test('a closed order is still booked, and carries the status that stops it raising jobs', () => {
    const r = build(SHEET_S);
    assert.deepEqual(r.orders.map((o) => [o.action, o.import_status]), [
      ['create', ''], ['create', 'completed'], ['create', 'cancelled'],
    ]);
  });

  test('a word can be told to mean something else, including not importing at all', () => {
    const r = build(SHEET_S, {}, { statusActions: { Delivered: 'skip', Pending: 'completed' } });
    assert.equal(r.orders[0].import_status, 'completed');
    assert.equal(r.orders[1].action, 'skip');
    assert.match(String(r.orders[1].note), /not being imported/);
    assert.equal(r.summary.create, 2);
  });
});

describe('a number used twice on one sheet', () => {
  test('is two orders, and the later one is suffixed rather than colliding', () => {
    // 33 numbers on the live book are stated against more than one customer,
    // the series having run round; both must be written, and the per-company
    // unique index would refuse two rows sharing a number.
    const r = build([
      HEAD,
      'SO/601,15-08-2026,Bharat Engineering Works,Handle 5L,,1000,4,500,,',
      'SO/601,16-08-2026,Shakti Fabricators,Handle 5L,,2000,4,500,,',
    ].join('\n'), {
      customers: [
        { id: 1, name: 'Bharat Engineering Works', currency: 'INR', country: 'India', is_export: 0 },
        { id: 2, name: 'Shakti Fabricators', currency: 'INR', country: 'India', is_export: 0 },
      ],
    });
    assert.equal(r.orders.length, 2);
    assert.equal(r.orders[0].number, 'SO/601');
    assert.equal(r.orders[1].number, 'SO/601-2');
    assert.match(String(r.orders[1].note), /used by more than one customer/);
    assert.equal(r.summary.create, 2);
  });
});
