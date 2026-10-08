import { openSync, readSync, closeSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { DB } from './db.ts';
import { tx } from './db.ts';
import { loadConfig } from './config.ts';
import { scopeForCwd } from './scope.ts';
import { redactSecrets } from './safety.ts';
import { nowIso, sha, clip } from './util.ts';

export const EXTRACTION_MARKER = 'ENGRAM-INTERNAL-EXTRACTION';

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  ts?: string;
}

export interface SessionInfo {
  harness: string;
  sessionId: string;
  cwd?: string | null;
  transcriptPath?: string | null;
  title?: string | null;
}

export function sessionKey(harness: string, sessionId: string): string {
  return `${harness}:${sessionId}`;
}

export function isExcludedCwd(cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  const cfg = loadConfig();
  const abs = resolve(cwd);
  return cfg.excludeCwds.some((x) => abs === resolve(x) || abs.startsWith(resolve(x) + '/'));
}

export function touchSession(db: DB, s: SessionInfo): string {
  const key = sessionKey(s.harness, s.sessionId);
  const now = nowIso();
  const scope = scopeForCwd(s.cwd ?? null);
  db.prepare(
    `insert into sessions (key, harness, session_id, cwd, scope, title, started_at, last_seen_at, transcript_path)
     values (?,?,?,?,?,?,?,?,?)
     on conflict(key) do update set
       last_seen_at = excluded.last_seen_at,
       cwd = coalesce(excluded.cwd, sessions.cwd),
       scope = case when excluded.cwd is not null then excluded.scope else sessions.scope end,
       title = coalesce(sessions.title, excluded.title),
       transcript_path = coalesce(excluded.transcript_path, sessions.transcript_path),
       ended_at = null`,
  ).run(key, s.harness, s.sessionId, s.cwd ?? null, scope, s.title ?? null, now, now, s.transcriptPath ?? null);
  return key;
}

export function endSession(db: DB, key: string): void {
  db.prepare('update sessions set ended_at = ?, last_seen_at = ? where key = ?').run(nowIso(), nowIso(), key);
}

const NOISE_PREFIX = /^\s*(<(task-notification|system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook|environment_context|user_instructions|recommended_plugins|app-context|permissions instructions|collaboration_mode|turn_aborted|subagent_notification|skill)\b|Caveat: The messages below|\[Request interrupted|# AGENTS\.md instructions|<INSTRUCTIONS>)/i;

export function cleanTurnText(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<engram-memory[\s\S]*?<\/engram-memory>/g, '')
    .replace(/<memory-context[\s\S]*?<\/memory-context>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isNoise(text: string): boolean {
  return !text.trim() || NOISE_PREFIX.test(text) || text.includes(EXTRACTION_MARKER);
}

export function addTurns(db: DB, key: string, harness: string, turns: Turn[]): number {
  let added = 0;
  const ins = db.prepare('insert or ignore into turns (session_key, harness, role, text, ts, hash) values (?,?,?,?,?,?)');
  tx(db, () => {
    for (const t of turns) {
      const cleaned = cleanTurnText(t.text);
      if (isNoise(cleaned)) continue;
      const text = clip(redactSecrets(cleaned).text, 20000);
      const res = ins.run(key, harness, t.role, text, t.ts || nowIso(), sha(`${t.role}|${text}`));
      if (res.changes) added++;
    }
    if (added) db.prepare('update sessions set turn_count = turn_count + ?, last_seen_at = ? where key = ?').run(added, nowIso(), key);
  });
  return added;
}

type Parsed = { turns: Turn[]; meta: { sessionId?: string; cwd?: string; title?: string; internal?: boolean; sidechain?: boolean } };

function textOf(content: unknown, kinds: string[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && typeof c === 'object' && kinds.includes((c as { type: string }).type))
    .map((c) => (c as { text?: string }).text || '')
    .join('\n')
    .trim();
}

export function parseClaudeCodeLines(lines: string[]): Parsed {
  const out: Parsed = { turns: [], meta: {} };
  for (const line of lines) {
    let d: Record<string, any>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.sessionId && !out.meta.sessionId) out.meta.sessionId = d.sessionId;
    if (d.cwd && !out.meta.cwd) out.meta.cwd = d.cwd;
    if (d.type === 'ai-title' && d.aiTitle) out.meta.title = d.aiTitle;
    if (d.type === 'summary' && d.summary && !out.meta.title) out.meta.title = d.summary;
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    if (d.isSidechain) {
      out.meta.sidechain = true;
      continue;
    }
    if (d.isMeta || d.isCompactSummary || d.isVisibleInTranscriptOnly) continue;
    const msg = d.message || {};
    if (d.type === 'user') {
      if (d.origin && d.origin.kind && d.origin.kind !== 'human') continue;
      const text = textOf(msg.content, ['text']);
      if (!text) continue;
      if (text.includes(EXTRACTION_MARKER)) out.meta.internal = true;
      out.turns.push({ role: 'user', text, ts: d.timestamp });
    } else {
      const text = textOf(msg.content, ['text']);
      if (!text) continue;
      out.turns.push({ role: 'assistant', text, ts: d.timestamp });
    }
  }
  return out;
}

export function parseCodexLines(lines: string[]): Parsed {
  const out: Parsed = { turns: [], meta: {} };
  for (const line of lines) {
    let d: Record<string, any>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const p = d.payload || {};
    if (d.type === 'session_meta') {
      out.meta.sessionId = p.id || p.session_id;
      out.meta.cwd = p.cwd;
      if (p.source && typeof p.source === 'object' && (p.source.subagent || p.source.SubAgent)) out.meta.sidechain = true;
      continue;
    }
    if (d.type === 'turn_context' && p.cwd && !out.meta.cwd) out.meta.cwd = p.cwd;
    if (d.type === 'event_msg') {
      if (p.type === 'user_message' && typeof p.message === 'string') out.turns.push({ role: 'user', text: p.message, ts: d.timestamp });
      else if (p.type === 'agent_message' && typeof p.message === 'string') out.turns.push({ role: 'assistant', text: p.message, ts: d.timestamp });
      else if (p.type === 'item_completed' && p.item?.type === 'UserMessage') {
        const text = textOf(p.item.content, ['text', 'input_text']);
        if (text) out.turns.push({ role: 'user', text, ts: d.timestamp });
      } else if (p.type === 'item_completed' && p.item?.type === 'AgentMessage') {
        const text = textOf(p.item.content, ['text', 'output_text']);
        if (text) out.turns.push({ role: 'assistant', text, ts: d.timestamp });
      }
      continue;
    }
    if (d.type === 'response_item' && p.type === 'message') {
      if (p.role === 'assistant') {
        const text = textOf(p.content, ['output_text', 'text']);
        if (text) out.turns.push({ role: 'assistant', text, ts: d.timestamp });
      } else if (p.role === 'user') {
        const text = textOf(p.content, ['input_text', 'text']);
        if (text && !text.trimStart().startsWith('<')) out.turns.push({ role: 'user', text, ts: d.timestamp });
      }
    }
  }
  for (const t of out.turns) if (t.role === 'user' && t.text.includes(EXTRACTION_MARKER)) out.meta.internal = true;
  if (!out.meta.title) {
    const first = out.turns.find((t) => t.role === 'user' && !isNoise(t.text));
    if (first) out.meta.title = clip(first.text.replace(/\s+/g, ' '), 80);
  }
  return out;
}

export function parseLoomLines(lines: string[]): Parsed {
  const out: Parsed = { turns: [], meta: {} };
  for (const line of lines) {
    let d: Record<string, any>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type === 'session') {
      out.meta.sessionId = d.session_id;
      out.meta.cwd = d.cwd;
      if (d.title) out.meta.title = d.title;
      if (d.parent_session_id || d.subagent) out.meta.sidechain = true;
      continue;
    }
    if (d.session_id && !out.meta.sessionId) out.meta.sessionId = d.session_id;
    if (d.cwd && !out.meta.cwd) out.meta.cwd = d.cwd;
    if (d.type !== 'message' || (d.role !== 'user' && d.role !== 'assistant')) continue;
    if (d.meta === 'memory' || d.synthetic) continue;
    const text = typeof d.text === 'string' ? d.text : '';
    if (!text.trim()) continue;
    if (text.includes(EXTRACTION_MARKER)) out.meta.internal = true;
    out.turns.push({ role: d.role, text, ts: d.ts });
  }
  if (!out.meta.title) {
    const first = out.turns.find((t) => t.role === 'user' && !isNoise(t.text));
    if (first) out.meta.title = clip(first.text.replace(/\s+/g, ' '), 80);
  }
  return out;
}

export const PARSERS: Record<string, (lines: string[]) => Parsed> = {
  'claude-code': parseClaudeCodeLines,
  codex: parseCodexLines,
  loom: parseLoomLines,
};

function readFrom(path: string, offset: number): { lines: string[]; next: number; size: number } {
  const size = statSync(path).size;
  if (offset > size) offset = 0;
  if (offset === size) return { lines: [], next: offset, size };
  const fd = openSync(path, 'r');
  try {
    const len = size - offset;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, offset);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return { lines: [], next: offset, size };
    const chunk = buf.subarray(0, lastNl + 1).toString('utf8');
    return { lines: chunk.split('\n').filter(Boolean), next: offset + lastNl + 1, size };
  } finally {
    closeSync(fd);
  }
}

export interface IngestResult {
  key: string | null;
  added: number;
  skipped?: string;
}

export function ingestTranscript(db: DB, harness: string, path: string, hint: Partial<SessionInfo> = {}): IngestResult {
  const parser = PARSERS[harness];
  if (!parser) return { key: null, added: 0, skipped: 'no parser' };
  if (!existsSync(path)) return { key: null, added: 0, skipped: 'missing file' };
  const existing = db.prepare('select key, ingest_offset from sessions where transcript_path = ?').get(path) as { key: string; ingest_offset: number } | undefined;
  const offset = existing?.ingest_offset ?? 0;
  const { lines, next } = readFrom(path, offset);
  if (!lines.length && existing) return { key: existing.key, added: 0 };
  let parsed = parser(lines);
  let meta = parsed.meta;
  if (offset > 0 && (!meta.sessionId || !meta.cwd)) {
    const head = readFrom(path, 0).lines.slice(0, 40);
    const hm = parser(head).meta;
    meta = { ...hm, ...Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)) };
    if (hm.internal) meta.internal = true;
  }
  const sessionId = hint.sessionId || meta.sessionId || path.split('/').pop()!.replace(/\.jsonl$/, '');
  const cwd = hint.cwd || meta.cwd || null;
  if (meta.internal || isExcludedCwd(cwd)) {
    const key = touchSession(db, { harness, sessionId, cwd, transcriptPath: path, title: meta.title });
    db.prepare("update sessions set ingest_offset = ?, extract_state = 'skip' where key = ?").run(next, key);
    return { key, added: 0, skipped: 'internal session' };
  }
  const key = touchSession(db, { harness, sessionId, cwd, transcriptPath: path, title: hint.title || meta.title });
  if (meta.title) db.prepare('update sessions set title = ? where key = ? and (title is null or title = ?)').run(meta.title, key, '');
  const added = addTurns(db, key, harness, parsed.turns);
  db.prepare('update sessions set ingest_offset = ? where key = ?').run(next, key);
  return { key, added };
}

function walk(dir: string, match: (name: string) => boolean, maxAgeMs: number, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || !existsSync(dir)) return out;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'subagents' || e.name === 'memory' || e.name.startsWith('.')) continue;
      walk(p, match, maxAgeMs, out, depth + 1);
    } else if (e.isFile() && match(e.name)) {
      try {
        if (statSync(p).mtimeMs >= cutoff) out.push(p);
      } catch {}
    }
  }
  return out;
}

export function transcriptRoots() {
  return {
    'claude-code': process.env.ENGRAM_CLAUDE_PROJECTS || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'),
    codex: process.env.ENGRAM_CODEX_SESSIONS || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'),
    loom: process.env.ENGRAM_LOOM_SESSIONS || join(process.env.LOOM_HOME || join(homedir(), '.loom'), 'sessions'),
  };
}

export function scanTranscripts(db: DB, opts: { maxAgeDays?: number; harnesses?: string[] } = {}): { files: number; added: number; sessions: string[] } {
  const cfg = loadConfig();
  const maxAge = (opts.maxAgeDays ?? cfg.ingest.maxAgeDays) * 86400000;
  const roots = transcriptRoots();
  const want = opts.harnesses || [...(cfg.ingest.claudeCode ? ['claude-code'] : []), ...(cfg.ingest.codex ? ['codex'] : []), ...(cfg.ingest.loom !== false ? ['loom'] : [])];
  let files = 0;
  let added = 0;
  const sessions = new Set<string>();
  for (const h of want) {
    const root = roots[h as keyof typeof roots];
    if (!root) continue;
    const list = h === 'codex' ? walk(root, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'), maxAge) : walk(root, (n) => n.endsWith('.jsonl'), maxAge);
    for (const f of list) {
      const known = db.prepare('select ingest_offset from sessions where transcript_path = ?').get(f) as { ingest_offset: number } | undefined;
      try {
        if (known && statSync(f).size === known.ingest_offset) continue;
        const r = ingestTranscript(db, h, f);
        files++;
        added += r.added;
        if (r.added && r.key) sessions.add(r.key);
      } catch (err) {
        if (process.env.ENGRAM_DEBUG) console.error('engram: ingest failed', f, (err as Error).message);
      }
    }
  }
  return { files, added, sessions: [...sessions] };
}

export function sessionTurns(db: DB, key: string, fromTurn = 0): { id: number; role: string; text: string; ts: string }[] {
  return db.prepare('select id, role, text, ts from turns where session_key = ? order by id limit -1 offset ?').all(key, fromTurn) as {
    id: number;
    role: string;
    text: string;
    ts: string;
  }[];
}
