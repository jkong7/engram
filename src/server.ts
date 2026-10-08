import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { timingSafeEqual } from 'node:crypto';
import type { DB } from './db.ts';
import { openDb } from './db.ts';
import { loadConfig, authToken, paths } from './config.ts';
import { createMcpServer } from './mcp.ts';
import { handleHook } from './hooks.ts';
import { buildDigest } from './digest.ts';
import { searchMemories, searchConversations } from './search.ts';
import { writeMemory, updateMemory, forgetMemories, getMemory, listMemories, publicMemory, approvePending, rejectPending, recentOps, undoOp, stats, backfillEmbeddings, restoreMemory, history, recordAccess } from './store.ts';
import { embedLocal, setEmbedMode, getEmbedder, embedModelName, localEmbedderLoaded } from './embed.ts';
import { scopeForCwd, normalizeScope } from './scope.ts';
import { touchSession, addTurns, endSession, scanTranscripts } from './capture.ts';
import { enqueue, claim, complete, fail, defer, pruneJobs } from './jobs.ts';
import { extractSession } from './extract.ts';
import { consolidate, decay, writeMirror, backup, maintenanceDue } from './maintain.ts';
import { resolveProvider } from './llm.ts';
import { getMeta, setMeta } from './db.ts';
import { nowIso } from './util.ts';
import { uiHtml } from './ui.ts';

const startedAt = Date.now();

export function log(...args: unknown[]): void {
  const line = `${nowIso()} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
  try {
    mkdirSync(paths().logs, { recursive: true });
    appendFileSync(join(paths().logs, 'daemon.log'), line);
  } catch {}
  if (process.env.ENGRAM_FOREGROUND) process.stderr.write(line);
}

function tokenOk(provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(authToken());
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieToken(req: IncomingMessage): string | undefined {
  const c = req.headers.cookie || '';
  const m = c.match(/(?:^|;\s*)engram_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : undefined;
}

function hostOk(req: IncomingMessage): boolean {
  const cfg = loadConfig();
  const host = (req.headers.host || '').toLowerCase();
  const allowed = [`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`, `[::1]:${cfg.port}`, ...(process.env.ENGRAM_ALLOWED_HOSTS || '').split(',').filter(Boolean)];
  if (!allowed.includes(host)) return false;
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin) && !(process.env.ENGRAM_ALLOWED_ORIGINS || '').split(',').includes(origin)) return false;
  return true;
}

async function readBody(req: IncomingMessage, limit = 8 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, data: unknown, type = 'application/json'): void {
  const body = type === 'application/json' ? JSON.stringify(data) : String(data);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

async function toWebRequest(req: IncomingMessage, body: Buffer): Promise<Request> {
  const cfg = loadConfig();
  const url = `http://${req.headers.host || `127.0.0.1:${cfg.port}`}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  return new Request(url, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : new Uint8Array(body) });
}

async function pipeWebResponse(res: ServerResponse, r: Response): Promise<void> {
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(r.status, headers);
  if (!r.body) return void res.end();
  const reader = r.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    res.end();
  }
}

export interface DaemonOptions {
  db?: DB;
  port?: number;
  jobs?: boolean;
  quiet?: boolean;
}

export function createHttpHandler(db: DB) {
  const mcp = createMcpHandler(() => createMcpServer({ db, harness: 'http' }), { legacy: 'stateless' });
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!hostOk(req)) return send(res, 403, { error: 'forbidden host or origin' });
      const url = new URL(req.url || '/', 'http://localhost');
      const path = url.pathname;
      if (path === '/healthz') {
        return send(res, 200, { ok: true, version: '0.1.0', uptime_s: Math.round((Date.now() - startedAt) / 1000), embed_model: embedModelName(), embedder_loaded: localEmbedderLoaded(), pid: process.pid });
      }
      const qToken = url.searchParams.get('token') || undefined;
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || undefined;
      const authed = tokenOk(bearer) || tokenOk(cookieToken(req)) || tokenOk(qToken);
      if (path === '/' && req.method === 'GET') {
        if (!authed) return send(res, 401, '<p>Open with <code>engram ui</code> (it adds the token).</p>', 'text/html');
        const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
        if (qToken && tokenOk(qToken)) headers['set-cookie'] = `engram_token=${encodeURIComponent(qToken)}; HttpOnly; SameSite=Strict; Path=/`;
        res.writeHead(200, headers);
        return void res.end(uiHtml());
      }
      if (!authed) return send(res, 401, { error: 'missing or bad bearer token (see ~/.engram/token)' });
      const body = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
      if (path === '/mcp') return pipeWebResponse(res, await mcp.fetch(await toWebRequest(req, body)));
      const json = () => (body.length ? JSON.parse(body.toString('utf8')) : {});
      const hook = path.match(/^\/v1\/hooks\/([^/]+)\/([^/]+)$/);
      if (hook && req.method === 'POST') {
        const r = await handleHook(db, decodeURIComponent(hook[1]), decodeURIComponent(hook[2]), json(), { embedMode: 'local' });
        log('hook', hook[1], hook[2], r.note);
        return send(res, 200, r.output ?? {});
      }
      if (path === '/v1/context' && req.method === 'GET') {
        const cwd = url.searchParams.get('cwd');
        const sid = url.searchParams.get('session_id');
        const harness = url.searchParams.get('harness') || 'api';
        const key = sid ? touchSession(db, { harness, sessionId: sid, cwd }) : null;
        const d = buildDigest(db, { scope: scopeForCwd(cwd), budget: Number(url.searchParams.get('budget')) || undefined, sessionKey: key, harness });
        if (url.searchParams.get('format') === 'json') return send(res, 200, d);
        return send(res, 200, d.text, 'text/markdown; charset=utf-8');
      }
      if (path === '/v1/recall' && req.method === 'POST') {
        const b = json();
        const { buildRecall } = await import('./digest.ts');
        const key = b.session_id ? touchSession(db, { harness: b.harness || 'api', sessionId: b.session_id, cwd: b.cwd }) : null;
        const r = await buildRecall(db, String(b.prompt || ''), { scope: scopeForCwd(b.cwd), sessionKey: key, embedMode: 'local' });
        return send(res, 200, { context: r.text, ids: r.ids, gate: r.gate });
      }
      if (path === '/v1/search' && req.method === 'POST') {
        const b = json();
        const scope = b.scope ? normalizeScope(b.scope, b.cwd) : scopeForCwd(b.cwd);
        const out: Record<string, unknown> = {};
        if (b.source !== 'conversations') {
          const hits = await searchMemories(db, { query: String(b.query || ''), scope, kinds: b.kinds, limit: b.limit, asOf: b.as_of, includeSensitive: true, embedMode: 'local' });
          recordAccess(db, hits.map((h) => h.memory.id));
          out.memories = hits.map((h) => ({ ...publicMemory(h.memory), score: h.score, cos: h.cos, why: h.why }));
        }
        if (b.source === 'conversations' || b.source === 'all') out.conversations = searchConversations(db, String(b.query || ''), { limit: b.limit, scope });
        return send(res, 200, out);
      }
      if (path === '/v1/memories' && req.method === 'POST') {
        const b = json();
        const r = await writeMemory(db, { body: b.text ?? b.body, kind: b.kind, title: b.title, scope: b.scope, cwd: b.cwd, tags: b.tags, importance: b.importance, supersedes: b.supersedes, sensitive: b.sensitive, pinned: b.pinned, trust: b.trust === 'user' ? 'user' : b.trust === 'external' ? 'external' : 'agent', source: { harness: b.harness || 'api', ...(b.source || {}) }, key: b.key, embedMode: 'local' });
        return send(res, r.status === 'rejected' ? 400 : 200, r);
      }
      if (path === '/v1/memories' && req.method === 'GET') {
        const status = url.searchParams.get('status');
        const ms = listMemories(db, {
          kinds: url.searchParams.get('kind')?.split(',').filter(Boolean),
          scope: url.searchParams.get('scope') || undefined,
          status: status ? (status.split(',') as never) : undefined,
          tag: url.searchParams.get('tag') || undefined,
          limit: Number(url.searchParams.get('limit')) || 100,
          offset: Number(url.searchParams.get('offset')) || 0,
          order: (url.searchParams.get('order') as never) || undefined,
        });
        return send(res, 200, { memories: ms.map((m) => publicMemory(m, { full: true })) });
      }
      const mem = path.match(/^\/v1\/memories\/([^/]+)(\/(history|restore))?$/);
      if (mem) {
        const id = decodeURIComponent(mem[1]);
        if (mem[3] === 'history') return send(res, 200, { history: history(db, id) });
        if (mem[3] === 'restore' && req.method === 'POST') return send(res, 200, { ok: restoreMemory(db, id) });
        if (req.method === 'GET') {
          const m = getMemory(db, id);
          return m ? send(res, 200, publicMemory(m, { full: true })) : send(res, 404, { error: 'not found' });
        }
        if (req.method === 'PATCH') {
          const b = json();
          const r = await updateMemory(db, id, { body: b.text ?? b.body, title: b.title, kind: b.kind, scope: b.scope, tags: b.tags, importance: b.importance, pinned: b.pinned, sensitive: b.sensitive, status: b.status }, b.actor || 'user', b.reason);
          return send(res, r.ok ? 200 : 400, r);
        }
        if (req.method === 'DELETE') return send(res, 200, forgetMemories(db, [id], url.searchParams.get('reason') || 'deleted via API', 'user'));
      }
      if (path === '/v1/ingest' && req.method === 'POST') {
        const b = json();
        const harness = String(b.harness || 'api');
        const sid = String(b.session_id || b.sessionId || `${harness}-${nowIso().slice(0, 10)}`);
        const key = touchSession(db, { harness, sessionId: sid, cwd: b.cwd ?? null, title: b.title ?? null });
        const added = addTurns(db, key, harness, (b.turns || b.messages || []).map((t: any) => ({ role: t.role === 'assistant' ? 'assistant' : 'user', text: String(t.text ?? t.content ?? ''), ts: t.ts })));
        if (b.end) endSession(db, key);
        enqueue(db, 'extract', `extract:${key}`, { session: key }, b.end ? 0 : loadConfig().extract.idleMinutes * 60000);
        return send(res, 200, { session: key, added });
      }
      if (path === '/v1/embed' && req.method === 'POST') {
        const b = json();
        const vecs = await embedLocal((b.texts || []).map(String));
        if (!vecs) return send(res, 503, { error: 'embeddings unavailable' });
        return send(res, 200, { model: embedModelName(), vectors: vecs.map((v) => Array.from(v)) });
      }
      if (path === '/v1/stats') return send(res, 200, { ...stats(db), last_consolidate: getMeta(db, 'last_consolidate'), last_backup: getMeta(db, 'last_backup'), last_scan: getMeta(db, 'last_scan') });
      if (path === '/v1/inbox' && req.method === 'GET') return send(res, 200, { pending: listMemories(db, { status: ['pending'], limit: 200 }).map((m) => publicMemory(m, { full: true })) });
      const inbox = path.match(/^\/v1\/inbox\/([^/]+)\/(approve|reject)$/);
      if (inbox && req.method === 'POST') return send(res, 200, inbox[2] === 'approve' ? approvePending(db, inbox[1]) : rejectPending(db, inbox[1]));
      if (path === '/v1/ops') return send(res, 200, { ops: recentOps(db, Number(url.searchParams.get('limit')) || 50).map((o) => ({ ...o, before: undefined, after: undefined })) });
      const undo = path.match(/^\/v1\/undo\/(\d+)$/);
      if (undo && req.method === 'POST') return send(res, 200, undoOp(db, Number(undo[1])));
      if (path === '/v1/sessions') return send(res, 200, { sessions: db.prepare('select key, harness, title, cwd, scope, started_at, last_seen_at, turn_count, extract_state, summary_id from sessions order by last_seen_at desc limit ?').all(Number(url.searchParams.get('limit')) || 50) });
      if (path === '/v1/maintain' && req.method === 'POST') {
        const b = json();
        return send(res, 200, await runMaintenance(db, b.task || 'all'));
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      log('error', req.method, req.url, (err as Error).stack || String(err));
      if (!res.headersSent) send(res, 500, { error: (err as Error).message });
      else res.end();
    }
  };
}

export async function runMaintenance(db: DB, task: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (task === 'all' || task === 'scan') {
    const r = scanTranscripts(db);
    setMeta(db, 'last_scan', nowIso());
    out.scan = { files: r.files, added: r.added };
  }
  if (task === 'all' || task === 'embed') out.embedded = await backfillEmbeddings(db, 512, 'local');
  if (task === 'all' || task === 'consolidate') out.consolidate = await consolidate(db);
  if (task === 'all' || task === 'decay') out.decay = decay(db);
  if (task === 'all' || task === 'mirror') out.mirror = writeMirror(db);
  if (task === 'all' || task === 'backup') out.backup = backup(db);
  return out;
}

async function replaySpool(db: DB): Promise<number> {
  const dir = paths().spool;
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) {
    const p = join(dir, f);
    const working = p + '.replaying';
    try {
      renameSync(p, working);
    } catch {
      continue;
    }
    const lines = readFileSync(working, 'utf8').split('\n').filter(Boolean);
    const failed: string[] = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as { harness: string; event: string; input: Record<string, unknown> };
        await handleHook(db, e.harness, e.event, e.input, { embedMode: 'local' });
        n++;
      } catch {
        failed.push(line);
      }
    }
    if (failed.length) writeFileSync(join(dir, `failed-${Date.now()}.jsonl.bad`), failed.join('\n') + '\n');
    unlinkSync(working);
  }
  return n;
}

function scheduleIdleExtractions(db: DB): number {
  const cfg = loadConfig();
  const cutoff = new Date(Date.now() - cfg.extract.idleMinutes * 60000).toISOString();
  const rows = db
    .prepare(
      `select key from sessions s
       where extract_state != 'skip' and turn_count > extracted_turns and last_seen_at < ?
       and last_seen_at > ?
       and not exists (select 1 from jobs j where j.key = 'extract:' || s.key and j.status in ('queued','running'))
       and (select count(*) from turns t where t.session_key = s.key and t.role = 'user') >= ?
       limit 50`,
    )
    .all(cutoff, new Date(Date.now() - cfg.ingest.maxAgeDays * 86400000).toISOString(), cfg.extract.minTurns) as { key: string }[];
  for (const r of rows) enqueue(db, 'extract', `extract:${r.key}`, { session: r.key }, 0);
  return rows.length;
}

async function runOneJob(db: DB): Promise<boolean> {
  const job = claim(db);
  if (!job) return false;
  try {
    if (job.kind === 'extract') {
      const r = await extractSession(db, String(job.payload.session));
      log('extract', job.payload.session, r.status, r.reason || '', r.applied.map((a) => `${a.op}:${a.status}`).join(','));
      if (r.status === 'deferred') {
        if (r.reason === 'no LLM provider configured') defer(db, job, 6 * 3600000, r.reason);
        else if (r.reason === 'hourly LLM budget used') defer(db, job, 20 * 60000, r.reason);
        else defer(db, job, loadConfig().extract.idleMinutes * 60000, r.reason);
      } else if (r.status === 'failed') fail(db, job, new Error(r.reason || 'failed'));
      else complete(db, job);
    } else if (job.kind === 'embed') {
      await backfillEmbeddings(db, 512, 'local');
      complete(db, job);
    } else if (job.kind === 'maintain') {
      log('maintain', await runMaintenance(db, String(job.payload.task || 'all')));
      complete(db, job);
    } else complete(db, job);
  } catch (err) {
    log('job error', job.kind, job.key, (err as Error).message);
    fail(db, job, err);
  }
  return true;
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<{ close: () => Promise<void>; port: number }> {
  const cfg = loadConfig();
  const db = opts.db || openDb();
  const port = opts.port ?? cfg.port;
  setEmbedMode('local');
  authToken();
  const handler = createHttpHandler(db);
  const server = createServer((req, res) => void handler(req, res));
  server.keepAliveTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, cfg.host, () => resolve());
  });
  mkdirSync(paths().home, { recursive: true });
  writeFileSync(paths().pid, String(process.pid));
  log('daemon listening', `${cfg.host}:${port}`, 'pid', process.pid);
  let remote: { close: () => Promise<void>; port: number } | null = null;
  if (cfg.remote.enabled) {
    try {
      const { startRemote } = await import('./remote.ts');
      remote = await startRemote(db);
      log('remote listener', `127.0.0.1:${remote.port}`, cfg.remote.publicUrl || '(no public url set)');
    } catch (err) {
      log('remote listener failed', (err as Error).message);
    }
  }
  void getEmbedder().then((e) => log('embedder', e ? 'ready' : 'unavailable'));
  const timers: NodeJS.Timeout[] = [];
  let stopping = false;
  if (opts.jobs !== false) {
    let busy = false;
    const tick = async () => {
      if (busy || stopping) return;
      busy = true;
      try {
        await replaySpool(db);
        if (maintenanceDue(db, 'last_scan', cfg.ingest.intervalSeconds * 1000)) {
          const r = scanTranscripts(db);
          setMeta(db, 'last_scan', nowIso());
          if (r.added) log('scan', r);
        }
        scheduleIdleExtractions(db);
        if (maintenanceDue(db, 'last_embed', 60000)) {
          await backfillEmbeddings(db, 256, 'local');
          setMeta(db, 'last_embed', nowIso());
        }
        if (maintenanceDue(db, 'last_mirror', 10 * 60000)) {
          writeMirror(db);
          writeFileSync(join(paths().home, 'digest.md'), buildDigest(db, { scope: 'global', record: false }).text + '\n');
          setMeta(db, 'last_mirror', nowIso());
        }
        if (maintenanceDue(db, 'last_daily', 24 * 3600000)) {
          setMeta(db, 'last_daily', nowIso());
          enqueue(db, 'maintain', 'maintain:daily', { task: 'all' }, 0);
          pruneJobs(db);
        }
        for (let i = 0; i < 3 && !stopping; i++) if (!(await runOneJob(db))) break;
      } catch (err) {
        log('tick error', (err as Error).stack || String(err));
      } finally {
        busy = false;
      }
    };
    timers.push(setInterval(() => void tick(), 5000));
    setTimeout(() => void tick(), 1500);
    void resolveProvider().then((p) => log('llm provider', p ? p.name : 'none'));
  }
  return {
    port,
    close: async () => {
      stopping = true;
      timers.forEach(clearInterval);
      if (remote) await remote.close();
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      try {
        if (existsSync(paths().pid) && readFileSync(paths().pid, 'utf8') === String(process.pid)) unlinkSync(paths().pid);
      } catch {}
    },
  };
}
