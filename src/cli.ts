import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, openSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, closeAll } from './db.ts';
import { loadConfig, authToken, paths, saveConfigPatch, configFile } from './config.ts';
import { writeMemory, updateMemory, forgetMemories, getMemories, listMemories, history, recentOps, undoOp, approvePending, rejectPending, restoreMemory, purgeMemory, stats, publicMemory, backfillEmbeddings, type Memory } from './store.ts';
import { searchMemories, searchConversations, recallGate } from './search.ts';
import { buildDigest, buildRecall } from './digest.ts';
import { handleHook } from './hooks.ts';
import { scanTranscripts, ingestTranscript, touchSession, addTurns, endSession } from './capture.ts';
import { extractSession } from './extract.ts';
import { consolidate, decay, writeMirror, backup, importClaudeMemoryDir, exportAll, importAll } from './maintain.ts';
import { scopeForCwd, normalizeScope } from './scope.ts';
import { setEmbedMode } from './embed.ts';
import { resolveProvider } from './llm.ts';
import { listJobs, enqueue } from './jobs.ts';
import { withTimeout, clip } from './util.ts';

const VERSION = '0.1.0';

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-') && !BOOL_FLAGS.has(a.slice(2))) {
          out.flags[a.slice(2)] = next;
          i++;
        } else out.flags[a.slice(2)] = true;
      }
    } else if (a.startsWith('-') && a.length === 2) {
      out.flags[SHORT[a[1]] || a[1]] = true;
    } else out._.push(a);
  }
  return out;
}

const BOOL_FLAGS = new Set(['json', 'pin', 'unpin', 'sensitive', 'history', 'dry-run', 'all', 'force', 'read-only', 'stdin', 'end', 'no-forget', 'yes', 'pending', 'quiet', 'foreground', 'user']);
const SHORT: Record<string, string> = { j: 'json', h: 'help', n: 'dry-run', y: 'yes', q: 'quiet' };

function str(f: Args['flags'], k: string): string | undefined {
  const v = f[k];
  return typeof v === 'string' ? v : undefined;
}

function num(f: Args['flags'], k: string): number | undefined {
  const v = str(f, k);
  return v === undefined ? undefined : Number(v);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function printMemory(m: Memory, verbose = false): void {
  const meta = [m.kind, m.scope, m.trust, `imp ${m.importance}`, m.updated_at.slice(0, 10), m.status !== 'active' ? m.status : '', m.pinned ? 'pinned' : '', m.sensitive ? 'sensitive' : ''].filter(Boolean).join(' · ');
  console.log(`${m.id}  ${meta}`);
  console.log(`  ${m.title}`);
  if (verbose || m.body !== m.title) console.log('  ' + (verbose ? m.body : clip(m.body, 300)).replace(/\n/g, '\n  '));
}

async function daemonUp(timeoutMs = 600): Promise<boolean> {
  const cfg = loadConfig();
  try {
    const r = await fetch(`http://${cfg.host}:${cfg.port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

async function daemonPost(path: string, body: unknown, timeoutMs: number): Promise<unknown | undefined> {
  const cfg = loadConfig();
  const call = (async () => {
    try {
      const r = await fetch(`http://${cfg.host}:${cfg.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${authToken()}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) return undefined;
      return await r.json();
    } catch {
      return undefined;
    }
  })();
  return withTimeout(call, timeoutMs + 200, undefined);
}

function spool(harness: string, event: string, input: unknown): void {
  try {
    mkdirSync(paths().spool, { recursive: true });
    appendFileSync(join(paths().spool, `${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ harness, event, input, ts: new Date().toISOString() }) + '\n');
  } catch {}
}

async function cmdHook(a: Args): Promise<void> {
  const [harness, event] = a._.slice(1);
  if (!harness || !event) {
    console.error('usage: engram hook <harness> <event>  (hook JSON on stdin)');
    return;
  }
  let input: Record<string, unknown> = {};
  try {
    const raw = await readStdin();
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    input = {};
  }
  if (process.env.ENGRAM_DISABLE === '1') return;
  const phaseTimeout = /start|prompt|beforeagent|pre_llm/i.test(event) ? 2500 : 1500;
  const viaDaemon = str(a.flags, 'mode') !== 'local' ? await daemonPost(`/v1/hooks/${encodeURIComponent(harness)}/${encodeURIComponent(event)}`, input, phaseTimeout) : undefined;
  let output: unknown = viaDaemon;
  if (viaDaemon === undefined) {
    try {
      setEmbedMode(/prompt|beforeagent|pre_llm/i.test(event) && loadConfig().embed.enabled ? 'local' : 'none');
      const db = openDb();
      const r = await handleHook(db, harness, event, input, {});
      output = r.output;
    } catch (err) {
      spool(harness, event, input);
      if (process.env.ENGRAM_DEBUG) console.error('engram hook failed, spooled:', (err as Error).message);
      return;
    }
  }
  if (output && typeof output === 'object' && Object.keys(output as object).length) process.stdout.write(JSON.stringify(output));
}

async function cmdDaemon(a: Args): Promise<void> {
  const sub = a._[1] || 'status';
  const cfg = loadConfig();
  const pidFile = paths().pid;
  const readPid = () => (existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : null);
  const alive = (pid: number | null) => {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (sub === 'run') {
    process.env.ENGRAM_FOREGROUND = a.flags.quiet ? '' : '1';
    const { startDaemon } = await import('./server.ts');
    const d = await startDaemon();
    const stop = async () => {
      await d.close();
      closeAll();
      process.exit(0);
    };
    process.on('SIGTERM', () => void stop());
    process.on('SIGINT', () => void stop());
    return new Promise(() => {});
  }
  const plist = join(process.env.HOME || '', 'Library', 'LaunchAgents', 'com.engram.daemon.plist');
  const managed = process.platform === 'darwin' && existsSync(plist) && !process.env.ENGRAM_HOME;
  const domain = `gui/${process.getuid?.() ?? 501}`;
  const waitUp = async (want: boolean) => {
    for (let i = 0; i < 40; i++) {
      if ((await daemonUp()) === want) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };
  if (managed && (sub === 'start' || sub === 'stop' || sub === 'restart')) {
    if (sub === 'stop') {
      spawnSync('launchctl', ['bootout', `${domain}/com.engram.daemon`]);
      await waitUp(false);
      return console.log('engram daemon stopped and unloaded from launchd (engram daemon start to bring it back)');
    }
    const loaded = spawnSync('launchctl', ['print', `${domain}/com.engram.daemon`]).status === 0;
    if (!loaded) spawnSync('launchctl', ['bootstrap', domain, plist]);
    else spawnSync('launchctl', ['kickstart', ...(sub === 'restart' ? ['-k'] : []), `${domain}/com.engram.daemon`]);
    if (sub === 'restart') await new Promise((r) => setTimeout(r, 500));
    return console.log((await waitUp(true)) ? `engram daemon ${sub === 'restart' ? 'restarted' : 'running'} under launchd on http://${cfg.host}:${cfg.port}` : 'daemon did not come up; see ~/.engram/logs/launchd.err.log');
  }
  if (sub === 'start') {
    if (await daemonUp()) return console.log(`engram daemon already running on ${cfg.host}:${cfg.port}`);
    mkdirSync(paths().logs, { recursive: true });
    const out = openSync(join(paths().logs, 'daemon.out.log'), 'a');
    const child = spawn(process.execPath, [resolve(import.meta.dirname, 'cli.ts'), 'daemon', 'run', '--quiet'], { detached: true, stdio: ['ignore', out, out], env: process.env });
    child.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await daemonUp()) return console.log(`engram daemon started (pid ${child.pid}) on http://${cfg.host}:${cfg.port}`);
    }
    return console.log('daemon did not come up; see ~/.engram/logs/daemon.out.log');
  }
  if (sub === 'stop') {
    const pid = readPid();
    if (!alive(pid)) return console.log('engram daemon not running');
    process.kill(pid!, 'SIGTERM');
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 200));
    return console.log(alive(pid) ? 'daemon still stopping' : 'engram daemon stopped');
  }
  if (sub === 'restart') {
    await cmdDaemon({ _: ['daemon', 'stop'], flags: {} });
    return cmdDaemon({ _: ['daemon', 'start'], flags: {} });
  }
  if (sub === 'logs') {
    const f = join(paths().logs, 'daemon.log');
    if (!existsSync(f)) return console.log('no logs yet');
    const lines = readFileSync(f, 'utf8').trim().split('\n');
    return console.log(lines.slice(-(num(a.flags, 'lines') || Number(a._[2]) || 40)).join('\n'));
  }
  const up = await daemonUp();
  console.log(up ? `engram daemon running on http://${cfg.host}:${cfg.port} (pid ${readPid()})` : 'engram daemon not running (start with: engram daemon start)');
}

const HELP = `engram ${VERSION}: durable personal memory for any AI agent harness

Memories
  engram add <text> [--kind K] [--scope global|project|PATH] [--tags a,b] [--importance N] [--pin] [--sensitive]
  engram search <query> [--source memories|conversations|all] [--kind K] [--as-of DATE] [--limit N] [--json]
  engram list [--kind K] [--scope S] [--status active,pending,...] [--limit N] [--json]
  engram get <id...> [--history] [--json]
  engram edit <id> [--text T] [--title T] [--kind K] [--scope S] [--importance N] [--pin|--unpin] [--outdated]
  engram forget <id...> [--reason R]      engram restore <id>      engram purge <id> --yes
  engram inbox [approve|reject <id>]      engram history <id>      engram ops [--limit N]      engram undo <op-id>

Context
  engram context [--cwd DIR] [--budget N] [--task T]     print the session digest
  engram recall <prompt> [--cwd DIR]                     show what per-prompt recall would inject

Capture and learning
  engram ingest [--harness claude-code|codex] [--days N]       scan transcripts now
  engram ingest --file PATH --harness H                         ingest one transcript
  engram ingest --stdin --harness H --session ID [--cwd D] [--end]   JSON turns on stdin
  engram extract [SESSION_KEY | --pending] [--dry-run] [--force]
  engram consolidate | decay [--dry-run] | mirror | backup | maintain [all|scan|embed|consolidate|decay|mirror|backup]

Integration
  engram mcp [--read-only] [--no-forget]           MCP server on stdio
  engram hook <harness> <event>                     hook entry point (JSON on stdin)
  engram install <claude-code|codex|cursor|gemini|opencode|hermes|claude-desktop|launchd|path|all> [--dry-run]
  engram uninstall <harness>                        engram doctor
  engram daemon start|stop|restart|status|run|logs  engram ui
  engram remote enable [--public-url URL] | disable | status | revoke | passphrase [--rotate]

Data
  engram import claude-memory [DIR] | engram import json FILE | engram export [--out FILE]
  engram stats | engram sessions | engram jobs | engram config [get|set KEY VALUE] | engram eval

Home: ${process.env.ENGRAM_HOME || '~/.engram'} (override with ENGRAM_HOME). Disable all hooks: ENGRAM_DISABLE=1.`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const a = parseArgs(argv);
  const cmd = a._[0];
  const json = !!a.flags.json;
  if (!cmd || cmd === 'help' || a.flags.help) return console.log(HELP);
  if (cmd === 'version' || a.flags.version) return console.log(VERSION);
  if (cmd === 'hook') return cmdHook(a);
  if (cmd === 'daemon') return cmdDaemon(a);
  if (cmd === 'mcp') {
    const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
    const { createMcpServer } = await import('./mcp.ts');
    const db = openDb();
    setEmbedMode('daemon-then-local');
    serveStdio(() => createMcpServer({ db, cwd: process.cwd(), harness: str(a.flags, 'harness') || 'mcp', readOnly: !!a.flags['read-only'], allowForget: !a.flags['no-forget'] }));
    return new Promise(() => {});
  }
  if (cmd === 'install' || cmd === 'uninstall' || cmd === 'doctor') {
    const inst = await import('./install.ts');
    if (cmd === 'doctor') return inst.doctor();
    const target = a._[1];
    if (!target) return console.log('usage: engram install <harness|all>');
    return cmd === 'install' ? inst.install(target, { dryRun: !!a.flags['dry-run'] }) : inst.uninstall(target, { dryRun: !!a.flags['dry-run'] });
  }
  if (cmd === 'ui') {
    const cfg = loadConfig();
    if (!(await daemonUp())) await cmdDaemon({ _: ['daemon', 'start'], flags: {} });
    const url = `http://${cfg.host}:${cfg.port}/?token=${encodeURIComponent(authToken())}`;
    spawnSync('open', [url]);
    return console.log(`opened ${url.replace(/token=[^&]+/, 'token=…')}`);
  }

  const db = openDb();
  const cwd = str(a.flags, 'cwd') || process.cwd();
  const up = ['search', 'recall', 'context', 'add', 'edit'].includes(cmd) ? await daemonUp(300) : false;
  setEmbedMode(up ? 'daemon' : 'local');

  switch (cmd) {
    case 'add':
    case 'remember': {
      const text = a._.slice(1).join(' ') || (await readStdin()).trim();
      const r = await writeMemory(db, {
        body: text,
        kind: str(a.flags, 'kind'),
        title: str(a.flags, 'title'),
        scope: str(a.flags, 'scope') || 'global',
        cwd,
        tags: str(a.flags, 'tags')?.split(',').map((t) => t.trim()),
        importance: num(a.flags, 'importance'),
        pinned: !!a.flags.pin,
        sensitive: a.flags.sensitive ? true : undefined,
        trust: 'user',
        source: { harness: 'cli', cwd },
        actor: 'user',
      });
      return json ? console.log(JSON.stringify(r)) : console.log(r.message);
    }
    case 'search': {
      const query = a._.slice(1).join(' ');
      const source = str(a.flags, 'source') || 'memories';
      const scope = str(a.flags, 'scope') ? normalizeScope(str(a.flags, 'scope'), cwd) : scopeForCwd(cwd);
      const out: Record<string, unknown> = {};
      if (source !== 'conversations') {
        const hits = await searchMemories(db, { query, scope, kinds: str(a.flags, 'kind')?.split(',') as never, asOf: str(a.flags, 'as-of'), limit: num(a.flags, 'limit') || 10, includeSensitive: true, statuses: a.flags.all ? ['active', 'superseded', 'archived'] : undefined });
        out.memories = hits;
        if (!json) {
          if (!hits.length) console.log('No matching memories.');
          for (const h of hits) {
            printMemory(h.memory);
            console.log(`  score ${h.score.toFixed(4)}${h.cos !== null ? ` cos ${h.cos.toFixed(2)}` : ''} ${h.why.join(' ')}`);
          }
        }
      }
      if (source !== 'memories') {
        const convs = searchConversations(db, query, { limit: num(a.flags, 'limit') || 5, scope });
        out.conversations = convs;
        if (!json)
          for (const c of convs) {
            console.log(`\n${c.started_at.slice(0, 16)} ${c.harness} "${c.title || c.session_id}" ${c.cwd || ''}`);
            for (const t of c.turns) console.log(`  ${t.role}: ${t.snippet}`);
          }
      }
      if (json) console.log(JSON.stringify(out, (k, v) => (k === 'embedding' ? undefined : v), 2));
      return;
    }
    case 'list': {
      const ms = listMemories(db, { kinds: str(a.flags, 'kind')?.split(','), scope: str(a.flags, 'scope') ? normalizeScope(str(a.flags, 'scope'), cwd) : undefined, status: str(a.flags, 'status')?.split(',') as never, limit: num(a.flags, 'limit') || 50, order: (str(a.flags, 'order') as never) || 'updated' });
      if (json) return console.log(JSON.stringify(ms.map((m) => publicMemory(m, { full: true })), null, 2));
      if (!ms.length) console.log('No memories.');
      for (const m of ms) printMemory(m);
      return;
    }
    case 'get': {
      const ms = getMemories(db, a._.slice(1));
      if (json) return console.log(JSON.stringify(ms.map((m) => ({ ...publicMemory(m, { full: true }), history: a.flags.history ? history(db, m.id) : undefined })), null, 2));
      for (const m of ms) {
        printMemory(m, true);
        console.log(`  source ${JSON.stringify(m.source)}`);
        if (a.flags.history) for (const o of history(db, m.id)) console.log(`  #${o.id} ${o.ts.slice(0, 19)} ${o.op} by ${o.actor || '?'}${o.reason ? ': ' + o.reason : ''}${o.undone ? ' (undone)' : ''}`);
      }
      return;
    }
    case 'edit': {
      const id = a._[1];
      const [m] = getMemories(db, [id]);
      if (!m) return console.log(`No memory ${id}`);
      let text = str(a.flags, 'text');
      const hasFlags = ['text', 'title', 'kind', 'scope', 'importance', 'pin', 'unpin', 'outdated', 'tags'].some((k) => k in a.flags);
      if (!hasFlags) {
        const dir = mkdtempSync(join(tmpdir(), 'engram-edit-'));
        const f = join(dir, `${id}.md`);
        writeFileSync(f, m.body);
        spawnSync(process.env.EDITOR || 'vi', [f], { stdio: 'inherit' });
        text = readFileSync(f, 'utf8').trim();
        rmSync(dir, { recursive: true, force: true });
        if (text === m.body) return console.log('No change.');
      }
      const r = await updateMemory(db, id, { body: text, title: str(a.flags, 'title'), kind: str(a.flags, 'kind'), scope: str(a.flags, 'scope'), importance: num(a.flags, 'importance'), pinned: a.flags.pin ? true : a.flags.unpin ? false : undefined, status: a.flags.outdated ? 'outdated' : undefined, tags: str(a.flags, 'tags')?.split(',') }, 'user', str(a.flags, 'reason'), cwd);
      return console.log(r.message);
    }
    case 'forget': {
      const r = forgetMemories(db, a._.slice(1), str(a.flags, 'reason') || 'forgotten via cli', 'user');
      return console.log(`Forgot ${r.forgotten.length}${r.missing.length ? `; not found: ${r.missing.join(', ')}` : ''}. Undo with engram restore <id>.`);
    }
    case 'restore':
      return console.log(restoreMemory(db, a._[1]) ? `Restored ${a._[1]}` : 'Not found');
    case 'purge':
      if (!a.flags.yes) return console.log('Permanently erases the memory and its history. Re-run with --yes.');
      return console.log(purgeMemory(db, a._[1]) ? `Purged ${a._[1]}` : 'Not found');
    case 'history': {
      for (const o of history(db, a._[1])) console.log(`#${o.id} ${o.ts.slice(0, 19)} ${o.op} by ${o.actor || '?'}${o.reason ? ': ' + o.reason : ''}${o.undone ? ' (undone)' : ''}`);
      return;
    }
    case 'ops': {
      const ops = recentOps(db, num(a.flags, 'limit') || 30);
      if (json) return console.log(JSON.stringify(ops.map((o) => ({ ...o, before: undefined, after: undefined })), null, 2));
      for (const o of ops) console.log(`#${o.id} ${o.ts.slice(0, 19)} ${o.op.padEnd(9)} ${String(o.memory_id || '').padEnd(12)} ${o.actor || ''}${o.reason ? ': ' + clip(o.reason, 80) : ''}${o.undone ? ' (undone)' : ''}`);
      return;
    }
    case 'undo':
      return console.log(undoOp(db, Number(a._[1])).message);
    case 'inbox': {
      const sub = a._[1];
      if (sub === 'approve' || sub === 'reject') {
        const ids = a._.slice(2);
        const targets = a.flags.all ? listMemories(db, { status: ['pending'], limit: 1000 }).map((m) => m.id) : ids;
        for (const id of targets) console.log((sub === 'approve' ? approvePending(db, id) : rejectPending(db, id)).message);
        return;
      }
      const ms = listMemories(db, { status: ['pending'], limit: 200 });
      if (!ms.length) return console.log('Inbox empty.');
      for (const m of ms) {
        printMemory(m, true);
        console.log(`  flags ${m.flags.join(', ') || '-'}  ${m.source.pending_update_of ? 'updates ' + m.source.pending_update_of : ''}${m.source.pending_supersedes?.length ? 'supersedes ' + m.source.pending_supersedes.join(',') : ''}`);
      }
      return console.log('\nengram inbox approve <id> | reject <id> | approve --all');
    }
    case 'context': {
      const d = buildDigest(db, { scope: scopeForCwd(cwd), budget: num(a.flags, 'budget'), record: false });
      console.log(d.text);
      if (str(a.flags, 'task')) {
        const r = await buildRecall(db, str(a.flags, 'task')!, { scope: scopeForCwd(cwd), record: false });
        if (r.text) console.log('\n' + r.text);
      }
      if (!json) console.error(`\n(${d.ids.length} memories, ~${d.tokens} tokens${d.truncated ? `, ${d.truncated} truncated` : ''})`);
      return;
    }
    case 'recall': {
      const prompt = a._.slice(1).join(' ');
      const gate = recallGate(prompt);
      const r = await buildRecall(db, prompt, { scope: scopeForCwd(cwd), record: false });
      console.log(`gate: ${gate.recall ? 'open' : 'closed'} (${r.gate})`);
      for (const h of r.hits) console.log(`  ${h.memory.id} score ${h.score.toFixed(4)} cos ${h.cos?.toFixed(2) ?? '-'} cov ${h.coverage.toFixed(2)} ${h.why.join(' ')} | ${clip(h.memory.body, 90)}`);
      if (r.text) console.log('\n' + r.text);
      return;
    }
    case 'ingest': {
      if (a.flags.stdin) {
        const harness = str(a.flags, 'harness') || 'api';
        const sid = str(a.flags, 'session') || `${harness}-${new Date().toISOString().slice(0, 10)}`;
        const raw = JSON.parse((await readStdin()) || '[]');
        const turns = Array.isArray(raw) ? raw : raw.turns || raw.messages || [];
        const key = touchSession(db, { harness, sessionId: sid, cwd });
        const added = addTurns(db, key, harness, turns.map((t: any) => ({ role: t.role === 'assistant' ? 'assistant' : 'user', text: String(t.text ?? t.content ?? ''), ts: t.ts })));
        if (a.flags.end) endSession(db, key);
        enqueue(db, 'extract', `extract:${key}`, { session: key }, a.flags.end ? 0 : loadConfig().extract.idleMinutes * 60000);
        return console.log(`ingested ${added} turns into ${key}`);
      }
      if (str(a.flags, 'file')) {
        const r = ingestTranscript(db, str(a.flags, 'harness') || 'claude-code', resolve(str(a.flags, 'file')!));
        return console.log(JSON.stringify(r));
      }
      const r = scanTranscripts(db, { maxAgeDays: num(a.flags, 'days'), harnesses: str(a.flags, 'harness')?.split(',') });
      return console.log(`scanned ${r.files} changed transcripts, added ${r.added} turns across ${r.sessions.length} sessions`);
    }
    case 'extract': {
      const provider = await resolveProvider();
      if (!provider) return console.log('No LLM provider available. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, install claude or codex CLI, or run Ollama. Configure with: engram config set llm.provider <name>');
      let keys: string[] = a._.slice(1);
      if (a.flags.pending || !keys.length) {
        const n = num(a.flags, 'limit') || 5;
        keys = (db.prepare("select key from sessions where extract_state != 'skip' and turn_count > extracted_turns and (select count(*) from turns t where t.session_key = sessions.key and t.role = 'user') >= ? order by last_seen_at desc limit ?").all(loadConfig().extract.minTurns, n) as { key: string }[]).map((r) => r.key);
      }
      console.log(`provider ${provider.name}; ${keys.length} session(s)`);
      for (const k of keys) {
        const t0 = Date.now();
        const r = await extractSession(db, k, { force: !!a.flags.force, dryRun: !!a.flags['dry-run'], provider });
        console.log(`\n${k}: ${r.status}${r.reason ? ' (' + clip(r.reason, a.flags['dry-run'] ? 4000 : 200) + ')' : ''} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        for (const x of r.applied) console.log(`  ${x.op} ${x.status} ${x.id || ''} ${x.title || ''}`);
        if (r.episodeId) console.log(`  episode ${r.episodeId}`);
      }
      return;
    }
    case 'consolidate':
      return console.log(JSON.stringify(await consolidate(db, { dryRun: !!a.flags['dry-run'] }), null, 2));
    case 'decay':
      return console.log(JSON.stringify(decay(db, { dryRun: !!a.flags['dry-run'] }), null, 2));
    case 'mirror':
      return console.log(JSON.stringify(writeMirror(db)));
    case 'backup':
      return console.log(backup(db));
    case 'embed':
      setEmbedMode('local');
      return console.log(`embedded ${await backfillEmbeddings(db, 100000, 'local')}`);
    case 'maintain': {
      setEmbedMode('local');
      const { runMaintenance } = await import('./server.ts');
      return console.log(JSON.stringify(await runMaintenance(db, a._[1] || 'all'), null, 2));
    }
    case 'import': {
      const kind = a._[1];
      if (kind === 'claude-memory') {
        setEmbedMode('local');
        const dirs = a._[2] ? [resolve(a._[2])] : (await import('./install.ts')).claudeMemoryDirs();
        for (const d of dirs) console.log(d, JSON.stringify(await importClaudeMemoryDir(db, d)));
        return;
      }
      if (kind === 'json') {
        setEmbedMode('local');
        return console.log(JSON.stringify(await importAll(db, JSON.parse(readFileSync(resolve(a._[2]), 'utf8')))));
      }
      return console.log('usage: engram import claude-memory [DIR] | engram import json FILE');
    }
    case 'export': {
      const data = JSON.stringify(exportAll(db, { includeDeleted: !!a.flags.all }), null, 2);
      if (str(a.flags, 'out')) {
        writeFileSync(resolve(str(a.flags, 'out')!), data);
        return console.log(`wrote ${str(a.flags, 'out')}`);
      }
      return console.log(data);
    }
    case 'stats': {
      const s = stats(db);
      if (json) return console.log(JSON.stringify(s, null, 2));
      console.log(`memories: ${s.byStatus.map((x) => `${x.status} ${x.n}`).join(', ') || 'none'}`);
      console.log(`active by kind: ${s.byKind.map((x) => `${x.kind} ${x.n}`).join(', ') || 'none'}`);
      console.log(`sessions ${s.sessions}, turns ${s.turns}, ops ${s.ops}, awaiting embedding ${s.unembedded}`);
      console.log(`jobs: ${s.jobs.map((x) => `${x.status} ${x.n}`).join(', ') || 'none'}`);
      console.log(`top scopes: ${s.byScope.slice(0, 6).map((x) => `${x.scope} ${x.n}`).join(', ')}`);
      return;
    }
    case 'sessions': {
      const rows = db.prepare('select key, title, scope, turn_count, extracted_turns, extract_state, last_seen_at from sessions order by last_seen_at desc limit ?').all(num(a.flags, 'limit') || 25) as Record<string, any>[];
      for (const r of rows) console.log(`${r.last_seen_at.slice(0, 16)} ${r.key}\n  ${r.title || '-'} · ${r.scope} · ${r.turn_count} turns · extracted ${r.extracted_turns} (${r.extract_state})`);
      return;
    }
    case 'jobs':
      return console.log(JSON.stringify(listJobs(db, str(a.flags, 'status')), null, 2));
    case 'config': {
      const sub = a._[1];
      if (sub === 'set') {
        const [key, value] = a._.slice(2);
        const parts = key.split('.');
        let v: unknown = value;
        if (value === 'true' || value === 'false') v = value === 'true';
        else if (value !== '' && !isNaN(Number(value))) v = Number(value);
        const patch: Record<string, unknown> = {};
        let cur = patch;
        parts.forEach((p, i) => {
          if (i === parts.length - 1) cur[p] = v;
          else cur = cur[p] = {} as Record<string, unknown>;
        });
        saveConfigPatch(patch);
        return console.log(`set ${key} = ${JSON.stringify(v)} in ${configFile()}`);
      }
      const cfg = loadConfig(true);
      if (sub === 'get' && a._[2]) return console.log(JSON.stringify(a._[2].split('.').reduce((o: any, k) => o?.[k], cfg)));
      return console.log(JSON.stringify(cfg, null, 2));
    }
    case 'remote': {
      const sub = a._[1] || 'status';
      const r = await import('./remote.ts');
      const cfg = loadConfig();
      if (sub === 'enable') {
        const url = str(a.flags, 'public-url') || cfg.remote.publicUrl;
        saveConfigPatch({ remote: { enabled: true, ...(url ? { publicUrl: url } : {}) } });
        const pass = r.remotePassphrase();
        await cmdDaemon({ _: ['daemon', 'restart'], flags: {} });
        console.log(`\nRemote MCP listener on http://127.0.0.1:${cfg.remote.port} (OAuth protected, forget disabled).`);
        console.log(`Passphrase for the consent page: ${pass}`);
        console.log(`\nExpose it over HTTPS, for example:\n  cloudflared tunnel --url http://127.0.0.1:${cfg.remote.port}\n  tailscale funnel ${cfg.remote.port}`);
        console.log(`Then: engram remote enable --public-url https://YOUR-HOST and add https://YOUR-HOST/mcp as a custom connector in claude.ai (Settings > Connectors) or ChatGPT (developer mode).`);
        return;
      }
      if (sub === 'disable') {
        saveConfigPatch({ remote: { enabled: false } });
        await cmdDaemon({ _: ['daemon', 'restart'], flags: {} });
        return console.log('Remote listener disabled.');
      }
      if (sub === 'revoke') return console.log(`Revoked ${r.revokeAll(db)} token(s).`);
      if (sub === 'passphrase') return console.log(r.remotePassphrase(!!a.flags.rotate));
      const st = r.remoteStatus(db);
      console.log(`remote ${cfg.remote.enabled ? 'enabled' : 'disabled'} on 127.0.0.1:${cfg.remote.port}${cfg.remote.publicUrl ? ' as ' + cfg.remote.publicUrl : ''}; writes ${cfg.remote.allowWrite ? 'on' : 'off'}, forget ${cfg.remote.allowForget ? 'on' : 'off'}`);
      console.log(`clients ${st.clients.length}, live tokens ${st.tokens.length}`);
      return;
    }
    case 'eval': {
      const { runEval } = await import('./eval.ts');
      await runEval({ json, verbose: !!a.flags.verbose, sweep: str(a.flags, 'sweep')?.split(',').map(Number) });
      return;
    }
    default:
      console.log(`unknown command: ${cmd}\n`);
      console.log(HELP);
  }
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry === resolve(import.meta.filename) || entry.endsWith('/bin/engram.js') || entry.endsWith('/bin/engram')) {
  main().then(
    () => {
      const cmd = process.argv[2];
      if (cmd !== 'mcp' && !(cmd === 'daemon' && process.argv[3] === 'run')) {
        closeAll();
        process.exitCode = process.exitCode ?? 0;
        if (cmd === 'hook') setTimeout(() => process.exit(0), 50).unref();
      }
    },
    (err) => {
      if (process.argv[2] === 'hook') process.exit(0);
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
