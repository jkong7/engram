import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { DB } from './db.ts';
import { loadConfig, engramHome } from './config.ts';
import { createMcpServer } from './mcp.ts';
import { nowIso } from './util.ts';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const rand = (n = 32) => randomBytes(n).toString('base64url');

export function remotePassphrase(rotate = false): string {
  const file = join(engramHome(), 'remote-passphrase');
  if (!rotate && existsSync(file)) return readFileSync(file, 'utf8').trim();
  const words = ['amber', 'birch', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'harbor', 'iris', 'juniper', 'koi', 'lumen', 'maple', 'nova', 'onyx', 'pine', 'quartz', 'raven', 'sage', 'tide', 'umber', 'vale', 'willow', 'yarrow', 'zephyr'];
  const pick = () => words[randomBytes(1)[0] % words.length];
  const pass = `${pick()}-${pick()}-${pick()}-${randomBytes(2).readUInt16BE(0) % 10000}`;
  writeFileSync(file, pass + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return pass;
}

function baseUrl(req: IncomingMessage): string {
  const cfg = loadConfig();
  if (cfg.remote.publicUrl) return cfg.remote.publicUrl.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

function send(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  const isStr = typeof data === 'string';
  res.writeHead(status, { 'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(isStr ? data : JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 2 * 1024 * 1024) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function parseForm(body: Buffer, type: string | undefined): Record<string, string> {
  const text = body.toString('utf8');
  if (type?.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function consentPage(p: Record<string, string>, clientName: string, error = ''): string {
  const hidden = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']
    .map((k) => (p[k] ? `<input type="hidden" name="${k}" value="${esc(p[k])}">` : ''))
    .join('');
  let host = '';
  try {
    host = new URL(p.redirect_uri).host;
  } catch {}
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>engram access</title>
<style>:root{--bg:#fbfaf8;--ink:#1c1b19;--muted:#6d6a64;--line:#e7e3dc;--accent:#3b5bdb}@media (prefers-color-scheme:dark){:root{--bg:#141413;--ink:#ecebe7;--muted:#9b978f;--line:#2f2d2a;--accent:#7c9cff}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
form{max-width:380px;width:100%;border:1px solid var(--line);border-radius:12px;padding:22px}h1{font-size:18px;margin:0 0 8px}p{color:var(--muted);margin:0 0 14px}
input[type=password]{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--ink);font:inherit}
button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}.err{color:#c0392b}</style></head>
<body><form method="post" action="/oauth/authorize"><h1>Connect to your engram memory</h1>
<p><b>${esc(clientName || 'An app')}</b> (${esc(host)}) wants to read and write your persistent memory.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}${hidden}
<input type="password" name="passphrase" placeholder="engram remote passphrase" autocomplete="off" autofocus required>
<button type="submit">Allow</button></form></body></html>`;
}

const failures: number[] = [];

function lockedOut(): boolean {
  const hourAgo = Date.now() - 3600000;
  while (failures.length && failures[0] < hourAgo) failures.shift();
  return failures.length >= 10;
}

export function revokeAll(db: DB): number {
  return Number(db.prepare('update oauth_tokens set revoked = 1 where revoked = 0').run().changes);
}

export function remoteStatus(db: DB) {
  const clients = db.prepare('select client_id, client_name, created_at from oauth_clients order by created_at desc').all();
  const tokens = db.prepare("select client_id, kind, expires_at, last_used from oauth_tokens where revoked = 0 and expires_at > ? order by created_at desc").all(nowIso());
  return { clients, tokens };
}

function checkBearer(db: DB, req: IncomingMessage): string | null {
  const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!raw) return null;
  const row = db.prepare("select client_id, expires_at, revoked from oauth_tokens where token_hash = ? and kind = 'access'").get(hash(raw)) as { client_id: string; expires_at: string; revoked: number } | undefined;
  if (!row || row.revoked || Date.parse(row.expires_at) < Date.now()) return null;
  db.prepare('update oauth_tokens set last_used = ? where token_hash = ?').run(nowIso(), hash(raw));
  return row.client_id;
}

function issueTokens(db: DB, clientId: string, scope: string | null) {
  const access = rand();
  const refresh = rand();
  const now = nowIso();
  db.prepare('insert into oauth_tokens (token_hash, kind, client_id, scope, expires_at, created_at) values (?,?,?,?,?,?)').run(hash(access), 'access', clientId, scope, new Date(Date.now() + 3600000).toISOString(), now);
  db.prepare('insert into oauth_tokens (token_hash, kind, client_id, scope, expires_at, created_at) values (?,?,?,?,?,?)').run(hash(refresh), 'refresh', clientId, scope, new Date(Date.now() + 30 * 86400000).toISOString(), now);
  return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: scope || 'memory' };
}

export function createRemoteHandler(db: DB) {
  const cfg = loadConfig();
  const mcp = createMcpHandler(() => createMcpServer({ db, harness: 'remote', readOnly: !cfg.remote.allowWrite, allowForget: cfg.remote.allowForget }), { legacy: 'stateless' });
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url || '/', 'http://x');
      const path = url.pathname;
      const base = baseUrl(req);
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version, mcp-session-id');
      res.setHeader('access-control-expose-headers', 'www-authenticate, mcp-session-id');
      if (req.method === 'OPTIONS') return send(res, 204, '');
      if (path === '/healthz') return send(res, 200, { ok: true });
      if (path.startsWith('/.well-known/oauth-protected-resource')) {
        return send(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'], scopes_supported: ['memory'], resource_name: 'engram memory' });
      }
      if (path.startsWith('/.well-known/oauth-authorization-server') || path.startsWith('/.well-known/openid-configuration')) {
        return send(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          registration_endpoint: `${base}/oauth/register`,
          revocation_endpoint: `${base}/oauth/revoke`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
          scopes_supported: ['memory'],
          client_id_metadata_document_supported: false,
        });
      }
      if (path === '/oauth/register' && req.method === 'POST') {
        const b = parseForm(await readBody(req), req.headers['content-type']) as unknown as Record<string, any>;
        const uris: string[] = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
        if (!uris.length || uris.some((u) => !/^https:\/\//.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u))) return send(res, 400, { error: 'invalid_redirect_uri' });
        const clientId = `c_${rand(12)}`;
        const wantsSecret = b.token_endpoint_auth_method && b.token_endpoint_auth_method !== 'none';
        const secret = wantsSecret ? rand() : null;
        db.prepare('insert into oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, created_at) values (?,?,?,?,?)').run(clientId, secret ? hash(secret) : null, String(b.client_name || 'MCP client').slice(0, 80), JSON.stringify(uris), nowIso());
        return send(res, 201, { client_id: clientId, ...(secret ? { client_secret: secret } : {}), client_name: b.client_name, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: wantsSecret ? b.token_endpoint_auth_method : 'none' });
      }
      if (path === '/oauth/authorize') {
        const p = req.method === 'POST' ? parseForm(await readBody(req), req.headers['content-type']) : Object.fromEntries(url.searchParams);
        const client = db.prepare('select * from oauth_clients where client_id = ?').get(p.client_id || '') as { client_name: string; redirect_uris: string } | undefined;
        if (!client) return send(res, 400, '<p>Unknown client. Re-add the connector.</p>');
        const uris = JSON.parse(client.redirect_uris) as string[];
        if (!uris.includes(p.redirect_uri)) return send(res, 400, '<p>Redirect URI not registered for this client.</p>');
        if (p.response_type !== 'code' || p.code_challenge_method !== 'S256' || !p.code_challenge) return send(res, 400, '<p>Only the authorization code flow with S256 PKCE is supported.</p>');
        if (req.method === 'GET') return send(res, 200, consentPage(p, client.client_name));
        if (lockedOut()) return send(res, 429, consentPage(p, client.client_name, 'Too many wrong attempts. Try again in an hour.'));
        const expected = Buffer.from(remotePassphrase());
        const given = Buffer.from(String(p.passphrase || ''));
        if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
          failures.push(Date.now());
          return send(res, 401, consentPage(p, client.client_name, 'Wrong passphrase.'));
        }
        const code = rand();
        db.prepare('insert into oauth_codes (code_hash, client_id, redirect_uri, challenge, scope, resource, expires_at) values (?,?,?,?,?,?,?)').run(hash(code), p.client_id, p.redirect_uri, p.code_challenge, p.scope || 'memory', p.resource || null, new Date(Date.now() + 600000).toISOString());
        const target = new URL(p.redirect_uri);
        target.searchParams.set('code', code);
        if (p.state) target.searchParams.set('state', p.state);
        res.writeHead(302, { location: target.toString(), 'cache-control': 'no-store' });
        return void res.end();
      }
      if (path === '/oauth/token' && req.method === 'POST') {
        const b = parseForm(await readBody(req), req.headers['content-type']);
        let clientId = b.client_id;
        let clientSecret = b.client_secret;
        const basic = (req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
        if (basic) {
          const [id, sec] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
          clientId = decodeURIComponent(id);
          clientSecret = decodeURIComponent(sec || '');
        }
        const client = db.prepare('select * from oauth_clients where client_id = ?').get(clientId || '') as { client_secret_hash: string | null } | undefined;
        if (!client) return send(res, 401, { error: 'invalid_client' });
        if (client.client_secret_hash && hash(clientSecret || '') !== client.client_secret_hash) return send(res, 401, { error: 'invalid_client' });
        if (b.grant_type === 'authorization_code') {
          const row = db.prepare('select * from oauth_codes where code_hash = ?').get(hash(b.code || '')) as Record<string, any> | undefined;
          if (!row || row.used || row.client_id !== clientId || Date.parse(row.expires_at) < Date.now()) return send(res, 400, { error: 'invalid_grant' });
          if (b.redirect_uri && b.redirect_uri !== row.redirect_uri) return send(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
          const challenge = createHash('sha256').update(b.code_verifier || '').digest('base64url');
          if (challenge !== row.challenge) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
          db.prepare('update oauth_codes set used = 1 where code_hash = ?').run(row.code_hash);
          return send(res, 200, issueTokens(db, clientId!, row.scope));
        }
        if (b.grant_type === 'refresh_token') {
          const row = db.prepare("select * from oauth_tokens where token_hash = ? and kind = 'refresh'").get(hash(b.refresh_token || '')) as Record<string, any> | undefined;
          if (!row || row.revoked || row.client_id !== clientId || Date.parse(row.expires_at) < Date.now()) return send(res, 400, { error: 'invalid_grant' });
          db.prepare('update oauth_tokens set revoked = 1 where token_hash = ?').run(row.token_hash);
          return send(res, 200, issueTokens(db, clientId!, row.scope));
        }
        return send(res, 400, { error: 'unsupported_grant_type' });
      }
      if (path === '/oauth/revoke' && req.method === 'POST') {
        const b = parseForm(await readBody(req), req.headers['content-type']);
        db.prepare('update oauth_tokens set revoked = 1 where token_hash = ?').run(hash(b.token || ''));
        return send(res, 200, {});
      }
      if (path === '/mcp' || path === '/') {
        if (!checkBearer(db, req)) {
          return send(res, 401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", scope="memory"` });
        }
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : new Uint8Array(await readBody(req));
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
        const r = await mcp.fetch(new Request(`http://localhost/mcp${url.search}`, { method: req.method, headers, body }));
        const out: Record<string, string> = {};
        r.headers.forEach((v, k) => (out[k] = v));
        res.writeHead(r.status, out);
        if (r.body) {
          const reader = r.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        }
        return void res.end();
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      if (!res.headersSent) send(res, 500, { error: (err as Error).message });
      else res.end();
    }
  };
}

export async function startRemote(db: DB, port?: number): Promise<{ close: () => Promise<void>; port: number }> {
  const cfg = loadConfig();
  remotePassphrase();
  const handler = createRemoteHandler(db);
  const server = createServer((req, res) => void handler(req, res));
  const p = port ?? cfg.remote.port;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(p, '127.0.0.1', () => resolve());
  });
  return { port: p, close: () => new Promise<void>((r) => server.close(() => r())) };
}
