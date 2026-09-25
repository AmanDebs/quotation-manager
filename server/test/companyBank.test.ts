import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { foreignBankError } from '../src/services/companies.js';

/**
 * A document may not print another entity's bank account.
 *
 * The bank picker on the proforma and invoice forms read `/api/settings`,
 * which is the view of the **default** company — so on a second entity's
 * document it offered the first entity's accounts (2026-09-25, the client:
 * *"this is picking AGLO polymers bank details in Aglo Packaging PI / CI"*).
 * The page then printed that account under `BENEFICIARY NAME: <the issuing
 * company>`: nothing on it contradicts itself, and the money goes to the
 * wrong entity.
 *
 * The screen was fixed to offer the issuing company's list; this is the
 * guard behind it, and most of these cases are about what it must **not**
 * refuse — a guard that fires wrongly makes a document unsavable.
 */

const ACCOUNT_A = 'AXIS BANK - DOMESTIC\nA/c 911020001234567\nIFSC UTIB0000123';
const ACCOUNT_A2 = 'AXIS BANK - FOREIGN\nA/c 911020007654321\nIFSC UTIB0000123';
const ACCOUNT_B = 'HDFC BANK - PACKAGING\nA/c 50200012345678\nIFSC HDFC0000456';

function company(name: string, accounts: string[], isDefault = 0): number {
  return Number(db.prepare(
    `INSERT INTO companies (company_name, is_default, bank_accounts) VALUES (?, ?, ?)`
  ).run(name, isDefault, JSON.stringify(accounts.map((d, i) => ({ label: `Account ${i + 1}`, details: d })))).lastInsertRowid);
}

const polymers = company('Aglo Polymers Pvt Ltd', [ACCOUNT_A, ACCOUNT_A2]);
const packaging = company('Aglo Packaging Pvt Ltd', [ACCOUNT_B]);

describe('the bank account on a document belongs to the company issuing it', () => {
  test('another entity’s account is refused, naming both', () => {
    const err = foreignBankError(packaging, ACCOUNT_A);
    assert.ok(err, 'the whole point');
    assert.match(String(err), /Aglo Polymers Pvt Ltd/);
    assert.match(String(err), /Aglo Packaging Pvt Ltd/);
  });

  test('and so is the second account of that entity', () => {
    assert.ok(foreignBankError(packaging, ACCOUNT_A2));
  });

  test('its own account is fine, and so is the other way round', () => {
    assert.equal(foreignBankError(packaging, ACCOUNT_B), null);
    assert.equal(foreignBankError(polymers, ACCOUNT_A), null);
    assert.equal(foreignBankError(polymers, ACCOUNT_A2), null);
  });

  test('a blank is fine — the field is not mandatory here, the checks table asks', () => {
    assert.equal(foreignBankError(packaging, ''), null);
    assert.equal(foreignBankError(packaging, null), null);
    assert.equal(foreignBankError(packaging, undefined), null);
  });

  /*
   * The case that decides the guard's shape. The details are **stored on the
   * document** rather than referenced, so a value edited or removed in
   * Settings afterwards matches no company at all — including its own. Refuse
   * those and every such document becomes unsavable, which is the trap this
   * codebase has built once and does not intend to build again.
   */
  test('an account matching nothing on file is left alone', () => {
    assert.equal(foreignBankError(packaging, 'SOME BANK\nA/c 000000\nIFSC ZZZZ'), null);
    assert.equal(foreignBankError(polymers, 'AXIS BANK - DOMESTIC\nA/c 911020001234567\nIFSC UTIB0000999'), null);
  });

  test('whitespace is not a different account', () => {
    assert.ok(foreignBankError(packaging, `  ${ACCOUNT_A}  `), 'padded still belongs to the other company');
    assert.equal(foreignBankError(polymers, ACCOUNT_A.replace(/\n/g, '\n ')), null, 'and still belongs to its own');
  });

  test('a company id that is not on file refuses what it can still place', () => {
    // A document pointing at a deleted company still renders (getCompany falls
    // back), so the guard has to answer rather than throw — and the account is
    // still identifiably somebody else's.
    const err = foreignBankError(9999, ACCOUNT_A);
    assert.ok(err);
    assert.match(String(err), /Aglo Polymers Pvt Ltd/);
    assert.match(String(err), /another company/);
  });
});
