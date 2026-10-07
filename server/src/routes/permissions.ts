import { Router } from 'express';
import { db } from '../db/connection.js';
import { requirePermission, type AuthedRequest } from '../middleware/auth.js';
import { record } from '../services/audit.js';
import {
  DEFAULT_ACCESS, EDITABLE_ROLES, FUNCTIONS, FUNCTION_GROUPS, FUNCTION_META, TEAM_ROLES,
  TEAM_ROLE_LABEL, isEditableRole, isFn, isLevel, isTeamRole, type Fn, type Level,
} from '../services/permissions.js';
import {
  capabilities, effectiveAccess, overridesFor, setRoleAccess, setUserAccess, userAccessList,
  roleCapabilities, type AccessChange,
} from '../services/accessPolicy.js';

/**
 * Who may do what, as ticks — and what *you* may do, which is a different
 * question with a different answer and a different guard.
 *
 * **Mounted on `requireAuth` alone, with every route carrying its own guard.**
 * The editing half is `team: full`, the same cell that owns the accounts
 * themselves — deciding what a team may do and deciding who is on it are one
 * job, and whoever can create a super admin account can already grant
 * themselves anything, so a separate function here would be a cell nobody
 * could honestly fill in on the client's own matrix. But `/mine` answers about
 * the caller's own team and must reach **everybody**, and there is no function
 * to gate it on that would do: under an editable matrix any cell can be
 * unticked, so every candidate is one somebody could be refused.
 *
 * Mounting the router on `team: full` and making an exception inside it is not
 * possible — a mount runs first — which is the trap `routes/workOrders.ts`
 * records from the other side, where a mount too specific for the router
 * beneath it refused a route its own guard would have allowed. The inverse
 * trap is `routes/pdf.ts`'s, where a mount too weak let a whole list out
 * through a route nobody thought of as part of the module: so both writes and
 * the whole-matrix read below name their guard explicitly, and a route added
 * here without one is open to every signed-in user.
 *
 * The vocabulary — the roles, the functions, their labels and **which levels
 * mean anything for each** — is sent with the answer rather than kept on the
 * client, the rule `/auth/me` already follows about the capability map: a
 * second list is a second policy, and it drifts.
 */
export const permissionsRouter = Router();

const functionList = FUNCTIONS.map((fn) => ({ fn, ...FUNCTION_META[fn] }));

function matrix() {
  const effective = effectiveAccess();
  return {
    roles: TEAM_ROLES.map((role) => ({
      role,
      label: TEAM_ROLE_LABEL[role],
      editable: isEditableRole(role),
      // How many cells this team has been re-ticked on, so the page can say
      // which rows are the client's own rather than the matrix's.
      customised: Object.keys(overridesFor(role)).length,
    })),
    functions: functionList,
    groups: FUNCTION_GROUPS,
    access: effective,
    recommended: DEFAULT_ACCESS,
    /*
     * And one row per account (2026-10-07, *"USER wise access rather than
     * department wise access"*). It rides the same payload rather than taking a
     * route of its own because the page draws both halves from one answer, and
     * two requests for one screen is how the two come to disagree about the
     * same person: a user's effective row is their ticks over their *team's*,
     * so the team matrix above is half of what this list means.
     */
    users: userAccessList(),
  };
}

/**
 * What the signed-in user's own team may do.
 *
 * Declared **above** the guarded routes, the rule the `export` endpoints
 * follow about `/:id` — and gated by nothing but the mount's `requireAuth`,
 * deliberately: somebody refused a screen should be able to read why without
 * having to ask the person who refused them.
 *
 * It answers about `req.user` and takes no parameter, so there is nothing to
 * ask it about somebody else. The levels come from `capabilities`, which is
 * the same function `/auth/me` hands the client its map with — the page cannot
 * disagree with what the app actually does, because it is the same answer.
 * A blank `team_role`, which is a row the backfill never reached, reads as no
 * access to anything, which is exactly what that session may do.
 */
permissionsRouter.get('/mine', (req: AuthedRequest, res) => {
  const role = req.user?.team_role ?? '';
  const team = roleCapabilities(role);
  const mine = capabilities(req.user);
  res.json({
    role,
    label: isTeamRole(role) ? TEAM_ROLE_LABEL[role] : '',
    functions: functionList,
    groups: FUNCTION_GROUPS,
    access: mine,
    /*
     * What the team says, so the page can mark the cells that are this
     * person's own rather than their team's (2026-10-07). It is sent rather
     * than derived on the client for the reason the whole vocabulary is: a
     * second copy of the matrix is a second policy.
     */
    team_access: team,
    own: FUNCTIONS.filter((fn) => mine[fn] !== team[fn]).length,
  });
});

permissionsRouter.get('/', requirePermission('team', 'full'), (_req, res) => res.json(matrix()));

/** What the log should say: the cells that moved, in words. */
function noteFor(changes: AccessChange[]): string {
  return changes
    .map((c) => `${FUNCTION_META[c.fn].label}: ${c.from} → ${c.to}`)
    .join(', ')
    .slice(0, 900);
}

/**
 * Re-tick one team.
 *
 * The audit entry is written here rather than by the middleware above the
 * routers — `permissions` is in its `SKIP` set — for the reason the numbering
 * counters are: there is no row with an `id` to diff, so the generic capture
 * would file "somebody did something" with nothing in it. This names the team
 * and every cell that moved, which is the whole of what somebody would come
 * looking for.
 */
/**
 * Re-tick one person.
 *
 * Declared **above `/:role`**, the rule every `export` and `prefill` route
 * here follows — two segments cannot be read as one today, but a sibling added
 * later could be, and the ordering costs nothing.
 *
 * The same guard as the team matrix, `team: full`: deciding what one person
 * may do and deciding who is on which team are the same job, held by the same
 * cell, and whoever can create a super admin account can already grant
 * themselves anything.
 *
 * **A super admin is refused by name**, exactly as that column is on the team
 * matrix, and for the same reason: untick `team` on the only account that can
 * put it back and there is no screen left to undo it from. The loader ignores
 * such a row however it got written, so this is the second of the two rails
 * rather than the only one.
 */
permissionsRouter.put('/user/:id', requirePermission('team', 'full'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT id, name, team_role, active FROM users WHERE id = ?').get(id) as
    { id: number; name: string; team_role: string; active: number } | undefined;
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.team_role === 'super_admin') {
    return res.status(400).json({
      error: 'A Super Admin has every permission and cannot be restricted — it is the account that can put the others back.',
    });
  }

  const body = (req.body ?? {}) as { access?: Record<string, unknown> };
  const access = body.access;
  if (!access || typeof access !== 'object') return res.status(400).json({ error: 'access is required' });

  // Everything is checked before anything is written, the rule PUT /users/:id
  // records: a refused level must not leave the ticks beside it half-saved.
  const wanted: Partial<Record<Fn, Level>> = {};
  for (const [fn, level] of Object.entries(access)) {
    if (!isFn(fn)) return res.status(400).json({ error: `Not a permission: ${fn}` });
    if (!isLevel(level)) return res.status(400).json({ error: `Level must be none, view or full — got ${String(level)} for ${fn}` });
    wanted[fn] = level;
  }

  const changes = setUserAccess(id, user.team_role, wanted);
  if (changes.length) {
    record({
      user: req.user, entity: 'permissions', action: 'update',
      // Named as an account rather than bare, or an entry reading *Production*
      // would not say whether the team moved or one person on it did.
      label: `${user.name} (account)`, note: noteFor(changes),
    });
  }
  res.json({ ...matrix(), changed: changes.length });
});

permissionsRouter.put('/:role', requirePermission('team', 'full'), (req: AuthedRequest, res) => {
  const role = req.params.role;
  if (!isEditableRole(role)) {
    return res.status(400).json({
      error: role === 'super_admin'
        ? 'The Super Admin has every permission and cannot be restricted — it is the account that can put the others back.'
        : `Role must be one of: ${EDITABLE_ROLES.join(', ')}`,
    });
  }
  const body = (req.body ?? {}) as { access?: Record<string, unknown> };
  const access = body.access;
  if (!access || typeof access !== 'object') return res.status(400).json({ error: 'access is required' });

  // Everything is checked before anything is written, the rule PUT /users/:id
  // records: a refused level must not leave the ticks beside it half-saved.
  const wanted: Partial<Record<Fn, Level>> = {};
  for (const [fn, level] of Object.entries(access)) {
    if (!isFn(fn)) return res.status(400).json({ error: `Not a permission: ${fn}` });
    if (!isLevel(level)) return res.status(400).json({ error: `Level must be none, view or full — got ${String(level)} for ${fn}` });
    wanted[fn] = level;
  }

  const changes = setRoleAccess(role, wanted);
  if (changes.length) {
    record({
      user: req.user, entity: 'permissions', action: 'update',
      label: TEAM_ROLE_LABEL[role], note: noteFor(changes),
    });
  }
  res.json({ ...matrix(), changed: changes.length });
});
