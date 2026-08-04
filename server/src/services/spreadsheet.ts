import { inflateRawSync } from 'node:zlib';

/**
 * Minimal spreadsheet reader for .xlsx and .csv, with no dependencies.
 *
 * An .xlsx file is a ZIP of XML parts, and Node ships both the inflate half of
 * ZIP (node:zlib) and everything else needed, so there is no reason to pull in
 * a third-party parser — which matters here because the machine has no C++
 * toolchain and the npm-hosted spreadsheet libraries carry known advisories.
 *
 * Scope is deliberately narrow: cell *values* as text, which is all a product
 * catalogue needs. Formatting, formulas, merged cells and date serials are not
 * interpreted — a cell formatted as a date comes back as Excel's underlying
 * serial number.
 */

export interface Sheet {
  name: string;
  /** Row-major cell text. Ragged rows are padded to the widest row. */
  rows: string[][];
}

/* ------------------------------------------------------------------ */
/* ZIP                                                                 */
/* ------------------------------------------------------------------ */

/** Read a ZIP's central directory and inflate every entry we're asked for. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();

  // The End Of Central Directory record sits at the end, after a comment of
  // unknown length, so scan backwards for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (no ZIP directory found)');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < entryCount; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    // The local header repeats the name and has its own extra field, whose
    // length can differ from the central one — always read it from here.
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compressedSize);

    try {
      files.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    } catch {
      // A part we cannot inflate is skipped rather than failing the whole file.
    }
  }
  return files;
}

/* ------------------------------------------------------------------ */
/* XML                                                                 */
/* ------------------------------------------------------------------ */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code] ?? whole;
  });
}

/** Text of every <t> inside a fragment, concatenated (rich text is split across runs). */
function textOf(fragment: string): string {
  let out = '';
  for (const m of fragment.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += m[1];
  return decodeXml(out);
}

/** "BC" → 54. Excel column letters are base-26 with no zero. */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/* ------------------------------------------------------------------ */
/* XLSX                                                                */
/* ------------------------------------------------------------------ */

function parseXlsx(buf: Buffer): Sheet[] {
  const files = unzip(buf);
  const read = (name: string) => files.get(name)?.toString('utf8') ?? '';

  // Shared strings: every <si> is one string, possibly split into <r> runs.
  const shared: string[] = [];
  const sharedXml = read('xl/sharedStrings.xml');
  if (sharedXml) {
    for (const m of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) {
      shared.push(m[1] ? textOf(m[1]) : '');
    }
  }

  // Sheet name → part path, via the workbook and its relationships.
  const rels = new Map<string, string>();
  for (const m of read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) rels.set(id, target.replace(/^\/?(xl\/)?/, ''));
  }

  const sheetRefs: { name: string; path: string }[] = [];
  for (const m of read('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)) {
    const name = /name="([^"]*)"/.exec(m[0])?.[1];
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
    const target = rid ? rels.get(rid) : undefined;
    if (name && target) sheetRefs.push({ name: decodeXml(name), path: `xl/${target}` });
  }
  // A workbook with no readable relationships still usually has sheet1.xml.
  if (sheetRefs.length === 0 && files.has('xl/worksheets/sheet1.xml')) {
    sheetRefs.push({ name: 'Sheet1', path: 'xl/worksheets/sheet1.xml' });
  }

  return sheetRefs.map(({ name, path }) => ({ name, rows: parseSheetXml(read(path), shared) }));
}

function parseSheetXml(xml: string, shared: string[]): string[][] {
  if (!xml) return [];
  const rows: string[][] = [];

  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] ?? '';
      const ref = /r="([A-Z]+)/.exec(attrs)?.[1];
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? 'n';

      let value = '';
      if (type === 's') {
        const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        value = shared[idx] ?? '';
      } else if (type === 'inlineStr') {
        value = textOf(body);
      } else if (type === 'b') {
        value = /<v>1<\/v>/.test(body) ? 'TRUE' : 'FALSE';
      } else {
        // Numbers, dates (as serials) and formula strings all live in <v>.
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      }

      const col = ref ? columnIndex(ref) : cells.length;
      while (cells.length < col) cells.push('');
      cells[col] = value.trim();
    }
    rows.push(cells);
  }

  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return rows.map((r) => {
    const padded = r.slice();
    while (padded.length < width) padded.push('');
    return padded;
  });
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

function parseCsv(text: string): Sheet[] {
  const body = text.replace(/^﻿/, '');
  // Guess the delimiter from the first line — Excel exports semicolons in
  // several locales, and tab-separated files are common too.
  const firstLine = body.slice(0, body.indexOf('\n') + 1 || body.length);
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const);
  const delimiter = counts.sort((a, b) => b[1] - a[1])[0][1] > 1 ? counts[0][0] : ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(field.trim()); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field.trim()); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field || row.length) { row.push(field.trim()); rows.push(row); }

  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return [{ name: 'CSV', rows: rows.map((r) => { const p = r.slice(); while (p.length < width) p.push(''); return p; }) }];
}

/* ------------------------------------------------------------------ */

/** Parse an uploaded spreadsheet into sheets of raw cell text. */
export function parseWorkbook(buf: Buffer, filename = ''): Sheet[] {
  const isCsv = /\.(csv|txt)$/i.test(filename);
  // .xlsx always begins with the ZIP local-header signature "PK\x03\x04".
  const looksZipped = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (isCsv && !looksZipped) return parseCsv(buf.toString('utf8'));
  if (!looksZipped) {
    if (/\.xls$/i.test(filename)) {
      throw new Error('The old .xls format is not supported — open it in Excel and "Save As" .xlsx or .csv.');
    }
    return parseCsv(buf.toString('utf8'));
  }
  return parseXlsx(buf);
}

/** Split a sheet at a known header row. */
export function splitAt(rows: string[][], headerRow: number): { headers: string[]; body: string[][]; headerRow: number } {
  const header = rows[headerRow] ?? [];
  return {
    headers: header.map((h, idx) => h || `Column ${idx + 1}`),
    body: rows.slice(headerRow + 1).filter((r) => r.some((c) => c !== '')),
    headerRow,
  };
}

/**
 * Guess which row holds the column headings, and return the table beneath it.
 *
 * Real spreadsheets rarely start at A1 — there is a title, a blank line, often
 * a merged banner above the real headings. So rather than taking the first
 * plausible row, score the candidates: a heading row is wide (many filled
 * cells) and made of words rather than numbers. The caller can override this,
 * and the import UI lets the user pick a different row.
 */
export function splitHeader(rows: string[][]): { headers: string[]; body: string[][]; headerRow: number } {
  const limit = Math.min(rows.length, 25);
  let best = -1;
  let bestScore = 0;

  for (let i = 0; i < limit; i++) {
    const filled = rows[i].filter((c) => c !== '');
    if (filled.length < 2) continue;
    const numeric = filled.filter((c) => !Number.isNaN(Number(c))).length;
    // Width is what identifies a heading row; numeric cells argue against it.
    const score = filled.length - numeric * 1.5;
    if (score > bestScore) { bestScore = score; best = i; }
  }

  if (best < 0) {
    const headers = (rows[0] ?? []).map((_, idx) => `Column ${idx + 1}`);
    return { headers, body: rows.filter((r) => r.some((c) => c !== '')), headerRow: -1 };
  }
  return splitAt(rows, best);
}
