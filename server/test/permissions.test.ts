import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEAM_ROLES, FUNCTIONS, ACCESS, can, levelFor, legacyRole, isTeamRole, capabilities,
  exportOnlyInvoice, type Fn, type TeamRole,
} from '../src/services/permissions.js';

/**
 * No `helpers/scratch.js` import, and — as in `companyPatterns.test.ts` — the
 * absence is the point rather than an oversight: `permissions.ts` imports
 * nothing at all, which is what lets it be sent to the client as a computed
 * map and read in one screen. If it ever grows a `db` import, the scratch
 * import goes back on line 1 or these run against the live database.
 */

describe('the access table', () => {
  /**
   * A missing cell reads as `none`, so a role would silently lose a screen and
   * the only symptom would be somebody saying "I can't see X any more".
   */
  test('is total — every role, every function', () => {
    for (const role of TEAM_ROLES) {
      for (const fn of FUNCTIONS) {
        assert.ok(ACCESS[role][fn] !== undefined, `${role} has no cell for ${fn}`);
        assert.ok(['none', 'view', 'full'].includes(ACCESS[role][fn]), `${role}/${fn} is not a level`);
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
   * trips a test and somebody has to decide it on purpose. Each one hands over
   * something that is not a job function: the whole database file, every
   * account, every supplier rate, the numbering, the whole activity log.
   */
  test('the administrative functions belong to the super admin alone', () => {
    const adminOnly: Fn[] = ['backup', 'team', 'settings', 'purchasing', 'audit', 'approval'];
    for (const fn of adminOnly) {
      for (const role of TEAM_ROLES) {
        if (role === 'super_admin') continue;
        assert.equal(levelFor(role, fn), 'none', `${role} should not reach ${fn}`);
      }
    }
  });

  /** The matrix, cell for cell, on the rows the client wrote out. */
  test('says what the client’s matrix says', () => {
    const expected: [TeamRole, Fn, 'none' | 'view' | 'full'][] = [
      ['sales', 'enquiry', 'full'], ['sales', 'quotation', 'full'], ['sales', 'proforma', 'full'],
      ['sales', 'order', 'full'], ['sales', 'dashboard', 'view'], ['sales', 'invoice', 'view'],
      ['logistics', 'order', 'view'], ['logistics', 'dashboard', 'view'], ['logistics', 'dispatch', 'full'],
      ['logistics', 'invoice', 'full'], ['logistics', 'quotation', 'none'],
      ['production', 'work_order', 'full'], ['production', 'output', 'full'],
      ['production', 'material', 'full'], ['production', 'dashboard', 'view'],
      ['production', 'dispatch', 'none'], ['production', 'quotation', 'none'],
      ['quality', 'qc', 'full'], ['quality', 'dispatch', 'none'], ['quality', 'quotation', 'none'],
    ];
    for (const [role, fn, level] of expected) {
      assert.equal(levelFor(role, fn), level, `${role}/${fn}`);
    }
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

describe('the map handed to the client', () => {
  test('covers every function, so no screen has to guess', () => {
    const caps = capabilities('production');
    assert.deepEqual(Object.keys(caps).sort(), [...FUNCTIONS].sort());
    assert.equal(caps.work_order, 'full');
    assert.equal(caps.quotation, 'none');
  });

  test('and an unknown role gets a map of nothing rather than an empty object', () => {
    const caps = capabilities('nobody');
    assert.equal(Object.keys(caps).length, FUNCTIONS.length);
    assert.ok(Object.values(caps).every((l) => l === 'none'));
  });
});
