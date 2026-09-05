/**
 * Who may do what.
 *
 * Five roles, from the access matrix the client supplied on 2026-09-05, each
 * with full / view / no access per function. Before this the whole of
 * authorisation was one boolean — `role === 'manager'` — plus row scoping on
 * `customers.owner_id`.
 *
 * **No `db` import, deliberately.** This is policy, not data: it is the same
 * table for every deployment, it has to be readable in one screen, and being
 * pure is what lets it be tested without a database and sent to the client as
 * a computed map. Same rule and same reason as `companyPatterns.ts` and
 * `productType.ts`.
 *
 * **There is no CHECK constraint on `users.team_role`**, for the reason
 * `products.product_type` records: SQLite cannot ALTER one, and a list of
 * roles is exactly the sort of thing a business adds a sixth entry to. The
 * enum is enforced in `routes/users.ts` instead, answering 400 with the list.
 */

export const TEAM_ROLES = ['super_admin', 'sales', 'logistics', 'production', 'quality'] as const;

export type TeamRole = (typeof TEAM_ROLES)[number];

export const TEAM_ROLE_LABEL: Record<TeamRole, string> = {
  super_admin: 'Super Admin',
  sales: 'Sales',
  logistics: 'Logistics',
  production: 'Production',
  quality: 'Quality',
};

export function isTeamRole(v: unknown): v is TeamRole {
  return typeof v === 'string' && (TEAM_ROLES as readonly string[]).includes(v);
}

/**
 * The things access is granted over.
 *
 * A *function*, not a route and not a table: `work_order`, `output` and `qc`
 * all live in `routes/workOrders.ts`, and `settings` spans two routers. The
 * mapping from function to route is made where the guard is applied.
 */
export const FUNCTIONS = [
  // The sales chain.
  'enquiry', 'quotation', 'proforma', 'order', 'dashboard',
  // The floor.
  'work_order', 'output', 'qc', 'material', 'dispatch',
  // Going out.
  'invoice', 'packing_list',
  // Reference data.
  'customer', 'product', 'master', 'followup', 'payment',
  // Administration.
  'purchasing', 'approval', 'audit', 'team', 'settings', 'backup',
] as const;

export type Fn = (typeof FUNCTIONS)[number];

export type Level = 'none' | 'view' | 'full';

/** none < view < full, so a `full` grant satisfies a `view` requirement. */
const RANK: Record<Level, number> = { none: 0, view: 1, full: 2 };

/**
 * The table itself.
 *
 * Written out in full — every role, every function, no defaults and no
 * inheritance — for the reason `routes/audit.ts` gives about its own
 * `OWNER_SQL`: getting one of these wrong shows one person another person's
 * data, and a rule you have to derive in your head to read is a rule nobody
 * checks. A missing cell would silently mean `none`, so a test asserts the
 * table is total.
 *
 * Cells marked (matrix) are the client's own. The rest answer "what does each
 * role have to be able to *read* to do its job" and are the ones to revisit
 * first if somebody cannot see something they need.
 */
export const ACCESS: Record<TeamRole, Record<Fn, Level>> = {
  super_admin: {
    enquiry: 'full', quotation: 'full', proforma: 'full', order: 'full', dashboard: 'full',
    work_order: 'full', output: 'full', qc: 'full', material: 'full', dispatch: 'full',
    invoice: 'full', packing_list: 'full',
    customer: 'full', product: 'full', master: 'full', followup: 'full', payment: 'full',
    purchasing: 'full', approval: 'full', audit: 'full', team: 'full', settings: 'full', backup: 'full',
  },
  sales: {
    enquiry: 'full', quotation: 'full', proforma: 'full', order: 'full', dashboard: 'view', // matrix
    work_order: 'none', output: 'none', qc: 'none', material: 'none', dispatch: 'none',
    invoice: 'view', packing_list: 'view', // matrix: VIEW / Download
    // `master` is reference data — plant names, transporters, the material
    // list. Sales reaches it through the recipe panel on the Products page, so
    // reading it is granted; the matrix does not mention masters at all.
    customer: 'full', product: 'full', master: 'view', followup: 'full', payment: 'full',
    purchasing: 'none', approval: 'none', audit: 'none', team: 'none', settings: 'none', backup: 'none',
  },
  logistics: {
    enquiry: 'none', quotation: 'none', proforma: 'none', order: 'view', dashboard: 'view', // matrix
    work_order: 'none', output: 'none', qc: 'none', material: 'none', dispatch: 'full', // matrix
    // Full, but only on an export shipment — see `exportOnlyInvoice`. A level
    // cannot say "only these rows", so the row rule lives beside it.
    invoice: 'full', packing_list: 'full',
    customer: 'view', product: 'view', master: 'view', followup: 'none', payment: 'none',
    purchasing: 'none', approval: 'none', audit: 'none', team: 'none', settings: 'none', backup: 'none',
  },
  production: {
    enquiry: 'none', quotation: 'none', proforma: 'none', order: 'none', dashboard: 'view', // matrix
    work_order: 'full', output: 'full', material: 'full', // matrix
    // Not in the matrix: the floor should see whether its own job passed.
    qc: 'view',
    dispatch: 'none',
    invoice: 'none', packing_list: 'none',
    customer: 'view', product: 'view', master: 'view', followup: 'none', payment: 'none',
    purchasing: 'none', approval: 'none', audit: 'none', team: 'none', settings: 'none', backup: 'none',
  },
  quality: {
    enquiry: 'none', quotation: 'none', proforma: 'none', order: 'none', dashboard: 'none',
    // Not in the matrix: a QC check hangs off a work order, so Quality has to
    // be able to reach one to record against it.
    work_order: 'view',
    output: 'none', qc: 'full', // matrix
    material: 'none', dispatch: 'none',
    invoice: 'none', packing_list: 'none',
    customer: 'view', product: 'view', master: 'view', followup: 'none', payment: 'none',
    purchasing: 'none', approval: 'none', audit: 'none', team: 'none', settings: 'none', backup: 'none',
  },
};

/** What this role may do with this function. An unknown role may do nothing. */
export function levelFor(role: unknown, fn: Fn): Level {
  return isTeamRole(role) ? ACCESS[role][fn] ?? 'none' : 'none';
}

/**
 * May this role do this, to at least this depth?
 *
 * An unknown, blank or missing role denies everything — which is the state of
 * a row the backfill has not reached and of a session whose `team_role` was
 * left out of a SELECT, and both should fail closed.
 */
export function can(role: unknown, fn: Fn, need: 'view' | 'full' = 'view'): boolean {
  return RANK[levelFor(role, fn)] >= RANK[need];
}

/**
 * Roles whose write access to a commercial invoice is limited to exports.
 *
 * The matrix reads "Yes - Only export" against Logistics, which is a rule
 * about *rows* rather than a level, so it cannot live in the table above. The
 * export paperwork travels with the goods, which is Logistics' job; a domestic
 * invoice stays with Sales and the Super Admin.
 */
export function exportOnlyInvoice(role: unknown): boolean {
  return role === 'logistics';
}

/**
 * The legacy `manager` / `employee` value for a team role.
 *
 * `users.role` is **not** written as a copy of `team_role` — it is derived
 * here, on every request, in `requireAuth`. Storing it would be a second
 * source for one fact, and the two would eventually disagree: a Team page
 * saying "Logistics" over a row still saying `manager` is an account that
 * keeps the database backup and every supplier rate. It is the same rule
 * `qc.ts` states about a pass — a verdict that is written down beside the
 * numbers can contradict them.
 *
 * Keeping it at all is what makes this migration reviewable in steps: every
 * `requireManager` not yet converted still compiles and still means *super
 * admin*, so anything missed fails closed rather than open.
 */
export function legacyRole(role: unknown): 'manager' | 'employee' {
  return role === 'super_admin' ? 'manager' : 'employee';
}

/** The whole table for one role, for the client to drive its screens from. */
export function capabilities(role: unknown): Record<Fn, Level> {
  const out = {} as Record<Fn, Level>;
  for (const fn of FUNCTIONS) out[fn] = levelFor(role, fn);
  return out;
}
