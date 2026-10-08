import { existsSync } from 'node:fs';
import type { DB } from './db.ts';
import { loadConfig } from './config.ts';
import { touchSession, endSession, addTurns, ingestTranscript, isExcludedCwd, PARSERS, sessionKey } from './capture.ts';
import { buildDigest, buildRecall } from './digest.ts';
import { enqueue } from './jobs.ts';
import { scopeForCwd } from './scope.ts';
import type { EmbedMode } from './embed.ts';

export type Phase = 'start' | 'prompt' | 'turn_end' | 'pre_compact' | 'post_compact' | 'end' | 'tool' | 'unknown';

const EVENT_MAP: Record<string, Phase> = {
  sessionstart: 'start',
  session_start: 'start',
  on_session_start: 'start',
  'session.created': 'start',
  userpromptsubmit: 'prompt',
  beforeagent: 'prompt',
  beforesubmitprompt: 'prompt',
  pre_llm_call: 'prompt',
  prompt: 'prompt',
  'chat.message': 'prompt',
  stop: 'turn_end',
  afteragent: 'turn_end',
  afteragentresponse: 'turn_end',
  post_llm_call: 'turn_end',
  'session.idle': 'turn_end',
  turn_end: 'turn_end',
  notify: 'turn_end',
  'agent-turn-complete': 'turn_end',
  subagentstop: 'tool',
  precompact: 'pre_compact',
  precompress: 'pre_compact',
  on_pre_compress: 'pre_compact',
  'experimental.session.compacting': 'pre_compact',
  postcompact: 'post_compact',
  'session.compacted': 'post_compact',
  sessionend: 'end',
  session_end: 'end',
  on_session_end: 'end',
  on_session_finalize: 'end',
  'session.deleted': 'end',
  posttooluse: 'tool',
  pretooluse: 'tool',
};

export function phaseOf(event: string): Phase {
  return EVENT_MAP[event.toLowerCase()] || EVENT_MAP[event] || 'unknown';
}

const HARNESS_ALIASES: Record<string, string> = {
  claude: 'claude-code',
  claudecode: 'claude-code',
  'claude-code': 'claude-code',
  codex: 'codex',
  'codex-cli': 'codex',
  cursor: 'cursor',
  'cursor-agent': 'cursor',
  gemini: 'gemini',
  'gemini-cli': 'gemini',
  opencode: 'opencode',
  hermes: 'hermes',
  loom: 'loom',
};

export function normalizeHarness(h: string): string {
  return HARNESS_ALIASES[h.toLowerCase()] || h.toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'generic';
}

type Input = Record<string, any>;

function pick(input: Input, ...keys: string[]): any {
  for (const k of keys) {
    const parts = k.split('.');
    let v: any = input;
    for (const p of parts) v = v == null ? undefined : v[p];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

export interface HookContext {
  harness: string;
  event: string;
  phase: Phase;
  sessionId: string;
  cwd: string | null;
  transcriptPath: string | null;
  prompt: string | null;
  assistant: string | null;
  source: string | null;
}

export function readContext(harnessIn: string, event: string, input: Input): HookContext {
  const harness = normalizeHarness(harnessIn);
  const cwd = pick(input, 'cwd', 'directory', 'workspace_roots.0', 'workspaceRoots.0', 'project.worktree', 'session.directory') ?? null;
  const sessionId = String(pick(input, 'session_id', 'sessionId', 'sessionID', 'conversation_id', 'conversationId', 'thread_id', 'thread-id', 'session.id', 'event.properties.sessionID') ?? `${harness}-${new Date().toISOString().slice(0, 10)}-${scopeForCwd(cwd)}`);
  let prompt = pick(input, 'prompt', 'user_message', 'userMessage', 'message', 'input', 'llm_request.prompt', 'user_prompt');
  if (Array.isArray(prompt)) prompt = prompt.map((x: any) => (typeof x === 'string' ? x : x?.text || '')).join('\n');
  if (prompt && typeof prompt !== 'string') prompt = prompt.text ?? JSON.stringify(prompt);
  if (!prompt && Array.isArray(input.parts)) prompt = input.parts.map((p: any) => p?.text || '').join('\n');
  if (!prompt && Array.isArray(input['input-messages'])) prompt = input['input-messages'].join('\n');
  let assistant = pick(input, 'last_assistant_message', 'lastAssistantMessage', 'last-assistant-message', 'response', 'assistant_response', 'text', 'llm_response.text');
  if (assistant && typeof assistant !== 'string') assistant = assistant.text ?? JSON.stringify(assistant);
  return {
    harness,
    event,
    phase: phaseOf(event),
    sessionId,
    cwd,
    transcriptPath: pick(input, 'transcript_path', 'transcriptPath') ?? null,
    prompt: prompt ? String(prompt) : null,
    assistant: assistant ? String(assistant) : null,
    source: pick(input, 'source', 'trigger', 'reason') ?? null,
  };
}

function formatOutput(c: HookContext, context: string): unknown {
  if (!context) return c.harness === 'hermes' || c.harness === 'generic' ? {} : null;
  switch (c.harness) {
    case 'claude-code':
    case 'codex':
      return { hookSpecificOutput: { hookEventName: c.event, additionalContext: context } };
    case 'gemini':
      return { hookSpecificOutput: { hookEventName: c.event, additionalContext: context } };
    case 'cursor':
      return c.phase === 'start' ? { additional_context: context } : null;
    case 'hermes':
      return { context };
    default:
      return { context, additionalContext: context };
  }
}

export interface HookResult {
  output: unknown;
  context: string;
  sessionKey: string | null;
  note: string;
}

export async function handleHook(db: DB, harnessIn: string, event: string, input: Input, opts: { embedMode?: EmbedMode } = {}): Promise<HookResult> {
  const c = readContext(harnessIn, event, input);
  const cfg = loadConfig();
  if (process.env.ENGRAM_DISABLE === '1' || isExcludedCwd(c.cwd)) return { output: null, context: '', sessionKey: null, note: 'disabled' };
  const key = touchSession(db, { harness: c.harness, sessionId: c.sessionId, cwd: c.cwd, transcriptPath: c.transcriptPath });
  const scope = scopeForCwd(c.cwd);
  const canParse = !!(c.transcriptPath && PARSERS[c.harness] && existsSync(c.transcriptPath));
  const ingest = () => {
    if (!canParse) return 0;
    try {
      return ingestTranscript(db, c.harness, c.transcriptPath!, { sessionId: c.sessionId, cwd: c.cwd }).added;
    } catch {
      return 0;
    }
  };
  switch (c.phase) {
    case 'start': {
      if (c.source === 'compact' || c.source === 'clear') db.prepare('delete from injections where session_key = ?').run(key);
      if (c.source === 'resume') ingest();
      const d = buildDigest(db, { scope, sessionKey: key, via: 'digest', harness: c.harness });
      return { output: formatOutput(c, d.text), context: d.text, sessionKey: key, note: `digest ${d.ids.length} items, ${d.tokens} tokens` };
    }
    case 'prompt': {
      if (c.prompt) addTurns(db, key, c.harness, [{ role: 'user', text: c.prompt }]);
      if (c.harness === 'cursor') return { output: { continue: true }, context: '', sessionKey: key, note: 'cursor cannot inject at prompt time' };
      const fresh = (db.prepare("select count(*) n from injections where session_key = ? and via = 'digest'").get(key) as { n: number }).n === 0;
      let context = '';
      let note = '';
      if (fresh && (c.harness === 'hermes' || c.harness === 'generic' || c.harness === 'opencode' || c.harness === 'gemini') && input.include_digest !== false) {
        const d = buildDigest(db, { scope, sessionKey: key, via: 'digest', harness: c.harness });
        context = d.text;
        note = `digest ${d.ids.length}; `;
      }
      if (c.prompt) {
        const r = await buildRecall(db, c.prompt, { scope, sessionKey: key, embedMode: opts.embedMode });
        if (r.text) context = context ? `${context}\n\n${r.text}` : r.text;
        note += `recall ${r.ids.length} (${r.gate})`;
      }
      return { output: formatOutput(c, context), context, sessionKey: key, note };
    }
    case 'turn_end': {
      let added = ingest();
      if (!canParse) {
        const turns: { role: 'user' | 'assistant'; text: string }[] = [];
        if (c.prompt && c.harness !== 'claude-code') turns.push({ role: 'user', text: c.prompt });
        if (c.assistant) turns.push({ role: 'assistant', text: c.assistant });
        added += addTurns(db, key, c.harness, turns);
      }
      enqueue(db, 'extract', `extract:${key}`, { session: key }, cfg.extract.idleMinutes * 60000);
      return { output: c.harness === 'hermes' || c.harness === 'generic' ? {} : null, context: '', sessionKey: key, note: `captured ${added}` };
    }
    case 'pre_compact': {
      const added = ingest();
      enqueue(db, 'extract', `extract:${key}`, { session: key, reason: 'pre-compact' }, 0);
      return { output: null, context: '', sessionKey: key, note: `flushed ${added}` };
    }
    case 'post_compact': {
      db.prepare('delete from injections where session_key = ?').run(key);
      return { output: null, context: '', sessionKey: key, note: 'injections reset' };
    }
    case 'end': {
      const added = ingest();
      endSession(db, key);
      enqueue(db, 'extract', `extract:${key}`, { session: key, reason: 'session-end' }, 60000);
      return { output: c.harness === 'hermes' || c.harness === 'generic' ? {} : null, context: '', sessionKey: key, note: `ended, captured ${added}` };
    }
    default:
      return { output: null, context: '', sessionKey: key, note: 'ignored' };
  }
}

export { sessionKey };
