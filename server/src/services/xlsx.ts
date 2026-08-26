import { deflateRawSync } from 'node:zlib';

/**
 * Minimal .xlsx **writer**, the counterpart to the reader in spreadsheet.ts
 * and dependency-free for the same reasons: the machine has no C++ toolchain,
 * and the npm-hosted spreadsheet libraries carry known advisories. An .xlsx is
 * a ZIP of XML parts, and Node ships both halves of ZIP in `node:zlib`.
 *
 * Scope is deliberately narrow — one sheet, a bold header row, and four cell
 * kinds (text, number, money, date). No formulas, no merged cells, no images.
 * That is what exporting a list needs; anything more belongs in the workbook
 * the user builds from it.
 *
 * **Numbers are written as numbers and dates as real dates**, not as text.
 * A quantity that arrives in Excel as the string "21,00,000" cannot be summed,
 * which defeats the point of exporting to a spreadsheet at all. The display
 * grouping is left to Excel: the value is the fact, the formatting is a
 * preference, and lakh grouping is a locale setting rather than something to
 * bake into the file.
 */

export type CellValue = string | number | null | undefined;
export type CellType = 'text' | 'number' | 'money' | 'date';

export interface Column<T> {
  header: string;
  value: (row: T) => CellValue;
  /** Defaults to 'text'. */
  type?: CellType;
  /** Column width in characters. Measured from the content when omitted. */
  width?: number;
}

/* ------------------------------------------------------------------ */
/* XML                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Escape text for XML, and drop the control characters XML 1.0 forbids.
 *
 * The second half matters more than it looks: a stray control character makes
 * Excel declare the whole workbook corrupt and offer to repair it, with
 * nothing to say which cell caused it. Tab, newline and carriage return are
 * legal and kept.
 */
function xmlText(s: string): string {
  return s
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A1, B1 … Z1, AA1 … for a zero-based column index. */
function cellRef(col: number, row: number): string {
  let name = '';
  for (let n = col + 1; n > 0; ) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return `${name}${row}`;
}

/**
 * A date as Excel's serial number: days since 1899-12-30.
 *
 * Parsed from the digits rather than through `new Date(s)`, which reads a bare
 * date as UTC midnight — the same trap `fiscalYearOf` in numbering.ts avoids,
 * and it would shift every exported date by a day on a server behind UTC.
 * Anything that is not a plain YYYY-MM-DD comes back null and is written as
 * text, since a half-understood date is worse than a visible string.
 */
function excelSerial(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const days = Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000);
  return Number.isFinite(days) && days > 0 ? days : null;
}

/* Style indexes, matching the cellXfs order in STYLES below. */
const S_DEFAULT = 0;
const S_HEADER = 1;
const S_DATE = 2;
const S_NUMBER = 3;
const S_MONEY = 4;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="#,##0"/><numFmt numFmtId="166" formatCode="#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEFF3F8"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>`;

/** Excel refuses these in a sheet name, and silently truncates past 31 chars. */
function safeSheetName(name: string): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, ' ').trim() || 'Sheet1';
  return cleaned.slice(0, 31);
}

/**
 * How wide a value will *look*, which is not how long its raw string is.
 *
 * A column sized to `String(12600000).length` is ten characters wide, and
 * Excel renders that cell as `1,26,00,000.00` — fourteen — so the column
 * shows `########` instead of the number. The separators are counted the
 * Indian way (one every two digits after the first three), which is the wider
 * of the two conventions and therefore the safe one to size against: too wide
 * is untidy, too narrow hides the figure entirely.
 */
export function displayWidth(value: CellValue, type: CellType): number {
  if (value === null || value === undefined || value === '') return 0;
  if (type === 'date') return 10; // dd/mm/yyyy
  if (type === 'number' || type === 'money') {
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value).length;
    const digits = Math.abs(Math.trunc(n)).toString().length;
    const separators = digits > 3 ? Math.ceil((digits - 3) / 2) : 0;
    return digits + separators + (type === 'money' ? 3 : 0) + (n < 0 ? 1 : 0);
  }
  return String(value).length;
}

function sheetXml<T>(columns: Column<T>[], rows: T[]): string {
  const widths = columns.map((c) => {
    if (c.width) return c.width;
    const type = c.type ?? 'text';
    let max = c.header.length;
    for (const row of rows) {
      const len = displayWidth(c.value(row), type);
      if (len > max) max = len;
    }
    // Clamped: one long remark should not push every other column off screen.
    return Math.min(Math.max(max + 2, 8), 46);
  });

  const cols = widths
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join('');

  const head = columns
    .map((c, i) => `<c r="${cellRef(i, 1)}" t="inlineStr" s="${S_HEADER}"><is><t>${xmlText(c.header)}</t></is></c>`)
    .join('');

  const body = rows
    .map((row, r) => {
      const cells = columns
        .map((c, i) => {
          const ref = cellRef(i, r + 2);
          const raw = c.value(row);
          if (raw === null || raw === undefined || raw === '') return '';
          const type = c.type ?? 'text';

          if (type === 'date') {
            const serial = excelSerial(String(raw));
            if (serial !== null) return `<c r="${ref}" s="${S_DATE}"><v>${serial}</v></c>`;
            return `<c r="${ref}" t="inlineStr" s="${S_DEFAULT}"><is><t>${xmlText(String(raw))}</t></is></c>`;
          }

          if (type === 'number' || type === 'money') {
            const n = Number(raw);
            // Not a number after all — write what was actually there rather
            // than NaN, which Excel shows as an empty cell.
            if (!Number.isFinite(n)) {
              return `<c r="${ref}" t="inlineStr" s="${S_DEFAULT}"><is><t>${xmlText(String(raw))}</t></is></c>`;
            }
            return `<c r="${ref}" s="${type === 'money' ? S_MONEY : S_NUMBER}"><v>${n}</v></c>`;
          }

          return `<c r="${ref}" t="inlineStr" s="${S_DEFAULT}"><is><t>${xmlText(String(raw))}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 2}">${cells}</row>`;
    })
    .join('');

  const lastCol = cellRef(Math.max(0, columns.length - 1), rows.length + 1);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastCol}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols><sheetData><row r="1">${head}</row>${body}</sheetData><autoFilter ref="A1:${lastCol}"/></worksheet>`;
}

/* ------------------------------------------------------------------ */
/* ZIP                                                                 */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * A fixed DOS timestamp (1 Jan 2020, 00:00) rather than the clock.
 *
 * The same input then produces byte-identical output, which is what makes the
 * writer testable. Excel does not read these fields, and the file's real date
 * is the one the filesystem gives it on download.
 */
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

interface Entry { name: string; body: Buffer }

/** Build a ZIP from parts already in memory — an .xlsx is never large enough to stream. */
function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.body);
    const crc = crc32(entry.body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(entry.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(entry.body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + deflated.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ------------------------------------------------------------------ */
/* The workbook                                                        */
/* ------------------------------------------------------------------ */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

/** One sheet of `rows`, described by `columns`. Returns the .xlsx bytes. */
export function buildXlsx<T>(sheetName: string, columns: Column<T>[], rows: T[]): Buffer {
  const name = safeSheetName(sheetName);
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlText(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  return zip([
    { name: '[Content_Types].xml', body: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', body: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'xl/workbook.xml', body: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', body: Buffer.from(WORKBOOK_RELS, 'utf8') },
    { name: 'xl/styles.xml', body: Buffer.from(STYLES, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', body: Buffer.from(sheetXml(columns, rows), 'utf8') },
  ]);
}

/**
 * A filename safe for the Content-Disposition header.
 *
 * Quotes and non-ASCII are stripped rather than encoded: browsers disagree
 * about `filename*`, and a plain ASCII name every one of them agrees on beats
 * a clever one that arrives mangled in some of them.
 */
export function attachmentName(base: string, date = new Date()): string {
  const stamp = date.toISOString().slice(0, 10);
  const clean = base.replace(/[^A-Za-z0-9 _-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'export';
  return `${clean} ${stamp}.xlsx`;
}
