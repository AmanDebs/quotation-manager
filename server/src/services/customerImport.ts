import { parseWorkbook, splitHeader, splitAt, type Sheet } from './spreadsheet.js';
import { autoMapFields, matchByName, norm, type SynonymField } from './importMapping.js';

/**
 * Turning a list of names into customers.
 *
 * The third importer, and the one the other two wait on: the order import
 * **refuses to create a customer from a spelling in a sheet**, so a backlog
 * cannot be loaded until the buyers are on file — the live order book names
 * **210 of them**. That refusal is not withdrawn here; it is answered. What
 * makes this a different act is that somebody is looking at the customer book
 * while they do it, sees every row that would be added, and is told which ones
 * already read like a record on file.
 *
 * Two shapes are expected, and one list of fields covers both: a proper
 * customer sheet with addresses and registrations, and **the Party Name column
 * of the order sheet on its own**, which is how this book's 210 names arrive.
 * A row carrying nothing but a name is a customer with a name — thin, and
 * exactly what the order import needs to stop refusing; the address is typed
 * later or imported again from a fuller sheet.
 *
 * What it will not do:
 *
 * - **A near-match is not a new customer.** Two spellings of one buyer is the
 *   whole risk of importing names in bulk, and nothing downstream can tell
 *   them apart afterwards — every document, payment and order hangs off one
 *   `customer_id`. *Northern Traders Pvt. Ltd.* against *Northern Traders Pvt
 *   Ltd* is therefore left alone by default and reported, and adding it anyway
 *   is a choice on the dialog rather than the default.
 * - **A near-match is never *updated* either**, which would rename a record
 *   the whole book points at to whatever the sheet happens to spell. Only an
 *   exact name is updated, and then only in the columns the sheet actually
 *   carries — a name list must not blank the addresses already on file.
 */

export type CustomerFieldKey =
  | 'name' | 'contact_person' | 'email' | 'phone' | 'gstin'
  | 'consignee' | 'notify_party_2' | 'notify_party'
  | 'address' | 'city' | 'country' | 'currency' | 'notes';

export interface CustomerFieldSpec extends SynonymField<CustomerFieldKey> {
  label: string;
  required?: boolean;
}

/**
 * Declaration order decides an ambiguous heading, and three pairs here would
 * otherwise collide: *Contact Name* before *Name* (a bare "name" matches
 * both), *Notify Party 2* before *Notify Party* (the first contains the
 * second), and *Delivery Address* before *Address*.
 */
export const CUSTOMER_IMPORT_FIELDS: CustomerFieldSpec[] = [
  { key: 'contact_person', label: 'Contact Person', synonyms: ['contact person', 'contact name', 'kind attn', 'attn', 'contact'] },
  { key: 'name', label: 'Customer Name', required: true, synonyms: ['customer name', 'party name', 'name of customer', 'account name', 'customer', 'party', 'buyer', 'client', 'name'] },
  { key: 'email', label: 'Email', synonyms: ['email id', 'e mail', 'email', 'mail id'] },
  { key: 'phone', label: 'Phone', synonyms: ['phone no', 'mobile no', 'contact no', 'telephone', 'phone', 'mobile', 'tel'] },
  { key: 'gstin', label: 'GSTIN', synonyms: ['gstin', 'gst no', 'gst number', 'gst', 'tax id'] },
  { key: 'consignee', label: 'Delivery Address', synonyms: ['delivery address', 'consignee', 'ship to'] },
  { key: 'notify_party_2', label: 'Notify Party 2', synonyms: ['notify party 2', 'notify 2'] },
  { key: 'notify_party', label: 'Notify Party', synonyms: ['notify party', 'notify 1', 'notify'] },
  { key: 'address', label: 'Address', synonyms: ['billing address', 'address', 'street'] },
  { key: 'city', label: 'City', synonyms: ['city', 'town', 'place'] },
  { key: 'country', label: 'Country', synonyms: ['country', 'nation'] },
  { key: 'currency', label: 'Currency', synonyms: ['currency', 'curr'] },
  { key: 'notes', label: 'Notes', synonyms: ['notes', 'remarks', 'comments', 'note'] },
];

export type CustomerMapping = Partial<Record<CustomerFieldKey, number>>;

/** Best-guess column for each field; the declaration order above decides ties. */
export function autoMapCustomers(headers: string[]): CustomerMapping {
  return autoMapFields(headers, CUSTOMER_IMPORT_FIELDS);
}

export interface DraftCustomer {
  name: string; contact_person: string; email: string; phone: string;
  address: string; city: string; country: string; gstin: string; currency: string;
  consignee: string; notify_party: string; notify_party_2: string; notes: string;
  is_export: number;
}

export interface CustomerRow {
  /** 1-based row in the original sheet, so a finding can be pointed at. */
  row: number;
  customer: DraftCustomer;
  action: 'create' | 'update' | 'skip';
  note?: string;
  existingId?: number;
  /** The name already on file this row reads like, where it is not the same spelling. */
  nearName?: string;
}

export interface CustomerBuildResult {
  sheetNames: string[];
  sheet: string;
  headerRow: number;
  headers: string[];
  mapping: CustomerMapping;
  rows: CustomerRow[];
  summary: { create: number; update: number; skip: number; near: number; total: number };
}

export interface CustomerBuildOptions {
  sheet?: string;
  headerRow?: number;
  mapping?: CustomerMapping;
  /** What to do with a row whose name is already on file, exactly. */
  onDuplicate?: 'update' | 'skip';
  /**
   * What to do with a row that reads like a record on file without matching it
   * exactly. `same` leaves that customer alone — the safe direction, since a
   * second spelling cannot be told from the first afterwards — and `new` adds
   * it, for a book that really does have two companies of nearly one name.
   */
  nearMatch?: 'same' | 'new';
}

/**
 * Where the headings are.
 *
 * `splitHeader` scores rows on width, which is right for a real sheet and
 * blind to a single column: no row has the two filled cells it needs to
 * consider one. So a one-column sheet is judged by **whether its first cell
 * reads like a heading for this import** — *Customer Name*, *Party Name* — and
 * treated as headerless when it does not, in which case the caller defaults
 * the name to that column.
 */
function headerSplit(rows: string[][]) {
  const found = splitHeader(rows);
  if (found.headerRow >= 0) return found;
  const first = rows.find((r) => r.some((c) => c !== ''));
  const width = Math.max(0, ...rows.map((r) => r.filter((c) => c !== '').length));
  if (width === 1 && first && autoMapCustomers([first[0] ?? '']).name === 0) {
    return splitAt(rows, rows.indexOf(first));
  }
  return found;
}

/** What this import matches against: the customers this caller can already see. */
export interface CustomerLookups {
  customers: { id: number; name: string }[];
}

/**
 * Read a workbook and work out what it would add, writing nothing.
 *
 * One row is one customer, so there is no grouping to do — what there is
 * instead is **repeat detection**, which matters more here than anywhere else:
 * the sheet these names come from is an order book where each buyer appears on
 * every line they ever ordered, so the live one names 210 customers across 804
 * rows.
 */
export function buildCustomerImport(
  buf: Buffer,
  filename: string,
  lookups: CustomerLookups,
  opts: CustomerBuildOptions = {}
): CustomerBuildResult {
  const sheets: Sheet[] = parseWorkbook(buf, filename);
  if (sheets.length === 0) throw new Error('That file has no readable sheets.');

  const chosen = sheets.find((s) => s.name === opts.sheet)
    ?? sheets.find((s) => s.rows.some((r) => r.some((c) => c !== '')))
    ?? sheets[0];

  const split = opts.headerRow !== undefined && opts.headerRow >= 0
    ? splitAt(chosen.rows, opts.headerRow)
    : headerSplit(chosen.rows);
  const { headers, body, headerRow } = split;

  const mapping = opts.mapping && Object.keys(opts.mapping).length ? opts.mapping : autoMapCustomers(headers);
  /*
   * A single column of names is a sheet `splitHeader` cannot judge: it scores a
   * heading row on **width**, and needs two filled cells to consider one at
   * all, so a list pasted into one column comes back as "no heading found" and
   * nothing is mapped. That shape is the likeliest of all here — it is what
   * the order sheet's Party Name column looks like on its own — so where the
   * sheet is one column wide and its first row is not a heading we can
   * recognise, the name is that column. Only ever applied when nobody has
   * mapped it: the dialog's own choice still wins.
   */
  if (mapping.name === undefined && headerRow < 0 && headers.length === 1) mapping.name = 0;
  const onDuplicate = opts.onDuplicate ?? 'skip';
  const nearMatch = opts.nearMatch ?? 'same';

  const cell = (r: string[], key: CustomerFieldKey) => {
    const idx = mapping[key];
    return idx === undefined || idx < 0 ? '' : (r[idx] ?? '').trim();
  };

  const seen = new Map<string, number>();
  const rows: CustomerRow[] = body.map((r, i) => {
    const rowNo = headerRow + 2 + i;
    const name = cell(r, 'name');
    const country = cell(r, 'country') || 'India';
    const customer: DraftCustomer = {
      name,
      contact_person: cell(r, 'contact_person'),
      email: cell(r, 'email'),
      phone: cell(r, 'phone'),
      address: cell(r, 'address'),
      city: cell(r, 'city'),
      country,
      gstin: cell(r, 'gstin').toUpperCase(),
      currency: cell(r, 'currency').toUpperCase() || 'INR',
      consignee: cell(r, 'consignee'),
      notify_party: cell(r, 'notify_party'),
      notify_party_2: cell(r, 'notify_party_2'),
      notes: cell(r, 'notes'),
      // The rule `POST /customers` already applies: a country stated and not
      // India is an export buyer. Silence is domestic, which is what the
      // column's own default says.
      is_export: country.trim().toLowerCase() !== 'india' && country.trim() !== '' ? 1 : 0,
    };

    if (!name) return { row: rowNo, customer, action: 'skip', note: 'No customer name in this row' };

    // The order sheet names each buyer once per line they ever ordered, so
    // this is the rule that turns 804 rows into 210 customers.
    const key = norm(name);
    const first = seen.get(key);
    if (first !== undefined) {
      return { row: rowNo, customer, action: 'skip', note: `Already named on row ${first} of this sheet` };
    }
    seen.set(key, rowNo);

    const match = matchByName(name, lookups.customers);
    if (match.exact && match.hit) {
      return onDuplicate === 'update'
        ? { row: rowNo, customer, action: 'update', existingId: match.hit.id }
        : { row: rowNo, customer, action: 'skip', note: 'Already on file — left exactly as it is', existingId: match.hit.id };
    }
    if (match.ambiguous) {
      const names = (match.near ?? []).map((c) => `“${c.name}”`).join(' and ');
      return {
        row: rowNo, customer,
        action: nearMatch === 'new' ? 'create' : 'skip',
        note: `Reads like ${names} already on file${nearMatch === 'new' ? ' — added anyway' : ' — left alone'}`,
      };
    }
    if (match.hit) {
      /*
       * A near match is **never updated**, whatever `onDuplicate` says: an
       * update writes the sheet's spelling over the name, and every document,
       * payment and order in the book hangs off that one record. Left alone or
       * added as its own customer — those are the two honest answers.
       */
      return nearMatch === 'new'
        ? { row: rowNo, customer, action: 'create', note: `Reads like “${match.hit.name}” already on file — added anyway`, nearName: match.hit.name }
        : { row: rowNo, customer, action: 'skip', note: `Reads like “${match.hit.name}” already on file — left alone`, existingId: match.hit.id, nearName: match.hit.name };
    }
    return { row: rowNo, customer, action: 'create' };
  });

  return {
    sheetNames: sheets.map((s) => s.name),
    sheet: chosen.name,
    headerRow,
    headers,
    mapping,
    rows,
    summary: {
      create: rows.filter((r) => r.action === 'create').length,
      update: rows.filter((r) => r.action === 'update').length,
      skip: rows.filter((r) => r.action === 'skip').length,
      near: rows.filter((r) => r.nearName).length,
      total: rows.length,
    },
  };
}

/** The columns an update may write: the ones the sheet actually carries. */
export function mappedColumns(mapping: CustomerMapping): CustomerFieldKey[] {
  return CUSTOMER_IMPORT_FIELDS
    .map((f) => f.key)
    .filter((k) => k !== 'name' && mapping[k] !== undefined && (mapping[k] as number) >= 0);
}
