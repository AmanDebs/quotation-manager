/**
 * Who may do what — **the recommended matrix, and the vocabulary**.
 *
 * Six roles, from the RBAC matrix in the client's ERP specification of
 * 2026-09-10, each with full / view / no access per function. That document
 * supersedes the access matrix of 2026-09-05 — the two disagree, and the
 * client chose this one.
 *
 * Since 2026-09-24 this table is a **default rather than the policy**: the
 * client did not like being held to a matrix somebody else wrote, so the User
 * Permissions page lets each team be re-ticked and the differences are stored
 * in `role_permissions`. `services/accessPolicy.ts` lays those over this and
 * owns the effective answer — which is why `can`, `levelFor` and
 * `capabilities` are **not** in this file any more. Two functions called `can`,
 * one reading the default and one reading what the client actually set, is
 * exactly how a screen comes to disagree with the guard behind it; the
 * compiler refuses the mistake instead.
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
  // The floor. `fg` is finished goods on hand — the spec's *View FG
  // Inventory* cell, which had nothing to grant until the ledger existed.
  'work_order', 'output', 'qc', 'material', 'dispatch', 'fg',
  // Going out.
  'invoice', 'packing_list',
  // Reference data.
  'customer', 'product', 'master', 'followup', 'payment',
  // Administration.
  'purchasing', 'approval', 'audit', 'team', 'settings', 'backup',
] as const;

export type Fn = (typeof FUNCTIONS)[number];

export const LEVELS = ['none', 'view', 'full'] as const;

export type Level = (typeof LEVELS)[number];

export type AccessTable = Record<TeamRole, Record<Fn, Level>>;

export function isFn(v: unknown): v is Fn {
  return typeof v === 'string' && (FUNCTIONS as readonly string[]).includes(v);
}

export function isLevel(v: unknown): v is Level {
  return typeof v === 'string' && (LEVELS as readonly string[]).includes(v);
}

/** none < view < full, so a `full` grant satisfies a `view` requirement. */
const RANK: Record<Level, number> = { none: 0, view: 1, full: 2 };

/** Does this level reach that one? The whole of the rank rule, in one place. */
export function atLeast(have: Level, need: Level): boolean {
  return RANK[have] >= RANK[need];
}

/**
 * What each function is called, what it covers, and **which levels mean
 * anything for it**.
 *
 * The last is the part worth having. `team` is mounted at `full` and nothing
 * anywhere asks for `view` of it, so a *View* tick beside it would be a
 * control that does nothing — worse than no control, since somebody would tick
 * it and conclude the page is broken. So a function declares `levels`, and the
 * screen draws one box or two accordingly:
 *
 * - `both`   — read it with View, change it with Edit (most of them).
 * - `view`   — there is nothing to change: the dashboard and the audit trail
 *              are read-only by nature.
 * - `full`   — an all-or-nothing act: the team page, the backup, the
 *              numbering counters, raising a purchase order.
 *
 * Sent to the client with the matrix rather than copied there, the rule
 * `capabilities` already follows: a second list is a second policy.
 */
export interface FunctionMeta {
  label: string;
  group: string;
  levels: 'both' | 'view' | 'full';
  /** What this actually opens, in the words the screens use. */
  hint: string;
}

export const FUNCTION_META: Record<Fn, FunctionMeta> = {
  enquiry: { label: 'Enquiries', group: 'Selling', levels: 'both', hint: 'The front of the funnel' },
  quotation: { label: 'Quotations', group: 'Selling', levels: 'both', hint: 'Offers and their prices, including revisions' },
  proforma: { label: 'Proforma Invoices', group: 'Selling', levels: 'both', hint: 'The document the advance is paid against' },
  order: { label: 'Sales Orders', group: 'Selling', levels: 'both', hint: 'The order book and its lines' },
  invoice: { label: 'Commercial Invoices', group: 'Selling', levels: 'both', hint: 'Export invoices and credit notes' },
  packing_list: { label: 'Packing Lists', group: 'Selling', levels: 'both', hint: 'Raised from the invoice it belongs to' },
  approval: { label: 'Approvals', group: 'Selling', levels: 'both', hint: 'View the queue; Edit approves and rejects' },

  work_order: { label: 'Work Orders', group: 'Factory', levels: 'both', hint: 'The jobs the floor works to' },
  output: { label: 'Production Output', group: 'Factory', levels: 'both', hint: 'Shift entries, batches and what was made' },
  qc: { label: 'Quality', group: 'Factory', levels: 'both', hint: 'Checks, specifications and the COA' },
  material: { label: 'Raw Material', group: 'Factory', levels: 'both', hint: 'Stock, issues and the shortfall' },
  fg: { label: 'Finished Goods', group: 'Factory', levels: 'both', hint: 'What is on the shelf; Edit records a stock count' },
  dispatch: { label: 'Dispatches', group: 'Factory', levels: 'both', hint: 'Trips, the sea leg and the delivery challan' },
  purchasing: { label: 'Purchase Orders', group: 'Factory', levels: 'full', hint: 'Buying, and every supplier rate with it' },

  customer: { label: 'Customers', group: 'Reference', levels: 'both', hint: 'The customer book' },
  product: { label: 'Products', group: 'Reference', levels: 'both', hint: 'The catalogue, which carries the price list' },
  master: { label: 'Production Masters', group: 'Reference', levels: 'both', hint: 'Plants, machines, moulds, processes, suppliers' },
  followup: { label: 'Follow-ups', group: 'Reference', levels: 'both', hint: 'Reminders and who chased what' },
  payment: { label: 'Payments', group: 'Reference', levels: 'both', hint: 'The money register and the receivables tracker' },

  dashboard: { label: 'Dashboard', group: 'Administration', levels: 'view', hint: 'The front page. A team without it lands elsewhere' },
  audit: { label: 'Activity Log', group: 'Administration', levels: 'view', hint: 'The whole trail. A record’s own history follows the record' },
  team: { label: 'Team & Permissions', group: 'Administration', levels: 'full', hint: 'Accounts, and this page' },
  settings: { label: 'Settings', group: 'Administration', levels: 'full', hint: 'Company profile, numbering, note presets' },
  backup: { label: 'Backup & Reset', group: 'Administration', levels: 'full', hint: 'Downloads the whole database' },
};

/**
 * The groups, in the order the page draws them.
 *
 * Written out rather than derived from `FUNCTION_META`, and the first attempt
 * is why: taking the groups in the order the functions happen to be declared
 * put *Administration* second, because `dashboard` sits in the sales block of
 * `FUNCTIONS` and is grouped with the app's own screens here. Order is a
 * different fact from membership, so it is stated.
 *
 * The page renders group by group, so a function whose group is missing from
 * this list would be **drawn nowhere** — a permission nobody could grant, with
 * nothing on screen to say so. A test asserts the list covers every group
 * `FUNCTION_META` names.
 */
export const FUNCTION_GROUPS = ['Selling', 'Factory', 'Reference', 'Administration'] as const;

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
 *
 * **It is where every team starts, not where it stays.** A cell the client
 * re-ticks is stored against the role and read over the top of this; a cell
 * nobody has touched follows this table, so a correction made here still
 * reaches a deployment that has customised something else — the rule
 * `DEFAULT_HIDDEN_COLUMNS` and the note presets already follow. A function
 * added in a later release therefore arrives with a sensible level rather than
 * silently `none` for a team whose row was frozen the day they first saved it.
 */
export const DEFAULT_ACCESS: AccessTable = {
  /**
   * The owner's account. Deliberately **not** the spec's administrator row:
   * that row is written for somebody whose job is the system rather than the
   * business, and this app is run by the people whose orders it holds.
   * `sys_admin` below is the spec's row, for whoever should be held to it.
   */
  super_admin: {
    enquiry: 'full', quotation: 'full', proforma: 'full', order: 'full', dashboard: 'full',
    work_order: 'full', output: 'full', qc: 'full', material: 'full', dispatch: 'full', fg: 'full',
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
    work_order: 'none', output: 'none', qc: 'none', material: 'none', dispatch: 'none', fg: 'none',
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
    fg: 'view',        // What can be promised from stock
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
   * *View FG Inventory* had **nothing to grant** until 2026-09-11 — there was
   * no finished-goods ledger, and granting `material` (raw material) would
   * have been granting a different thing from the one asked for. It is `fg`
   * now, held `full` here rather than `view` because a stock count is a
   * stores act and the Dispatch Lead is the stores.
   */
  logistics: {
    enquiry: 'none', quotation: 'none', proforma: 'none', order: 'view', dashboard: 'view',
    work_order: 'none', output: 'none', material: 'none',
    qc: 'view',        // Read Only (Verify COA Clearance) — the spec's pre-dispatch step
    dispatch: 'full',  // Full (Pick, Pack, Gate Pass, Logistics)
    fg: 'full',        // View FG Inventory — and the stock count, which is a stores act
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
    fg: 'view',        // What the floor has made and not yet shipped
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
    fg: 'view',
    invoice: 'none', packing_list: 'none',
    customer: 'view', product: 'view', master: 'view', followup: 'none', payment: 'none',
    purchasing: 'none', approval: 'none', audit: 'none', team: 'none', settings: 'none', backup: 'none',
  },
};

/**
 * The roles the User Permissions page may re-tick.
 *
 * **The super admin is not one of them, and that is the rail that makes the
 * whole page safe to ship.** Its row is the only guaranteed way back in: untick
 * `team` on it and nobody can ever open the permissions page again — including
 * the person who just did it — and there is no screen left to undo it from.
 * This codebase has built exactly one trap with no way out (`work_orders.
 * product_id`, found when the invoice gate made it reachable) and does not
 * intend to build a second, least of all one that locks the owner out of their
 * own book. So that row is drawn ticked and disabled, the route refuses to
 * store a cell against it, and the loader ignores one that somehow got in.
 *
 * It costs nothing real: a super admin is by definition the account that may
 * do everything, and holding somebody to less is what the System Administrator
 * row and the other four are for.
 */
export const EDITABLE_ROLES = TEAM_ROLES.filter((r) => r !== 'super_admin');

export type EditableRole = Exclude<TeamRole, 'super_admin'>;

export function isEditableRole(v: unknown): v is EditableRole {
  return isTeamRole(v) && v !== 'super_admin';
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
