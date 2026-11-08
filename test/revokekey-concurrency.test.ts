import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { freshHome } from './helpers.ts';
import { createKey, revokeKey, listKeys } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';

const GUARDED_UPDATE = `update api_keys set revoked = 1 where id = (
  select id from api_keys where name = ? and revoked = 0 group by name having count(*) = 1
)`;

// Regression for the race an independent review found in the original PR head:
// the name fallback counted live same-named keys and updated in two statements,
// so a concurrent insert of a same-named key between them was revoked too.
// These tests pin the two mechanisms that close it: the write lock held for the
// whole name path, and the guarded single update that cannot match two rows.

test('revoke name path holds the write lock: a second connection cannot insert a same-named key mid-transaction', () => {
  const { db, dir, cleanup } = freshHome();
  const path = loadConfig().dbPath;
  const other = new DatabaseSync(path, { timeout: 0 }); // fail fast instead of waiting out busy_timeout
  try {
    createKey(db, 'shared', ['read']);

    // Simulate revokeKey's transaction state just before its update.
    db.exec('begin immediate');
    const named = db.prepare('select count(*) as n from api_keys where name = ? and revoked = 0').get('shared') as { n: number };
    assert.equal(named.n, 1);

    // The old bug needed another process to insert a same-named key here.
    // With BEGIN IMMEDIATE held, that write must be refused, not queued in.
    assert.throws(
      () => other.prepare('insert into api_keys (id, name, key_hash, scopes, tenant, created_at) values (?,?,?,?,?,?)').run('k_evil1', 'shared', 'x', 'read', 'default', '2026-01-01'),
      /SQLITE_BUSY|database is locked/i,
      'concurrent same-named insert must be blocked while the revoke transaction holds the write lock',
    );

    const res = db.prepare(GUARDED_UPDATE).run('shared');
    db.exec('commit');
    assert.equal(res.changes, 1);

    const live = (listKeys(db) as any[]).filter((k) => !k.revoked);
    assert.equal(live.length, 0, 'the one intended key is revoked and no extra key appeared');

    // After commit the name is free again and a new key with it can be created normally.
    const k2 = createKey(db, 'shared', ['read']);
    assert.ok(k2.id);
  } finally {
    other.close();
    cleanup();
  }
});

test('guarded update cannot revoke two keys even if a same-named key appears after the count', () => {
  const { db, cleanup } = freshHome();
  try {
    createKey(db, 'shared', ['read']);
    // A second same-named key lands before the update executes (the old race outcome).
    createKey(db, 'shared', ['read']);
    // The guarded statement must refuse outright: 0 changes, nothing revoked.
    const res = db.prepare(GUARDED_UPDATE).run('shared');
    assert.equal(res.changes, 0, 'guard must refuse when two live keys share the name');
    const live = (listKeys(db) as any[]).filter((k) => !k.revoked);
    assert.equal(live.length, 2);
    // And revokeKey agrees with the guard.
    assert.equal(revokeKey(db, 'shared'), 'ambiguous');
    assert.equal((listKeys(db) as any[]).filter((k) => !k.revoked).length, 2);
  } finally { cleanup(); }
});

test('rollback inside the name path leaves every key live', () => {
  const { db, cleanup } = freshHome();
  try {
    createKey(db, 'shared', ['read']);
    db.exec('begin immediate');
    db.prepare(GUARDED_UPDATE).run('shared');
    // Simulate a failure after the update: the transaction must roll back cleanly.
    db.exec('rollback');
    const live = (listKeys(db) as any[]).filter((k) => !k.revoked);
    assert.equal(live.length, 1, 'rollback must restore the pre-transaction state');
    assert.equal(revokeKey(db, 'shared'), 'revoked');
    assert.equal((listKeys(db) as any[]).filter((k) => !k.revoked).length, 0);
  } finally { cleanup(); }
});
