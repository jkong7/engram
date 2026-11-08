import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshHome } from './helpers.ts';
import { createKey, revokeKey, listKeys } from '../src/auth.ts';

test('issue #2 repro: revoking the default name revokes every unnamed key', () => {
  const { db, cleanup } = freshHome();
  try {
    createKey(db, 'key', ['read']);   // unnamed key A (server default name)
    createKey(db, 'key', ['read']);   // unnamed key B (server default name)
    createKey(db, 'named-one', ['read']);
    const r = revokeKey(db, 'key');   // ambiguous name: correct behavior is refusal, nothing revoked
    assert.equal(r, 'ambiguous', 'ambiguous name must be refused');
    const live = (listKeys(db) as any[]).filter((k) => !k.revoked);
    assert.equal(live.length, 3, `ambiguous name must revoke nothing, got ${live.length}: ${live.map((k)=>k.name)}`);
  } finally { cleanup(); }
});

test('issue #2 repro: an id equal to another key name revokes both', () => {
  const { db, cleanup } = freshHome();
  try {
    const a = createKey(db, 'alpha', ['read']);
    createKey(db, a.id, ['read']);    // key whose NAME equals a's id
    const r = revokeKey(db, a.id);    // intend: revoke key a by id
    assert.equal(r, 'revoked', 'id revocation must succeed');
    const live = (listKeys(db) as any[]).filter((k) => !k.revoked);
    assert.equal(live.length, 1, 'only the id-named key should survive... but OR-clause revokes both');
  } finally { cleanup(); }
});
