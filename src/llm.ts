import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.ts';
import { getMeta, setMeta } from './db.ts';
import { loadConfig, paths, type LlmProviderName } from './config.ts';
import { EXTRACTION_MARKER } from './capture.ts';

export interface CompleteOptions {
  system: string;
  user: string;
  maxTokens?: number;
  json?: boolean;
}

export interface Provider {
  name: Exclude<LlmProviderName, 'auto' | 'none'>;
  complete(o: CompleteOptions): Promise<string>;
}

function which(bin: string): string | null {
  const r = spawnSync('/bin/sh', ['-lc', `command -v ${bin}`], { encoding: 'utf8' });
  const p = r.stdout.trim();
  return r.status === 0 && p ? p : null;
}

function run(cmd: string, args: string[], input: string, timeoutMs: number, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ENGRAM_DISABLE: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function workDir(): string {
  const d = paths().work;
  mkdirSync(d, { recursive: true });
  return d;
}

const anthropic = (model: string): Provider => ({
  name: 'anthropic',
  async complete(o) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: o.maxTokens ?? 4096, system: o.system, messages: [{ role: 'user', content: o.user }] }),
      signal: AbortSignal.timeout(loadConfig().llm.timeoutMs),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { content: { type: string; text?: string }[] };
    return data.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  },
});

const openai = (model: string): Provider => ({
  name: 'openai',
  async complete(o) {
    const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: o.system },
          { role: 'user', content: o.user },
        ],
        ...(o.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(loadConfig().llm.timeoutMs),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message?.content || '';
  },
});

const claudeCli = (model: string): Provider => ({
  name: 'claude-cli',
  async complete(o) {
    const args = ['-p', '--model', model, '--output-format', 'json', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--tools', '', '--system-prompt', o.system];
    const r = await run('claude', args, `${o.user}\n\n(${EXTRACTION_MARKER})`, loadConfig().llm.timeoutMs, workDir());
    if (r.code !== 0) throw new Error(`claude cli exit ${r.code}: ${(r.stderr || r.stdout).slice(0, 400)}`);
    const data = JSON.parse(r.stdout) as { result?: string; is_error?: boolean; subtype?: string };
    if (data.is_error) throw new Error(`claude cli error: ${data.subtype} ${String(data.result).slice(0, 300)}`);
    return data.result || '';
  },
});

const codexCli = (model: string | undefined): Provider => ({
  name: 'codex-cli',
  async complete(o) {
    const tmp = mkdtempSync(join(workDir(), 'codex-'));
    const out = join(tmp, 'last.txt');
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '--output-last-message', out, ...(model ? ['-m', model] : []), '-'];
    try {
      const r = await run('codex', args, `${o.system}\n\n${o.user}\n\n(${EXTRACTION_MARKER})`, loadConfig().llm.timeoutMs, tmp);
      if (r.code !== 0) throw new Error(`codex exit ${r.code}: ${(r.stderr || r.stdout).slice(-400)}`);
      return readFileSync(out, 'utf8');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
});

const ollama = (model: string): Provider => ({
  name: 'ollama',
  async complete(o) {
    const host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
    const res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        ...(o.json ? { format: 'json' } : {}),
        options: { temperature: 0.1, num_ctx: 16384 },
        messages: [
          { role: 'system', content: o.system },
          { role: 'user', content: o.user },
        ],
      }),
      signal: AbortSignal.timeout(loadConfig().llm.timeoutMs),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content || '';
  },
});

let testProvider: Provider | null = null;

export function setTestProvider(p: Provider | null): void {
  testProvider = p;
}

async function ollamaUp(): Promise<boolean> {
  try {
    const res = await fetch((process.env.OLLAMA_HOST || 'http://127.0.0.1:11434') + '/api/tags', { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function resolveProvider(): Promise<Provider | null> {
  if (testProvider) return testProvider;
  const cfg = loadConfig();
  const p = cfg.llm.provider;
  const m = cfg.llm.model;
  if (p === 'none') return null;
  if (p === 'anthropic' || (p === 'auto' && process.env.ANTHROPIC_API_KEY)) return process.env.ANTHROPIC_API_KEY ? anthropic(m || 'claude-haiku-5-5') : null;
  if (p === 'openai' || (p === 'auto' && process.env.OPENAI_API_KEY)) return process.env.OPENAI_API_KEY ? openai(m || 'gpt-5-mini') : null;
  if (p === 'claude-cli' || (p === 'auto' && which('claude'))) return which('claude') ? claudeCli(m || 'haiku') : null;
  if (p === 'codex-cli' || (p === 'auto' && which('codex'))) return which('codex') ? codexCli(m) : null;
  if (p === 'ollama' || p === 'auto') return (await ollamaUp()) ? ollama(m || 'qwen3:8b') : null;
  return null;
}

export function underRateLimit(db: DB): boolean {
  const cfg = loadConfig();
  const stamps = JSON.parse(getMeta(db, 'llm_calls') || '[]') as number[];
  const hourAgo = Date.now() - 3600000;
  return stamps.filter((t) => t > hourAgo).length < cfg.llm.maxExtractionsPerHour;
}

export function noteCall(db: DB): void {
  const stamps = JSON.parse(getMeta(db, 'llm_calls') || '[]') as number[];
  const hourAgo = Date.now() - 3600000;
  const next = [...stamps.filter((t) => t > hourAgo), Date.now()];
  setMeta(db, 'llm_calls', JSON.stringify(next));
}

export function parseJsonLoose<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.search(/[\[{]/);
    if (start < 0) continue;
    const open = c[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(c.slice(start, i + 1)) as T;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

export function writeDebug(name: string, content: string): void {
  if (!process.env.ENGRAM_DEBUG) return;
  try {
    mkdirSync(paths().logs, { recursive: true });
    writeFileSync(join(paths().logs, name), content);
  } catch {}
}
