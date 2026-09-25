import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { generatePassword, resetUserPassword } from '../src/services/passwordReset.js';
import { db } from '../src/db/connection.js';
import { makeUser } from './helpers/factory.js';

/**
 * Resetting somebody else's password — the Team page's button and the
 * command-line script, which are one function precisely so that only one of
 * them can be wrong.
 *
 * The thing worth testing is not the hash, it is the **session bump beside it**:
 * a hash written without one leaves every session signed under the old password
 * alive, which is not a recovery but a second key cut for the same lock. That
 * failure is invisible from the outside — the new password works, so it looks
 * like success.
 */

const row = (id: number) =>
  db.prepare('SELECT password_hash, token_version, active FROM users WHERE id = ?').get(id) as
    { password_hash: string; token_version: number; active: number };

/** Somebody with a password we know, so "the old one stops working" is checkable. */
function userWith(password: string, active = 1): number {
  const id = makeUser('sales');
  db.prepare('UPDATE users SET password_hash = ?, active = ? WHERE id = ?')
    .run(bcrypt.hashSync(password, 10), active, id);
  return id;
}

describe('the generated password', () => {
  test('is five groups of four from the unambiguous alphabet', () => {
    for (let i = 0; i < 20; i++) {
      assert.match(generatePassword(), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}(-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}){4}$/);
    }
  });

  /*
   * Read off a screen and typed into a browser, sometimes over the phone — so
   * the pairs a person cannot tell apart are left out on purpose, and a change
   * that put them back would be a change somebody noticed only as a support
   * call about a password that "does not work".
   */
  test('and carries none of the characters a person would mistype', () => {
    const joined = Array.from({ length: 50 }, generatePassword).join('');
    for (const c of ['0', 'O', '1', 'l', 'I']) {
      assert.ok(!joined.includes(c), `${c} should not appear`);
    }
  });

  test('and is not the same twice', () => {
    const seen = new Set(Array.from({ length: 200 }, generatePassword));
    assert.equal(seen.size, 200);
  });
});

describe('what a reset does to the account', () => {
  test('the password it returns is the password on the row', () => {
    const id = userWith('oldpassword');
    const fresh = resetUserPassword(id);
    assert.ok(bcrypt.compareSync(fresh, row(id).password_hash));
  });

  test('and the old one stops working', () => {
    const id = userWith('oldpassword');
    resetUserPassword(id);
    assert.ok(!bcrypt.compareSync('oldpassword', row(id).password_hash));
  });

  /** The half that is invisible when it is missing. */
  test('every session on it is ended, exactly once', () => {
    const id = userWith('oldpassword');
    const before = row(id).token_version;
    resetUserPassword(id);
    assert.equal(row(id).token_version, before + 1);
    resetUserPassword(id);
    assert.equal(row(id).token_version, before + 2);
  });
});

describe('what a reset deliberately leaves alone', () => {
  /*
   * Switching a deactivated account back on is a decision somebody makes, not
   * part of a password reset — the script says so and offers `--activate` for
   * saying it out loud. The Team page's button never passes it, so a
   * deactivated account stays refused at sign-in whatever password it now has,
   * which is what its dialog warns about.
   */
  test('a deactivated account stays deactivated', () => {
    const id = userWith('oldpassword', 0);
    resetUserPassword(id);
    assert.equal(row(id).active, 0);
  });

  test('unless the caller says otherwise', () => {
    const id = userWith('oldpassword', 0);
    resetUserPassword(id, { activate: true });
    assert.equal(row(id).active, 1);
  });

  test('and an active account is not touched by that flag either way', () => {
    const id = userWith('oldpassword');
    resetUserPassword(id);
    assert.equal(row(id).active, 1);
    resetUserPassword(id, { activate: true });
    assert.equal(row(id).active, 1);
  });

  test('nobody else is reset by it', () => {
    const a = userWith('passworda');
    const b = userWith('passwordb');
    const bBefore = row(b);
    resetUserPassword(a);
    assert.equal(row(b).password_hash, bBefore.password_hash);
    assert.equal(row(b).token_version, bBefore.token_version);
  });
});
