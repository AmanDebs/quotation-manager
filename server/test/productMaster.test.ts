import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCT_TYPES, PRODUCT_TYPE_LABEL, guessProductType, isProductType,
} from '../src/services/productType.js';
import { autoMap, buildImport, identityKey } from '../src/services/productImport.js';

/**
 * No `helpers/scratch.js` import, and — as in `companyPatterns.test.ts` — that
 * is deliberate rather than forgotten. Neither module under test touches the
 * database: `productType.ts` imports nothing at all, and `productImport.ts`
 * reaches only `spreadsheet.ts`, which reaches only `node:zlib`. If either ever
 * grows a `db` import, the scratch import goes back on line 1 or these tests
 * start running against `server/data/app.db`.
 */

describe('reading a product type off a name', () => {
  test('the four the user named', () => {
    assert.equal(guessProductType('28mm Preform 119g'), 'preform');
    assert.equal(guessProductType('20 LTR Threaded Cap'), 'cap');
    assert.equal(guessProductType('20 Ltr Double Handle'), 'handle');
    assert.equal(guessProductType('19/20 Flip Top Neck 1810'), 'other');
  });

  test('plurals and case, because a catalogue writes both', () => {
    for (const n of ['Caps', 'CAP 28mm', 'caps assorted']) assert.equal(guessProductType(n), 'cap', n);
    for (const n of ['Preforms 28mm', 'PRE-FORM 24g']) assert.equal(guessProductType(n), 'preform', n);
    assert.equal(guessProductType('Handles, Double'), 'handle');
  });

  /**
   * The reason this is a regex and not `LIKE '%cap%'`, which would have been
   * the obvious way to write the boot migration in SQL.
   */
  test('a word that merely contains one of them is not a match', () => {
    for (const n of ['High Capacity Bottle', 'Encapsulated Insert', 'Handling Charge', 'Preformed?']) {
      assert.equal(guessProductType(n), 'other', n);
    }
  });

  /**
   * Two matches is ambiguity, not first-wins. A chain testing preform first
   * would answer "preform" here and sound certain about it.
   */
  test('a name naming two of them stays other', () => {
    assert.equal(guessProductType('Preform Cap Combo'), 'other');
    assert.equal(guessProductType('Cap with Handle'), 'other');
  });

  test('nothing to go on is other, never a guess', () => {
    for (const n of ['', '   ', '1810', 'MS Forged Flange DN100']) assert.equal(guessProductType(n), 'other', n);
  });

  /**
   * The classifier, the route's enum and the schema default are three copies of
   * one vocabulary. A classifier that can emit a value the route would refuse
   * is a boot migration that writes rows nobody can then save.
   */
  test('everything it can emit is a value the route accepts', () => {
    const names = ['Caps', 'Preform', 'Handle', 'anything else', 'Preform Cap'];
    for (const n of names) assert.ok(isProductType(guessProductType(n)), n);
    for (const t of PRODUCT_TYPES) assert.ok(PRODUCT_TYPE_LABEL[t], `${t} has no label`);
  });

  test('and the schema default is one of them', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const schema = readFileSync(path.join(here, '..', 'src', 'db', 'schema.sql'), 'utf8');
    const line = schema.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('product_type '));
    assert.ok(line, 'product_type is not declared in schema.sql');
    assert.ok(isProductType(line.split("'")[1]), `schema default ${line} is not a product type`);
  });
});

/** A sheet, as `parseWorkbook` takes it: CSV is chosen by the filename. */
const csv = (rows: string[][]) => Buffer.from(rows.map((r) => r.join(',')).join('\n'));

describe('importing the two new columns', () => {
  /**
   * A regression test for a bug that was live before these columns existed.
   *
   * `IMPORT_FIELDS` is matched in order and a claimed column joins a `taken`
   * set, and `name` carries the bare word "product" as a synonym — so a sheet
   * headed *Item Code | Product Type* mapped **name** onto the Product Type
   * column and imported a catalogue of products called "Preform" and "Caps".
   * Declaring product_type first takes that column back.
   */
  test('a Product Type column is not read as the product name', () => {
    const m = autoMap(['Item Code', 'Product Type', 'Colour']);
    assert.equal(m.name, 0);
    assert.equal(m.product_type, 1);
  });

  test('and no existing mapping moved to make room', () => {
    const m = autoMap(['Standard Name', 'Colour', 'Pcs Box', '20', '40', 'Basic Price']);
    assert.deepEqual(
      { name: m.name, color: m.color, pcs_per_pack: m.pcs_per_pack, qty_20ft: m.qty_20ft, qty_40ft: m.qty_40ft, unit_price: m.unit_price },
      { name: 0, color: 1, pcs_per_pack: 2, qty_20ft: 3, qty_40ft: 4, unit_price: 5 }
    );
  });

  test('a weight is a number, and a blank one is null rather than 0', () => {
    const r = buildImport(csv([
      ['Product Name', 'Type', 'Weight (gms)', 'Pcs Box'],
      ['28mm Preform', 'Preform', '119', '900'],
      ['Blank Weight Item', 'Caps', '', '500'],
    ]), 'sheet.csv', new Map());
    assert.equal(r.rows[0].product.weight_grams, 119);
    assert.equal(r.rows[0].product.product_type, 'preform');
    // Not 0, and not '' — a weight nobody recorded is a different claim from
    // a weight of nothing, and '' in a REAL column sorts above every number.
    assert.equal(r.rows[1].product.weight_grams, null);
    assert.equal(r.rows[1].product.product_type, 'cap');
  });

  test('with no type column, the type is read off the name', () => {
    const r = buildImport(csv([
      ['Product Name', 'Pcs Box'],
      ['20 Ltr Double Handle', '200'],
      ['MS Flange', '50'],
    ]), 'sheet.csv', new Map());
    assert.equal(r.rows[0].product.product_type, 'handle');
    assert.equal(r.rows[1].product.product_type, 'other');
  });

  /**
   * The guard against ever putting weight into `identityKey`. Doing so would
   * make the first re-import after this change see every product on file
   * (weight NULL) as new, and there is no unique index on `products` to stop
   * the whole catalogue being written twice.
   */
  test('a sheet whose weights changed still updates in place', () => {
    const existing = new Map([[identityKey({ name: '28mm Preform', color: 'Blue', pcs_per_pack: 900 }), 42]]);
    const r = buildImport(csv([
      ['Product Name', 'Colour', 'Pcs Box', 'Weight (gms)'],
      ['28mm Preform', 'Blue', '900', '124'],
    ]), 'sheet.csv', existing);
    assert.equal(r.rows[0].action, 'update');
    assert.equal(r.rows[0].existingId, 42);
    assert.equal(r.rows[0].product.weight_grams, 124);
  });
});
