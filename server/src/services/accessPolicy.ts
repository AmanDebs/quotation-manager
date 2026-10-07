import { db, transaction } from '../db/connection.js';
import {
  DEFAULT_ACCESS, FUNCTIONS, TEAM_ROLES, TEAM_ROLE_LABEL, atLeast, isEditableRole, isFn, isLevel, isTeamRole,
  type AccessTable, type EditableRole, type Fn, type Level, type TeamRole,
} from './permissions.js';

/**
 * What each person may actually do — their own ticks over their team's, over
 * the recommended matrix.
 *
 * **Three layers, and each one is only its differences from the one below.**
 * `DEFAULT_ACCESS` is the specification compiled in; `role_permissions` is what
 * the client re-ticked per team (2026-09-24); `user_permissions` is what they
 * re-ticked for one person (2026-10-07, *"USER wise access rather than
 * department wise access"*). A person with no row of their own follows their
 * team exactly as before, which is every account on file the day this ships —
 * so nobody's access moves until somebody ticks — and correcting the Sales row
 * still reaches every Sales account that has not been re-ticked itself. It is
 * the `DEFAULT_HIDDEN_COLUMNS` call made twice: a default, not a rule.
 *
 * Per team was the shape confirmed with the client when this page was built,
 * on the reasoning that one screen should answer *what can Sales do?*. That
 * screen is still there and still answers it; what is added is the other
 * question, *what can this person do?*, which a team matrix cannot answer when
 * two people on one team need different things.
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
let userCache: Map<number, Partial<Record<Fn, Level>>> | null = null;

/** Forget the cached tables. Called on every write; exported for the tests. */
export function reloadAccess(): void {
  cache = null;
  userCache = null;
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

function buildUsers(): Map<number, Partial<Record<Fn, Level>>> {
  const out = new Map<number, Partial<Record<Fn, Level>>>();
  let rows: { user_id: number; fn: string; level: string; team_role: string }[] = [];
  try {
    rows = db.prepare(
      `SELECT p.user_id, p.fn, p.level, u.team_role
         FROM user_permissions p JOIN users u ON u.id = p.user_id`
    ).all() as typeof rows;
  } catch {
    // A database opened by something that does not run schema.sql. Falling
    // back to the team table is the safe direction: it is what every
    // deployment had before this existed.
    return out;
  }
  for (const row of rows) {
    // The vocabulary is the code's, never the row's — same rule as above, and
    // a super admin's row is inert however it got written, which is what keeps
    // the account that can put everything back from being restricted by a
    // hand-edited table or a restored backup.
    if (row.team_role === 'super_admin' || !isFn(row.fn) || !isLevel(row.level)) continue;
    const held = out.get(Number(row.user_id)) ?? {};
    held[row.fn] = row.level;
    out.set(Number(row.user_id), held);
  }
  return out;
}

function users(): Map<number, Partial<Record<Fn, Level>>> {
  if (!userCache) userCache = buildUsers();
  return userCache;
}

/** What a session is: an id and a team, both of which may be missing. */
export interface AccessSubject {
  id?: unknown;
  team_role?: unknown;
}

/** What this team may do with this function. An unknown team may do nothing. */
export function roleLevelFor(role: unknown, fn: Fn): Level {
  return isTeamRole(role) ? table()[role][fn] ?? 'none' : 'none';
}

/**
 * What this **person** may do with this function: their own tick where they
 * have one, else their team's.
 *
 * A person with no id — which is a caller that passed a bare role, and nothing
 * in the app does any more — is answered by their team alone, which is the
 * behaviour this had before per-person ticks existed.
 */
export function levelFor(user: AccessSubject | undefined, fn: Fn): Level {
  const id = Number(user?.id);
  if (Number.isFinite(id) && id > 0) {
    const own = users().get(id)?.[fn];
    if (own !== undefined) return own;
  }
  return roleLevelFor(user?.team_role, fn);
}

/**
 * May this person do this, to at least this depth?
 *
 * An unknown, blank or missing team denies everything unless the person has
 * been ticked for it themselves — which is the state of a row the backfill has
 * not reached and of a session whose `team_role` was left out of a SELECT, and
 * both should fail closed.
 */
export function can(user: AccessSubject | undefined, fn: Fn, need: 'view' | 'full' = 'view'): boolean {
  return atLeast(levelFor(user, fn), need);
}

/** The whole table for one person, for the client to drive its screens from. */
export function capabilities(user: AccessSubject | undefined): Record<Fn, Level> {
  const out = {} as Record<Fn, Level>;
  for (const fn of FUNCTIONS) out[fn] = levelFor(user, fn);
  return out;
}

/** The whole table for one team, before anybody's own ticks. */
export function roleCapabilities(role: unknown): Record<Fn, Level> {
  const out = {} as Record<Fn, Level>;
  for (const fn of FUNCTIONS) out[fn] = roleLevelFor(role, fn);
  return out;
}

/** Which cells this person has been re-ticked on, for the "customised" marker. */
export function userOverridesFor(userId: number): Partial<Record<Fn, Level>> {
  return { ...(users().get(Number(userId)) ?? {}) };
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

/**
 * Re-tick one person.
 *
 * `setRoleAccess`'s rule one level further on, and the important half is which
 * cells are **deleted rather than stored**: a level equal to what this person's
 * **team** currently says is not an override at all, so it is removed. That is
 * what keeps "follows their team" meaning something, what makes Reset a
 * DELETE, and what lets a later correction to the Sales row still reach
 * everybody who was never re-ticked away from it.
 *
 * A function the body does not mention is **left alone** — the `batch_ids`
 * contract — so a screen drawing a subset can save without clearing the rest.
 * Returns the cells that actually moved; a save that changes nothing writes
 * nothing and says so.
 */
export function setUserAccess(
  userId: number,
  teamRole: unknown,
  wanted: Partial<Record<Fn, Level>>
): AccessChange[] {
  const changes: AccessChange[] = [];

  transaction(() => {
    for (const fn of FUNCTIONS) {
      const to = wanted[fn];
      if (to === undefined) continue;
      const from = levelFor({ id: userId, team_role: teamRole }, fn);
      if (to === roleLevelFor(teamRole, fn)) {
        db.prepare('DELETE FROM user_permissions WHERE user_id = ? AND fn = ?').run(userId, fn);
      } else {
        db.prepare(
          `INSERT INTO user_permissions (user_id, fn, level) VALUES (?, ?, ?)
             ON CONFLICT(user_id, fn) DO UPDATE SET level = excluded.level, updated_at = datetime('now')`
        ).run(userId, fn, to);
      }
      if (to !== from) changes.push({ fn, from, to });
    }
  });

  reloadAccess();
  return changes;
}

/** One row per account for the permissions page: who they are and what they hold. */
export interface UserAccessRow {
  id: number;
  name: string;
  email: string;
  team_role: string;
  team_label: string;
  /** A super admin is drawn locked, for the reason that role is. */
  editable: boolean;
  /** What they may actually do — their ticks over their team's. */
  access: Record<Fn, Level>;
  /** What their team says, so the page can show what they are departing from. */
  team_access: Record<Fn, Level>;
  /** How many cells are their own. */
  customised: number;
}

export function userAccessList(): UserAccessRow[] {
  const rows = db.prepare(
    `SELECT id, name, email, team_role FROM users WHERE active = 1 ORDER BY name, id`
  ).all() as { id: number; name: string; email: string; team_role: string }[];

  return rows.map((u) => {
    const editable = u.team_role !== 'super_admin';
    return {
      id: Number(u.id),
      name: String(u.name),
      email: String(u.email),
      team_role: String(u.team_role ?? ''),
      team_label: isTeamRole(u.team_role) ? TEAM_ROLE_LABEL[u.team_role] : '',
      editable,
      access: capabilities(u),
      team_access: roleCapabilities(u.team_role),
      // A super admin holds everything and has no overrides to count; saying
      // "0 changed" beside a locked column is the truth either way.
      customised: editable ? Object.keys(userOverridesFor(u.id)).length : 0,
    };
  });
}
