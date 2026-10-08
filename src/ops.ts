import { existsSync, mkdirSync, readdirSync, renameSync, statSync, appendFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DB } from './db.ts';
import { loadConfig, paths } from './config.ts';
import { nowIso } from './util.ts';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const KEEP_LOGS = 5;
let lastSizeCheck = 0;

export function rotateIfNeeded(file: string): void {
  try {
    if (!existsSync(file) || statSync(file).size < MAX_LOG_BYTES) return;
    for (let i = KEEP_LOGS - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (existsSync(from)) renameSync(from, `${file}.${i + 1}`);
    }
    renameSync(file, `${file}.1`);
    const extra = `${file}.${KEEP_LOGS + 1}`;
    if (existsSync(extra)) rmSync(extra, { force: true });
  } catch {}
}

export function writeLog(name: string, line: string): void {
  try {
    const dir = paths().logs;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    if (Date.now() - lastSizeCheck > 30000) {
      lastSizeCheck = Date.now();
      rotateIfNeeded(file);
    }
    appendFileSync(file, line);
  } catch {}
}

export function integrityOk(file: string): { ok: boolean; detail: string } {
  if (!existsSync(file)) return { ok: true, detail: 'new database' };
  let probe: DatabaseSync | null = null;
  try {
    probe = new DatabaseSync(file, { readOnly: true, timeout: 8000 });
    const row = probe.prepare('pragma quick_check').get() as Record<string, string>;
    const v = Object.values(row)[0];
    return { ok: v === 'ok', detail: String(v) };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  } finally {
    try {
      probe?.close();
    } catch {}
  }
}

export function listBackups(): string[] {
  const dir = paths().backups;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('engram-') && f.endsWith('.db'))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

export function restoreBackup(backupFile: string, target = loadConfig().dbPath): string {
  const check = integrityOk(backupFile);
  if (!check.ok) throw new Error(`backup ${backupFile} is not healthy: ${check.detail}`);
  const quarantine = `${target}.corrupt-${nowIso().replace(/[:.]/g, '-')}`;
  if (existsSync(target)) renameSync(target, quarantine);
  for (const ext of ['-wal', '-shm']) if (existsSync(target + ext)) renameSync(target + ext, quarantine + ext);
  copyFileSync(backupFile, target);
  return quarantine;
}

export function ensureHealthyDb(log: (...a: unknown[]) => void): void {
  const file = loadConfig().dbPath;
  const check = integrityOk(file);
  if (check.ok) return;
  log('database failed integrity check', check.detail);
  for (const b of listBackups()) {
    if (!integrityOk(b).ok) continue;
    const q = restoreBackup(b, file);
    log('restored database from backup', b, 'corrupt copy kept at', q);
    return;
  }
  log('no healthy backup found; starting with the existing file');
}

export function applyRetention(db: DB): { turns: number; sessions: number } {
  const cfg = loadConfig() as unknown as { retention?: { turnsDays?: number; deletedDays?: number } };
  const turnsDays = cfg.retention?.turnsDays ?? 0;
  const deletedDays = cfg.retention?.deletedDays ?? 30;
  let turns = 0;
  let sessions = 0;
  if (turnsDays > 0) {
    const cutoff = new Date(Date.now() - turnsDays * 86400000).toISOString();
    turns = Number(db.prepare('delete from turns where ts < ?').run(cutoff).changes);
    sessions = Number(db.prepare('delete from sessions where last_seen_at < ? and not exists (select 1 from turns t where t.session_key = sessions.key)').run(cutoff).changes);
  }
  if (deletedDays > 0) {
    const cutoff = new Date(Date.now() - deletedDays * 86400000).toISOString();
    const ids = (db.prepare("select id from memories where status = 'deleted' and updated_at < ?").all(cutoff) as { id: string }[]).map((r) => r.id);
    for (const id of ids) {
      db.prepare('delete from memories where id = ?').run(id);
      db.prepare('update ops set before = null, after = null where memory_id = ?').run(id);
    }
  }
  return { turns, sessions };
}

const counters = new Map<string, number>();
const histograms = new Map<string, number[]>();

export function count(name: string, labels: Record<string, string> = {}, n = 1): void {
  const key = name + JSON.stringify(labels);
  counters.set(key, (counters.get(key) || 0) + n);
}

export function observe(name: string, ms: number, labels: Record<string, string> = {}): void {
  const key = name + JSON.stringify(labels);
  const arr = histograms.get(key) || [];
  arr.push(ms);
  if (arr.length > 2000) arr.splice(0, arr.length - 2000);
  histograms.set(key, arr);
}

function fmtLabels(json: string): string {
  const o = JSON.parse(json) as Record<string, string>;
  const parts = Object.entries(o).map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

export function metricsText(db: DB): string {
  const lines: string[] = [];
  const gauge = (name: string, help: string, rows: [Record<string, string>, number][]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [l, v] of rows) lines.push(`${name}${fmtLabels(JSON.stringify(l))} ${v}`);
  };
  const byStatus = db.prepare('select status, count(*) n from memories group by status').all() as { status: string; n: number }[];
  gauge('engram_memories', 'Memories by status', byStatus.map((r) => [{ status: r.status }, r.n]));
  const byKind = db.prepare("select kind, count(*) n from memories where status = 'active' group by kind").all() as { kind: string; n: number }[];
  gauge('engram_active_memories', 'Active memories by kind', byKind.map((r) => [{ kind: r.kind }, r.n]));
  const jobs = db.prepare('select kind, status, count(*) n from jobs group by kind, status').all() as { kind: string; status: string; n: number }[];
  gauge('engram_jobs', 'Background jobs', jobs.map((r) => [{ kind: r.kind, status: r.status }, r.n]));
  gauge('engram_turns', 'Archived conversation turns', [[{}, (db.prepare('select count(*) n from turns').get() as { n: number }).n]]);
  gauge('engram_sessions', 'Sessions seen', [[{}, (db.prepare('select count(*) n from sessions').get() as { n: number }).n]]);
  const spool = existsSync(paths().spool) ? readdirSync(paths().spool).filter((f) => f.endsWith('.jsonl')).length : 0;
  gauge('engram_spool_files', 'Hook payloads waiting for replay', [[{}, spool]]);
  try {
    gauge('engram_db_bytes', 'Database file size', [[{}, statSync(loadConfig().dbPath).size]]);
  } catch {}
  lines.push('# HELP engram_events_total Event counters', '# TYPE engram_events_total counter');
  for (const [k, v] of counters) {
    const i = k.indexOf('{');
    lines.push(`engram_events_total${fmtLabels(JSON.stringify({ name: k.slice(0, i), ...JSON.parse(k.slice(i)) }))} ${v}`);
  }
  lines.push('# HELP engram_latency_ms Request latency quantiles', '# TYPE engram_latency_ms summary');
  for (const [k, arr] of histograms) {
    const i = k.indexOf('{');
    const sorted = [...arr].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
    const base = { op: k.slice(0, i), ...JSON.parse(k.slice(i)) };
    for (const p of [0.5, 0.9, 0.99]) lines.push(`engram_latency_ms${fmtLabels(JSON.stringify({ ...base, quantile: String(p) }))} ${q(p).toFixed(1)}`);
    lines.push(`engram_latency_ms_count${fmtLabels(JSON.stringify(base))} ${arr.length}`);
  }
  return lines.join('\n') + '\n';
}
