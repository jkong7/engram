import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { DB } from './db.ts';
import { tx, getMeta, setMeta } from './db.ts';
import { loadConfig, paths } from './config.ts';
import { rowToMemory, logOp, getMemory, writeMemory, listMemories, type Memory, type Kind, type Trust } from './store.ts';
import { resolveProvider, parseJsonLoose, underRateLimit, noteCall, type Provider } from './llm.ts';
import { embedModelName } from './embed.ts';
import { scopeLabel, scopeForCwd } from './scope.ts';
import { cosine, nowIso, daysBetween, newId, clip, contentTerms } from './util.ts';

export interface DecayResult {
  archived: string[];
}

export function decay(db: DB, opts: { dryRun?: boolean } = {}): DecayResult {
  const cfg = loadConfig();
  const rows = db.prepare("select * from memories where status = 'active' and pinned = 0").all() as Record<string, unknown>[];
  const archived: string[] = [];
  const now = nowIso();
  for (const r of rows) {
    const m = rowToMemory(r);
    const last = [m.last_accessed, m.last_injected, m.updated_at].filter(Boolean).sort().pop()!;
    const idle = daysBetween(last);
    let stale = false;
    if (m.kind === 'episode') stale = idle > Math.max(180, cfg.decay.unusedDays) && m.access_count === 0;
    else if (m.trust !== 'user' && m.kind !== 'profile' && m.importance <= cfg.decay.maxImportance) stale = idle > cfg.decay.unusedDays;
    else if (m.trust === 'extracted' && m.importance <= 6 && m.access_count === 0 && m.injected_count === 0) stale = idle > cfg.decay.unusedDays * 2;
    if (!stale) continue;
    archived.push(m.id);
    if (!opts.dryRun) {
      db.prepare("update memories set status = 'archived', updated_at = ? where id = ?").run(now, m.id);
      logOp(db, 'archive', m.id, m, getMemory(db, m.id), 'maintenance', `unused for ${Math.round(idle)} days`);
    }
  }
  return { archived };
}

function survivorOrder(a: Memory, b: Memory): number {
  const tr: Record<Trust, number> = { user: 3, agent: 2, extracted: 1, external: 0 };
  return tr[b.trust] - tr[a.trust] || b.importance - a.importance || b.access_count + b.injected_count - (a.access_count + a.injected_count) || b.updated_at.localeCompare(a.updated_at);
}

export function findClusters(db: DB, threshold = 0.86): Memory[][] {
  const rows = db
    .prepare("select * from memories where status = 'active' and kind != 'episode' and embedding is not null and embed_model = ?")
    .all(embedModelName()) as Record<string, unknown>[];
  const ms = rows.map(rowToMemory);
  const parent = ms.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < ms.length; i++) {
    for (let j = i + 1; j < ms.length; j++) {
      if (ms[i].kind !== ms[j].kind || ms[i].scope !== ms[j].scope) continue;
      if (cosine(ms[i].embedding!, ms[j].embedding!) >= threshold) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, Memory[]>();
  ms.forEach((m, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) || []), m]);
  });
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort(survivorOrder));
}

const MERGE_SYSTEM = `You maintain one person's long-term memory. You get a small group of memories that look similar. Decide how to clean them up without losing information.

For the group, return JSON:
{"action":"keep_all"} when they are genuinely different facts,
or {"action":"merge","title":"...","body":"...","ids":["ids merged"]} to combine duplicates into one memory that keeps every distinct detail (dates, names, reasons),
or {"action":"supersede","keep":"id of the current one","outdated":["ids that are now wrong"],"reason":"..."} when a later memory replaced an earlier one.

Write declarative third-person statements, never imperatives. Prefer keep_all when unsure. JSON only.`;

export interface ConsolidateResult {
  autoMerged: number;
  llmMerged: number;
  superseded: number;
  kept: number;
  clusters: number;
  batch: string;
}

function mergeInto(db: DB, survivor: Memory, others: Memory[], body: string, title: string, batch: string, actor: string): void {
  const now = nowIso();
  const tags = Array.from(new Set([survivor, ...others].flatMap((m) => m.tags)));
  const importance = Math.max(survivor.importance, ...others.map((m) => m.importance));
  db.prepare('update memories set body = ?, title = ?, tags = ?, importance = ?, embedding = case when body = ? then embedding else null end, updated_at = ?, version = version + 1 where id = ?').run(
    body,
    title,
    JSON.stringify(tags),
    importance,
    body,
    now,
    survivor.id,
  );
  logOp(db, 'merge', survivor.id, survivor, getMemory(db, survivor.id), actor, `merged ${others.map((o) => o.id).join(', ')}`, batch);
  for (const o of others) {
    db.prepare("update memories set status = 'superseded', superseded_by = ?, valid_to = coalesce(valid_to, ?), updated_at = ? where id = ?").run(survivor.id, now, now, o.id);
    logOp(db, 'supersede', o.id, o, getMemory(db, o.id), actor, `merged into ${survivor.id}`, batch);
  }
}

function shrinkOk(original: Memory[], body: string): boolean {
  const longest = Math.max(...original.map((m) => m.body.length));
  if (body.length < longest * 0.75) return false;
  const want = new Set(original.flatMap((m) => contentTerms(m.body)).filter((t) => /\d/.test(t) || t.length > 5));
  const have = new Set(contentTerms(body));
  let kept = 0;
  for (const t of want) if (have.has(t)) kept++;
  return want.size === 0 || kept / want.size >= 0.7;
}

export async function consolidate(db: DB, opts: { provider?: Provider | null; maxLlmClusters?: number; dryRun?: boolean } = {}): Promise<ConsolidateResult> {
  const batch = newId('b');
  const res: ConsolidateResult = { autoMerged: 0, llmMerged: 0, superseded: 0, kept: 0, clusters: 0, batch };
  const clusters = findClusters(db, 0.86);
  res.clusters = clusters.length;
  if (opts.dryRun) return res;
  const provider = opts.provider !== undefined ? opts.provider : await resolveProvider();
  let llmBudget = opts.maxLlmClusters ?? 12;
  for (const group of clusters) {
    const [survivor, ...rest] = group;
    const tight = rest.filter((m) => cosine(survivor.embedding!, m.embedding!) >= 0.95 && (m.body.length <= survivor.body.length * 1.15 || survivor.body.includes(m.body.slice(0, 40))));
    if (tight.length) {
      tx(db, () => mergeInto(db, survivor, tight, survivor.body, survivor.title, batch, 'maintenance'));
      res.autoMerged += tight.length;
    }
    const loose = rest.filter((m) => !tight.includes(m));
    if (!loose.length) continue;
    if (!provider || llmBudget <= 0 || !underRateLimit(db)) {
      res.kept += loose.length;
      continue;
    }
    llmBudget--;
    const items = [survivor, ...loose];
    const user = items.map((m) => `${m.id} | ${m.kind} | ${scopeLabel(m.scope)} | trust ${m.trust} | updated ${m.updated_at.slice(0, 10)} | ${m.body}`).join('\n');
    let out: Record<string, any> | null = null;
    try {
      noteCall(db);
      out = parseJsonLoose<Record<string, any>>(await provider.complete({ system: MERGE_SYSTEM, user, json: true, maxTokens: 1500 }));
    } catch {
      out = null;
    }
    if (!out || out.action === 'keep_all') {
      res.kept += loose.length;
      continue;
    }
    const byId = new Map(items.map((m) => [m.id, m]));
    if (out.action === 'merge' && typeof out.body === 'string') {
      const ids: string[] = (Array.isArray(out.ids) ? out.ids : items.map((m) => m.id)).filter((id: string) => byId.has(id));
      const merged = ids.map((id) => byId.get(id)!).sort(survivorOrder);
      if (merged.length < 2 || !shrinkOk(merged, out.body) || merged.some((m) => m.trust === 'user' && m !== merged[0])) {
        res.kept += loose.length;
        continue;
      }
      tx(db, () => mergeInto(db, merged[0], merged.slice(1), clip(out!.body, 2000), clip(String(out!.title || merged[0].title), 120), batch, 'consolidator'));
      res.llmMerged += merged.length - 1;
    } else if (out.action === 'supersede' && byId.has(out.keep)) {
      const keep = byId.get(out.keep)!;
      const outdated = (Array.isArray(out.outdated) ? out.outdated : []).map((id: string) => byId.get(id)).filter((m: Memory | undefined): m is Memory => !!m && m.id !== keep.id && m.trust !== 'user');
      const now = nowIso();
      tx(db, () => {
        for (const o of outdated) {
          db.prepare("update memories set status = 'superseded', superseded_by = ?, valid_to = coalesce(valid_to, ?), updated_at = ? where id = ?").run(keep.id, now, now, o.id);
          logOp(db, 'supersede', o.id, o, getMemory(db, o.id), 'consolidator', String(out!.reason || 'outdated'), batch);
        }
      });
      res.superseded += outdated.length;
    } else res.kept += loose.length;
  }
  setMeta(db, 'last_consolidate', nowIso());
  return res;
}

function frontmatter(m: Memory): string {
  const fm: Record<string, unknown> = {
    id: m.id,
    kind: m.kind,
    scope: m.scope,
    title: m.title,
    tags: m.tags,
    importance: m.importance,
    trust: m.trust,
    status: m.status,
    created: m.created_at,
    updated: m.updated_at,
  };
  if (m.pinned) fm.pinned = true;
  if (m.sensitive) fm.sensitive = true;
  if (m.valid_to) fm.valid_to = m.valid_to;
  if (m.superseded_by) fm.superseded_by = m.superseded_by;
  if (m.source.harness) fm.source = `${m.source.harness}${m.source.session ? ' ' + m.source.session : ''}`;
  return '---\n' + Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') + '\n---\n';
}

export function writeMirror(db: DB, opts: { commit?: boolean } = {}): { files: number; dir: string } {
  const cfg = loadConfig();
  const dir = paths().mirror;
  mkdirSync(dir, { recursive: true });
  const ms = listMemories(db, { status: ['active', 'pending'], limit: 100000, order: 'importance' });
  const keep = new Set<string>();
  for (const m of ms) {
    const sub = join(dir, m.status === 'pending' ? 'pending' : m.kind);
    mkdirSync(sub, { recursive: true });
    const file = join(sub, `${m.id}.md`);
    keep.add(file);
    const content = `${frontmatter(m)}\n# ${m.title}\n\n${m.body}\n`;
    if (!existsSync(file) || readFileSync(file, 'utf8') !== content) writeFileSync(file, content);
  }
  for (const sub of readdirSync(dir, { withFileTypes: true })) {
    if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
    for (const f of readdirSync(join(dir, sub.name))) {
      const p = join(dir, sub.name, f);
      if (f.endsWith('.md') && !keep.has(p)) unlinkSync(p);
    }
  }
  const groups = new Map<string, Memory[]>();
  for (const m of ms.filter((x) => x.status === 'active')) groups.set(m.kind, [...(groups.get(m.kind) || []), m]);
  let index = `# engram memory\n\nGenerated ${nowIso()} from ${cfg.dbPath}. Read-only mirror; edit with the engram CLI or web UI.\n`;
  for (const [kind, list] of groups) {
    index += `\n## ${kind} (${list.length})\n`;
    for (const m of list) index += `- [${m.title}](${kind}/${m.id}.md) ${m.scope !== 'global' ? '`' + scopeLabel(m.scope) + '`' : ''}\n`;
  }
  writeFileSync(join(dir, 'MEMORY.md'), index);
  if ((opts.commit ?? cfg.mirror.git) && spawnSync('git', ['--version']).status === 0) {
    if (!existsSync(join(dir, '.git'))) spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['-c', 'user.name=engram', '-c', 'user.email=engram@localhost', 'commit', '-qm', `snapshot ${nowIso()}`], { cwd: dir });
  }
  return { files: ms.length, dir };
}

export function backup(db: DB): string {
  const cfg = loadConfig();
  const dir = paths().backups;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `engram-${nowIso().replace(/[:.]/g, '-')}.db`);
  db.exec(`vacuum into '${file.replace(/'/g, "''")}'`);
  const all = readdirSync(dir)
    .filter((f) => f.startsWith('engram-') && f.endsWith('.db'))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const old of all.slice(cfg.backups.keep)) rmSync(old, { force: true });
  setMeta(db, 'last_backup', nowIso());
  return file;
}

function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  const fm: Record<string, string> = {};
  let current: string | null = null;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      current = kv[1];
      fm[current] = kv[2].replace(/^["']|["']$/g, '');
    } else if (current && /^\s+/.test(line)) {
      const sub = line.trim().match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (sub) fm[`${current}.${sub[1]}`] = sub[2].replace(/^["']|["']$/g, '');
    }
  }
  return { fm, body: m[2].trim() };
}

export async function importClaudeMemoryDir(db: DB, dir: string): Promise<{ imported: number; skipped: number }> {
  const typeMap: Record<string, Kind> = { user: 'profile', feedback: 'preference', project: 'fact', reference: 'reference' };
  let imported = 0;
  let skipped = 0;
  const batch = newId('b');
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
    const { fm, body } = parseFrontmatter(readFileSync(join(dir, f), 'utf8'));
    if (!body) {
      skipped++;
      continue;
    }
    const type = fm['metadata.type'] || fm.type || 'project';
    const kind = typeMap[type] || 'fact';
    const name = fm.name || basename(f, '.md');
    const tomb = db.prepare("select 1 from memories where key = ? and status = 'deleted' and not exists (select 1 from memories m2 where m2.key = memories.key and m2.status = 'active') limit 1").get(`claude-memory:${name}`);
    if (tomb) {
      skipped++;
      continue;
    }
    const text = body.length > 7800 ? clip(body, 7800) : body;
    const r = await writeMemory(db, {
      body: text,
      title: clip(fm.description || name, 120),
      kind,
      maxChars: 8000,
      scope: 'global',
      trust: 'agent',
      key: `claude-memory:${name}`,
      tags: ['claude-memory', name],
      source: { harness: 'claude-code', uri: join(dir, f) },
      actor: 'import',
      batch,
      importance: kind === 'preference' ? 8 : kind === 'profile' ? 8 : 6,
    });
    if (r.status === 'created' || r.status === 'updated' || r.status === 'merged') imported++;
    else skipped++;
  }
  return { imported, skipped };
}

export function exportAll(db: DB, opts: { includeDeleted?: boolean } = {}) {
  const status = opts.includeDeleted ? "('active','pending','superseded','archived','deleted')" : "('active','pending','superseded','archived')";
  const memories = (db.prepare(`select * from memories where status in ${status}`).all() as Record<string, unknown>[]).map(rowToMemory).map(({ embedding, ...m }) => m);
  const sessions = db.prepare('select * from sessions').all();
  return { version: 1, exported_at: nowIso(), memories, sessions };
}

export async function importAll(db: DB, data: { memories: Record<string, any>[] }): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;
  for (const m of data.memories || []) {
    if (getMemory(db, m.id)) {
      skipped++;
      continue;
    }
    const r = await writeMemory(db, { body: m.body, title: m.title, kind: m.kind, scope: m.scope, tags: m.tags, importance: m.importance, trust: m.trust, sensitive: m.sensitive, pinned: m.pinned, source: m.source, key: m.key ?? undefined, validFrom: m.valid_from ?? undefined, actor: 'import' });
    if (r.status === 'created') imported++;
    else skipped++;
  }
  return { imported, skipped };
}

export function maintenanceDue(db: DB, key: string, everyMs: number): boolean {
  const last = getMeta(db, key);
  return !last || Date.now() - Date.parse(last) >= everyMs;
}

export function knownRepos(): Map<string, string> {
  const out = new Map<string, string>();
  const roots = new Set<string>();
  for (const r of [join(homedir(), 'dev'), join(homedir(), 'projects'), join(homedir(), 'code'), join(homedir(), 'src')]) if (existsSync(r)) roots.add(r);
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const dir = join(root, name);
      if (existsSync(join(dir, '.git'))) out.set(name.toLowerCase(), scopeForCwd(dir));
    }
  }
  return out;
}

export function inferScope(text: string, repos: Map<string, string>): string {
  const found = new Set<string>();
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/~\/(?:dev|projects|code|src)\/([a-z0-9._-]+)/g)) {
    const s = repos.get(m[1]);
    if (s) found.add(s);
  }
  if (!found.size) {
    for (const [name, s] of repos) {
      if (name.length < 4) continue;
      if (new RegExp(`(^|[^a-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_-]|$)`).test(lower)) found.add(s);
    }
  }
  return found.size === 1 ? [...found][0] : 'global';
}

export function rescope(db: DB, opts: { dryRun?: boolean } = {}): { moved: { id: string; from: string; to: string }[] } {
  const repos = knownRepos();
  const moved: { id: string; from: string; to: string }[] = [];
  const rows = db.prepare("select * from memories where scope != 'global' and status in ('active','pending','archived')").all() as Record<string, unknown>[];
  for (const r of rows) {
    const m = rowToMemory(r);
    const path = m.scope.slice(8);
    const abs = path.startsWith('~') ? join(homedir(), path.slice(1)) : path;
    if (scopeForCwd(abs) === m.scope) continue;
    const to = inferScope(`${m.title}\n${m.body}`, repos);
    if (to === m.scope) continue;
    moved.push({ id: m.id, from: m.scope, to });
    if (!opts.dryRun) {
      db.prepare('update memories set scope = ?, updated_at = updated_at where id = ?').run(to, m.id);
      logOp(db, 'rescope', m.id, m, getMemory(db, m.id), 'maintenance', `${m.scope} -> ${to}`);
    }
  }
  if (!opts.dryRun) {
    const sessions = db.prepare('select key, cwd, scope from sessions').all() as { key: string; cwd: string | null; scope: string }[];
    for (const s of sessions) {
      const next = scopeForCwd(s.cwd);
      if (next !== s.scope) db.prepare('update sessions set scope = ? where key = ?').run(next, s.key);
    }
  }
  return { moved };
}
