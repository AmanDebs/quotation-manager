import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx, attachmentName, displayWidth, type Column } from '../src/services/xlsx.js';
import { parseWorkbook } from '../src/services/spreadsheet.js';

/**
 * The .xlsx writer, checked by reading its output back with the project's own
 * reader. The two share no code — one deflates and builds a ZIP, the other
 * inflates and parses one — so a round trip is a real test of the container
 * and the sheet XML rather than a restatement of the writer.
 *
 * What it cannot prove is that Excel is happy: a workbook can be well-formed
 * ZIP and well-formed XML and still make Excel offer to repair it. The style
 * table is the part at risk there, and nothing here covers it.
 */

interface Row { name: string; qty: number; amount: number; when: string }

const COLUMNS: Column<Row>[] = [
  { header: 'Item', value: (r) => r.name },
  { header: 'Qty', value: (r) => r.qty, type: 'number' },
  { header: 'Amount', value: (r) => r.amount, type: 'money' },
  { header: 'Date', value: (r) => r.when, type: 'date' },
];

const ROWS: Row[] = [
  { name: '28mm PCO 1881 CSD', qty: 2_100_000, amount: 1234.5, when: '2026-08-17' },
  { name: '29/21 Press on', qty: 165, amount: 0, when: '2026-08-13' },
];

const readBack = (buf: Buffer) => parseWorkbook(buf, 'export.xlsx');

describe('the file it produces', () => {
  test('is a workbook with one sheet, named as asked', () => {
    const sheets = readBack(buildXlsx('Order lines', COLUMNS, ROWS));
    assert.equal(sheets.length, 1);
    assert.equal(sheets[0].name, 'Order lines');
  });

  test('has the headers on the first row', () => {
    const [sheet] = readBack(buildXlsx('S', COLUMNS, ROWS));
    assert.deepEqual(sheet.rows[0], ['Item', 'Qty', 'Amount', 'Date']);
  });

  test('and a row per record, in order', () => {
    const [sheet] = readBack(buildXlsx('S', COLUMNS, ROWS));
    assert.equal(sheet.rows.length, 3, 'header + two rows');
    assert.equal(sheet.rows[1][0], '28mm PCO 1881 CSD');
    assert.equal(sheet.rows[2][0], '29/21 Press on');
  });
});

describe('what a spreadsheet is actually for', () => {
  /**
   * The point of the whole exercise. A quantity written as the text
   * "21,00,000" looks right and cannot be summed, which is the one way an
   * export can be useless while appearing to work.
   */
  test('a quantity is a number, with no grouping baked into it', () => {
    const [sheet] = readBack(buildXlsx('S', COLUMNS, ROWS));
    assert.equal(sheet.rows[1][1], '2100000');
    assert.doesNotMatch(sheet.rows[1][1], /,/);
  });

  test('money keeps its decimals', () => {
    const [sheet] = readBack(buildXlsx('S', COLUMNS, ROWS));
    assert.equal(sheet.rows[1][2], '1234.5');
  });

  test('a date is written as a serial, not as text', () => {
    // 2026-08-17 is 46251 days after 1899-12-30. The reader deliberately does
    // not interpret styles, so a real date comes back as its serial — which is
    // exactly what proves it was not written as a string.
    const [sheet] = readBack(buildXlsx('S', COLUMNS, ROWS));
    assert.equal(sheet.rows[1][3], '46251');
  });

  test('a date it cannot parse falls back to text rather than to a wrong day', () => {
    const cols: Column<{ d: string }>[] = [{ header: 'D', value: (r) => r.d, type: 'date' }];
    const [sheet] = readBack(buildXlsx('S', cols, [{ d: 'not a date' }]));
    assert.equal(sheet.rows[1][0], 'not a date');
  });

  test('a zero is written, not dropped as though it were blank', () => {
    const [sheet] = readBack(buildXlsx('S', COLUMNS, ROWS));
    assert.equal(sheet.rows[2][2], '0');
  });
});

describe('the things that corrupt a workbook', () => {
  test('XML metacharacters in the data survive as themselves', () => {
    const cols: Column<{ v: string }>[] = [{ header: 'V', value: (r) => r.v }];
    const nasty = 'M&S <Pvt> "Ltd" & Co';
    const [sheet] = readBack(buildXlsx('S', cols, [{ v: nasty }]));
    assert.equal(sheet.rows[1][0], nasty);
  });

  test('and so do the metacharacters in a header', () => {
    const cols: Column<{ v: string }>[] = [{ header: 'A & B', value: (r) => r.v }];
    const [sheet] = readBack(buildXlsx('S', cols, [{ v: 'x' }]));
    assert.equal(sheet.rows[0][0], 'A & B');
  });

  test('a control character is dropped instead of making Excel offer to repair', () => {
    const cols: Column<{ v: string }>[] = [{ header: 'V', value: (r) => r.v }];
    const [sheet] = readBack(buildXlsx('S', cols, [{ v: 'bad\x07char' }]));
    assert.equal(sheet.rows[1][0], 'badchar');
  });

  test('a sheet name Excel would refuse is cleaned and clipped to 31', () => {
    const [a] = readBack(buildXlsx('a/b:c*d?e[f]g', COLUMNS, ROWS));
    assert.doesNotMatch(a.name, /[[\]:*?/\\]/);
    const [b] = readBack(buildXlsx('x'.repeat(60), COLUMNS, ROWS));
    assert.equal(b.name.length, 31);
  });

  test('no rows still produces a readable workbook with its headers', () => {
    const [sheet] = readBack(buildXlsx('Empty', COLUMNS, []));
    assert.deepEqual(sheet.rows[0], ['Item', 'Qty', 'Amount', 'Date']);
    assert.equal(sheet.rows.length, 1);
  });

  test('a null or undefined value leaves the cell empty rather than printing it', () => {
    const cols: Column<{ v: string | null }>[] = [
      { header: 'A', value: () => 'x' },
      { header: 'B', value: (r) => r.v },
    ];
    const [sheet] = readBack(buildXlsx('S', cols, [{ v: null }]));
    assert.equal(sheet.rows[1][0], 'x');
    assert.doesNotMatch(sheet.rows[1][1] ?? '', /null|undefined/);
  });
});

describe('the container', () => {
  test('the same input produces byte-identical output', () => {
    // The timestamp is fixed rather than taken from the clock, which is what
    // makes this true — and what makes the writer testable at all.
    const a = buildXlsx('S', COLUMNS, ROWS);
    const b = buildXlsx('S', COLUMNS, ROWS);
    assert.ok(a.equals(b));
  });

  test('it looks like a ZIP from the first bytes', () => {
    const buf = buildXlsx('S', COLUMNS, ROWS);
    assert.equal(buf.readUInt32LE(0), 0x04034b50, 'local file header signature');
  });

  test('a wide sheet keeps its columns in order past Z', () => {
    const cols: Column<number>[] = Array.from({ length: 30 }, (_, i) => ({
      header: `C${i}`,
      value: () => i,
      type: 'number' as const,
    }));
    const [sheet] = readBack(buildXlsx('Wide', cols, [0]));
    assert.equal(sheet.rows[0].length, 30);
    assert.equal(sheet.rows[0][26], 'C26', 'the column after Z');
    assert.equal(sheet.rows[1][29], '29');
  });
});

describe('column widths, which are sized to what Excel draws', () => {
  /**
   * Found by opening a real export in Excel: the Amount column showed
   * ######## because it had been sized to String(12600000).length, ten
   * characters, while Excel renders that cell as 1,26,00,000.00 -- fourteen.
   * Nothing in a round trip through the reader would ever have caught it.
   */
  test('a large money value is measured as it is drawn, separators and all', () => {
    assert.equal(displayWidth(12_600_000, 'money'), '1,26,00,000.00'.length);
  });

  test('and a large quantity likewise', () => {
    assert.equal(displayWidth(2_100_000, 'number'), '21,00,000'.length);
  });

  test('small numbers need no separators', () => {
    assert.equal(displayWidth(165, 'number'), 3);
    assert.equal(displayWidth(0, 'number'), 1);
  });

  test('a negative leaves room for its sign', () => {
    assert.equal(displayWidth(-165, 'number'), 4);
  });

  test('a date is its formatted length, not the length of the ISO string', () => {
    assert.equal(displayWidth('2026-08-17', 'date'), 10);
  });

  test('text is just its own length, and blank is nothing', () => {
    assert.equal(displayWidth('28mm PCO', 'text'), 8);
    assert.equal(displayWidth('', 'text'), 0);
    assert.equal(displayWidth(null, 'number'), 0);
  });

  test('a value that is not a number falls back to its text length', () => {
    assert.equal(displayWidth('n/a', 'number'), 3);
  });
});

describe('the download filename', () => {
  const on = new Date('2026-08-25T10:00:00Z');

  test('carries the date, so two exports do not overwrite each other', () => {
    assert.equal(attachmentName('Order lines', on), 'Order lines 2026-08-25.xlsx');
  });

  test('drops what a Content-Disposition header cannot carry plainly', () => {
    assert.equal(attachmentName('Order "lines"/2026', on), 'Order lines 2026 2026-08-25.xlsx');
  });

  test('and never comes back empty', () => {
    assert.equal(attachmentName('///', on), 'export 2026-08-25.xlsx');
  });
});
