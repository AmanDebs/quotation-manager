import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from '../db/connection.js';

/**
 * Setting somebody else's password, in one function with two doors.
 *
 * `db/resetPassword.ts` is the way back in when nobody can sign in at all —
 * run where the disk is, outside HTTP entirely. `POST /api/users/:id/
 * reset-password` is the ordinary case: an employee has forgotten theirs and
 * whoever holds the Team cell resets it from the Team page. Both end up here,
 * the call `services/resetBook.ts` records about its own script and button: two
 * implementations of *reset a password* is how one of them comes to forget the
 * session bump.
 */

/**
 * Readable, and no ambiguity a person can mistype.
 *
 * `0/O` and `1/l/I` are left out because this is read off a screen and typed
 * into a browser, sometimes over the phone. Five groups of four from a
 * 32-character alphabet is a shade under 100 bits — far past anything the login
 * rate limiter would let through, and short enough to read aloud.
 */
export function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(20);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12, 16].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

/**
 * Set a fresh generated password on an account and return it once.
 *
 * **It generates rather than taking one**, the rule the command-line script
 * states about itself: a password somebody invents on the spot for somebody
 * else is invariably weak, and the operator has to hand it over anyway, so
 * inventing it buys nothing. The Team page's Edit dialog still accepts a
 * specific password for whoever wants to set one, so nothing is taken away.
 *
 * **The hash and `token_version` move in one statement.** A hash written
 * without the bump would leave every session signed under the old password
 * alive, which is not a recovery — it is a second key cut for the same lock.
 *
 * Nothing is stored in clear and nothing is returned twice: the caller hands
 * the string over and it is gone. `activate` is for the command line's own
 * `--activate`; switching a deactivated account back on is a decision, not
 * part of a password reset.
 */
export function resetUserPassword(userId: number, opts: { activate?: boolean } = {}): string {
  const password = generatePassword();
  db.prepare(
    `UPDATE users SET password_hash = ?, token_version = token_version + 1,
       active = CASE WHEN ? = 1 THEN 1 ELSE active END
     WHERE id = ?`
  ).run(bcrypt.hashSync(password, 10), opts.activate ? 1 : 0, userId);
  return password;
}
