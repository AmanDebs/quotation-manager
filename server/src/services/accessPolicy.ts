import { db, transaction } from '../db/connection.js';
import {
  DEFAULT_ACCESS, FUNCTIONS, TEAM_ROLES, atLeast, isEditableRole, isFn, isLevel, isTeamRole,
  type AccessTable, type EditableRole, type Fn, type Level, type TeamRole,
} from './permissions.js';

/**
 * What each team may actually do — the client's own ticks over the recommended
 * matrix.
 *
 * `permissions.ts` is the vocabulary and the default and stays pure; this is
 * the half that reads the database, and it is deliberately the **only** place
 * in the app that answers "may they?". `can`, `levelFor` and `capabilities`
 * live here rather than beside the table they start from, because two
 * functions of that name — one reading the spec's matrix, one reading what the
 * client set — is precisely how a screen comes to disagree with the guard
 * behind it. There is one, and it reads the answer in force.
 *
 * **Only the differences are stored.** A cell nobody has re-ticked follows
 * `DEFAULT_ACCESS`, so resetting a team is a DELETE rather than a rewrite, a
 * correction shipped in a later release still reaches a deployment that has
 * customised something else, and a function added later arrives with a
 * sensible level instead of silently `none`. Same call, and the same reason,
 * as `DEFAULT_HIDDEN_COLUMNS`: a default, not a rule.
 *
 * **The table is cached in memory and rebuilt on write.** `can()` is asked
 * several times per request — every mount, every `allows()` key on a `getFull`
 * — and this is one process against one file on one disk, which the deployment
 * notes require and which is what makes a cache honest here rather than a
 * second copy that can go stale. Nothing outside this file writes the table.
 */

let cache: AccessTable | null = null;

/** Forget the cached table. Called on every write; exported for the tests. */
export function reloadAccess(): void {
  cache = null;
}

function build(): AccessTable {
  const table = {} as AccessTable;
  for (const role of TEAM_ROLES) table[role] = { ...DEFAULT_ACCESS[role] };

  let rows: { team_role: string; fn: string; level: string }[] = [];
  try {
    rows = db.prepare('SELECT team_role, fn, level FROM role_permissions').all() as typeof rows;
  } catch {
    // The table is created by schema.sql on every boot, so this can only be a
    // database opened by something that does not run it (a script reading the
    // file directly). Falling back to the recommended matrix is the safe
    // direction: it is what every deployment had before this existed.
    return table;
  }

  for (const row of rows) {
    // The vocabulary is the code's, never the row's — a level or a function
    // name that is no longer a thing is ignored rather than trusted, so
    // renaming a function in a later release cannot grant anybody anything.
    // `isEditableRole` is what keeps a hand-written super admin row inert.
    if (!isEditableRole(row.team_role) || !isFn(row.fn) || !isLevel(row.level)) continue;
    table[row.team_role][row.fn] = row.level;
  }
  return table;
}

function table(): AccessTable {
  if (!cache) cache = build();
  return cache;
}

/** What this role may do with this function. An unknown role may do nothing. */
export function levelFor(role: unknown, fn: Fn): Level {
  return isTeamRole(role) ? table()[role][fn] ?? 'none' : 'none';
}

/**
 * May this role do this, to at least this depth?
 *
 * An unknown, blank or missing role denies everything — which is the state of
 * a row the backfill has not reached and of a session whose `team_role` was
 * left out of a SELECT, and both should fail closed.
 */
export function can(role: unknown, fn: Fn, need: 'view' | 'full' = 'view'): boolean {
  return atLeast(levelFor(role, fn), need);
}

/** The whole table for one role, for the client to drive its screens from. */
export function capabilities(role: unknown): Record<Fn, Level> {
  const out = {} as Record<Fn, Level>;
  for (const fn of FUNCTIONS) out[fn] = levelFor(role, fn);
  return out;
}

/** Every role's effective row — what the permissions page draws. A copy. */
export function effectiveAccess(): AccessTable {
  const src = table();
  const out = {} as AccessTable;
  for (const role of TEAM_ROLES) out[role] = { ...src[role] };
  return out;
}

/** Which cells this role has been re-ticked on, for the "customised" marker. */
export function overridesFor(role: TeamRole): Partial<Record<Fn, Level>> {
  const out: Partial<Record<Fn, Level>> = {};
  const src = table();
  for (const fn of FUNCTIONS) if (src[role][fn] !== DEFAULT_ACCESS[role][fn]) out[fn] = src[role][fn];
  return out;
}

export interface AccessChange {
  fn: Fn;
  from: Level;
  to: Level;
}

/**
 * Re-tick one team.
 *
 * A function the body does not mention is **left alone** — the contract the
 * despatch's `batch_ids` and the tracker's sea-leg PATCH already follow, so a
 * screen that draws a subset can save without silently clearing the rest.
 *
 * A cell set back to what the recommended matrix says is **deleted rather than
 * stored**, which is what keeps "customised" meaning something and what makes
 * Reset a delete. Returns the cells that actually moved, so the audit entry
 * can name them; a save that changes nothing writes nothing and says so.
 */
export function setRoleAccess(role: EditableRole, wanted: Partial<Record<Fn, Level>>): AccessChange[] {
  const before = table()[role];
  const changes: AccessChange[] = [];

  transaction(() => {
    for (const fn of FUNCTIONS) {
      const to = wanted[fn];
      if (to === undefined) continue;
      const from = before[fn];
      if (to === DEFAULT_ACCESS[role][fn]) {
        db.prepare('DELETE FROM role_permissions WHERE team_role = ? AND fn = ?').run(role, fn);
      } else {
        db.prepare(
          `INSERT INTO role_permissions (team_role, fn, level) VALUES (?, ?, ?)
             ON CONFLICT(team_role, fn) DO UPDATE SET level = excluded.level, updated_at = datetime('now')`
        ).run(role, fn, to);
      }
      if (to !== from) changes.push({ fn, from, to });
    }
  });

  reloadAccess();
  return changes;
}
