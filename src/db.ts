import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config.ts';

export type DB = DatabaseSync;

const MIGRATIONS: string[] = [
  `
  create table meta (k text primary key, v text);

  create table memories (
    rid integer primary key,
    id text not null unique,
    kind text not null,
    scope text not null default 'global',
    title text not null,
    body text not null,
    tags text not null default '[]',
    importance integer not null default 5,
    trust text not null default 'agent',
    sensitive integer not null default 0,
    pinned integer not null default 0,
    status text not null default 'active',
    flags text not null default '[]',
    key text,
    valid_from text,
    valid_to text,
    superseded_by text,
    source text not null default '{}',
    created_at text not null,
    updated_at text not null,
    version integer not null default 1,
    access_count integer not null default 0,
    last_accessed text,
    injected_count integer not null default 0,
    last_injected text,
    hash text not null,
    embedding blob,
    embed_model text
  );
  create index memories_status_kind on memories(status, kind, scope);
  create index memories_hash on memories(hash);
  create index memories_key on memories(key);

  create virtual table memories_fts using fts5(
    title, body, tags,
    content='memories', content_rowid='rid',
    tokenize='porter unicode61 remove_diacritics 2'
  );
  create trigger memories_ai after insert on memories begin
    insert into memories_fts(rowid, title, body, tags) values (new.rid, new.title, new.body, new.tags);
  end;
  create trigger memories_ad after delete on memories begin
    insert into memories_fts(memories_fts, rowid, title, body, tags) values ('delete', old.rid, old.title, old.body, old.tags);
  end;
  create trigger memories_au after update of title, body, tags on memories begin
    insert into memories_fts(memories_fts, rowid, title, body, tags) values ('delete', old.rid, old.title, old.body, old.tags);
    insert into memories_fts(rowid, title, body, tags) values (new.rid, new.title, new.body, new.tags);
  end;

  create table sessions (
    key text primary key,
    harness text not null,
    session_id text not null,
    cwd text,
    scope text not null default 'global',
    title text,
    started_at text not null,
    last_seen_at text not null,
    ended_at text,
    transcript_path text,
    ingest_offset integer not null default 0,
    turn_count integer not null default 0,
    extracted_turns integer not null default 0,
    extract_state text not null default 'pending',
    summary_id text
  );
  create index sessions_seen on sessions(last_seen_at);

  create table turns (
    id integer primary key,
    session_key text not null,
    harness text not null,
    role text not null,
    text text not null,
    ts text not null,
    hash text not null
  );
  create unique index turns_dedupe on turns(session_key, hash);
  create index turns_session on turns(session_key, id);

  create virtual table turns_fts using fts5(
    text, content='turns', content_rowid='id',
    tokenize='porter unicode61 remove_diacritics 2'
  );
  create trigger turns_ai after insert on turns begin
    insert into turns_fts(rowid, text) values (new.id, new.text);
  end;
  create trigger turns_ad after delete on turns begin
    insert into turns_fts(turns_fts, rowid, text) values ('delete', old.id, old.text);
  end;

  create table ops (
    id integer primary key,
    ts text not null,
    op text not null,
    memory_id text,
    actor text,
    reason text,
    before text,
    after text,
    batch text,
    undone integer not null default 0
  );
  create index ops_memory on ops(memory_id);
  create index ops_batch on ops(batch);

  create table jobs (
    id integer primary key,
    kind text not null,
    key text not null unique,
    payload text not null default '{}',
    status text not null default 'queued',
    attempts integer not null default 0,
    run_after text not null,
    lease_until text,
    last_error text,
    dirty integer not null default 0,
    created_at text not null,
    updated_at text not null
  );
  create index jobs_ready on jobs(status, run_after);

  create table injections (
    session_key text not null,
    memory_id text not null,
    ts text not null,
    via text not null,
    primary key (session_key, memory_id)
  );
  `,
];

const opened = new Map<string, DB>();

export function openDb(path?: string): DB {
  const file = path || loadConfig().dbPath;
  const existing = opened.get(file);
  if (existing && existing.isOpen) return existing;
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { timeout: 8000 });
  db.exec('pragma journal_mode = wal');
  db.exec('pragma synchronous = normal');
  db.exec('pragma foreign_keys = on');
  db.exec('pragma busy_timeout = 8000');
  migrate(db);
  opened.set(file, db);
  return db;
}

export function closeAll(): void {
  for (const db of opened.values()) {
    try {
      if (db.isOpen) db.close();
    } catch {}
  }
  opened.clear();
}

function migrate(db: DB): void {
  const row = db.prepare('pragma user_version').get() as { user_version: number };
  let version = row.user_version;
  while (version < MIGRATIONS.length) {
    db.exec('begin immediate');
    try {
      const again = (db.prepare('pragma user_version').get() as { user_version: number }).user_version;
      if (again > version) {
        db.exec('commit');
        version = again;
        continue;
      }
      db.exec(MIGRATIONS[version]);
      db.exec(`pragma user_version = ${version + 1}`);
      db.exec('commit');
      version += 1;
    } catch (err) {
      db.exec('rollback');
      throw err;
    }
  }
}

export function tx<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('begin immediate');
  try {
    const out = fn();
    db.exec('commit');
    return out;
  } catch (err) {
    if (db.isTransaction) db.exec('rollback');
    throw err;
  }
}

export function getMeta(db: DB, k: string): string | undefined {
  const row = db.prepare('select v from meta where k = ?').get(k) as { v: string } | undefined;
  return row?.v;
}

export function setMeta(db: DB, k: string, v: string): void {
  db.prepare('insert into meta(k, v) values (?, ?) on conflict(k) do update set v = excluded.v').run(k, v);
}
