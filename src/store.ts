import type { DB } from './db.ts';
import { tx } from './db.ts';
import { loadConfig } from './config.ts';
import { redactSecrets, scanInjection, looksSensitive } from './safety.ts';
import { normalizeScope } from './scope.ts';
import { embedOne, embedModelName, type EmbedMode } from './embed.ts';
import { newId, nowIso, sha, normalize, clip, safeJson, cosine, toBlob, fromBlob, contentTerms } from './util.ts';

export const KINDS = ['profile', 'preference', 'fact', 'decision', 'procedure', 'episode', 'reference'] as const;
export type Kind = (typeof KINDS)[number];
export const TRUSTS = ['user', 'agent', 'extracted', 'external'] as const;
export type Trust = (typeof TRUSTS)[number];
export type Status = 'active' | 'superseded' | 'archived' | 'pending' | 'deleted';

export const TRUST_RANK: Record<Trust, number> = { user: 3, agent: 2, extracted: 1, external: 0 };

export const DEFAULT_IMPORTANCE: Record<Kind, number> = {
  profile: 8,
  preference: 7,
  decision: 6,
  procedure: 6,
  fact: 5,
  reference: 4,
  episode: 3,
};

export interface Source {
  harness?: string;
  session?: string;
  cwd?: string;
  uri?: string;
  evidence?: string;
  pending_supersedes?: string[];
  pending_update_of?: string;
  [k: string]: unknown;
}

export interface Memory {
  id: string;
  kind: Kind;
  scope: string;
  title: string;
  body: string;
  tags: string[];
  importance: number;
  trust: Trust;
  sensitive: boolean;
  pinned: boolean;
  status: Status;
  flags: string[];
  key: string | null;
  valid_from: string | null;
  valid_to: string | null;
  superseded_by: string | null;
  source: Source;
  created_at: string;
  updated_at: string;
  version: number;
  access_count: number;
  last_accessed: string | null;
  injected_count: number;
  last_injected: string | null;
  hash: string;
  embedding: Float32Array | null;
  embed_model: string | null;
}

export interface WriteInput {
  body: string;
  title?: string;
  kind?: Kind | string;
  scope?: string;
  cwd?: string | null;
  tags?: string[];
  importance?: number;
  trust?: Trust;
  sensitive?: boolean;
  pinned?: boolean;
  source?: Source;
  supersedes?: string[];
  key?: string;
  validFrom?: string;
  actor?: string;
  reason?: string;
  batch?: string;
  embedMode?: EmbedMode;
  dedupe?: boolean;
  maxChars?: number;
}

export type WriteStatus = 'created' | 'duplicate' | 'merged' | 'updated' | 'pending' | 'rejected';

export interface WriteResult {
  id: string | null;
  status: WriteStatus;
  message: string;
  superseded?: string[];
  flags?: string[];
  redactions?: string[];
}

type Row = Record<string, unknown>;

export function rowToMemory(r: Row): Memory {
  return {
    id: r.id as string,
    kind: r.kind as Kind,
    scope: r.scope as string,
    title: r.title as string,
    body: r.body as string,
    tags: safeJson<string[]>(r.tags as string, []),
    importance: Number(r.importance),
    trust: r.trust as Trust,
    sensitive: !!r.sensitive,
    pinned: !!r.pinned,
    status: r.status as Status,
    flags: safeJson<string[]>(r.flags as string, []),
    key: (r.key as string) ?? null,
    valid_from: (r.valid_from as string) ?? null,
    valid_to: (r.valid_to as string) ?? null,
    superseded_by: (r.superseded_by as string) ?? null,
    source: safeJson<Source>(r.source as string, {}),
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    version: Number(r.version),
    access_count: Number(r.access_count),
    last_accessed: (r.last_accessed as string) ?? null,
    injected_count: Number(r.injected_count),
    last_injected: (r.last_injected as string) ?? null,
    hash: r.hash as string,
    embedding: fromBlob(r.embedding as Uint8Array | null),
    embed_model: (r.embed_model as string) ?? null,
  };
}

export function publicMemory(m: Memory, opts: { full?: boolean } = {}) {
  const out: Record<string, unknown> = {
    id: m.id,
    kind: m.kind,
    scope: m.scope,
    title: m.title,
    body: m.body,
    tags: m.tags,
    importance: m.importance,
    trust: m.trust,
    status: m.status,
    created: m.created_at.slice(0, 10),
    updated: m.updated_at.slice(0, 10),
  };
  if (m.pinned) out.pinned = true;
  if (m.sensitive) out.sensitive = true;
  if (m.valid_to) out.valid_to = m.valid_to;
  if (m.superseded_by) out.superseded_by = m.superseded_by;
  if (opts.full) {
    out.valid_from = m.valid_from;
    out.source = m.source;
    out.flags = m.flags;
    out.version = m.version;
    out.access_count = m.access_count;
    out.last_accessed = m.last_accessed;
    out.injected_count = m.injected_count;
    out.key = m.key;
  }
  return out;
}

function snapshot(m: Memory | null): string | null {
  if (!m) return null;
  const { embedding, ...rest } = m;
  return JSON.stringify(rest);
}

export function logOp(
  db: DB,
  op: string,
  memoryId: string | null,
  before: Memory | null,
  after: Memory | null,
  actor?: string,
  reason?: string,
  batch?: string,
): number {
  const res = db
    .prepare('insert into ops(ts, op, memory_id, actor, reason, before, after, batch) values (?,?,?,?,?,?,?,?)')
    .run(nowIso(), op, memoryId, actor ?? null, reason ?? null, snapshot(before), snapshot(after), batch ?? null);
  return Number(res.lastInsertRowid);
}

export function getMemory(db: DB, id: string): Memory | null {
  const r = db.prepare('select * from memories where id = ?').get(id) as Row | undefined;
  return r ? rowToMemory(r) : null;
}

export function getMemories(db: DB, ids: string[]): Memory[] {
  return ids.map((id) => getMemory(db, id)).filter((m): m is Memory => !!m);
}

export function inferKind(text: string): Kind {
  const t = text.toLowerCase();
  if (/^(how to|to (run|deploy|build|release|set up|setup|install|test|publish)\b|steps?:|procedure:|recipe:|workflow:)/.test(t) || /\n\s*(1\.|-)\s.+\n\s*(2\.|-)\s/.test(t)) return 'procedure';
  if (/\b(decided|decision|we chose|chose to|going with|agreed (to|on)|settled on|opted (for|to))\b/.test(t)) return 'decision';
  if (/\b(prefers?|preference|likes? (to|it when)|dislikes?|hates?|wants? (me|you|agents?|claude) to|never (use|write|add|send)|always (use|write|add|sign)|don't (use|write|add)|do not (use|write|add))\b/.test(t)) return 'preference';
  if (/^(see|docs?|link|reference|dashboard|repo):?\s|https?:\/\//.test(t) && t.length < 400) return 'reference';
  if (/\b(user'?s? name is|goes by|lives in|works (at|as)|is a (student|senior|engineer|developer)|born in|grew up|his (girlfriend|partner)|her (boyfriend|partner))\b/.test(t)) return 'profile';
  return 'fact';
}

export function deriveTitle(body: string): string {
  const first = body.split(/\n/)[0].replace(/^[#>*\-\s]+/, '').trim();
  const sentence = first.split(/(?<=[.!?])\s/)[0];
  return clip(sentence || first || body.trim(), 90);
}

function normalizeKind(k: string | undefined, body: string): Kind {
  if (!k) return inferKind(body);
  const s = k.toLowerCase().trim();
  if ((KINDS as readonly string[]).includes(s)) return s as Kind;
  const aliases: Record<string, Kind> = {
    user: 'profile',
    identity: 'profile',
    feedback: 'preference',
    rule: 'preference',
    pref: 'preference',
    semantic: 'fact',
    note: 'fact',
    project: 'fact',
    skill: 'procedure',
    how_to: 'procedure',
    howto: 'procedure',
    playbook: 'procedure',
    event: 'episode',
    episodic: 'episode',
    summary: 'episode',
    link: 'reference',
    resource: 'reference',
  };
  return aliases[s] || inferKind(body);
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function findNearDuplicate(db: DB, kind: Kind, scope: string, title: string, body: string, vec: Float32Array | null): { m: Memory; sim: number } | null {
  const cfg = loadConfig();
  const rows = db
    .prepare("select * from memories where kind = ? and scope = ? and status in ('active','pending')")
    .all(kind, scope) as Row[];
  let best: { m: Memory; sim: number } | null = null;
  const nt = normalize(title);
  const terms = contentTerms(title + ' ' + body);
  for (const r of rows) {
    const m = rowToMemory(r);
    let sim = 0;
    if (vec && m.embedding && m.embed_model === embedModelName()) sim = cosine(vec, m.embedding);
    else {
      const j = jaccard(terms, contentTerms(m.title + ' ' + m.body));
      sim = j >= 0.8 ? 0.93 : j;
    }
    if (normalize(m.title) === nt && nt.length > 12 && sim < cfg.nearDuplicate) {
      const j = jaccard(terms, contentTerms(m.title + ' ' + m.body));
      if (j >= 0.5) sim = Math.max(sim, cfg.nearDuplicate);
    }
    if (sim >= cfg.nearDuplicate && (!best || sim > best.sim)) best = { m, sim };
  }
  return best;
}

export function memoryHash(kind: string, scope: string, body: string): string {
  return sha(`${kind}|${scope}|${normalize(body)}`);
}

export async function writeMemory(db: DB, input: WriteInput): Promise<WriteResult> {
  const cfg = loadConfig();
  const raw = (input.body || '').trim();
  if (!raw) return { id: null, status: 'rejected', message: 'Nothing to save: body is empty.' };
  const red = redactSecrets(raw);
  const body = red.text;
  const kind = normalizeKind(input.kind as string | undefined, body);
  const cap = input.maxChars ?? (kind === 'procedure' ? cfg.bodyMaxChars * 4 : kind === 'episode' ? cfg.bodyMaxChars * 2 : cfg.bodyMaxChars);
  if (body.length > cap) {
    return {
      id: null,
      status: 'rejected',
      message: `Too long (${body.length} chars, limit ${cap} for ${kind}). Save one atomic fact per memory, or split it. Procedures may be longer.`,
    };
  }
  const title = clip(redactSecrets((input.title || '').trim()).text || deriveTitle(body), 120);
  const scope = normalizeScope(input.scope, input.cwd ?? input.source?.cwd ?? null);
  const trust: Trust = input.trust && (TRUSTS as readonly string[]).includes(input.trust) ? input.trust : 'agent';
  const importance = Math.max(1, Math.min(10, Math.round(input.importance ?? DEFAULT_IMPORTANCE[kind])));
  const tags = Array.from(new Set((input.tags || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean))).slice(0, 12);
  const flags: string[] = [];
  const injection = scanInjection(title + '\n' + body);
  if (injection.length) flags.push(...injection.map((x) => 'injection:' + x));
  if (red.redactions.length) flags.push('redacted');
  const sensitive = input.sensitive ?? looksSensitive(body);
  const hash = memoryHash(kind, scope, body);
  const now = nowIso();
  const actor = input.actor || input.source?.harness || trust;
  const source: Source = { ...(input.source || {}) };
  if (source.evidence) source.evidence = clip(redactSecrets(String(source.evidence)).text, 400);

  const exact = db
    .prepare("select * from memories where hash = ? and status in ('active','pending') limit 1")
    .get(hash) as Row | undefined;
  if (exact) {
    const m = rowToMemory(exact);
    if (TRUST_RANK[trust] > TRUST_RANK[m.trust] || importance > m.importance) {
      db.prepare('update memories set trust = ?, importance = ?, updated_at = ? where id = ?').run(
        TRUST_RANK[trust] > TRUST_RANK[m.trust] ? trust : m.trust,
        Math.max(importance, m.importance),
        now,
        m.id,
      );
    }
    return { id: m.id, status: 'duplicate', message: `Already remembered as ${m.id}.`, redactions: red.redactions };
  }

  let vec: Float32Array | null = null;
  try {
    vec = await embedOne(`${title}\n${body}`, input.embedMode);
  } catch {
    vec = null;
  }

  let quarantined = injection.length > 0 && trust !== 'user';
  if (trust === 'external') quarantined = true;

  return tx(db, () => {
    if (input.key) {
      const keyed = db
        .prepare("select * from memories where key = ? and scope = ? and status = 'active' limit 1")
        .get(input.key, scope) as Row | undefined;
      if (keyed) {
        const before = rowToMemory(keyed);
        if (TRUST_RANK[trust] < TRUST_RANK[before.trust] && trust !== 'agent') {
          return stagePending(db, { kind, scope, title, body, tags, importance, trust, sensitive, flags, source: { ...source, pending_update_of: before.id }, hash, vec, now, actor, input, reason: 'lower-trust update of a keyed memory' }, red.redactions);
        }
        applyUpdate(db, before, { title, body, tags: union(before.tags, tags), importance: Math.max(importance, before.importance), hash, vec, now, flags });
        logOp(db, 'update', before.id, before, getMemory(db, before.id), actor, input.reason || 'same key', input.batch);
        return { id: before.id, status: 'updated' as WriteStatus, message: `Updated ${before.id} (same key).`, redactions: red.redactions };
      }
    }

    const supersedes = (input.supersedes || []).filter(Boolean);
    if (!supersedes.length && input.dedupe !== false) {
      const near = findNearDuplicate(db, kind, scope, title, body, vec);
      if (near) {
        const before = near.m;
        if (normalize(before.body).includes(normalize(body))) {
          return { id: before.id, status: 'duplicate' as WriteStatus, message: `Already covered by ${before.id}.`, redactions: red.redactions };
        }
        if (TRUST_RANK[trust] < TRUST_RANK[before.trust] && before.trust === 'user') {
          return stagePending(db, { kind, scope, title, body, tags, importance, trust, sensitive, flags, source: { ...source, pending_update_of: before.id }, hash, vec, now, actor, input, reason: 'would change a user-stated memory' }, red.redactions);
        }
        applyUpdate(db, before, {
          title,
          body,
          tags: union(before.tags, tags),
          importance: Math.max(importance, before.importance),
          hash,
          vec,
          now,
          flags: union(before.flags, flags),
          trust: TRUST_RANK[trust] > TRUST_RANK[before.trust] ? trust : before.trust,
        });
        logOp(db, 'merge', before.id, before, getMemory(db, before.id), actor, input.reason || `near duplicate (${near.sim.toFixed(2)})`, input.batch);
        return { id: before.id, status: 'merged' as WriteStatus, message: `Merged into existing ${before.id} (near duplicate); newer wording kept.`, redactions: red.redactions };
      }
    }

    const targets = getMemories(db, supersedes).filter((m) => m.status === 'active' || m.status === 'pending');
    const protectedTargets = targets.filter((m) => m.trust === 'user' && TRUST_RANK[trust] < TRUST_RANK.agent);
    if (protectedTargets.length || quarantined) {
      return stagePending(
        db,
        { kind, scope, title, body, tags, importance, trust, sensitive, flags: quarantined ? union(flags, ['quarantined']) : flags, source: { ...source, pending_supersedes: targets.map((t) => t.id) }, hash, vec, now, actor, input, reason: quarantined ? 'quarantined for review' : 'would supersede a user-stated memory' },
        red.redactions,
      );
    }

    const id = insertMemory(db, { kind, scope, title, body, tags, importance, trust, sensitive, flags, source, hash, vec, now, status: 'active', key: input.key ?? null, pinned: !!input.pinned, validFrom: input.validFrom ?? now });
    logOp(db, 'create', id, null, getMemory(db, id), actor, input.reason, input.batch);
    const superseded: string[] = [];
    for (const t of targets) {
      supersede(db, t, id, now, actor, input.batch);
      superseded.push(t.id);
    }
    const msg = superseded.length ? `Saved ${id}; superseded ${superseded.join(', ')}.` : `Saved ${id}.`;
    return { id, status: 'created' as WriteStatus, message: msg, superseded, flags, redactions: red.redactions };
  });
}

function union(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b]));
}

interface InsertArgs {
  kind: Kind;
  scope: string;
  title: string;
  body: string;
  tags: string[];
  importance: number;
  trust: Trust;
  sensitive: boolean;
  flags: string[];
  source: Source;
  hash: string;
  vec: Float32Array | null;
  now: string;
  status: Status;
  key: string | null;
  pinned: boolean;
  validFrom: string | null;
}

function insertMemory(db: DB, a: InsertArgs): string {
  let id = newId('m');
  while (db.prepare('select 1 from memories where id = ?').get(id)) id = newId('m');
  db.prepare(
    `insert into memories (id, kind, scope, title, body, tags, importance, trust, sensitive, pinned, status, flags, key, valid_from, source, created_at, updated_at, hash, embedding, embed_model)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    a.kind,
    a.scope,
    a.title,
    a.body,
    JSON.stringify(a.tags),
    a.importance,
    a.trust,
    a.sensitive ? 1 : 0,
    a.pinned ? 1 : 0,
    a.status,
    JSON.stringify(a.flags),
    a.key,
    a.validFrom,
    JSON.stringify(a.source),
    a.now,
    a.now,
    a.hash,
    a.vec ? toBlob(a.vec) : null,
    a.vec ? embedModelName() : null,
  );
  return id;
}

interface PendingArgs {
  kind: Kind;
  scope: string;
  title: string;
  body: string;
  tags: string[];
  importance: number;
  trust: Trust;
  sensitive: boolean;
  flags: string[];
  source: Source;
  hash: string;
  vec: Float32Array | null;
  now: string;
  actor: string;
  input: WriteInput;
  reason: string;
}

function stagePending(db: DB, p: PendingArgs, redactions: string[]): WriteResult {
  const id = insertMemory(db, { ...p, status: 'pending', key: p.input.key ?? null, pinned: false, validFrom: p.input.validFrom ?? p.now });
  logOp(db, 'stage', id, null, getMemory(db, id), p.actor, p.reason, p.input.batch);
  return { id, status: 'pending', message: `Staged ${id} for review (${p.reason}). It will not be used until approved with \`engram inbox approve ${id}\`.`, flags: p.flags, redactions };
}

function applyUpdate(
  db: DB,
  before: Memory,
  u: { title: string; body: string; tags: string[]; importance: number; hash: string; vec: Float32Array | null; now: string; flags: string[]; trust?: Trust },
): void {
  db.prepare(
    `update memories set title = ?, body = ?, tags = ?, importance = ?, hash = ?, embedding = ?, embed_model = ?, updated_at = ?, version = version + 1, flags = ?, trust = ? where id = ?`,
  ).run(
    u.title,
    u.body,
    JSON.stringify(u.tags),
    u.importance,
    u.hash,
    u.vec ? toBlob(u.vec) : null,
    u.vec ? embedModelName() : null,
    u.now,
    JSON.stringify(u.flags),
    u.trust ?? before.trust,
    before.id,
  );
}

function supersede(db: DB, old: Memory, byId: string, now: string, actor: string, batch?: string): void {
  db.prepare("update memories set status = 'superseded', valid_to = ?, superseded_by = ?, updated_at = ? where id = ?").run(now, byId, now, old.id);
  logOp(db, 'supersede', old.id, old, getMemory(db, old.id), actor, `superseded by ${byId}`, batch);
}

export interface UpdatePatch {
  title?: string;
  body?: string;
  kind?: string;
  scope?: string;
  tags?: string[];
  importance?: number;
  pinned?: boolean;
  sensitive?: boolean;
  status?: 'outdated' | 'active' | 'archived';
  validTo?: string;
  expectedVersion?: number;
}

export async function updateMemory(db: DB, id: string, patch: UpdatePatch, actor = 'agent', reason?: string, cwd?: string | null): Promise<{ ok: boolean; message: string; version?: number }> {
  const before = getMemory(db, id);
  if (!before) return { ok: false, message: `No memory with id ${id}. Use memory_search to find the right id.` };
  if (patch.expectedVersion && patch.expectedVersion !== before.version) {
    return { ok: false, message: `Version conflict on ${id}: expected ${patch.expectedVersion}, current ${before.version}. Re-read it with memory_get.` };
  }
  const cfg = loadConfig();
  const body = patch.body !== undefined ? redactSecrets(patch.body.trim()).text : before.body;
  const title = patch.title !== undefined ? clip(redactSecrets(patch.title.trim()).text, 120) : patch.body !== undefined && before.title === deriveTitle(before.body) ? deriveTitle(body) : before.title;
  const kind = patch.kind ? normalizeKind(patch.kind, body) : before.kind;
  const cap = kind === 'procedure' ? cfg.bodyMaxChars * 4 : kind === 'episode' ? cfg.bodyMaxChars * 2 : cfg.bodyMaxChars;
  if (body.length > cap) return { ok: false, message: `Too long (${body.length} chars, limit ${cap}).` };
  const scope = patch.scope ? normalizeScope(patch.scope, cwd) : before.scope;
  let vec = before.embedding;
  let model = before.embed_model;
  if (body !== before.body || title !== before.title) {
    try {
      vec = await embedOne(`${title}\n${body}`);
      model = vec ? embedModelName() : null;
    } catch {
      vec = null;
      model = null;
    }
  }
  const now = nowIso();
  let status: Status = before.status;
  let validTo = patch.validTo ?? before.valid_to;
  if (patch.status === 'outdated') {
    status = 'superseded';
    validTo = validTo || now;
  } else if (patch.status === 'archived') status = 'archived';
  else if (patch.status === 'active') {
    status = 'active';
    validTo = patch.validTo ?? null;
  }
  const flags = scanInjection(title + '\n' + body).length && actor !== 'user' ? union(before.flags, ['injection:edit']) : before.flags;
  tx(db, () => {
    db.prepare(
      `update memories set title = ?, body = ?, kind = ?, scope = ?, tags = ?, importance = ?, pinned = ?, sensitive = ?, status = ?, valid_to = ?, hash = ?, embedding = ?, embed_model = ?, flags = ?, updated_at = ?, version = version + 1 where id = ?`,
    ).run(
      title,
      body,
      kind,
      scope,
      JSON.stringify(patch.tags ?? before.tags),
      Math.max(1, Math.min(10, Math.round(patch.importance ?? before.importance))),
      (patch.pinned ?? before.pinned) ? 1 : 0,
      (patch.sensitive ?? before.sensitive) ? 1 : 0,
      status,
      validTo,
      memoryHash(kind, scope, body),
      vec ? toBlob(vec) : null,
      model,
      JSON.stringify(flags),
      now,
      id,
    );
    logOp(db, 'update', id, before, getMemory(db, id), actor, reason);
  });
  const after = getMemory(db, id)!;
  return { ok: true, message: `Updated ${id} (version ${after.version}).`, version: after.version };
}

export function forgetMemories(db: DB, ids: string[], reason: string, actor = 'agent'): { forgotten: string[]; missing: string[] } {
  const forgotten: string[] = [];
  const missing: string[] = [];
  const batch = newId('b');
  tx(db, () => {
    for (const id of ids) {
      const before = getMemory(db, id);
      if (!before || before.status === 'deleted') {
        missing.push(id);
        continue;
      }
      db.prepare("update memories set status = 'deleted', updated_at = ?, valid_to = coalesce(valid_to, ?) where id = ?").run(nowIso(), nowIso(), id);
      logOp(db, 'forget', id, before, getMemory(db, id), actor, reason, batch);
      forgotten.push(id);
    }
  });
  return { forgotten, missing };
}

export function purgeMemory(db: DB, id: string, actor = 'user'): boolean {
  const before = getMemory(db, id);
  if (!before) return false;
  tx(db, () => {
    db.prepare('delete from memories where id = ?').run(id);
    db.prepare("update ops set before = null, after = null where memory_id = ?").run(id);
    logOp(db, 'purge', id, null, null, actor, 'permanently erased');
  });
  return true;
}

export function restoreMemory(db: DB, id: string, actor = 'user'): boolean {
  const before = getMemory(db, id);
  if (!before) return false;
  db.prepare("update memories set status = 'active', valid_to = null, superseded_by = null, updated_at = ? where id = ?").run(nowIso(), id);
  logOp(db, 'restore', id, before, getMemory(db, id), actor);
  return true;
}

export function approvePending(db: DB, id: string, actor = 'user'): { ok: boolean; message: string } {
  const m = getMemory(db, id);
  if (!m || m.status !== 'pending') return { ok: false, message: `${id} is not pending.` };
  const now = nowIso();
  return tx(db, () => {
    const flags = m.flags.filter((f) => f !== 'quarantined');
    if (m.source.pending_update_of) {
      const target = getMemory(db, m.source.pending_update_of);
      if (target && target.status === 'active') {
        applyUpdate(db, target, { title: m.title, body: m.body, tags: union(target.tags, m.tags), importance: Math.max(target.importance, m.importance), hash: m.hash, vec: m.embedding, now, flags: target.flags });
        logOp(db, 'update', target.id, target, getMemory(db, target.id), actor, `approved ${id}`);
        db.prepare("update memories set status = 'deleted', updated_at = ? where id = ?").run(now, id);
        logOp(db, 'approve', id, m, getMemory(db, id), actor, `applied to ${target.id}`);
        return { ok: true, message: `Applied ${id} to ${target.id}.` };
      }
    }
    const { pending_supersedes, pending_update_of, ...source } = m.source;
    db.prepare("update memories set status = 'active', flags = ?, source = ?, updated_at = ? where id = ?").run(JSON.stringify(flags), JSON.stringify(source), now, id);
    logOp(db, 'approve', id, m, getMemory(db, id), actor);
    for (const sid of pending_supersedes || []) {
      const t = getMemory(db, sid);
      if (t && t.status === 'active') supersede(db, t, id, now, actor);
    }
    return { ok: true, message: `Approved ${id}.` };
  });
}

export function rejectPending(db: DB, id: string, actor = 'user'): { ok: boolean; message: string } {
  const m = getMemory(db, id);
  if (!m || m.status !== 'pending') return { ok: false, message: `${id} is not pending.` };
  db.prepare("update memories set status = 'deleted', updated_at = ? where id = ?").run(nowIso(), id);
  logOp(db, 'reject', id, m, getMemory(db, id), actor);
  return { ok: true, message: `Rejected ${id}.` };
}

export interface OpRow {
  id: number;
  ts: string;
  op: string;
  memory_id: string | null;
  actor: string | null;
  reason: string | null;
  before: string | null;
  after: string | null;
  batch: string | null;
  undone: number;
}

export function history(db: DB, id: string): OpRow[] {
  return db.prepare('select * from ops where memory_id = ? order by id').all(id) as unknown as OpRow[];
}

export function recentOps(db: DB, limit = 30): OpRow[] {
  return db.prepare('select * from ops order by id desc limit ?').all(limit) as unknown as OpRow[];
}

export function undoOp(db: DB, opId: number, actor = 'user'): { ok: boolean; message: string } {
  const op = db.prepare('select * from ops where id = ?').get(opId) as unknown as OpRow | undefined;
  if (!op) return { ok: false, message: `No op ${opId}.` };
  if (op.undone) return { ok: false, message: `Op ${opId} was already undone.` };
  const ops = op.batch ? (db.prepare('select * from ops where batch = ? and undone = 0 order by id desc').all(op.batch) as unknown as OpRow[]) : [op];
  return tx(db, () => {
    for (const o of ops) {
      if (!o.memory_id) continue;
      const current = getMemory(db, o.memory_id);
      if (!current) continue;
      if (!o.before) {
        db.prepare("update memories set status = 'deleted', updated_at = ? where id = ?").run(nowIso(), o.memory_id);
      } else {
        const b = JSON.parse(o.before) as Memory;
        db.prepare(
          `update memories set kind = ?, scope = ?, title = ?, body = ?, tags = ?, importance = ?, trust = ?, sensitive = ?, pinned = ?, status = ?, flags = ?, valid_to = ?, superseded_by = ?, hash = ?, updated_at = ?, version = version + 1, embedding = case when body = ? then embedding else null end where id = ?`,
        ).run(b.kind, b.scope, b.title, b.body, JSON.stringify(b.tags), b.importance, b.trust, b.sensitive ? 1 : 0, b.pinned ? 1 : 0, b.status, JSON.stringify(b.flags), b.valid_to, b.superseded_by, b.hash, nowIso(), b.body, o.memory_id);
      }
      db.prepare('update ops set undone = 1 where id = ?').run(o.id);
      logOp(db, 'undo', o.memory_id, current, getMemory(db, o.memory_id), actor, `undo op ${o.id}`);
    }
    return { ok: true, message: `Undid ${ops.length} op(s).` };
  });
}

export interface ListFilter {
  kinds?: string[];
  scope?: string;
  status?: Status[];
  trust?: Trust[];
  tag?: string;
  limit?: number;
  offset?: number;
  order?: 'updated' | 'created' | 'importance';
}

export function listMemories(db: DB, f: ListFilter = {}): Memory[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const status = f.status?.length ? f.status : ['active'];
  where.push(`status in (${status.map(() => '?').join(',')})`);
  args.push(...status);
  if (f.kinds?.length) {
    where.push(`kind in (${f.kinds.map(() => '?').join(',')})`);
    args.push(...f.kinds);
  }
  if (f.trust?.length) {
    where.push(`trust in (${f.trust.map(() => '?').join(',')})`);
    args.push(...f.trust);
  }
  if (f.scope) {
    where.push('scope = ?');
    args.push(f.scope);
  }
  if (f.tag) {
    where.push('exists (select 1 from json_each(memories.tags) where value = ?)');
    args.push(f.tag.toLowerCase());
  }
  const order = f.order === 'created' ? 'created_at desc' : f.order === 'importance' ? 'importance desc, updated_at desc' : 'updated_at desc';
  args.push(f.limit ?? 50, f.offset ?? 0);
  const rows = db.prepare(`select * from memories where ${where.join(' and ')} order by ${order} limit ? offset ?`).all(...args) as Row[];
  return rows.map(rowToMemory);
}

export function recordAccess(db: DB, ids: string[]): void {
  if (!ids.length) return;
  const now = nowIso();
  const st = db.prepare('update memories set access_count = access_count + 1, last_accessed = ? where id = ?');
  try {
    tx(db, () => {
      for (const id of ids) st.run(now, id);
    });
  } catch {}
}

export function recordInjection(db: DB, sessionKey: string | null, ids: string[], via: string): void {
  if (!ids.length) return;
  const now = nowIso();
  try {
    tx(db, () => {
      const st = db.prepare('update memories set injected_count = injected_count + 1, last_injected = ? where id = ?');
      const ins = db.prepare("insert into injections(session_key, memory_id, ts, via) values (?,?,?,?) on conflict(session_key, memory_id) do update set via = case when excluded.via = 'digest-partial' then injections.via else excluded.via end, ts = excluded.ts");
      for (const id of ids) {
        st.run(now, id);
        if (sessionKey) ins.run(sessionKey, id, now, via);
      }
    });
  } catch {}
}

export function injectedIn(db: DB, sessionKey: string | null): Set<string> {
  if (!sessionKey) return new Set();
  const rows = db.prepare("select memory_id from injections where session_key = ? and via != 'digest-partial'").all(sessionKey) as { memory_id: string }[];
  return new Set(rows.map((r) => r.memory_id));
}

export function stats(db: DB) {
  const byStatus = db.prepare('select status, count(*) n from memories group by status').all() as { status: string; n: number }[];
  const byKind = db.prepare("select kind, count(*) n from memories where status = 'active' group by kind").all() as { kind: string; n: number }[];
  const byScope = db.prepare("select scope, count(*) n from memories where status = 'active' group by scope order by n desc limit 15").all() as { scope: string; n: number }[];
  const unembedded = (db.prepare("select count(*) n from memories where status in ('active','pending') and (embedding is null or embed_model != ?)").get(embedModelName()) as { n: number }).n;
  const sessions = (db.prepare('select count(*) n from sessions').get() as { n: number }).n;
  const turns = (db.prepare('select count(*) n from turns').get() as { n: number }).n;
  const ops = (db.prepare('select count(*) n from ops').get() as { n: number }).n;
  const jobs = db.prepare('select status, count(*) n from jobs group by status').all() as { status: string; n: number }[];
  return { byStatus, byKind, byScope, unembedded, sessions, turns, ops, jobs };
}

export async function backfillEmbeddings(db: DB, limit = 256, mode: EmbedMode = 'local'): Promise<number> {
  const { embed } = await import('./embed.ts');
  const rows = db
    .prepare("select id, title, body from memories where status in ('active','pending','superseded','archived') and (embedding is null or embed_model is null or embed_model != ?) limit ?")
    .all(embedModelName(), limit) as { id: string; title: string; body: string }[];
  if (!rows.length) return 0;
  const vecs = await embed(rows.map((r) => `${r.title}\n${r.body}`), mode);
  if (!vecs) return 0;
  const st = db.prepare('update memories set embedding = ?, embed_model = ? where id = ?');
  tx(db, () => {
    rows.forEach((r, i) => st.run(toBlob(vecs[i]), embedModelName(), r.id));
  });
  return rows.length;
}
