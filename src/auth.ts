import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { DB } from './db.ts';
import { openDb } from './db.ts';
import { authToken, engramHome } from './config.ts';
import { nowIso } from './util.ts';

export type Scope = 'read' | 'write' | 'admin';

export interface Principal {
  name: string;
  tenant: string;
  scopes: Set<Scope>;
  keyId: string | null;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

export function createKey(db: DB, name: string, scopes: Scope[], tenant = 'default'): { id: string; key: string } {
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(tenant)) throw new Error('tenant must be lowercase letters, digits, - or _');
  const key = `ek_${randomBytes(24).toString('base64url')}`;
  const id = `k_${randomBytes(5).toString('hex')}`;
  const valid = scopes.filter((s) => s === 'read' || s === 'write' || s === 'admin');
  if (!valid.length) throw new Error('at least one scope: read, write, admin');
  db.prepare('insert into api_keys (id, name, key_hash, scopes, tenant, created_at) values (?,?,?,?,?,?)').run(id, name, hash(key), valid.join(','), tenant, nowIso());
  return { id, key };
}

export function listKeys(db: DB) {
  return db.prepare('select id, name, scopes, tenant, created_at, last_used, revoked from api_keys order by created_at').all() as Record<string, unknown>[];
}

export function revokeKey(db: DB, id: string): boolean {
  return Number(db.prepare('update api_keys set revoked = 1 where id = ? or name = ?').run(id, id).changes) > 0;
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

let lastTouch = new Map<string, number>();

export function authenticate(db: DB, token: string | undefined): Principal | null {
  if (!token) return null;
  if (safeEq(token, authToken())) return { name: 'owner', tenant: 'default', scopes: new Set(['read', 'write', 'admin']), keyId: null };
  if (!token.startsWith('ek_')) return null;
  const row = db.prepare('select id, name, scopes, tenant, revoked from api_keys where key_hash = ?').get(hash(token)) as { id: string; name: string; scopes: string; tenant: string; revoked: number } | undefined;
  if (!row || row.revoked) return null;
  const now = Date.now();
  if ((lastTouch.get(row.id) || 0) < now - 60000) {
    lastTouch.set(row.id, now);
    try {
      db.prepare('update api_keys set last_used = ? where id = ?').run(nowIso(), row.id);
    } catch {}
  }
  return { name: row.name, tenant: row.tenant, scopes: new Set(row.scopes.split(',') as Scope[]), keyId: row.id };
}

export function tenantDbPath(tenant: string): string {
  return join(engramHome(), 'tenants', tenant, 'engram.db');
}

export function dbFor(rootDb: DB, tenant: string): DB {
  if (tenant === 'default') return rootDb;
  return openDb(tenantDbPath(tenant));
}

export function requiredScope(method: string, path: string): Scope {
  if (path === '/' || path.startsWith('/v1/keys') || path === '/v1/maintain' || path.startsWith('/v1/undo') || /^\/v1\/inbox\/[^/]+\/(approve|reject)$/.test(path) || method === 'DELETE' || /\/restore$/.test(path)) return 'admin';
  if (method === 'GET') return 'read';
  if (path === '/v1/search' || path === '/v1/recall' || path === '/v1/embed') return 'read';
  if (path === '/mcp') return 'read';
  return 'write';
}

interface Bucket {
  tokens: number;
  at: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimited(id: string, ratePerSec = Number(process.env.ENGRAM_RATE || 60), burst = Number(process.env.ENGRAM_BURST || 200)): boolean {
  const now = Date.now();
  const b = buckets.get(id) || { tokens: burst, at: now };
  b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * ratePerSec);
  b.at = now;
  if (b.tokens < 1) {
    buckets.set(id, b);
    return true;
  }
  b.tokens -= 1;
  buckets.set(id, b);
  return false;
}

export function resetAuthState(): void {
  buckets.clear();
  lastTouch = new Map();
}
