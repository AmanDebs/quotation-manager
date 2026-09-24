import { Router } from 'express';
import type { AuthedRequest } from '../middleware/auth.js';
import { record } from '../services/audit.js';
import {
  DEFAULT_ACCESS, EDITABLE_ROLES, FUNCTIONS, FUNCTION_GROUPS, FUNCTION_META, TEAM_ROLES,
  TEAM_ROLE_LABEL, isEditableRole, isFn, isLevel, type Fn, type Level,
} from '../services/permissions.js';
import { effectiveAccess, overridesFor, setRoleAccess, type AccessChange } from '../services/accessPolicy.js';

/**
 * The User Permissions page — who may do what, as ticks.
 *
 * Mounted on `team: full`, the same cell that owns the accounts themselves:
 * deciding what a team may do and deciding who is on it are one job, and
 * whoever can create a super admin account can already grant themselves
 * anything, so a separate function here would be a cell nobody could honestly
 * fill in on the client's own matrix.
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
  };
}

permissionsRouter.get('/', (_req, res) => res.json(matrix()));

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
permissionsRouter.put('/:role', (req: AuthedRequest, res) => {
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
