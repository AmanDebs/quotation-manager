import { db } from '../db/connection.js';
import type { SessionUser } from '../middleware/auth.js';

/**
 * Who changed what, and when.
 *
 * The rules the trail has to obey to be worth keeping, all of them here rather
 * than spread across thirty routes:
 *
 * - **It is append-only.** Nothing in the application updates or deletes a row
 *   in `audit_log`. A log that can be edited answers a different question from
 *   the one it is being asked.
 * - **It records the change, not the request.** Entries carry a field-level
 *   diff of the row before and after, so "someone PUT the invoice" becomes
 *   "grand_total 3,000 → 4,500". Where nothing differed, nothing is written —
 *   a save that changed nothing is not an event.
 * - **It never reads a request body.** That is what makes "a password can
 *   never end up in the log" a structural fact rather than a promise: the
 *   capture path only ever looks at database rows, and the two fields that
 *   would matter are refused by name below.
 * - **It cannot fail a save.** Recording happens after the response, so a
 *   defect here can lose an entry but can never lose an invoice. The trade is
 *   deliberate and stated: this is a record of what the business did, not a
 *   ledger the business depends on.
 */

/** One field that moved. `truncated` where the value was too big to keep. */
export interface Change {
  field: string;
  from?: unknown;
  to?: unknown;
  truncated?: true;
}

export interface AuditEntry {
  user: SessionUser | undefined;
  entity: string;
  entity_id?: number | null;
  action: string;
  label?: string;
  changes?: Change[];
  note?: string;
}

/**
 * Left out of the diff entirely.
 *
 * `id` and `created_at` never move, and printing them on a create or a delete
 * — where every field appears to — buries the two or three that a reader came
 * for. The entry already carries both, as `entity_id` and `at`. The token
 * version moves in lockstep with a password change and says nothing on its
 * own; recording it would put a second, cryptic row beside the one that
 * already says what happened.
 */
const HIDDEN_FIELDS = new Set(['id', 'created_at', 'token_version']);

/**
 * Recorded as changed, without the value.
 *
 * Two different reasons, one treatment. `password_hash` is the important one:
 * **that a password changed is exactly what an audit trail is for**, and the
 * value is exactly what it must never hold. Dropping the field outright was
 * the first attempt and it made a manager resetting someone's account produce
 * no entry at all, since the hash and the token version are the only two
 * columns such a reset touches. The rest are base64 images and JSON blobs
 * running to hundreds of kilobytes — a diff carrying two of them would be
 * larger than the document it describes.
 */
const BULKY_FIELDS = new Set([
  'password_hash', 'logo', 'signature', 'image', 'bank_accounts', 'column_config', 'items',
]);

/** Beyond this a value is noted as changed rather than quoted. */
const MAX_VALUE_CHARS = 300;

/**
 * Two values that mean the same thing.
 *
 * **Empty counts as empty however it is spelled.** Most text columns here
 * default to `''`, so a create compared against nothing recorded every one of
 * them as `null → blank`: an invoice arrived in the log as thirty-seven
 * changes, thirty of them saying a field was empty and still is. The event is
 * that a document was created; "Consignee: blank" is not part of it. An edit
 * that genuinely clears a field still reads as a change, because the value it
 * had was not empty.
 *
 * SQLite also hands back a number where the caller wrote a numeric string, so
 * those are compared as numbers.
 */
const blank = (v: unknown) => v === null || v === undefined || v === '';

const same = (a: unknown, b: unknown) => {
  if (a === b) return true;
  if (blank(a) || blank(b)) return blank(a) && blank(b);
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
};

/**
 * The fields that differ between two rows.
 *
 * Either side may be absent: a create has no `before`, a delete no `after`,
 * and each is reported as the whole row moving in one direction. A field
 * present in one and missing from the other is compared as if it were null,
 * so adding a column does not make every subsequent edit look like a change.
 */
export function diffRows(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): Change[] {
  const fields = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  const changes: Change[] = [];
  for (const field of fields) {
    if (HIDDEN_FIELDS.has(field)) continue;
    const from = before?.[field] ?? null;
    const to = after?.[field] ?? null;
    if (same(from, to)) continue;
    const tooBig = BULKY_FIELDS.has(field)
      || String(from ?? '').length > MAX_VALUE_CHARS
      || String(to ?? '').length > MAX_VALUE_CHARS;
    changes.push(tooBig ? { field, truncated: true } : { field, from, to });
  }
  return changes;
}

/**
 * Write one entry.
 *
 * Swallows its own errors on purpose — see the note at the top of the file.
 * The failure is printed, because a trail quietly recording nothing is the one
 * way this feature can be worse than not having it.
 */
export function record(entry: AuditEntry): void {
  try {
    db.prepare(
      `INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, label, changes, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.user?.id ?? null,
      entry.user?.name ?? '',
      entry.entity,
      entry.entity_id ?? null,
      entry.action,
      entry.label ?? '',
      JSON.stringify(entry.changes ?? []),
      entry.note ?? '',
    );
  } catch (err) {
    console.error('audit: failed to record', entry.entity, entry.action, err);
  }
}

/**
 * What to call this row in the log.
 *
 * Stored rather than joined, so an entry still reads after the row it
 * describes has been deleted — which is precisely when it is being read.
 */
export function labelOf(row: Record<string, unknown> | undefined): string {
  if (!row) return '';
  for (const field of ['number', 'name', 'company_name', 'email', 'description', 'destination']) {
    const v = row[field];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 80);
  }
  return '';
}
