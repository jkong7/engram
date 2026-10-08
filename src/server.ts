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
import { touchSession, addTurns, endSession, scanTranscripts, ingestOpencode } from './capture.ts';
import { enqueue, claim, complete, fail, defer, pruneJobs } from './jobs.ts';
import { extractSession } from './extract.ts';
import { consolidate, decay, writeMirror, backup, maintenanceDue, importClaudeMemoryDir } from './maintain.ts';
import { resolveProvider } from './llm.ts';
import { getMeta, setMeta } from './db.ts';
import { nowIso } from './util.ts';
import { uiHtml } from './ui.ts';
import { writeLog, ensureHealthyDb, metricsText, count, observe, applyRetention } from './ops.ts';
import { authenticate, requiredScope, rateLimited, dbFor, createKey, listKeys, revokeKey, type Scope } from './auth.ts';
import { Span, parseTraceparent, memoryToolSpan, traceSettings, withSpan, type Attrs } from './trace.ts';

const startedAt = Date.now();

export function log(...args: unknown[]): void {
  const line = `${nowIso()} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
  writeLog('daemon.log', line);
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
  const allowed = [`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`, `[::1]:${cfg.port}`, `${cfg.host}:${cfg.port}`, ...(process.env.ENGRAM_ALLOWED_HOSTS || '').split(',').filter(Boolean)];
  if (process.env.ENGRAM_ALLOWED_HOSTS === '*') return true;
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

function requestSpan(req: IncomingMessage, path: string, body: Buffer, url: URL, tenant: string): Span | null {
  const settings = traceSettings();
  if (!settings) return null;
  const method = req.method || 'GET';
  let b: any = {};
  if (body.length) {
    try {
      b = JSON.parse(body.toString('utf8'));
    } catch {}
  }
  let parent = parseTraceparent(req.headers.traceparent);
  let op: [string, string] | null = null;
  let name = '';
  const attrs: Attrs = { 'http.request.method': method, 'url.path': path, 'engram.tenant': tenant, 'gen_ai.memory.provider': 'engram' };
  const sid = b.session_id ?? b.sessionId ?? url.searchParams.get('session_id');
  if (sid) attrs['session.id'] = String(sid);
  let query: unknown;
  if (path === '/v1/recall' && method === 'POST') (op = ['search_memory', 'recall']), (query = b.prompt);
  else if (path === '/v1/search' && method === 'POST') (op = ['search_memory', 'search']), (query = b.query);
  else if (path === '/v1/context' && method === 'GET') op = ['read_memory', 'digest'];
  else if (path === '/v1/memories' && method === 'POST') (op = ['create_memory', 'create']), (query = b.text ?? b.body);
  else if (/^\/v1\/memories\/[^/]+$/.test(path) && method === 'PATCH') op = ['update_memory', 'update'];
  else if (/^\/v1\/memories\/[^/]+$/.test(path) && method === 'DELETE') op = ['delete_memory', 'delete'];
  else if (path === '/v1/ingest' && method === 'POST') (op = ['create_memory', 'ingest']), (attrs['engram.turns'] = (b.turns || b.messages || []).length);
  else if (path.startsWith('/v1/hooks/') && method === 'POST') {
    const [, , , harness, event] = path.split('/').map(decodeURIComponent);
    attrs['engram.harness'] = harness;
    attrs['engram.hook.event'] = event;
    if (/^(UserPromptSubmit|BeforeAgent|pre_llm_call|beforeSubmitPrompt)$/i.test(event)) (op = ['search_memory', 'recall']), (query = b.prompt ?? b.user_message);
    else if (/^SessionStart$/i.test(event) || event === 'sessionStart') op = ['read_memory', 'digest'];
    else if (/^(Stop|SubagentStop|PreCompact|PostCompact|SessionEnd|PreCompress|AfterAgent|afterAgentResponse|stop|sessionEnd|preCompact|post_llm_call|on_session_end)$/.test(event)) op = ['create_memory', 'capture'];
    else if (parent) name = `engram.hook ${harness} ${event}`;
  } else if (path === '/mcp' && method === 'POST' && b?.method === 'tools/call') {
    const tool = String(b.params?.name ?? '');
    op = memoryToolSpan(tool);
    parent = parent ?? parseTraceparent(b.params?._meta?.traceparent);
    attrs['gen_ai.tool.name'] = tool;
    attrs['mcp.method.name'] = 'tools/call';
    query = b.params?.arguments;
    if (!op) name = `mcp ${tool}`;
  }
  if (!op && !name) return null;
  if (op) {
    name = `${op[0]} engram`;
    attrs['gen_ai.operation.name'] = op[0];
    attrs['blackbox.memory.op'] = op[1];
  }
  const span = new Span(name, parent, attrs, 2, settings);
  span.content('gen_ai.memory.query.text', query);
  return span;
}

export interface DaemonOptions {
  db?: DB;
  port?: number;
  jobs?: boolean;
  quiet?: boolean;
}

export function createHttpHandler(rootDb: DB) {
  const mcpHandlers = new Map<string, ReturnType<typeof createMcpHandler>>();
  const mcpFor = (tenant: string, db: DB, readOnly: boolean, allowForget: boolean) => {
    const k = `${tenant}|${readOnly}|${allowForget}`;
    let h = mcpHandlers.get(k);
    if (!h) {
      h = createMcpHandler(() => createMcpServer({ db, harness: 'http', readOnly, allowForget }), { legacy: 'stateless' });
      mcpHandlers.set(k, h);
    }
    return h;
  };
  return async (req: IncomingMessage, res: ServerResponse) => {
    let db = rootDb;
    try {
      if (!hostOk(req)) return send(res, 403, { error: 'forbidden host or origin' });
      const url = new URL(req.url || '/', 'http://localhost');
      const path = url.pathname;
      if (path === '/favicon.ico') {
        res.writeHead(204);
        return void res.end();
      }
      if (path === '/metrics') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        return void res.end(metricsText(db));
      }
      if (path === '/healthz') {
        return send(res, 200, { ok: true, version: '0.1.0', uptime_s: Math.round((Date.now() - startedAt) / 1000), embed_model: embedModelName(), embedder_loaded: localEmbedderLoaded(), pid: process.pid });
      }
      const qToken = url.searchParams.get('token') || undefined;
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || undefined;
      const principal = authenticate(rootDb, bearer) || authenticate(rootDb, cookieToken(req)) || authenticate(rootDb, qToken);
      const authed = !!principal;
      if (principal && rateLimited(principal.keyId || 'owner')) return send(res, 429, { error: 'rate limited' });
      if (principal) {
        const need = requiredScope(req.method || 'GET', path);
        if (!principal.scopes.has(need)) return send(res, 403, { error: `this key lacks the ${need} scope` });
        db = dbFor(rootDb, principal.tenant);
      }
      if (path === '/' && req.method === 'GET') {
        if (!authed) return send(res, 401, '<p>Open with <code>engram ui</code> (it adds the token).</p>', 'text/html');
        const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
        if (qToken && tokenOk(qToken)) headers['set-cookie'] = `engram_token=${encodeURIComponent(qToken)}; HttpOnly; SameSite=Strict; Path=/`;
        res.writeHead(200, headers);
        return void res.end(uiHtml());
      }
      if (!authed) return send(res, 401, { error: 'missing or bad bearer token (see ~/.engram/token)' });
      const body = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
      const json = () => (body.length ? JSON.parse(body.toString('utf8')) : {});
      const span = requestSpan(req, path, body, url, principal!.tenant);
      if (span) res.once('finish', () => span.set({ 'http.response.status_code': res.statusCode }).end(res.statusCode >= 400 ? `HTTP ${res.statusCode}` : undefined));
      if (path === '/mcp') {
        const mcp = mcpFor(principal!.tenant, db, !principal!.scopes.has('write'), principal!.scopes.has('admin'));
        return pipeWebResponse(res, await mcp.fetch(await toWebRequest(req, body)));
      }
      if (path === '/v1/keys' && req.method === 'GET') return send(res, 200, { keys: listKeys(rootDb) });
      if (path === '/v1/keys' && req.method === 'POST') {
        const b = json();
        return send(res, 201, createKey(rootDb, String(b.name || 'key'), (b.scopes || ['read']) as Scope[], b.tenant || 'default'));
      }
      const keyDel = path.match(/^\/v1\/keys\/([^/]+)$/);
      if (keyDel && req.method === 'DELETE') return send(res, 200, { revoked: revokeKey(rootDb, keyDel[1]) });
      const hook = path.match(/^\/v1\/hooks\/([^/]+)\/([^/]+)$/);
      if (hook && req.method === 'POST') {
        const t0 = performance.now();
        const r = await handleHook(db, decodeURIComponent(hook[1]), decodeURIComponent(hook[2]), json(), { embedMode: 'local' });
        observe('hook', performance.now() - t0, { harness: hook[1], event: hook[2] });
        count('hook', { harness: hook[1], event: hook[2] });
        log('hook', hook[1], hook[2], r.note);
        span?.set({
          'engram.note': r.note ? String(r.note).slice(0, 500) : undefined,
          'engram.recall.ids': r.detail?.recall?.ids,
          'engram.recall.hits': r.detail?.recall?.hits.length,
          'engram.gate': r.detail?.recall?.gate,
          'engram.digest.ids': r.detail?.digest?.ids,
          'engram.digest.tokens': r.detail?.digest?.tokens,
        }).content('output.value', r.output ?? {});
        return send(res, 200, r.output ?? {});
      }
      if (path === '/v1/context' && req.method === 'GET') {
        const cwd = url.searchParams.get('cwd');
        const sid = url.searchParams.get('session_id');
        const harness = url.searchParams.get('harness') || 'api';
        const key = sid ? touchSession(db, { harness, sessionId: sid, cwd }) : null;
        const d = buildDigest(db, { scope: scopeForCwd(cwd), budget: Number(url.searchParams.get('budget')) || undefined, sessionKey: key, harness, record: url.searchParams.get('dry_run') !== '1' });
        span?.set({ 'engram.scope': scopeForCwd(cwd) }).content('output.value', d.text);
        if (url.searchParams.get('format') === 'json') return send(res, 200, d);
        return send(res, 200, d.text, 'text/markdown; charset=utf-8');
      }
      if (path === '/v1/recall' && req.method === 'POST') {
        const b = json();
        const { buildRecall } = await import('./digest.ts');
        const key = b.session_id ? touchSession(db, { harness: b.harness || 'api', sessionId: b.session_id, cwd: b.cwd }) : null;
        const dry = b.dry_run === true || b.dry_run === 1 || url.searchParams.get('dry_run') === '1';
        const r = await buildRecall(db, String(b.prompt || ''), { scope: scopeForCwd(b.cwd), sessionKey: key, embedMode: 'local', record: !dry });
        span?.set({ 'engram.recall.ids': r.ids, 'engram.recall.hits': r.ids.length, 'engram.gate': typeof r.gate === 'string' ? r.gate : JSON.stringify(r.gate ?? null).slice(0, 500) }).content('output.value', r.text);
        return send(res, 200, { context: r.text, ids: r.ids, gate: r.gate, hits: r.hits.map((h) => ({ id: h.memory.id, title: h.memory.title, kind: h.memory.kind, score: h.score, cos: h.cos, why: h.why })) });
      }
      if (path === '/v1/search' && req.method === 'POST') {
        const b = json();
        const scope = b.scope ? normalizeScope(b.scope, b.cwd) : scopeForCwd(b.cwd);
        const out: Record<string, unknown> = {};
        if (b.source !== 'conversations' && b.source !== 'docs') {
          const hits = await searchMemories(db, { query: String(b.query || ''), scope, kinds: b.kinds, limit: b.limit, asOf: b.as_of, includeSensitive: true, embedMode: 'local' });
          recordAccess(db, hits.map((h) => h.memory.id));
          out.memories = hits.map((h) => ({ ...publicMemory(h.memory), score: h.score, cos: h.cos, why: h.why }));
          span?.set({ 'engram.search.hits': hits.length, 'engram.recall.ids': hits.map((h) => h.memory.id) });
        }
        if (b.source === 'docs' || b.source === 'all') out.docs = await (await import('./docs.ts')).searchDocs(db, String(b.query || ''), { limit: b.limit, includeSensitive: true, embedMode: 'local' });
        if (b.source === 'conversations' || b.source === 'all') out.conversations = searchConversations(db, String(b.query || ''), { limit: b.limit, scope });
        return send(res, 200, out);
      }
      if (path === '/v1/memories' && req.method === 'POST') {
        const b = json();
        const r = await writeMemory(db, { body: b.text ?? b.body, kind: b.kind, title: b.title, scope: b.scope, cwd: b.cwd, tags: b.tags, importance: b.importance, supersedes: b.supersedes, sensitive: b.sensitive, pinned: b.pinned, trust: b.trust === 'user' ? 'user' : b.trust === 'external' ? 'external' : 'agent', source: { harness: b.harness || 'api', ...(b.source || {}) }, key: b.key, embedMode: 'local' });
        span?.set({ 'engram.write.status': String(r.status), 'engram.memory.id': (r as any).id ?? undefined }).content('output.value', r);
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
        span?.set({ 'engram.ingest.added': typeof added === 'number' ? added : undefined, 'engram.session': key });
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
  if (task === 'all' || task === 'rescope') out.rescope = (await import('./maintain.ts')).rescope(db).moved.length;
  if (task === 'all' || task === 'mirror') out.mirror = writeMirror(db);
  if (task === 'all' || task === 'backup') out.backup = backup(db);
  if (task === 'all' || task === 'retention') out.retention = applyRetention(db);
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

function tenantDbs(): DB[] {
  const dir = join(paths().home, 'tenants');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((t) => existsSync(join(dir, t, 'engram.db')))
    .map((t) => openDb(join(dir, t, 'engram.db')));
}

async function runOneJob(db: DB): Promise<boolean> {
  const job = claim(db);
  if (!job) return false;
  try {
    if (job.kind === 'extract') {
      const sessionKey = String(job.payload.session);
      const span = traceSettings() ? new Span('invoke_agent engram-extractor', null, { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'engram-extractor', 'engram.session': sessionKey, 'session.id': sessionKey.split(':').slice(1).join(':') || undefined }, 1) : null;
      const r = await withSpan(span, () => extractSession(db, sessionKey));
      span?.set({ 'engram.extract.status': r.status, 'engram.extract.reason': r.reason || undefined, 'engram.extract.applied': r.applied.map((a) => `${a.op}:${a.status}`) }).content('output.value', r.applied).end(r.status === 'failed' ? r.reason || 'failed' : undefined);
      count('extract', { status: r.status });
      log('extract', job.payload.session, r.status, r.reason || '', r.applied.map((a) => `${a.op}:${a.status}`).join(','));
      if (r.status === 'deferred') {
        if (r.reason === 'no LLM provider configured') defer(db, job, 6 * 3600000, r.reason);
        else if (r.reason === 'hourly LLM budget used') defer(db, job, Math.round((3600000 / Math.max(1, loadConfig().llm.maxExtractionsPerHour)) * (1 + Math.random())), r.reason);
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
  if (!opts.db) ensureHealthyDb(log);
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
          const oc = await ingestOpencode(db);
          if (oc.added) log('opencode ingest', oc);
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
        if (maintenanceDue(db, 'last_docs', 15 * 60000)) {
          setMeta(db, 'last_docs', nowIso());
          const r = await (await import('./docs.ts')).indexSources(db, { embedMode: 'local' });
          if (r.files || r.removed) log('docs index', r);
        }
        if (maintenanceDue(db, 'last_claude_sync', 30 * 60000)) {
          setMeta(db, 'last_claude_sync', nowIso());
          const { claudeMemoryDirs } = await import('./install.ts');
          for (const dir of claudeMemoryDirs()) {
            const r = await importClaudeMemoryDir(db, dir);
            if (r.imported) log('claude memory sync', dir, r);
          }
        }
        for (const t of tenantDbs()) {
          scheduleIdleExtractions(t);
          for (let i = 0; i < 2 && !stopping; i++) if (!(await runOneJob(t))) break;
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
