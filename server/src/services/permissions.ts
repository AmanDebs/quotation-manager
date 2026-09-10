/**
 * Who may do what.
 *
 * Six roles, from the RBAC matrix in the client's ERP specification of
 * 2026-09-10, each with full / view / no access per function. That document
 * supersedes the access matrix of 2026-09-05 — the two disagree, and the
 * client chose this one.
 *
 * Its four columns are *modules*, and each cell carries a parenthetical
 * naming what to read: *Read Only (View SO Demand)*, *(Verify COA
 * Clearance)*, *(View WO Status)*. **The parenthetical is the
 * specification, not the module header** — so Production reading the Sales
 * module means the order, not the price that was quoted for it. The
 * conservative reading, and the one that keeps a quotation off the floor.
 *
 * Functions the spec's four columns do not cover — `customer`, `product`,
 * `master`, `dashboard`, `followup`, `payment`, `purchasing` — are
 * **reachability**, kept at whatever lets each role work its own module.
 * Silence about a function is not an instruction to refuse it. Before this the whole of
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

export const TEAM_ROLES = ['super_admin', 'sys_admin', 'sales', 'logistics', 'production', 'quality'] as const;

export type TeamRole = (typeof TEAM_ROLES)[number];

export const TEAM_ROLE_LABEL: Record<TeamRole, string> = {
  super_admin: 'Super Admin',
  sys_admin: 'System Administrator',
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
  /**
   * The owner's account. Deliberately **not** the spec's administrator row:
   * that row is written for somebody whose job is the system rather than the
   * business, and this app is run by the people whose orders it holds.
   * `sys_admin` below is the spec's row, for whoever should be held to it.
   */
  super_admin: {
    enquiry: 'full', quotation: 'full', proforma: 'full', order: 'full', dashboard: 'full',
    work_order: 'full', output: 'full', qc: 'full', material: 'full', dispatch: 'full',
    invoice: 'full', packing_list: 'full',
    customer: 'full', product: 'full', master: 'full', followup: 'full', payment: 'full',
    purchasing: 'full', approval: 'full', audit: 'full', team: 'full', settings: 'full', backup: 'full',
  },
  /**
   * **ERP System Administrator** — "User Management Only" on all four business
   * modules, "Full Access (System Config)" on its own.
   *
   * The whole point of the row is what it cannot read, so every business
   * function is `none` and stays that way. Two judgements the spec does not
   * make for us. `master` is granted because locations, machines, moulds and
   * processes are plant *configuration*, which is what System Config names,
   * and nothing priced is reachable through it. `product` is **refused**,
   * because the catalogue carries `unit_price` — it looks like reference data
   * and is business data.
   *
   * `legacyRole` maps this to `employee`, so any guard still written as
   * `requireManager` fails closed for it rather than open.
   */
  sys_admin: {
    enquiry: 'none', quotation: 'none', proforma: 'none', order: 'none', dashboard: 'none',
    work_order: 'none', output: 'none', qc: 'none', material: 'none', dispatch: 'none',
    invoice: 'none', packing_list: 'none',
    customer: 'none', product: 'none', master: 'full', followup: 'none', payment: 'none',
    purchasing: 'none', approval: 'none', audit: 'full', team: 'full', settings: 'full', backup: 'full',
  },
  /**
   * **Sales Manager** — Full on Sales (Create/Approve Quotes, SO, Invoice),
   * Read Only on Production (View WO Status), QC (View COA Status) and
   * Logistics (Tracking Status).
   *
   * `approval: 'full'` is the spec's word *Approve*, and it is a real change:
   * this role could approve nothing before, so every document waited on the
   * owner. `mayApprove` reads exactly this cell.
   */
  sales: {
    enquiry: 'full', quotation: 'full', proforma: 'full', order: 'full', dashboard: 'view',
    // Read Only (View WO Status). Output and material are the shop log and the
    // store, neither of which that parenthetical names.
    work_order: 'view', output: 'none', material: 'none',
    qc: 'view',        // Read Only (View COA Status)
    dispatch: 'view',  // Read Only (Tracking Status)
    invoice: 'full', packing_list: 'full',
    customer: 'full', product: 'full', master: 'view', followup: 'full', payment: 'full',
    purchasing: 'none', approval: 'full', audit: 'none', team: 'none', settings: 'none', backup: 'none',
  },
  /**
   * **Dispatch Lead / Warehouse Manager** — Full on Logistics (Pick, Pack,
   * Gate Pass), Read Only on Sales (View Confirmed SOs), Production (View FG
   * Inventory) and QC (Verify COA Clearance).
   *
   * Two cells worth reading twice. `invoice` drops from `full` to `view`: the
   * 2026-09-05 matrix gave this role export invoicing, and the 2026-09-10 spec
   * makes the whole Sales module read-only for it. `exportOnlyInvoice` stays
   * in the code but can no longer fire, there being no write left to narrow.
   *
   * And *View FG Inventory* has **nothing to grant**: there is no
   * finished-goods ledger in this app — `material_moves` is raw material — so
   * the production functions stay `none` until one exists. Granting `material`
   * would be granting a different thing from the one that was asked for.
   */
  logistics: {
    enquiry: 'none', quotation: 'none', proforma: 'none', order: 'view', dashboard: 'view',
    work_order: 'none', output: 'none', material: 'none',
    qc: 'view',        // Read Only (Verify COA Clearance) — the spec's pre-dispatch step
    dispatch: 'full',  // Full (Pick, Pack, Gate Pass, Logistics)
    invoice: 'view', packing_list: 'full',
    customer: 'view', product: 'view', master: 'view', followup: 'none', payment: 'none',
    purchasing: 'none', approval: 'none', audit: 'none', team: 'none', settings: 'none', backup: 'none',
  },
  /**
   * **Production Supervisor** — Full on Production (Create WO, Material Issue,
   * Shop Log), Read Only on Sales (View SO Demand) and QC (View QC Logs), no
   * access to Logistics.
   *
   * *View SO Demand* is read as the parenthetical writes it: the **order**,
   * not the quotation or the proforma. A price is not demand, and a quotation
   * readable from the shop floor is the leak `routes/audit.ts` records closing.
   */
  production: {
    enquiry: 'none', quotation: 'none', proforma: 'none', order: 'view', dashboard: 'view',
    work_order: 'full', output: 'full', material: 'full',
    qc: 'view',        // Read Only (View QC Logs)
    dispatch: 'none',  // No Access
    invoice: 'none', packing_list: 'none',
    customer: 'view', product: 'view', master: 'view', followup: 'none', payment: 'none',
    purchasing: 'none', approval: 'none', audit: 'none', team: 'none', settings: 'none', backup: 'none',
  },
  /**
   * **QC Inspector / Auditor** — Full on QC (Shift QC, Final COA Approval),
   * Read Only on Production (View Batch Logs) and Logistics (Pre-Dispatch
   * Verification), **No Access** to Sales.
   *
   * `customer`, `product` and `master` are reference data the spec's four
   * modules do not cover, and they are what a check is recorded *against* — a
   * QC check hangs off a work order, which hangs off an order, which names a
   * customer, and a customer may hold tolerances of its own. Refusing them
   * would refuse the role its own module.
   */
  quality: {
    enquiry: 'none', quotation: 'none', proforma: 'none', order: 'none', dashboard: 'none',
    work_order: 'view', output: 'view',   // Read Only (View Batch Logs)
    qc: 'full',                           // Full (Shift QC, Final COA Approval)
    material: 'none',
    dispatch: 'view',                     // Read Only (Pre-Dispatch Verification)
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
