import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export type LlmProviderName = 'auto' | 'anthropic' | 'openai' | 'claude-cli' | 'codex-cli' | 'ollama' | 'none';

export interface EngramConfig {
  home: string;
  dbPath: string;
  port: number;
  host: string;
  digestBudget: number;
  recallItems: number;
  recallBudget: number;
  bodyMaxChars: number;
  nearDuplicate: number;
  recallFloor: number;
  searchFloor: number;
  embed: { enabled: boolean; model: string; dims: number; pooling: 'cls' | 'mean' };
  llm: { provider: LlmProviderName; model?: string; maxExtractionsPerHour: number; timeoutMs: number };
  extract: { idleMinutes: number; minTurns: number; maxTranscriptChars: number };
  decay: { unusedDays: number; maxImportance: number };
  ingest: { claudeCode: boolean; codex: boolean; loom?: boolean; intervalSeconds: number; maxAgeDays: number };
  mirror: { enabled: boolean; git: boolean };
  backups: { keep: number };
  excludeCwds: string[];
  remote: { enabled: boolean; port: number; publicUrl: string; allowWrite: boolean; allowForget: boolean };
}

export function engramHome(): string {
  return process.env.ENGRAM_HOME || join(homedir(), '.engram');
}

function defaults(home: string): EngramConfig {
  return {
    home,
    dbPath: join(home, 'engram.db'),
    port: Number(process.env.ENGRAM_PORT || 7432),
    host: '127.0.0.1',
    digestBudget: 1500,
    recallItems: 5,
    recallBudget: 700,
    bodyMaxChars: 2000,
    nearDuplicate: 0.92,
    recallFloor: 0.64,
    searchFloor: 0.45,
    embed: { enabled: true, model: 'Xenova/bge-small-en-v1.5', dims: 384, pooling: 'cls' },
    llm: { provider: 'auto', maxExtractionsPerHour: 20, timeoutMs: 180000 },
    extract: { idleMinutes: 20, minTurns: 2, maxTranscriptChars: 60000 },
    decay: { unusedDays: 120, maxImportance: 4 },
    ingest: { claudeCode: true, codex: true, intervalSeconds: 120, maxAgeDays: 14 },
    mirror: { enabled: true, git: true },
    backups: { keep: 14 },
    excludeCwds: [join(home, 'work')],
    remote: { enabled: false, port: 7433, publicUrl: '', allowWrite: true, allowForget: false },
  };
}

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = out[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? merge(b, v) : v;
  }
  return out as T;
}

let cached: EngramConfig | undefined;

export function loadConfig(fresh = false): EngramConfig {
  if (cached && !fresh) return cached;
  const home = engramHome();
  mkdirSync(home, { recursive: true });
  const file = join(home, 'config.json');
  let user: unknown = {};
  if (existsSync(file)) {
    try {
      user = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      user = {};
    }
  }
  const cfg = merge(defaults(home), user);
  cfg.home = home;
  if (process.env.ENGRAM_DB) cfg.dbPath = process.env.ENGRAM_DB;
  if (process.env.ENGRAM_EMBED === 'off') cfg.embed.enabled = false;
  if (process.env.ENGRAM_LLM) cfg.llm.provider = process.env.ENGRAM_LLM as LlmProviderName;
  if (process.env.ENGRAM_PORT) cfg.port = Number(process.env.ENGRAM_PORT);
  cached = cfg;
  return cfg;
}

export function resetConfigCache(): void {
  cached = undefined;
}

export function configFile(): string {
  return join(engramHome(), 'config.json');
}

export function saveConfigPatch(patch: Record<string, unknown>): void {
  const file = configFile();
  let cur: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      cur = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      cur = {};
    }
  }
  writeFileSync(file, JSON.stringify(merge(cur, patch), null, 2) + '\n');
  cached = undefined;
}

export function authToken(): string {
  if (process.env.ENGRAM_TOKEN) return process.env.ENGRAM_TOKEN;
  const file = join(engramHome(), 'token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(engramHome(), { recursive: true });
  const token = randomBytes(24).toString('base64url');
  writeFileSync(file, token + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

export function paths() {
  const home = engramHome();
  return {
    home,
    mirror: join(home, 'mirror'),
    backups: join(home, 'backups'),
    logs: join(home, 'logs'),
    spool: join(home, 'spool'),
    models: process.env.ENGRAM_MODELS || join(home, 'models'),
    work: join(home, 'work'),
    pid: join(home, 'daemon.pid'),
  };
}
