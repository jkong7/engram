import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import type { DB } from './db.ts';
import { tx } from './db.ts';
import { loadConfig } from './config.ts';
import { embed, embedModelName, type EmbedMode } from './embed.ts';
import { redactSecrets, looksSensitive } from './safety.ts';
import { sha, toBlob, fromBlob, cosine, ftsQuery, clip, nowIso } from './util.ts';

export interface SourceConfig {
  path: string;
  exclude?: string[];
}

export interface DocChunk {
  path: string;
  heading: string;
  text: string;
}

function expand(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

export function chunkMarkdown(path: string, content: string, max = 1600): DocChunk[] {
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, '');
  const lines = body.split('\n');
  const chunks: DocChunk[] = [];
  let heading = '';
  let title = '';
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    buf = [];
    if (text.length < 20) return;
    const h = [title, heading].filter(Boolean).join(' > ') || path.split('/').pop()!.replace(/\.md$/, '');
    if (text.length <= max) return void chunks.push({ path, heading: h, text });
    const paras = text.split(/\n\s*\n/);
    let cur = '';
    for (const p of paras) {
      if ((cur + '\n\n' + p).length > max && cur) {
        chunks.push({ path, heading: h, text: cur.trim() });
        cur = '';
      }
      cur += (cur ? '\n\n' : '') + (p.length > max ? p.slice(0, max) : p);
    }
    if (cur.trim().length >= 20) chunks.push({ path, heading: h, text: cur.trim() });
  };
  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.*)$/);
    if (m) {
      flush();
      if (m[1].length === 1 && !title) title = m[2].trim();
      else heading = m[2].trim();
      continue;
    }
    buf.push(line);
  }
  flush();
  return chunks;
}

function walk(root: string, exclude: string[], out: string[] = [], dir = root, depth = 0): string[] {
  if (depth > 8) return out;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    const rel = relative(root, p);
    if (exclude.some((x) => rel === x || rel.startsWith(x + '/'))) continue;
    if (e.isDirectory()) walk(root, exclude, out, p, depth + 1);
    else if (e.isFile() && e.name.endsWith('.md') && statSync(p).size < 400000) out.push(p);
  }
  return out;
}

export function ensureDocsSchema(db: DB): void {
  db.exec(`
    create table if not exists docs (
      rid integer primary key,
      source text not null,
      path text not null,
      heading text not null,
      text text not null,
      file_hash text not null,
      sensitive integer not null default 0,
      indexed_at text not null,
      embedding blob,
      embed_model text
    );
    create index if not exists docs_path on docs(path);
    create virtual table if not exists docs_fts using fts5(heading, text, content='docs', content_rowid='rid', tokenize='porter unicode61 remove_diacritics 2');
    create trigger if not exists docs_ai after insert on docs begin
      insert into docs_fts(rowid, heading, text) values (new.rid, new.heading, new.text);
    end;
    create trigger if not exists docs_ad after delete on docs begin
      insert into docs_fts(docs_fts, rowid, heading, text) values ('delete', old.rid, old.heading, old.text);
    end;
  `);
}

export function configuredSources(): SourceConfig[] {
  const cfg = loadConfig() as unknown as { sources?: SourceConfig[] };
  return cfg.sources || [];
}

export async function indexSources(db: DB, opts: { embedMode?: EmbedMode } = {}): Promise<{ files: number; chunks: number; removed: number }> {
  ensureDocsSchema(db);
  let files = 0;
  let chunks = 0;
  let removed = 0;
  for (const src of configuredSources()) {
    const root = expand(src.path);
    if (!existsSync(root)) continue;
    const list = walk(root, src.exclude || []);
    const seen = new Set(list);
    const known = db.prepare('select distinct path, file_hash from docs where source = ?').all(src.path) as { path: string; file_hash: string }[];
    for (const k of known) {
      if (!seen.has(k.path)) {
        removed += Number(db.prepare('delete from docs where path = ?').run(k.path).changes);
      }
    }
    const knownHash = new Map(known.map((k) => [k.path, k.file_hash]));
    for (const f of list) {
      let content: string;
      try {
        content = readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      const h = sha(content);
      if (knownHash.get(f) === h) continue;
      const parts = chunkMarkdown(f, redactSecrets(content).text);
      const vecs = parts.length ? await embed(parts.map((p) => `${p.heading}\n${p.text}`), opts.embedMode) : [];
      const now = nowIso();
      tx(db, () => {
        db.prepare('delete from docs where path = ?').run(f);
        const ins = db.prepare('insert into docs (source, path, heading, text, file_hash, sensitive, indexed_at, embedding, embed_model) values (?,?,?,?,?,?,?,?,?)');
        parts.forEach((p, i) => {
          const v = vecs ? vecs[i] : null;
          ins.run(src.path, f, p.heading, p.text, h, looksSensitive(p.text) ? 1 : 0, now, v ? toBlob(v) : null, v ? embedModelName() : null);
        });
      });
      files++;
      chunks += parts.length;
    }
  }
  return { files, chunks, removed };
}

export interface DocHit {
  path: string;
  heading: string;
  snippet: string;
  score: number;
  sensitive: boolean;
}

export async function searchDocs(db: DB, query: string, opts: { limit?: number; includeSensitive?: boolean; embedMode?: EmbedMode } = {}): Promise<DocHit[]> {
  ensureDocsSchema(db);
  const limit = opts.limit ?? 5;
  const scores = new Map<number, number>();
  const rows = new Map<number, { path: string; heading: string; text: string; sensitive: number }>();
  const fq = ftsQuery(query);
  if (fq) {
    try {
      const res = db.prepare('select d.rid, d.path, d.heading, d.text, d.sensitive from docs_fts f join docs d on d.rid = f.rowid where docs_fts match ? order by bm25(docs_fts, 2.0, 1.0) limit 40').all(fq) as Record<string, any>[];
      res.forEach((r, i) => {
        rows.set(r.rid, r as never);
        scores.set(r.rid, (scores.get(r.rid) || 0) + 1 / (60 + i + 1));
      });
    } catch {}
  }
  const [qv] = (await embed([query], opts.embedMode)) || [null];
  if (qv) {
    const all = db.prepare('select rid, path, heading, text, sensitive, embedding from docs where embedding is not null and embed_model = ?').all(embedModelName()) as Record<string, any>[];
    const scored = all.map((r) => ({ r, c: cosine(qv, fromBlob(r.embedding)!) })).filter((x) => x.c >= loadConfig().searchFloor + 0.1);
    scored.sort((a, b) => b.c - a.c);
    scored.slice(0, 40).forEach((x, i) => {
      rows.set(x.r.rid, x.r as never);
      scores.set(x.r.rid, (scores.get(x.r.rid) || 0) + 1 / (60 + i + 1));
    });
  }
  const out: DocHit[] = [];
  for (const [rid, score] of [...scores].sort((a, b) => b[1] - a[1])) {
    const r = rows.get(rid)!;
    if (r.sensitive && !opts.includeSensitive) continue;
    out.push({ path: r.path.replace(homedir(), '~'), heading: r.heading, snippet: clip(r.text.replace(/\s+/g, ' '), 500), score, sensitive: !!r.sensitive });
    if (out.length >= limit) break;
  }
  return out;
}
