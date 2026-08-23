import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { diffRows, labelOf } from '../src/services/audit.js';
import { parsePath } from '../src/middleware/audit.js';

/**
 * The audit trail's two jobs are to say what changed and to never say a
 * secret. Both are decided in `diffRows`, and the path parser decides which
 * record an entry is filed against — the way to make the trail actively lie.
 */

const fields = (cs: ReturnType<typeof diffRows>) => cs.map((c) => c.field).sort();
const find = (cs: ReturnType<typeof diffRows>, f: string) => cs.find((c) => c.field === f);

describe('diffRows', () => {
  test('reports only what moved', () => {
    const cs = diffRows(
      { number: 'QT/1', status: 'draft', notes: 'hello' },
      { number: 'QT/1', status: 'sent', notes: 'hello' },
    );
    assert.deepEqual(fields(cs), ['status']);
    assert.deepEqual(find(cs, 'status'), { field: 'status', from: 'draft', to: 'sent' });
  });

  test('a row that did not change produces nothing', () => {
    assert.deepEqual(diffRows({ a: 1, b: 'x' }, { a: 1, b: 'x' }), []);
  });

  /**
   * Most text columns default to ''. Compared against nothing, a create used
   * to report every one of them: an invoice arrived as 37 changes, thirty of
   * which said a field was empty and still is.
   */
  test('empty counts as empty however it is spelled', () => {
    assert.deepEqual(diffRows(undefined, { name: 'Acme', notes: '', phone: null }), [
      { field: 'name', from: null, to: 'Acme' },
    ]);
    assert.deepEqual(diffRows({ notes: '' }, { notes: null }), []);
  });

  test('but clearing a field that had something in it is a real change', () => {
    const cs = diffRows({ notes: 'call back Monday' }, { notes: '' });
    assert.deepEqual(fields(cs), ['notes']);
  });

  test('a number and its string spelling are the same value', () => {
    assert.deepEqual(diffRows({ qty: 10 }, { qty: '10' }), []);
  });

  describe('what is never written down', () => {
    test('that a password changed is recorded; the hash is not', () => {
      const cs = diffRows({ password_hash: '$2a$10$old' }, { password_hash: '$2a$10$new' });
      assert.deepEqual(cs, [{ field: 'password_hash', truncated: true }]);
      assert.ok(!JSON.stringify(cs).includes('$2a$'),
        'the value must not survive anywhere in the entry');
    });

    test('the token version is left out entirely — it says nothing on its own', () => {
      assert.deepEqual(diffRows({ token_version: 0 }, { token_version: 1 }), []);
    });

    test('id and created_at are left out, since the entry already carries both', () => {
      assert.deepEqual(diffRows(undefined, { id: 7, created_at: '2026-08-01', name: 'x' }), [
        { field: 'name', from: null, to: 'x' },
      ]);
    });

    test('a value too long to keep is reported as changed without its content', () => {
      const cs = diffRows({ notes: 'a'.repeat(400) }, { notes: 'b'.repeat(400) });
      assert.deepEqual(cs, [{ field: 'notes', truncated: true }]);
    });

    test('and so are the bulky columns, whatever their length', () => {
      for (const field of ['logo', 'signature', 'image', 'bank_accounts', 'column_config', 'items']) {
        const cs = diffRows({ [field]: 'x' }, { [field]: 'y' });
        assert.deepEqual(cs, [{ field, truncated: true }], field);
      }
    });
  });

  test('a delete records the row as it stood, in one direction', () => {
    const cs = diffRows({ number: 'QT/1', status: 'draft' }, undefined);
    assert.deepEqual(find(cs, 'number'), { field: 'number', from: 'QT/1', to: null });
  });

  test('a column added since does not make every later edit look like a change', () => {
    assert.deepEqual(diffRows({ a: 1 }, { a: 1, brand_new_column: '' }), []);
  });
});

describe('labelOf', () => {
  test('prefers the document number', () => {
    assert.equal(labelOf({ number: 'AP/0001/26-27', name: 'ignored' }), 'AP/0001/26-27');
  });
  test('falls back to a name', () => {
    assert.equal(labelOf({ name: 'Acme Ltd' }), 'Acme Ltd');
  });
  test('and to nothing at all rather than inventing one', () => {
    assert.equal(labelOf({ qty: 5 }), '');
    assert.equal(labelOf(undefined), '');
  });
});

/**
 * Filing an entry against the wrong record is the way this feature becomes
 * worse than not having it, so the parser gets its own tests.
 */
describe('parsePath', () => {
  const p = (method: string, url: string) => parsePath(method, url);

  test('a create has no id in the path', () => {
    assert.deepEqual(p('POST', '/api/quotations'), { entity: 'quotations', id: null, action: 'create' });
  });

  test('an edit and a delete take the id after the entity', () => {
    assert.deepEqual(p('PUT', '/api/quotations/12'), { entity: 'quotations', id: 12, action: 'update' });
    assert.deepEqual(p('DELETE', '/api/quotations/12'), { entity: 'quotations', id: 12, action: 'delete' });
  });

  test('a verb after the id names the action', () => {
    assert.deepEqual(p('POST', '/api/quotations/12/status'), { entity: 'quotations', id: 12, action: 'status' });
    assert.deepEqual(p('POST', '/api/work-orders/3/entries'), { entity: 'work-orders', id: 3, action: 'entries' });
  });

  test('a query string is not part of the path', () => {
    assert.equal(p('PUT', '/api/quotations/12?all=1')?.id, 12);
  });

  /**
   * `/work-orders/qc-checks/5` numbers a QC check, not a work order. Reading
   * it as a work order id logged the whole job as though it had just appeared.
   */
  test('a sub-resource id is resolved to its parent, not taken at face value', () => {
    const parsed = p('DELETE', '/api/work-orders/qc-checks/5');
    assert.equal(parsed?.entity, 'work-orders');
    assert.equal(parsed?.action, 'qc-checks delete');
    assert.notEqual(parsed?.id, 5,
      'check 5 is not work order 5 — with no such check it resolves to nothing at all');
  });

  test('settings is rewritten onto the company it actually edits', () => {
    const parsed = p('PUT', '/api/settings');
    assert.equal(parsed?.entity, 'companies', 'there is no table called settings');
    assert.ok((parsed?.id ?? 0) > 0);
  });

  test('a route that records itself is skipped, so one act is not logged twice', () => {
    assert.equal(p('PUT', '/api/settings/sequences'), null);
  });

  test('anything that is not an /api path is ignored', () => {
    assert.equal(p('POST', '/health'), null);
    assert.equal(p('POST', '/api'), null);
  });
});
