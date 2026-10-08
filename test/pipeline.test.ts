import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { freshHome } from './helpers.ts';
import { handleHook } from '../src/hooks.ts';
import { writeMemory, getMemory, listMemories } from '../src/store.ts';
import { enqueue, claim, complete, fail } from '../src/jobs.ts';
import { extractSession } from '../src/extract.ts';
import { parseCodexLines, parseClaudeCodeLines, ingestTranscript, sessionTurns } from '../src/capture.ts';
import { decay } from '../src/maintain.ts';
import { searchConversations } from '../src/search.ts';
import type { Provider } from '../src/llm.ts';
import type { DB } from '../src/db.ts';

const BIN = resolve(import.meta.dirname, '..', 'bin', 'engram.js');

function claudeLine(type: 'user' | 'assistant', text: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ type, sessionId: 'cc1', cwd: '/Users/x/dev/proj', timestamp: new Date().toISOString(), message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] }, ...extra });
}

describe('hooks and capture', () => {
  let h: ReturnType<typeof freshHome>;
  let db: DB;
  let transcript: string;
  before(async () => {
    h = freshHome(false);
    db = h.db;
    await writeMemory(db, { body: 'Sam prefers pnpm over npm in new projects.', kind: 'preference', trust: 'user' });
    await writeMemory(db, { body: 'The ledger lives in ~/dev/jobhunt/ledger.csv and is the source of truth for applications.', kind: 'fact' });
    transcript = join(h.dir, 'cc1.jsonl');
    writeFileSync(
      transcript,
      [
        claudeLine('user', 'set up the new repo with the package manager I like'),
        claudeLine('assistant', 'Using pnpm since you prefer it.'),
        claudeLine('user', '<system-reminder>noise</system-reminder>'),
        claudeLine('user', 'sidechain text', { isSidechain: true }),
        JSON.stringify({ type: 'ai-title', aiTitle: 'Repo setup', sessionId: 'cc1' }),
      ].join('\n') + '\n',
    );
  });
  after(() => h.cleanup());

  test('Claude Code SessionStart returns a digest in hookSpecificOutput', async () => {
    const r = await handleHook(db, 'claude-code', 'SessionStart', { session_id: 'cc1', cwd: '/Users/x/dev/proj', source: 'startup' });
    const out = r.output as any;
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(out.hookSpecificOutput.additionalContext, /pnpm/);
  });

  test('UserPromptSubmit records the prompt and recalls only what was not injected', async () => {
    const r = await handleHook(db, 'claude-code', 'UserPromptSubmit', { session_id: 'cc1', cwd: '/Users/x/dev/proj', prompt: 'where is the applications ledger csv kept?' });
    assert.ok(!r.context.includes('pnpm'));
    const turns = sessionTurns(db, 'claude-code:cc1');
    assert.equal(turns.length, 1);
  });

  test('Stop ingests the transcript, filters noise and sidechains, and enqueues extraction', async () => {
    const r = await handleHook(db, 'claude-code', 'Stop', { session_id: 'cc1', cwd: '/Users/x/dev/proj', transcript_path: transcript });
    assert.match(r.note, /captured 2/);
    const turns = sessionTurns(db, 'claude-code:cc1');
    assert.equal(turns.length, 3);
    assert.ok(!turns.some((t) => /noise|sidechain/.test(t.text)));
    const job = db.prepare("select * from jobs where key = 'extract:claude-code:cc1'").get() as any;
    assert.equal(job.status, 'queued');
    const s = db.prepare("select title from sessions where key = 'claude-code:cc1'").get() as any;
    assert.equal(s.title, 'Repo setup');
    const again = await handleHook(db, 'claude-code', 'Stop', { session_id: 'cc1', transcript_path: transcript });
    assert.match(again.note, /captured 0/);
  });

  test('PreCompact makes extraction due now; compact SessionStart resets session injections', async () => {
    await handleHook(db, 'claude-code', 'PreCompact', { session_id: 'cc1', transcript_path: transcript });
    const job = db.prepare("select run_after from jobs where key = 'extract:claude-code:cc1'").get() as any;
    assert.ok(Date.parse(job.run_after) <= Date.now() + 1000);
    const r = await handleHook(db, 'claude-code', 'SessionStart', { session_id: 'cc1', cwd: '/Users/x/dev/proj', source: 'compact' });
    assert.match(r.context, /pnpm/);
  });

  test('output shapes for Cursor, Gemini, Hermes and Codex', async () => {
    const cur = (await handleHook(db, 'cursor', 'sessionStart', { conversation_id: 'c1', workspace_roots: ['/Users/x/dev/proj'] })).output as any;
    assert.ok(cur.additional_context.includes('engram-memory'));
    const curPrompt = (await handleHook(db, 'cursor', 'beforeSubmitPrompt', { conversation_id: 'c1', prompt: 'hello there friend' })).output as any;
    assert.deepEqual(curPrompt, { continue: true });
    const gem = (await handleHook(db, 'gemini', 'BeforeAgent', { session_id: 'g1', cwd: '/tmp', prompt: 'which package manager do I prefer for javascript projects' })).output as any;
    assert.ok(gem.hookSpecificOutput.additionalContext.includes('pnpm'));
    const her = (await handleHook(db, 'hermes', 'pre_llm_call', { session_id: 'h1', user_message: 'what package manager should this new project use' })).output as any;
    assert.ok(typeof her.context === 'string' && her.context.includes('pnpm'));
    const cdx = (await handleHook(db, 'codex', 'SessionStart', { session_id: 'x1', cwd: '/tmp', source: 'startup' })).output as any;
    assert.equal(cdx.hookSpecificOutput.hookEventName, 'SessionStart');
    const stop = (await handleHook(db, 'hermes', 'post_llm_call', { session_id: 'h1', user_message: 'what package manager should this new project use', assistant_response: 'pnpm, per your preference.' })).output as any;
    assert.deepEqual(stop, {});
    assert.equal(sessionTurns(db, 'hermes:h1').length, 2);
  });

  test('ENGRAM_DISABLE turns every hook into a no-op', async () => {
    process.env.ENGRAM_DISABLE = '1';
    const r = await handleHook(db, 'claude-code', 'SessionStart', { session_id: 'zz', cwd: '/tmp' });
    delete process.env.ENGRAM_DISABLE;
    assert.equal(r.output, null);
    assert.equal(db.prepare("select count(*) n from sessions where session_id = 'zz'").get()!.n, 0);
  });

  test('conversation search finds archived turns', () => {
    const hits = searchConversations(db, 'package manager');
    assert.ok(hits.length >= 1);
  });
});

describe('transcript parsers', () => {
  test('Codex rollout parsing keeps real user and assistant text only', () => {
    const lines = [
      { type: 'session_meta', payload: { id: 'cx1', cwd: '/Users/x/dev/p' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev instructions' }] } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'rename the module to core' }] } } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Renamed.' }] } },
      { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'xx' } },
    ].map((x) => JSON.stringify({ timestamp: '2026-10-01T00:00:00Z', ...x }));
    const p = parseCodexLines(lines);
    assert.equal(p.meta.sessionId, 'cx1');
    assert.deepEqual(p.turns.map((t) => t.role), ['user', 'assistant']);
    assert.equal(p.meta.title, 'rename the module to core');
  });

  test('Claude parser marks internal extraction sessions', () => {
    const p = parseClaudeCodeLines([claudeLine('user', 'please extract (ENGRAM-INTERNAL-EXTRACTION)')]);
    assert.equal(p.meta.internal, true);
  });

  test('incremental ingest only reads appended complete lines', () => {
    const h = freshHome(false);
    const f = join(h.dir, 'inc.jsonl');
    writeFileSync(f, claudeLine('user', 'first message here') + '\n' + claudeLine('assistant', 'partial').slice(0, 30));
    const a = ingestTranscript(h.db, 'claude-code', f);
    assert.equal(a.added, 1);
    writeFileSync(f, claudeLine('user', 'first message here') + '\n' + claudeLine('assistant', 'complete reply now') + '\n');
    const b = ingestTranscript(h.db, 'claude-code', f);
    assert.equal(b.added, 1);
    h.cleanup();
  });
});

describe('jobs', () => {
  test('debounce, claim, dirty requeue, backoff', () => {
    const h = freshHome(false);
    const db = h.db;
    enqueue(db, 'extract', 'k1', { a: 1 }, 0);
    enqueue(db, 'extract', 'k1', { a: 2 }, 0);
    assert.equal(db.prepare('select count(*) n from jobs').get()!.n, 1);
    const j = claim(db)!;
    assert.equal(j.payload.a, 2);
    assert.equal(claim(db), null);
    enqueue(db, 'extract', 'k1', { a: 3 }, 0);
    complete(db, j);
    assert.equal(db.prepare("select status from jobs where key = 'k1'").get()!.status, 'queued');
    const j2 = claim(db)!;
    fail(db, j2, new Error('boom'));
    const row = db.prepare("select status, last_error, run_after from jobs where key = 'k1'").get() as any;
    assert.equal(row.status, 'queued');
    assert.equal(row.last_error, 'boom');
    assert.ok(Date.parse(row.run_after) > Date.now());
    h.cleanup();
  });
});

describe('extraction with a scripted model', () => {
  let h: ReturnType<typeof freshHome>;
  let db: DB;
  let userPref: string;
  const calls: string[] = [];
  const script: string[] = [];
  const provider: Provider = {
    name: 'ollama',
    async complete(o) {
      calls.push(o.user);
      return script.shift() || '{"operations":[],"episode":null}';
    },
  };
  before(async () => {
    h = freshHome(false);
    db = h.db;
    userPref = (await writeMemory(db, { body: 'Sam wants application answers written in first person.', kind: 'preference', trust: 'user' })).id!;
    await handleHook(db, 'generic', 'prompt', { session_id: 's1', cwd: '/Users/x/dev/jobs', prompt: 'I decided to only apply to SF roles from now on, Chicago is off' });
    await handleHook(db, 'generic', 'turn_end', { session_id: 's1', assistant_response: 'Noted, SF only.' });
    await handleHook(db, 'generic', 'prompt', { session_id: 's1', prompt: 'also write the answers in third person going forward' });
  });
  after(() => h.cleanup());

  test('applies add, protects user memories, and stores an episode', async () => {
    script.push(
      JSON.stringify({
        operations: [
          { op: 'add', kind: 'decision', scope: 'global', title: 'SF only applications', body: 'Sam decided on 2026-10-07 to apply only to San Francisco roles and stop Chicago applications.', importance: 7, evidence: 'only apply to SF roles' },
          { op: 'supersede', supersedes: [userPref], kind: 'preference', scope: 'global', title: 'Third person answers', body: 'Sam wants application answers written in third person.', importance: 6 },
          { op: 'update', id: 'm_doesnotexist', body: 'ignored' },
        ],
        episode: { title: 'Application targeting', body: 'Sam narrowed applications to SF roles and changed the answer voice to third person.' },
      }),
    );
    const r = await extractSession(db, 'generic:s1', { provider, force: true });
    assert.equal(r.status, 'done');
    assert.match(calls[0], /EXISTING MEMORIES/);
    assert.match(calls[0], new RegExp(userPref));
    const decision = r.applied.find((a) => a.op === 'add')!;
    assert.equal(decision.status, 'created');
    const sup = r.applied.find((a) => a.op === 'supersede')!;
    assert.equal(sup.status, 'pending');
    assert.equal(getMemory(db, userPref)!.status, 'active');
    assert.ok(r.episodeId);
    assert.equal(getMemory(db, r.episodeId!)!.kind, 'episode');
  });

  test('second run is incremental and updates the same episode', async () => {
    await handleHook(db, 'generic', 'prompt', { session_id: 's1', prompt: 'one more thing: my graduation is June 2027' });
    script.push(JSON.stringify({ operations: [{ op: 'add', kind: 'profile', body: 'Sam graduates from Lakeshore in June 2027.', importance: 7 }], episode: { title: 'Application targeting', body: 'Sam narrowed applications to SF roles, changed answer voice, and noted his June 2027 graduation.' } }));
    const before = listMemories(db, { kinds: ['episode'] }).length;
    const r = await extractSession(db, 'generic:s1', { provider });
    assert.equal(r.status, 'done');
    assert.match(calls[1], /already extracted/);
    assert.equal(listMemories(db, { kinds: ['episode'] }).length, before);
    assert.match(getMemory(db, r.episodeId!)!.body, /June 2027/);
  });

  test('no new turns means no model call', async () => {
    const n = calls.length;
    const r = await extractSession(db, 'generic:s1', { provider });
    assert.equal(r.status, 'skipped');
    assert.equal(calls.length, n);
  });

  test('garbage model output fails cleanly', async () => {
    await handleHook(db, 'generic', 'prompt', { session_id: 's1', prompt: 'and another detail about the ledger format' });
    script.push('I cannot comply');
    const r = await extractSession(db, 'generic:s1', { provider });
    assert.equal(r.status, 'failed');
  });
});

describe('decay', () => {
  test('archives stale low-importance agent memories but never user or pinned ones', async () => {
    const h = freshHome(false);
    const db = h.db;
    const a = (await writeMemory(db, { body: 'Minor detail about a temp script.', kind: 'fact', importance: 3 })).id!;
    const b = (await writeMemory(db, { body: 'Sam hates long emails.', kind: 'preference', trust: 'user', importance: 3 })).id!;
    const c = (await writeMemory(db, { body: 'Pinned minor detail.', kind: 'fact', importance: 3, pinned: true })).id!;
    const old = new Date(Date.now() - 400 * 86400000).toISOString();
    db.prepare('update memories set updated_at = ?, created_at = ?').run(old, old);
    const r = decay(db);
    assert.deepEqual(r.archived, [a]);
    assert.equal(getMemory(db, b)!.status, 'active');
    assert.equal(getMemory(db, c)!.status, 'active');
    h.cleanup();
  });
});

describe('daemon over HTTP', () => {
  let h: ReturnType<typeof freshHome>;
  let close: () => Promise<void>;
  let base: string;
  let token: string;
  before(async () => {
    h = freshHome(false);
    const { startDaemon } = await import('../src/server.ts');
    const { authToken } = await import('../src/config.ts');
    const d = await startDaemon({ db: h.db, jobs: false });
    close = d.close;
    base = `http://127.0.0.1:${d.port}`;
    token = authToken();
  });
  after(async () => {
    await close();
    h.cleanup();
  });
  const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

  test('health is open, everything else needs the token', async () => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/v1/stats`)).status, 401);
    assert.equal((await fetch(`${base}/v1/stats`, { headers: auth() })).status, 200);
  });

  test('rejects foreign Host and Origin headers', async () => {
    const r = await fetch(`${base}/v1/stats`, { headers: { ...auth(), origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
  });

  test('write, search, context and hook endpoints', async () => {
    const w = await (await fetch(`${base}/v1/memories`, { method: 'POST', headers: auth(), body: JSON.stringify({ text: 'Sam uses Raycast and skhd for launch shortcuts', kind: 'fact' }) })).json();
    assert.equal(w.status, 'created');
    const s = await (await fetch(`${base}/v1/search`, { method: 'POST', headers: auth(), body: JSON.stringify({ query: 'raycast shortcuts' }) })).json();
    assert.equal(s.memories[0].id, w.id);
    const ctx = await (await fetch(`${base}/v1/context?cwd=/tmp`, { headers: auth() })).text();
    assert.match(ctx, /Raycast/);
    const hk = await (await fetch(`${base}/v1/hooks/claude-code/SessionStart`, { method: 'POST', headers: auth(), body: JSON.stringify({ session_id: 'http1', cwd: '/tmp' }) })).json();
    assert.match(hk.hookSpecificOutput.additionalContext, /Raycast/);
    const ing = await (await fetch(`${base}/v1/ingest`, { method: 'POST', headers: auth(), body: JSON.stringify({ harness: 'myagent', session_id: 'a1', turns: [{ role: 'user', text: 'remember I like dark roast coffee' }], end: true }) })).json();
    assert.equal(ing.added, 1);
  });

  test('MCP over HTTP answers a legacy initialize and tools/list', async () => {
    const headers = { ...auth(), accept: 'application/json, text/event-stream' };
    const init = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) });
    assert.equal(init.status, 200);
    const text = await init.text();
    assert.match(text, /engram/);
    const list = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
    assert.match(await list.text(), /memory_search/);
  });
});

describe('CLI and installers in an isolated HOME', () => {
  test('hook falls back in-process when the daemon is down', () => {
    const h = freshHome(false);
    const env = { ...process.env, ENGRAM_HOME: h.dir, ENGRAM_EMBED: 'off', ENGRAM_PORT: '1' };
    spawnSync(process.execPath, [BIN, 'add', 'Sam drinks matcha every morning', '--kind', 'profile'], { env, encoding: 'utf8' });
    const r = spawnSync(process.execPath, [BIN, 'hook', 'claude-code', 'SessionStart'], { env, input: JSON.stringify({ session_id: 'f1', cwd: '/tmp' }), encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /matcha/);
    const bad = spawnSync(process.execPath, [BIN, 'hook', 'claude-code', 'Stop'], { env, input: 'not json', encoding: 'utf8' });
    assert.equal(bad.status, 0);
    h.cleanup();
  });

  test('install and uninstall cursor, gemini and codex configs without clobbering existing entries', () => {
    const home = mkdtempSync(join(tmpdir(), 'engram-home-'));
    mkdirSync(join(home, '.cursor'), { recursive: true });
    mkdirSync(join(home, '.gemini'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-x"\n\n[mcp_servers.other]\ncommand = "y"\n');
    const env = { ...process.env, HOME: home, ENGRAM_HOME: join(home, '.engram'), ENGRAM_EMBED: 'off', CODEX_HOME: join(home, '.codex') };
    for (const t of ['cursor', 'gemini', 'codex']) {
      const r = spawnSync(process.execPath, [BIN, 'install', t], { env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    }
    spawnSync(process.execPath, [BIN, 'install', 'codex'], { env, encoding: 'utf8' });
    const cur = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
    assert.ok(cur.mcpServers.other && cur.mcpServers.engram);
    const hooks = JSON.parse(readFileSync(join(home, '.cursor', 'hooks.json'), 'utf8'));
    assert.equal(hooks.hooks.sessionStart.length, 1);
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    assert.equal(toml.match(/\[mcp_servers\.engram\]/g)!.length, 1);
    assert.match(toml, /\[mcp_servers\.other\]/);
    assert.match(toml, /model = "gpt-x"/);
    const ch = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8'));
    assert.equal(ch.hooks.SessionStart.length, 1);
    const gem = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'));
    assert.ok(gem.mcpServers.engram && gem.hooks.BeforeAgent);
    for (const t of ['cursor', 'gemini', 'codex']) spawnSync(process.execPath, [BIN, 'uninstall', t], { env, encoding: 'utf8' });
    const cur2 = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
    assert.ok(cur2.mcpServers.other && !cur2.mcpServers.engram);
    assert.ok(!readFileSync(join(home, '.codex', 'config.toml'), 'utf8').includes('engram'));
    assert.deepEqual(JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')).hooks, {});
    assert.ok(existsSync(join(home, '.engram', 'backups', 'config')));
    rmSync(home, { recursive: true, force: true });
  });
});
