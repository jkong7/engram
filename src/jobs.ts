import type { DB } from './db.ts';
import { nowIso } from './util.ts';

export interface Job {
  id: number;
  kind: string;
  key: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  run_after: string;
  last_error: string | null;
}

export function enqueue(db: DB, kind: string, key: string, payload: Record<string, unknown> = {}, delayMs = 0): void {
  const now = nowIso();
  const runAfter = new Date(Date.now() + delayMs).toISOString();
  db.prepare(
    `insert into jobs (kind, key, payload, status, attempts, run_after, created_at, updated_at)
     values (?, ?, ?, 'queued', 0, ?, ?, ?)
     on conflict(key) do update set
       payload = excluded.payload,
       run_after = excluded.run_after,
       updated_at = excluded.updated_at,
       attempts = case when jobs.status in ('done','failed') then 0 else jobs.attempts end,
       dirty = case when jobs.status = 'running' then 1 else 0 end,
       status = case when jobs.status = 'running' then 'running' else 'queued' end`,
  ).run(kind, key, JSON.stringify(payload), runAfter, now, now);
}

export function claim(db: DB, kinds?: string[], leaseMs = 10 * 60000): Job | null {
  const now = nowIso();
  const lease = new Date(Date.now() + leaseMs).toISOString();
  const kindSql = kinds?.length ? `and kind in (${kinds.map(() => '?').join(',')})` : '';
  const row = db
    .prepare(
      `update jobs set status = 'running', lease_until = ?, attempts = attempts + 1, updated_at = ?
       where id = (
         select id from jobs
         where ((status = 'queued' and run_after <= ?) or (status = 'running' and lease_until < ?)) ${kindSql}
         order by run_after limit 1
       )
       returning *`,
    )
    .get(lease, now, now, now, ...(kinds || [])) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: Number(row.id),
    kind: row.kind as string,
    key: row.key as string,
    payload: JSON.parse((row.payload as string) || '{}'),
    status: row.status as string,
    attempts: Number(row.attempts),
    run_after: row.run_after as string,
    last_error: (row.last_error as string) ?? null,
  };
}

export function complete(db: DB, job: Job): void {
  db.prepare(
    `update jobs set
       status = case when dirty = 1 then 'queued' else 'done' end,
       dirty = 0, lease_until = null, last_error = null, updated_at = ?
     where id = ?`,
  ).run(nowIso(), job.id);
}

export function fail(db: DB, job: Job, err: unknown, maxAttempts = 5): void {
  const msg = err instanceof Error ? err.message : String(err);
  const backoff = Math.min(6 * 3600000, 60000 * 2 ** job.attempts);
  const terminal = job.attempts >= maxAttempts;
  db.prepare(
    `update jobs set status = ?, run_after = ?, lease_until = null, last_error = ?, dirty = 0, updated_at = ? where id = ?`,
  ).run(terminal ? 'failed' : 'queued', new Date(Date.now() + backoff).toISOString(), msg.slice(0, 2000), nowIso(), job.id);
}

export function defer(db: DB, job: Job, delayMs: number, note?: string): void {
  db.prepare(`update jobs set status = 'queued', run_after = ?, lease_until = null, attempts = max(0, attempts - 1), last_error = ?, updated_at = ? where id = ?`).run(
    new Date(Date.now() + delayMs).toISOString(),
    note ?? null,
    nowIso(),
    job.id,
  );
}

export function listJobs(db: DB, status?: string, limit = 50) {
  if (status) return db.prepare('select id, kind, key, status, attempts, run_after, last_error from jobs where status = ? order by run_after limit ?').all(status, limit);
  return db.prepare('select id, kind, key, status, attempts, run_after, last_error from jobs order by updated_at desc limit ?').all(limit);
}

export function pruneJobs(db: DB, days = 14): number {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return Number(db.prepare("delete from jobs where status = 'done' and updated_at < ?").run(cutoff).changes);
}
