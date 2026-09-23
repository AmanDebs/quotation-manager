import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomerImport, autoMapCustomers, mappedColumns,
  type CustomerLookups } from '../src/services/customerImport.js';

/**
 * Pure, like the order importer beside it: the book it matches against is an
 * argument, so none of this needs a database.
 *
 * The case that matters most is the last group — a near match is the whole
 * risk of loading names in bulk, because two spellings of one buyer cannot be
 * told apart by anything downstream.
 */

const BOOK: CustomerLookups['customers'] = [
  { id: 1, name: 'Bharat Engineering Works' },
  { id: 2, name: 'Northern Traders Pvt Ltd' },
];

const build = (csv: string, over: Partial<CustomerLookups> = {}, opts = {}) =>
  buildCustomerImport(Buffer.from(csv, 'utf8'), 'customers.csv', { customers: BOOK, ...over }, opts);

describe('mapping a customer sheet', () => {
  test('a proper customer list maps itself', () => {
    const m = autoMapCustomers(['Customer Name', 'Contact Person', 'Email', 'Phone', 'Address', 'City', 'Country', 'GSTIN']);
    assert.equal(m.name, 0);
    assert.equal(m.contact_person, 1);
    assert.equal(m.email, 2);
    assert.equal(m.phone, 3);
    assert.equal(m.address, 4);
    assert.equal(m.city, 5);
    assert.equal(m.country, 6);
    assert.equal(m.gstin, 7);
  });

  test('Contact Name does not take the name column, and Notify 2 does not take Notify', () => {
    const m = autoMapCustomers(['Contact Name', 'Name', 'Notify Party 2', 'Notify Party', 'Delivery Address', 'Address']);
    assert.equal(m.contact_person, 0);
    assert.equal(m.name, 1);
    assert.equal(m.notify_party_2, 2);
    assert.equal(m.notify_party, 3);
    assert.equal(m.consignee, 4);
    assert.equal(m.address, 5);
  });

  test("the order sheet's own Party Name column is enough on its own", () => {
    const m = autoMapCustomers(['Order Through', 'Ent By', 'Order No.', 'Date', 'Party Name', 'Item', 'Quantity']);
    assert.equal(m.name, 4);
  });
});

describe('what each row would do', () => {
  test('a name nobody holds is a new customer', () => {
    const r = build(['Customer Name,City,Country', 'Sundarbans Food Products,Kolkata,India'].join('\n'));
    assert.equal(r.rows[0].action, 'create');
    assert.equal(r.rows[0].customer.city, 'Kolkata');
    assert.equal(r.rows[0].customer.is_export, 0);
  });

  test('a country that is not India makes an export buyer, as the create route does', () => {
    const r = build(['Customer Name,Country,Currency', 'Acme GmbH,Germany,eur'].join('\n'));
    assert.equal(r.rows[0].customer.is_export, 1);
    assert.equal(r.rows[0].customer.currency, 'EUR');
  });

  test('a blank country is domestic and a blank currency is rupees', () => {
    const r = build(['Customer Name', 'Some Buyer'].join('\n'));
    assert.equal(r.rows[0].customer.country, 'India');
    assert.equal(r.rows[0].customer.currency, 'INR');
    assert.equal(r.rows[0].customer.is_export, 0);
  });

  test('a row with no name is skipped rather than creating a nameless customer', () => {
    const r = build(['Customer Name,City', ',Kolkata'].join('\n'));
    assert.equal(r.rows[0].action, 'skip');
    assert.match(String(r.rows[0].note), /No customer name/);
  });

  test('the same name twice in one sheet is one customer, naming the row it first appeared on', () => {
    // This is what turns an order book's 804 lines into its 210 buyers.
    const r = build([
      'Party Name,Item',
      'Vinayak Industry,29/21 CTC Cap',
      'Vinayak Industry,Seal Cap',
      'vinayak  industry,Flip top cap',
    ].join('\n'));
    assert.deepEqual(r.rows.map((x) => x.action), ['create', 'skip', 'skip']);
    assert.match(String(r.rows[1].note), /Already named on row 2/);
    assert.equal(r.summary.create, 1);
  });

  test('a name already on file is left alone by default, and updated when asked', () => {
    const sheet = ['Customer Name,City', 'Bharat Engineering Works,Pune'].join('\n');
    const left = build(sheet);
    assert.equal(left.rows[0].action, 'skip');
    assert.equal(left.rows[0].existingId, 1);
    assert.match(String(left.rows[0].note), /Already on file/);

    const updated = build(sheet, {}, { onDuplicate: 'update' });
    assert.equal(updated.rows[0].action, 'update');
    assert.equal(updated.rows[0].existingId, 1);
  });
});

describe('a name that nearly matches one on file', () => {
  // Punctuation and case are not a near match — `norm` already strips both, so
  // *Northern Traders Pvt. Ltd.* **is** the record on file. What is near is a
  // name differing by the words a company name carries either way.
  const sheet = ['Customer Name,City', 'Northern Traders,Kolkata'].join('\n');

  test('punctuation alone is the same customer, not a near one', () => {
    const r = build(['Customer Name,City', 'Northern  Traders Pvt. Ltd.,Kolkata'].join('\n'));
    assert.equal(r.rows[0].action, 'skip');
    assert.match(String(r.rows[0].note), /Already on file/);
    assert.equal(r.summary.near, 0);
  });

  test('is left alone by default, and says which record it reads like', () => {
    const r = build(sheet);
    assert.equal(r.rows[0].action, 'skip');
    assert.equal(r.rows[0].nearName, 'Northern Traders Pvt Ltd');
    assert.match(String(r.rows[0].note), /Reads like “Northern Traders Pvt Ltd” already on file/);
    assert.equal(r.summary.near, 1);
  });

  test('is added as its own customer only when that is asked for', () => {
    const r = build(sheet, {}, { nearMatch: 'new' });
    assert.equal(r.rows[0].action, 'create');
    assert.match(String(r.rows[0].note), /added anyway/);
  });

  test('is never *updated*, because that renames the record the whole book points at', () => {
    const r = build(sheet, {}, { onDuplicate: 'update' });
    assert.equal(r.rows[0].action, 'skip');
    assert.notEqual(r.rows[0].action, 'update');
  });

  test('a spelling that fits two records is refused rather than guessed', () => {
    const r = build(['Customer Name', 'Traders Private Limited'].join('\n'), {
      customers: [{ id: 3, name: 'Traders Pvt Ltd' }, { id: 4, name: 'Traders Ltd' }],
    });
    assert.equal(r.rows[0].action, 'skip');
    assert.match(String(r.rows[0].note), /Reads like “Traders Pvt Ltd” and “Traders Ltd”/);
  });

  test('scope is the caller’s: a customer they cannot see is not matched against', () => {
    const r = build(['Customer Name', 'Bharat Engineering Works'].join('\n'), { customers: [] });
    assert.equal(r.rows[0].action, 'create');
  });
});

describe('what an update may write', () => {
  test('only the columns the sheet carries, so a name list cannot blank an address', () => {
    const r = build(['Customer Name,City', 'Bharat Engineering Works,Pune'].join('\n'), {}, { onDuplicate: 'update' });
    assert.deepEqual(mappedColumns(r.mapping), ['city']);
  });

  test('a sheet of nothing but names writes no column at all', () => {
    const r = build(['Party Name', 'Bharat Engineering Works'].join('\n'), {}, { onDuplicate: 'update' });
    assert.deepEqual(mappedColumns(r.mapping), []);
  });
});
