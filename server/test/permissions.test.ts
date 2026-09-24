import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEAM_ROLES, FUNCTIONS, DEFAULT_ACCESS, FUNCTION_META, FUNCTION_GROUPS, EDITABLE_ROLES, atLeast, legacyRole,
  isTeamRole, isEditableRole, exportOnlyInvoice, type Fn, type Level, type TeamRole,
} from '../src/services/permissions.js';

/**
 * No `helpers/scratch.js` import, and — as in `companyPatterns.test.ts` — the
 * absence is the point rather than an oversight: `permissions.ts` imports
 * nothing at all, which is what lets it be sent to the client as a computed
 * map and read in one screen. If it ever grows a `db` import, the scratch
 * import goes back on line 1 or these run against the live database.
 *
 * What this file asserts is the **recommended** matrix — where every team
 * starts. What a team may do *today* is that table with the client's own ticks
 * over it, which is `accessPolicy.ts` and is tested against a database in
 * `accessPolicy.test.ts`.
 */

/**
 * The default's own answer, spelled out here rather than imported, because
 * `can` and `levelFor` deliberately do not live in the pure module any more:
 * one function of each name, reading the table in force, is what stops a
 * screen disagreeing with the guard behind it.
 */
const levelFor = (role: unknown, fn: Fn): Level => (isTeamRole(role) ? DEFAULT_ACCESS[role][fn] ?? 'none' : 'none');
const can = (role: unknown, fn: Fn, need: Level = 'view') => atLeast(levelFor(role, fn), need);

describe('the access table', () => {
  /**
   * A missing cell reads as `none`, so a role would silently lose a screen and
   * the only symptom would be somebody saying "I can't see X any more".
   */
  test('is total — every role, every function', () => {
    for (const role of TEAM_ROLES) {
      for (const fn of FUNCTIONS) {
        assert.ok(DEFAULT_ACCESS[role][fn] !== undefined, `${role} has no cell for ${fn}`);
        assert.ok(['none', 'view', 'full'].includes(DEFAULT_ACCESS[role][fn]), `${role}/${fn} is not a level`);
      }
    }
  });

  test('full implies view, everywhere', () => {
    for (const role of TEAM_ROLES) {
      for (const fn of FUNCTIONS) {
        if (can(role, fn, 'full')) assert.ok(can(role, fn, 'view'), `${role} has full ${fn} but not view`);
      }
    }
  });

  test('exactly one role can do everything, and it is the super admin', () => {
    const total = TEAM_ROLES.filter((r) => FUNCTIONS.every((f) => can(r, f, 'full')));
    assert.deepEqual(total, ['super_admin']);
  });

  /**
   * Asserted by enumeration rather than by rule, so that widening any of these
   * trips a test and somebody has to decide it on purpose. Each hands over
   * something that is not a job function: the whole database file, every
   * account, every supplier rate, the numbering, the whole activity log.
   *
   * Two of these are no longer super-admin-only, and both are deliberate.
   * **`approval` is the Sales Manager's**, the ERP spec of 2026-09-10 reading
   * "Full Access (Create/Approve Quotes, SO, Invoice)". And the four system
   * functions are shared with **`sys_admin`**, which is that spec's own
   * administrator row and exists to hold exactly them.
   */
  test('the administrative functions stay with the two roles that own them', () => {
    const systemOnly: Fn[] = ['backup', 'team', 'settings', 'audit'];
    for (const fn of systemOnly) {
      for (const role of TEAM_ROLES) {
        if (role === 'super_admin' || role === 'sys_admin') continue;
        assert.equal(levelFor(role, fn), 'none', `${role} should not reach ${fn}`);
      }
    }
    // Procurement is named by no row of the spec, so it stays where it was.
    for (const role of TEAM_ROLES) {
      if (role === 'super_admin') continue;
      assert.equal(levelFor(role, 'purchasing'), 'none', `${role} reached purchasing`);
    }
    // Approving is a Sales act now, and nobody else's.
    for (const role of TEAM_ROLES) {
      const expected = role === 'super_admin' || role === 'sales' ? 'full' : 'none';
      assert.equal(levelFor(role, 'approval'), expected, `${role}/approval`);
    }
  });

  /**
   * The System Administrator is defined by what it cannot read: "User
   * Management Only" on all four business modules. This is the row where a
   * single wrong cell would undo the separation of duties it exists for.
   */
  test('the system administrator reaches no business data at all', () => {
    const business: Fn[] = [
      'enquiry', 'quotation', 'proforma', 'order', 'invoice', 'packing_list',
      'work_order', 'output', 'qc', 'material', 'dispatch', 'fg',
      'customer', 'product', 'followup', 'payment', 'purchasing', 'approval', 'dashboard',
    ];
    for (const fn of business) {
      assert.equal(levelFor('sys_admin', fn), 'none', `sys_admin reached ${fn}`);
    }
    // What it does hold: the system, and the plant configuration inside it.
    for (const fn of ['team', 'settings', 'backup', 'audit', 'master'] as Fn[]) {
      assert.equal(levelFor('sys_admin', fn), 'full', `sys_admin should hold ${fn}`);
    }
    // `product` looks like reference data and carries `unit_price`, so it is
    // refused where `master` is granted — the one cell that distinguishes the
    // two, and the reason they are asserted apart.
    assert.equal(levelFor('sys_admin', 'product'), 'none');
  });

  /** The matrix, cell for cell, on the rows the client wrote out. */
  test('says what the client’s matrix says', () => {
    const expected: [TeamRole, Fn, 'none' | 'view' | 'full'][] = [
      // Sales Manager — Full on Sales, Read Only on the other three modules.
      ['sales', 'enquiry', 'full'], ['sales', 'quotation', 'full'], ['sales', 'proforma', 'full'],
      ['sales', 'order', 'full'], ['sales', 'invoice', 'full'], ['sales', 'approval', 'full'],
      ['sales', 'work_order', 'view'], ['sales', 'qc', 'view'], ['sales', 'dispatch', 'view'],
      ['sales', 'output', 'none'], ['sales', 'material', 'none'], ['sales', 'dashboard', 'view'],
      // Dispatch Lead — Full on Logistics, Read Only on Sales and QC.
      ['logistics', 'dispatch', 'full'], ['logistics', 'packing_list', 'full'],
      ['logistics', 'order', 'view'], ['logistics', 'qc', 'view'],
      ['logistics', 'invoice', 'view'], ['logistics', 'quotation', 'none'],
      ['logistics', 'work_order', 'none'], ['logistics', 'dashboard', 'view'],
      // Production Supervisor — Full on Production, the order but not the price.
      ['production', 'work_order', 'full'], ['production', 'output', 'full'],
      ['production', 'material', 'full'], ['production', 'order', 'view'],
      ['production', 'qc', 'view'], ['production', 'dispatch', 'none'],
      ['production', 'quotation', 'none'], ['production', 'proforma', 'none'],
      ['production', 'dashboard', 'view'],
      // QC Inspector — Full on QC, no access to Sales at all.
      ['quality', 'qc', 'full'], ['quality', 'work_order', 'view'], ['quality', 'output', 'view'],
      ['quality', 'dispatch', 'view'], ['quality', 'order', 'none'],
      ['quality', 'quotation', 'none'], ['quality', 'invoice', 'none'],
    ];
    for (const [role, fn, level] of expected) {
      assert.equal(levelFor(role, fn), level, `${role}/${fn}`);
    }
  });

  /**
   * *View SO Demand* and *No Access* are the two cells that keep a price off
   * the shop floor, and they are what the 2026-09-05 matrix and the 2026-09-10
   * spec most nearly disagree about — the module header says Sales, the
   * parenthetical says the order. Asserted on its own so that reading the
   * header instead of the parenthetical trips a test with the reason on it.
   */
  test('the floor sees demand, never a price', () => {
    for (const role of ['production', 'quality'] as TeamRole[]) {
      for (const fn of ['quotation', 'proforma', 'invoice', 'payment'] as Fn[]) {
        assert.equal(levelFor(role, fn), 'none', `${role} can read ${fn}`);
      }
    }
    assert.equal(levelFor('production', 'order'), 'view', 'Production must see SO demand');
    assert.equal(levelFor('quality', 'order'), 'none', 'QC has No Access to the Sales module');
  });

  /**
   * The state of a row the backfill has not reached, and of a session whose
   * `team_role` was left out of a SELECT. Both must fail closed.
   */
  test('an unknown role may do nothing at all', () => {
    for (const bad of ['', 'manager', 'employee', 'admin', undefined, null, 0]) {
      assert.equal(isTeamRole(bad), false, String(bad));
      for (const fn of FUNCTIONS) {
        assert.equal(can(bad, fn, 'view'), false, `${String(bad)} reached ${fn}`);
      }
    }
  });
});

describe('the legacy mirror', () => {
  /**
   * `users.role` is derived from this and never stored as a copy. Every
   * `requireManager` not yet converted still means *super admin*, which is
   * what makes anything missed fail closed.
   */
  test('is manager for the super admin and for nobody else', () => {
    for (const role of TEAM_ROLES) {
      assert.equal(legacyRole(role) === 'manager', role === 'super_admin', role);
    }
  });

  test('and an unknown role is never a manager', () => {
    for (const bad of ['', 'manager', undefined, null]) assert.equal(legacyRole(bad), 'employee', String(bad));
  });
});

describe('the row rule the table cannot carry', () => {
  test('only logistics is limited to export invoices', () => {
    assert.equal(exportOnlyInvoice('logistics'), true);
    for (const role of TEAM_ROLES) {
      if (role !== 'logistics') assert.equal(exportOnlyInvoice(role), false, role);
    }
  });
});

describe('the vocabulary the permissions page draws', () => {
  /**
   * A function with no entry would be drawn with a blank label and no ticks —
   * a permission nobody can grant, and no error to say so.
   */
  test('every function is named, grouped, and says which levels mean anything', () => {
    for (const fn of FUNCTIONS) {
      const meta = FUNCTION_META[fn];
      assert.ok(meta, `${fn} has no label`);
      assert.ok(meta.label && meta.group && meta.hint, `${fn} is incompletely described`);
      assert.ok(['both', 'view', 'full'].includes(meta.levels), `${fn}/${meta.levels}`);
    }
  });

  /**
   * The page draws one group at a time, so a function in a group this list
   * does not name would be drawn nowhere at all — a permission nobody could
   * grant, and no error anywhere to say why.
   */
  test('every group a function claims is one the page draws', () => {
    for (const fn of FUNCTIONS) {
      assert.ok(
        (FUNCTION_GROUPS as readonly string[]).includes(FUNCTION_META[fn].group),
        `${fn} is in "${FUNCTION_META[fn].group}", which the page does not draw`,
      );
    }
    for (const group of FUNCTION_GROUPS) {
      assert.ok(FUNCTIONS.some((fn) => FUNCTION_META[fn].group === group), `nothing is in "${group}"`);
    }
  });

  /**
   * The rail the whole page rests on. Untick `team` on the super admin and
   * nobody can ever open the page again — including whoever just did it — so
   * that row is not offered.
   */
  test('the super admin is not editable, and everyone else is', () => {
    assert.equal(isEditableRole('super_admin'), false);
    assert.deepEqual([...EDITABLE_ROLES].sort(), TEAM_ROLES.filter((r) => r !== 'super_admin').sort());
    for (const role of EDITABLE_ROLES) assert.equal(isEditableRole(role), true, role);
  });
});
