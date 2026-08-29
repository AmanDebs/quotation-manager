import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import bcrypt from 'bcryptjs';
import { db, dataDir } from './connection.js';
import { record } from '../services/audit.js';

/**
 * The way back in when nobody can sign in.
 *
 * The app has no "forgot password" flow and deliberately shouldn't: there is
 * no mail server, and a reset link nobody can receive is worse than none.
 * Instead this runs where the database is — the Render shell, or a terminal
 * beside `server/data` — so the person who can reach the disk is the person
 * who can recover the account. That is the same authority the disk already
 * gives them; anyone able to run this could read the database anyway, so it
 * adds no exposure that did not exist.
 *
 *     npm run reset-password                    -- list the accounts
 *     npm run reset-password -- --email a@b.com -- reset that one
 *
 * **It generates the password rather than taking one.** A password typed as an
 * argument goes into shell history and, for a moment, into the process list
 * where any other user on the box can read it. There is no need: the operator
 * signs in with what this prints and changes it in the app, which is a better
 * habit anyway. That is why there is no `--password` flag, and adding one
 * would be a step backwards.
 *
 * Two things it does besides setting the hash, both matching what the app
 * itself does on `PUT /users/:id`:
 *
 * - **Bumps `token_version`**, so every session signed under the old password
 *   stops working. A reset that left somebody else logged in would not be a
 *   recovery, it would be a second key cut for the same lock.
 * - **Writes to the audit log**, with no user against it and a note saying it
 *   came from the command line. A password changing with nothing in the trail
 *   is exactly the hole the trail exists to close, and this is the one path
 *   that bypasses the HTTP layer entirely.
 */

interface UserRow {
  id: number;
  name: string;
  email: string;
  role: string;
  active: number;
}

/**
 * Readable, and no ambiguity a person can mistype.
 *
 * `0/O` and `1/l/I` are left out because this gets read off a terminal and
 * typed into a browser, sometimes over the phone. Five groups of four from a
 * 30-character alphabet is a shade under 100 bits — far past anything the
 * login rate limiter would let through, and short enough to read aloud.
 */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(20);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12, 16].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

const arg = (name: string): string | undefined => {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline?.slice(flag.length + 1);
};
const has = (name: string) => process.argv.includes(`--${name}`);

function listUsers(users: UserRow[]) {
  console.log('\nAccounts in this database:\n');
  const width = Math.max(...users.map((u) => u.email.length), 5);
  for (const u of users) {
    console.log(
      `  ${u.email.padEnd(width)}  ${u.role.padEnd(8)}  ${u.active ? 'active  ' : 'INACTIVE'}  ${u.name}`
    );
  }
  console.log('\nReset one with:\n  npm run reset-password -- --email <address>\n');
}

async function main() {
  console.log(`\nERP Tool — password reset`);
  // Said out loud every time. The commonest way to get this wrong is to run it
  // against the wrong database and wonder why the new password does not work.
  console.log(`Database: ${dataDir}`);

  const users = db
    .prepare('SELECT id, name, email, role, active FROM users ORDER BY role, email')
    .all() as unknown as UserRow[];

  if (users.length === 0) {
    console.log('\nThere are no accounts at all. Open the app and register — the first');
    console.log('account is created through the sign-up screen, which is refused once');
    console.log('any account exists.\n');
    return;
  }

  const email = (arg('email') ?? '').trim().toLowerCase();
  if (!email) {
    listUsers(users);
    return;
  }

  const user = users.find((u) => u.email.toLowerCase() === email);
  if (!user) {
    console.error(`\nNo account with the address "${email}".`);
    listUsers(users);
    process.exitCode = 1;
    return;
  }

  console.log(`\nAccount:  ${user.name} <${user.email}>`);
  console.log(`Role:     ${user.role}${user.role === 'employee' ? '  (an employee cannot reach Settings, Team or Approvals)' : ''}`);
  if (!user.active) {
    console.log('Status:   DEACTIVATED — sign-in is refused for this account even with the');
    console.log('          right password. Re-run with --activate to switch it back on.');
  }

  if (!has('yes')) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    const answer = (await rl.question('\nReset this password, ending every session it has open? [y/N] ')).trim();
    rl.close();
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      console.log('Nothing changed.\n');
      return;
    }
  }

  const password = generatePassword();
  // Hash and version bump together: a hash written without the bump would
  // leave old sessions alive, which is the failure this is meant to prevent.
  db.prepare(
    'UPDATE users SET password_hash = ?, token_version = token_version + 1, active = ? WHERE id = ?'
  ).run(bcrypt.hashSync(password, 10), has('activate') ? 1 : user.active, user.id);

  record({
    user: undefined,
    entity: 'users',
    entity_id: user.id,
    action: 'change-password',
    label: user.email,
    changes: [{ field: 'password_hash', truncated: true }],
    note: 'reset from the command line; every session signed out',
  });

  console.log(`\n  New password:  ${password}\n`);
  console.log('Every session on that account has been signed out.');
  console.log('Sign in with the password above, then change it under your own profile —');
  console.log('it has been printed to this terminal and should not stay in use.\n');
}

main().catch((err) => {
  console.error('\nPassword reset failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
