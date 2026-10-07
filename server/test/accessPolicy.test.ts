import './helpers/scratch.js';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import {
  can, capabilities, effectiveAccess, levelFor, overridesFor, reloadAccess, setRoleAccess,
  setUserAccess, userAccessList, userOverridesFor,
} from '../src/services/accessPolicy.js';
import { DEFAULT_ACCESS, FUNCTIONS, TEAM_ROLES } from '../src/services/permissions.js';

/**
 * What each team may actually do.
 *
 * `permissions.ts` holds the matrix from the client's ERP specification and is
 * where every team starts; this is that table with the client's own ticks over
 * it, stored by the User Permissions page (2026-09-24, the client: *"i do not
 * like the current user matrix, can you create a module - user permission with
 * checkboxes"*).
 *
 * Almost everything here is about the same two properties, because between
 * them they are the whole design. **Only the differences are stored** — so a
 * cell nobody touched still follows the recommended matrix, and a correction
 * shipped to it later still reaches a deployment that has customised something
 * else. And **a stored row is data, never vocabulary** — a role, function or
 * level the code does not know is ignored rather than trusted, which is what
 * keeps a hand-written super admin row inert.
 */

/**
 * A session on a team and nothing of its own.
 *
 * `can`, `levelFor` and `capabilities` take the **person** since 2026-10-07,
 * their own ticks over their team's — so every case below, which is about the
 * team layer, says so by passing a subject with no id. The per-person layer has
 * its own group at the foot of this file.
 */
const team = (role: unknown) => ({ team_role: role });

beforeEach(() => {
  db.prepare('DELETE FROM user_permissions').run();
  db.prepare('DELETE FROM role_permissions').run();
  reloadAccess();
});

describe('with nothing re-ticked', () => {
  test('every team is exactly where the recommended matrix puts it', () => {
    const live = effectiveAccess();
    for (const role of TEAM_ROLES) {
      for (const fn of FUNCTIONS) {
        assert.equal(live[role][fn], DEFAULT_ACCESS[role][fn], `${role}/${fn}`);
      }
    }
    for (const role of TEAM_ROLES) assert.deepEqual(overridesFor(role), {}, `${role} reads as customised`);
  });

  /** Moved here from `permissions.test.ts` when the map stopped being the default's. */
  test('the map handed to the client covers every function, so no screen has to guess', () => {
    const caps = capabilities(team('production'));
    assert.deepEqual(Object.keys(caps).sort(), [...FUNCTIONS].sort());
    assert.equal(caps.work_order, 'full');
    assert.equal(caps.quotation, 'none');
  });

  test('and an unknown role gets a map of nothing rather than an empty object', () => {
    const caps = capabilities(team('nobody'));
    assert.equal(Object.keys(caps).length, FUNCTIONS.length);
    assert.ok(Object.values(caps).every((l) => l === 'none'));
  });
});

describe('re-ticking a team', () => {
  test('changes what the guard answers, at once', () => {
    assert.equal(can(team('production'), 'quotation'), false);
    setRoleAccess('production', { quotation: 'view' });
    assert.equal(can(team('production'), 'quotation'), true);
    assert.equal(can(team('production'), 'quotation', 'full'), false, 'view is not edit');
    setRoleAccess('production', { quotation: 'full' });
    assert.equal(can(team('production'), 'quotation', 'full'), true);
    // And the map the client draws its screens from is the same answer.
    assert.equal(capabilities(team('production')).quotation, 'full');
  });

  test('moves nobody else', () => {
    setRoleAccess('production', { quotation: 'full' });
    for (const role of TEAM_ROLES) {
      if (role === 'production') continue;
      assert.equal(levelFor(team(role), 'quotation'), DEFAULT_ACCESS[role].quotation, `${role} moved too`);
    }
  });

  /**
   * The `batch_ids` contract: a field the body does not mention is left alone,
   * so a screen that draws part of the matrix cannot silently clear the rest.
   */
  test('leaves every function the save did not mention exactly as it was', () => {
    setRoleAccess('quality', { quotation: 'view' });
    setRoleAccess('quality', { invoice: 'view' });
    assert.equal(levelFor(team('quality'), 'quotation'), 'view', 'the first save was undone');
    assert.equal(levelFor(team('quality'), 'invoice'), 'view');
    assert.equal(levelFor(team('quality'), 'qc'), 'full', 'an untouched cell moved');
  });

  test('reports the cells that moved, and a save that changes nothing writes nothing', () => {
    // `dispatch: full` is what the matrix already says for Logistics, so only
    // one of the two is a change.
    const first = setRoleAccess('logistics', { quotation: 'view', dispatch: 'full' });
    assert.deepEqual(first, [{ fn: 'quotation', from: 'none', to: 'view' }]);
    assert.deepEqual(setRoleAccess('logistics', { quotation: 'view' }), []);
  });

  /**
   * Only the differences are stored, which is what lets a team be put back by
   * deleting rows and what keeps the "customised" count on the page meaning
   * something.
   */
  test('a cell set back to the recommended value stops being stored at all', () => {
    setRoleAccess('sales', { audit: 'view' });
    assert.deepEqual(overridesFor('sales'), { audit: 'view' });
    assert.equal(rows(), 1);

    setRoleAccess('sales', { audit: DEFAULT_ACCESS.sales.audit });
    assert.deepEqual(overridesFor('sales'), {});
    assert.equal(rows(), 0, 'the row was left behind');
  });

  /**
   * *Reset to recommended* on the page is this save and nothing else — it
   * sends the whole recommended row, every cell of which then matches the
   * default and is deleted. One write path rather than two ways to do one
   * thing, which is also why there is no reset endpoint.
   */
  test('sending the recommended row back is what resets a team', () => {
    setRoleAccess('quality', { quotation: 'view', order: 'view', qc: 'none' });
    assert.equal(rows(), 3);

    const moved = setRoleAccess('quality', DEFAULT_ACCESS.quality);
    assert.deepEqual(moved.map((c) => c.fn).sort(), ['order', 'qc', 'quotation']);
    assert.equal(rows(), 0, 'the override rows were left behind');
    for (const fn of FUNCTIONS) assert.equal(levelFor(team('quality'), fn), DEFAULT_ACCESS.quality[fn], fn);
    assert.deepEqual(setRoleAccess('quality', DEFAULT_ACCESS.quality), [], 'resetting a team already on the matrix moves nothing');
  });

  /**
   * The point of storing differences rather than whole rows: a team customised
   * today still receives a cell corrected in a later release, and a function
   * added later arrives at its recommended level rather than silently `none`.
   */
  test('a customised team still follows the matrix everywhere it was not re-ticked', () => {
    setRoleAccess('sales', { purchasing: 'full' });
    assert.equal(levelFor(team('sales'), 'purchasing'), 'full');
    assert.equal(levelFor(team('sales'), 'quotation'), DEFAULT_ACCESS.sales.quotation);
    assert.equal(levelFor(team('sales'), 'backup'), 'none');
  });
});

describe('what a stored row may not do', () => {
  /**
   * The rail the page rests on: untick `team` on the super admin and nobody
   * could ever open it again, including whoever just did it. The route refuses
   * the role, and this asserts the loader refuses the row as well — so one
   * written by hand, by an older client or by a restored backup is inert.
   */
  test('a super admin row is ignored, however it got there', () => {
    db.prepare("INSERT INTO role_permissions (team_role, fn, level) VALUES ('super_admin', 'team', 'none')").run();
    db.prepare("INSERT INTO role_permissions (team_role, fn, level) VALUES ('super_admin', 'backup', 'none')").run();
    reloadAccess();
    assert.equal(can(team('super_admin'), 'team', 'full'), true);
    assert.equal(can(team('super_admin'), 'backup', 'full'), true);
    for (const fn of FUNCTIONS) assert.equal(levelFor(team('super_admin'), fn), 'full', fn);
    assert.deepEqual(overridesFor('super_admin'), {});
  });

  test('a row naming something the code does not know is ignored, never trusted', () => {
    const bad = [
      ['sales', 'time_travel', 'full'],   // a function that does not exist
      ['sales', 'quotation', 'admin'],    // a level that does not exist
      ['accounts', 'quotation', 'full'],  // a role that does not exist
      ['', 'quotation', 'full'],
    ];
    for (const [role, fn, level] of bad) {
      db.prepare('INSERT INTO role_permissions (team_role, fn, level) VALUES (?, ?, ?)').run(role, fn, level);
    }
    reloadAccess();
    const live = effectiveAccess();
    for (const role of TEAM_ROLES) {
      for (const fn of FUNCTIONS) assert.equal(live[role][fn], DEFAULT_ACCESS[role][fn], `${role}/${fn}`);
    }
  });

  test('and an unknown role still may do nothing at all', () => {
    setRoleAccess('sales', { quotation: 'full' });
    for (const bad of ['', 'manager', 'employee', undefined, null]) {
      for (const fn of FUNCTIONS) assert.equal(can(team(bad), fn), false, `${String(bad)} reached ${fn}`);
    }
  });
});

function rows(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM role_permissions').get() as { c: number }).c;
}

/**
 * One person's own ticks, over their team's (2026-10-07, the client: *"USER
 * wise access rather than department wise access"*).
 *
 * The third layer, and it follows the same two properties as the second: only
 * the differences are stored, and a stored row is data rather than vocabulary.
 * Most of these are about what must **not** move — a person who has never been
 * re-ticked has to go on following their team exactly, or this would have
 * changed what every account on file may do on the day it shipped.
 */
describe('re-ticking one person', () => {
  let seq = 0;
  const makeAccount = (role: string, name: string) => {
    seq += 1;
    const info = db.prepare(
      "INSERT INTO users (name, email, password_hash, role, team_role) VALUES (?, ?, 'x', 'employee', ?)"
    ).run(name, `u${seq}@test.local`, role);
    return Number(info.lastInsertRowid);
  };

  test('a person with no ticks of their own is exactly their team', () => {
    const id = makeAccount('production', 'Follows the floor');
    for (const fn of FUNCTIONS) {
      assert.equal(levelFor({ id, team_role: 'production' }, fn), DEFAULT_ACCESS.production[fn], fn);
    }
    assert.deepEqual(userOverridesFor(id), {});
  });

  test('a tick of their own wins over the team', () => {
    const id = makeAccount('production', 'Reads quotes');
    assert.equal(can({ id, team_role: 'production' }, 'quotation'), false);
    setUserAccess(id, 'production', { quotation: 'view' });
    assert.equal(can({ id, team_role: 'production' }, 'quotation'), true);
    assert.equal(can({ id, team_role: 'production' }, 'quotation', 'full'), false, 'view is not edit');
    // And nobody else on that team moved with them, which is the whole point.
    assert.equal(can(team('production'), 'quotation'), false);
    const other = makeAccount('production', 'Another floor hand');
    assert.equal(levelFor({ id: other, team_role: 'production' }, 'quotation'), 'none');
  });

  test('a level equal to the team is not an override and is not stored', () => {
    const id = makeAccount('sales', 'Plain sales');
    setUserAccess(id, 'sales', { quotation: DEFAULT_ACCESS.sales.quotation, backup: 'full' });
    assert.deepEqual(userOverridesFor(id), { backup: 'full' }, 'only the one that differs');
  });

  test('so correcting the team still reaches everybody who was never moved off it', () => {
    const id = makeAccount('quality', 'Follows quality');
    setUserAccess(id, 'quality', { backup: 'full' });   // their own
    setRoleAccess('quality', { quotation: 'view' });    // the team's
    assert.equal(levelFor({ id, team_role: 'quality' }, 'quotation'), 'view', 'the team change reached them');
    assert.equal(levelFor({ id, team_role: 'quality' }, 'backup'), 'full', 'and their own stands');
  });

  test('setting a cell back to what the team says deletes it, which is Reset', () => {
    const id = makeAccount('logistics', 'Reset me');
    setUserAccess(id, 'logistics', { quotation: 'full' });
    assert.deepEqual(userOverridesFor(id), { quotation: 'full' });
    setUserAccess(id, 'logistics', { quotation: DEFAULT_ACCESS.logistics.quotation });
    assert.deepEqual(userOverridesFor(id), {}, 'no row at all, not a copy of the team');
    const left = db.prepare('SELECT COUNT(*) AS c FROM user_permissions WHERE user_id = ?').get(id) as { c: number };
    assert.equal(left.c, 0);
  });

  test('a function the body does not mention is left alone', () => {
    const id = makeAccount('sales', 'Partial save');
    setUserAccess(id, 'sales', { backup: 'full', purchasing: 'full' });
    setUserAccess(id, 'sales', { backup: 'none' });
    assert.equal(levelFor({ id, team_role: 'sales' }, 'purchasing'), 'full', 'untouched');
    assert.equal(levelFor({ id, team_role: 'sales' }, 'backup'), 'none');
  });

  test('it reports the cells that moved, and a save that changes nothing writes nothing', () => {
    const id = makeAccount('quality', 'Change report');
    const first = setUserAccess(id, 'quality', { quotation: 'view' });
    assert.deepEqual(first, [{ fn: 'quotation', from: 'none', to: 'view' }]);
    assert.deepEqual(setUserAccess(id, 'quality', { quotation: 'view' }), []);
  });

  test('a super admin row is inert however it got written', () => {
    const id = makeAccount('super_admin', 'Cannot be clipped');
    // Straight into the table, the way a hand-edit or a restored backup would.
    db.prepare("INSERT INTO user_permissions (user_id, fn, level) VALUES (?, 'team', 'none')").run(id);
    reloadAccess();
    assert.equal(can({ id, team_role: 'super_admin' }, 'team', 'full'), true, 'the rail held');
    for (const fn of FUNCTIONS) assert.equal(levelFor({ id, team_role: 'super_admin' }, fn), 'full', fn);
  });

  test('an unknown function or level in the table is ignored rather than trusted', () => {
    const id = makeAccount('sales', 'Junk rows');
    db.prepare("INSERT INTO user_permissions (user_id, fn, level) VALUES (?, 'teleportation', 'full')").run(id);
    db.prepare("INSERT INTO user_permissions (user_id, fn, level) VALUES (?, 'quotation', 'everything')").run(id);
    reloadAccess();
    assert.equal(levelFor({ id, team_role: 'sales' }, 'quotation'), DEFAULT_ACCESS.sales.quotation);
    assert.deepEqual(userOverridesFor(id), {});
  });

  test('somebody on no team at all can still be ticked, one function at a time', () => {
    // A row the backfill never reached reads as no access to anything — and
    // that is exactly the person a per-user grant is for.
    const id = makeAccount('', 'No team');
    assert.equal(can({ id, team_role: '' }, 'quotation'), false);
    setUserAccess(id, '', { quotation: 'view' });
    assert.equal(can({ id, team_role: '' }, 'quotation'), true);
    assert.equal(can({ id, team_role: '' }, 'invoice'), false, 'and nothing else came with it');
  });

  test('the list says who follows their team and who does not', () => {
    const id = makeAccount('logistics', 'Listed');
    setUserAccess(id, 'logistics', { quotation: 'full' });
    const row = userAccessList().find((u) => u.id === id)!;
    assert.equal(row.customised, 1);
    assert.equal(row.access.quotation, 'full', 'what they may actually do');
    assert.equal(row.team_access.quotation, DEFAULT_ACCESS.logistics.quotation, 'and what they departed from');
    assert.equal(row.editable, true);
    const admin = makeAccount('super_admin', 'The admin');
    assert.equal(userAccessList().find((u) => u.id === admin)?.editable, false);
  });
});
