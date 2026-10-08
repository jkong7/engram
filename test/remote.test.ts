import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { freshHome } from './helpers.ts';
import { startRemote, remotePassphrase, revokeAll } from '../src/remote.ts';
import { writeMemory } from '../src/store.ts';

describe('remote OAuth MCP listener', () => {
  let h: ReturnType<typeof freshHome>;
  let close: () => Promise<void>;
  let base: string;
  before(async () => {
    h = freshHome(false);
    await writeMemory(h.db, { body: 'Sam keeps his notes in an Obsidian vault at ~/notes.', kind: 'fact' });
    const r = await startRemote(h.db, 18000 + Math.floor(Math.random() * 1000));
    close = r.close;
    base = `http://127.0.0.1:${r.port}`;
  });
  after(async () => {
    await close();
    h.cleanup();
  });

  test('full flow: discovery, DCR, consent, PKCE, MCP call, refresh, revoke', async () => {
    const unauth = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get('www-authenticate') || '', /resource_metadata=/);
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    assert.equal(prm.resource, `${base}/mcp`);
    const asm = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual(asm.code_challenge_methods_supported, ['S256']);
    const reg = await (await fetch(asm.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'claude.ai', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' }) })).json();
    assert.ok(reg.client_id);
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'memory' });
    const page = await (await fetch(`${asm.authorization_endpoint}?${q}`)).text();
    assert.match(page, /claude\.ai/);
    const wrong = await fetch(asm.authorization_endpoint, { method: 'POST', body: new URLSearchParams({ ...Object.fromEntries(q), passphrase: 'nope' }), redirect: 'manual' });
    assert.equal(wrong.status, 401);
    const ok = await fetch(asm.authorization_endpoint, { method: 'POST', body: new URLSearchParams({ ...Object.fromEntries(q), passphrase: remotePassphrase() }), redirect: 'manual' });
    assert.equal(ok.status, 302);
    const loc = new URL(ok.headers.get('location')!);
    assert.equal(loc.searchParams.get('state'), 'xyz');
    const code = loc.searchParams.get('code')!;
    const bad = await fetch(asm.token_endpoint, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: reg.client_id, code_verifier: 'wrong', redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }) });
    assert.equal(bad.status, 400);
    const tok = await (await fetch(asm.token_endpoint, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: reg.client_id, code_verifier: verifier, redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }) })).json();
    assert.ok(tok.access_token && tok.refresh_token);
    const replay = await fetch(asm.token_endpoint, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: reg.client_id, code_verifier: verifier }) });
    assert.equal(replay.status, 400);
    const headers = { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const init = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '1' } } }) });
    assert.equal(init.status, 200);
    const list = await (await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) })).text();
    assert.match(list, /memory_write/);
    assert.ok(!list.includes('memory_forget'));
    const call = await (await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'where are my obsidian notes' } } }) })).text();
    assert.match(call, /notes/);
    const ref = await (await fetch(asm.token_endpoint, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id }) })).json();
    assert.ok(ref.access_token && ref.access_token !== tok.access_token);
    const reuse = await fetch(asm.token_endpoint, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id }) });
    assert.equal(reuse.status, 400);
    revokeAll(h.db);
    const after = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${ref.access_token}` }, body: '{}' });
    assert.equal(after.status, 401);
  });

  test('rejects non-https redirect URIs at registration', async () => {
    const r = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
    assert.equal(r.status, 400);
  });
});
