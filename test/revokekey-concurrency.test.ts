import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { freshHome } from './helpers.ts';
import { createKey, revokeKey, listKeys } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';

// Regression for the race an independent review found in the original PR head:
// the name fallback counted live same-named keys and updated in two statements,
// so a concurrent insert of a same-named key between them was revoked too.
// These tests drive the REAL revokeKey through that interleaving by proxying
// the db handle: a second connection strikes exactly after the count query.

function proxyWithInterleave(db: any, onCount: () => void, failUpdate = false) {
  let countFired = false;
  return new Proxy(db, {
    get(target, prop, recv) {
      if (prop !== 'prepare') {
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      }
      return (sql: string, ...rest: any[]) => {
        const stmt = (target as any).prepare(sql, ...rest);
        if (!countFired && sql.includes('count(*)')) {
          countFired = true;
          const origGet = stmt.get.bind(stmt);
          stmt.get = (...args: any[]) => {
            const r = origGet(...args);
            onCount(); // the concurrent writer strikes right after our count
            return r;
          };
        }
        if (failUpdate && sql.includes('having count(*)')) {
          stmt.run = () => { throw new Error('injected update failure'); };
        }
        return stmt;
      };
    },
  });
}

test('revokeKey cannot over-revoke when a same-named key lands between count and update', () => {
  const { db, cleanup } = freshHome();
  const path = loadConfig().dbPath;
  const other = new DatabaseSync(path, { timeout: 0 }); // fail fast, no busy wait
  try {
    createKey(db, 'shared', ['read']);
    let strike: string = 'not-attempted';
    const proxied = proxyWithInterleave(db, () => {
      try {
        other.prepare('insert into api_keys (id, name, key_hash, scopes, tenant, created_at) values (?,?,?,?,?,?)')
          .run('k_evil1', 'shared', 'x', 'read', 'default', '2026-01-01');
        strike = 'inserted';
      } catch (e: any) {
        strike = 'blocked';
      }
    });
    const r = revokeKey(proxied, 'shared');
    const keys = listKeys(db) as any[];
    const revokedCount = keys.filter((k) => k.revoked).length;
    const evilPresent = keys.some((k) => k.id === 'k_evil1');

    // Either outcome is safe; over-revocation is not.
    if (strike === 'inserted') {
      // Old behavior: the race window was open. If the interleave landed, the
      // function must still not have revoked more than the one intended key.
      assert.equal(revokedCount, 1, `race window open and revokeKey over-revoked: ${JSON.stringify(keys)}`);
      assert.equal(r, 'ambiguous', 'with two live same-named keys at update time the function must refuse');
    } else {
      // Fixed behavior: the write lock closes the window outright.
      assert.equal(strike, 'blocked');
      assert.equal(r, 'revoked');
      assert.equal(revokedCount, 1);
      assert.equal(evilPresent, false);
    }
  } finally {
    other.close();
    cleanup();
  }
});

test('revokeKey rolls back when the guarded update fails mid-transaction', () => {
  const { db, cleanup } = freshHome();
  try {
    createKey(db, 'shared', ['read']);
    const proxied = proxyWithInterleave(db, () => {}, true);
    assert.throws(() => revokeKey(proxied, 'shared'), /injected update failure/);
    const live = (listKeys(db) as any[]).filter((k) => !k.revoked);
    assert.equal(live.length, 1, 'failed update must roll back, key stays live');
    // The transaction must be fully released: the db is usable and the key revocable.
    assert.equal(revokeKey(db, 'shared'), 'revoked');
    assert.equal((listKeys(db) as any[]).filter((k) => !k.revoked).length, 0);
  } finally { cleanup(); }
});

test('revokeKey refuses two live same-named keys and revokes nothing', () => {
  const { db, cleanup } = freshHome();
  try {
    createKey(db, 'shared', ['read']);
    createKey(db, 'shared', ['read']);
    assert.equal(revokeKey(db, 'shared'), 'ambiguous');
    assert.equal((listKeys(db) as any[]).filter((k) => !k.revoked).length, 2);
  } finally { cleanup(); }
});
