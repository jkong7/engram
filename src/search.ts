import type { DB } from './db.ts';
import { loadConfig } from './config.ts';
import { rowToMemory, type Memory, type Kind, type Status, TRUST_RANK } from './store.ts';
import { embedOne, embedModelName, type EmbedMode } from './embed.ts';
import { scopeMatches } from './scope.ts';
import { contentTerms, ftsQuery, stem, cosine, fromBlob, daysBetween, clip } from './util.ts';

export interface SearchOptions {
  query: string;
  scope?: string;
  kinds?: Kind[];
  statuses?: Status[];
  includeSensitive?: boolean;
  asOf?: string;
  since?: string;
  limit?: number;
  mode?: 'search' | 'recall';
  exclude?: Set<string>;
  embedMode?: EmbedMode;
  floor?: number;
  queryVector?: Float32Array | null;
  gap?: number;
}

export interface Hit {
  memory: Memory;
  score: number;
  cos: number | null;
  coverage: number;
  matched: number;
  why: string[];
}

interface VecEntry {
  id: string;
  rid: number;
  vec: Float32Array;
}

const vecCache = new Map<string, { sig: string; entries: VecEntry[] }>();

function vectorEntries(db: DB, statuses: Status[]): VecEntry[] {
  const model = embedModelName();
  const sig = db
    .prepare(`select count(*) n, max(updated_at) u, sum(length(embedding)) l from memories where embedding is not null and embed_model = ?`)
    .get(model) as { n: number; u: string | null; l: number | null };
  const key = `${db.location() ?? 'mem'}|${statuses.join(',')}`;
  const sigStr = `${sig.n}|${sig.u}|${sig.l}`;
  const hit = vecCache.get(key);
  if (hit && hit.sig === sigStr) return hit.entries;
  const rows = db
    .prepare(`select rid, id, embedding from memories where embedding is not null and embed_model = ? and status in (${statuses.map(() => '?').join(',')})`)
    .all(model, ...statuses) as { rid: number; id: string; embedding: Uint8Array }[];
  const entries = rows.map((r) => ({ id: r.id, rid: r.rid, vec: fromBlob(r.embedding)! }));
  vecCache.set(key, { sig: sigStr, entries });
  return entries;
}

function stemmedSet(text: string): Set<string> {
  return new Set(contentTerms(text).map(stem));
}

function coverageOf(queryTerms: string[], doc: Memory): { coverage: number; matched: number } {
  if (!queryTerms.length) return { coverage: 0, matched: 0 };
  const docTerms = stemmedSet(`${doc.title} ${doc.body} ${doc.tags.join(' ')}`);
  let matched = 0;
  for (const t of queryTerms) if (docTerms.has(t)) matched++;
  return { coverage: matched / queryTerms.length, matched };
}

const KIND_WEIGHT: Record<Kind, number> = {
  profile: 1.05,
  preference: 1.05,
  decision: 1.05,
  procedure: 1.0,
  fact: 1.0,
  reference: 0.95,
  episode: 0.85,
};

export async function searchMemories(db: DB, opts: SearchOptions): Promise<Hit[]> {
  const cfg = loadConfig();
  const mode = opts.mode || 'search';
  const limit = Math.max(1, Math.min(50, opts.limit ?? (mode === 'recall' ? cfg.recallItems : 8)));
  let statuses: Status[] = opts.statuses?.length ? opts.statuses : ['active'];
  if (opts.asOf && !opts.statuses) statuses = ['active', 'superseded'];
  const active = opts.scope || 'global';
  const queryTerms = Array.from(new Set(contentTerms(opts.query).map(stem)));
  const ranksLex = new Map<string, number>();
  const ranksVec = new Map<string, number>();
  const cosById = new Map<string, number>();
  const rows = new Map<string, Memory>();

  const fq = ftsQuery(opts.query);
  if (fq) {
    try {
      const res = db
        .prepare(
          `select m.* from memories_fts f join memories m on m.rid = f.rowid
           where memories_fts match ? and m.status in (${statuses.map(() => '?').join(',')})
           order by bm25(memories_fts, 3.0, 1.0, 2.0) limit 80`,
        )
        .all(fq, ...statuses) as Record<string, unknown>[];
      res.forEach((r, i) => {
        const m = rowToMemory(r);
        rows.set(m.id, m);
        ranksLex.set(m.id, i + 1);
      });
    } catch {}
  }

  let qvec: Float32Array | null = opts.queryVector ?? null;
  if (qvec === null && opts.queryVector === undefined) {
    try {
      qvec = await embedOne(opts.query, opts.embedMode);
    } catch {
      qvec = null;
    }
  }
  if (qvec) {
    const entries = vectorEntries(db, statuses);
    const scored = entries.map((e) => ({ e, c: cosine(qvec!, e.vec) }));
    scored.sort((a, b) => b.c - a.c);
    scored.slice(0, 80).forEach((s, i) => {
      ranksVec.set(s.e.id, i + 1);
      cosById.set(s.e.id, s.c);
    });
    const missing = scored.slice(0, 80).filter((s) => !rows.has(s.e.id)).map((s) => s.e.rid);
    for (let i = 0; i < missing.length; i += 200) {
      const chunk = missing.slice(i, i + 200);
      const rs = db.prepare(`select * from memories where rid in (${chunk.map(() => '?').join(',')})`).all(...chunk) as Record<string, unknown>[];
      for (const r of rs) {
        const m = rowToMemory(r);
        rows.set(m.id, m);
      }
    }
    for (const m of rows.values()) {
      if (!cosById.has(m.id) && m.embedding && m.embed_model === embedModelName()) cosById.set(m.id, cosine(qvec, m.embedding));
    }
  }

  const hint = parseTimeHint(opts.query);
  const timeBoosted = new Set<string>();
  if (hint.since && (!opts.kinds || opts.kinds.includes('episode'))) {
    const eps = db
      .prepare(`select * from memories where kind = 'episode' and status in (${statuses.map(() => '?').join(',')}) and updated_at >= ? and created_at < ? order by updated_at desc limit 8`)
      .all(...statuses, hint.since, hint.until || '9999') as Record<string, unknown>[];
    for (const r of eps) {
      const m = rowToMemory(r);
      if (!rows.has(m.id)) rows.set(m.id, m);
      timeBoosted.add(m.id);
    }
  }
  const floor = opts.floor ?? (mode === 'recall' ? cfg.recallFloor : cfg.searchFloor);
  const hits: Hit[] = [];
  for (const m of rows.values()) {
    if (opts.exclude?.has(m.id)) continue;
    if (opts.kinds?.length && !opts.kinds.includes(m.kind)) continue;
    if (!opts.includeSensitive && m.sensitive && mode === 'recall') continue;
    if (mode === 'recall' && (m.trust === 'external' || m.flags.some((f) => f.startsWith('injection')))) continue;
    if (opts.asOf) {
      const t = Date.parse(opts.asOf);
      const from = m.valid_from ? Date.parse(m.valid_from) : Date.parse(m.created_at);
      const to = m.valid_to ? Date.parse(m.valid_to) : Infinity;
      if (!(from <= t && t < to)) continue;
    }
    if (opts.since && Date.parse(m.created_at) < Date.parse(opts.since)) continue;
    const { coverage, matched } = coverageOf(queryTerms, m);
    const c = cosById.has(m.id) ? cosById.get(m.id)! : null;
    const why: string[] = [];
    let pass = false;
    if (mode === 'recall') {
      if (c !== null && c >= floor) pass = true;
      else if (c !== null && c >= floor - 0.08 && coverage >= 0.34 && matched >= 1) pass = true;
      else if (c === null && matched >= 2 && coverage >= 0.5) pass = true;
      else if (c === null && matched >= 1 && queryTerms.length <= 2 && coverage >= 0.5) pass = true;
    } else {
      if (c !== null && c >= floor) pass = true;
      if (ranksLex.has(m.id) && matched >= 1) pass = true;
    }
    if (timeBoosted.has(m.id)) {
      pass = true;
      why.push('in-time-range');
    }
    if (!pass) continue;
    let rrf = 0;
    const rl = ranksLex.get(m.id);
    const rv = ranksVec.get(m.id);
    if (rl) {
      rrf += 1 / (60 + rl);
      why.push(`lexical#${rl}`);
    }
    if (rv) {
      rrf += 1 / (60 + rv);
      why.push(`semantic#${rv}`);
    }
    if (!rl && !rv) rrf = 1 / 200;
    if (timeBoosted.has(m.id)) rrf += 1 / 62;
    const scopeW = scopeMatches(m.scope, active);
    const impW = 1 + 0.04 * (m.importance - 5);
    const trustW = 0.9 + 0.05 * TRUST_RANK[m.trust];
    const lastUse = m.last_accessed || m.last_injected;
    const useW = lastUse ? 1 + 0.1 * Math.exp(-daysBetween(lastUse) / 30) : 1;
    const ageW = m.kind === 'episode' ? 1 + 0.15 * Math.exp(-daysBetween(m.created_at) / 14) : 1;
    const statusW = m.status === 'active' ? 1 : 0.6;
    const covW = 1 + 0.25 * coverage;
    const score = rrf * scopeW * impW * trustW * useW * ageW * statusW * covW * KIND_WEIGHT[m.kind] * (m.pinned ? 1.1 : 1);
    if (scopeW < 1) why.push('other-scope');
    hits.push({ memory: m, score, cos: c, coverage, matched, why });
  }
  hits.sort((a, b) => b.score - a.score);
  const top = hits[0]?.score ?? 0;
  const rel = mode === 'recall' ? 0.45 : 0.4;
  const topCos = Math.max(-1, ...hits.map((h) => h.cos ?? -1));
  const gap = opts.gap ?? (mode === 'recall' ? Number(process.env.ENGRAM_RECALL_GAP || 0.07) : 0.16);
  const kept = hits.filter((h) => timeBoosted.has(h.memory.id) || (h.score >= top * rel && (h.cos === null || topCos < 0 || h.cos >= topCos - gap || h.coverage >= 0.6)));
  return mmr(kept.slice(0, limit * 4), limit, 0.72);
}

function mmr(hits: Hit[], k: number, lambda: number): Hit[] {
  if (hits.length <= 1) return hits.slice(0, k);
  const max = hits[0].score || 1;
  const picked: Hit[] = [];
  const pool = hits.slice();
  const termCache = new Map<string, Set<string>>();
  const terms = (m: Memory) => {
    let s = termCache.get(m.id);
    if (!s) {
      s = stemmedSet(m.title + ' ' + m.body);
      termCache.set(m.id, s);
    }
    return s;
  };
  const sim = (a: Memory, b: Memory) => {
    if (a.embedding && b.embedding && a.embed_model === b.embed_model) return cosine(a.embedding, b.embedding);
    const sa = terms(a);
    const sb = terms(b);
    let inter = 0;
    for (const x of sa) if (sb.has(x)) inter++;
    return inter / Math.max(1, sa.size + sb.size - inter);
  };
  while (picked.length < k && pool.length) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const rel = pool[i].score / max;
      let red = 0;
      for (const p of picked) red = Math.max(red, sim(pool[i].memory, p.memory));
      const val = lambda * rel - (1 - lambda) * red;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    const [h] = pool.splice(bestIdx, 1);
    if (picked.length && sim(h.memory, picked[0].memory) > 0.97) continue;
    picked.push(h);
  }
  return picked;
}

const TRIVIAL = /^(ok(ay)?|k|yes|yep|yeah|no|nope|y|n|sure|thanks?( you)?|ty|thx|continue|go( ahead| on)?|proceed|do it|ship it|sounds good|lgtm|nice|cool|great|perfect|awesome|done|next|retry|try again|again|keep going|carry on|stop|wait|hmm+|lol|good|fine|right|correct|exactly|agreed|approve[ds]?|confirm(ed)?)[\s.!?]*$/i;

export function recallGate(prompt: string): { recall: boolean; reason: string } {
  const p = prompt.trim();
  if (!p) return { recall: false, reason: 'empty' };
  if (process.env.ENGRAM_DISABLE === '1') return { recall: false, reason: 'disabled' };
  if (/^\/[\w:-]+\s*$/.test(p)) return { recall: false, reason: 'bare slash command' };
  if (TRIVIAL.test(p)) return { recall: false, reason: 'acknowledgement' };
  if (/^<(task-notification|system-reminder|command-name)/.test(p)) return { recall: false, reason: 'harness message' };
  const terms = contentTerms(p);
  if (terms.length === 0) return { recall: false, reason: 'no content words' };
  if (terms.length === 1 && p.length < 16) return { recall: false, reason: 'too short' };
  return { recall: true, reason: `${terms.length} content terms` };
}

export function recallQuery(prompt: string): string {
  let p = prompt.replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  if (p.length > 1200) p = p.slice(0, 600) + ' ' + p.slice(-600);
  return p.trim();
}

export interface TimeHint {
  since?: string;
  until?: string;
}

export function parseTimeHint(text: string, now = new Date()): TimeHint {
  const t = text.toLowerCase();
  const day = 86400000;
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = startOf(now);
  if (/\btoday\b/.test(t)) return { since: today.toISOString() };
  if (/\byesterday\b/.test(t)) return { since: new Date(today.getTime() - day).toISOString(), until: today.toISOString() };
  if (/\b(this|past|last) (few )?days?\b/.test(t)) return { since: new Date(today.getTime() - 3 * day).toISOString() };
  if (/\bthis week\b/.test(t)) return { since: new Date(today.getTime() - ((today.getDay() + 6) % 7) * day).toISOString() };
  if (/\b(last|past) week\b/.test(t)) return { since: new Date(today.getTime() - 7 * day).toISOString() };
  if (/\b(last|past) (two|2) weeks\b/.test(t)) return { since: new Date(today.getTime() - 14 * day).toISOString() };
  if (/\bthis month\b/.test(t)) return { since: new Date(now.getFullYear(), now.getMonth(), 1).toISOString() };
  if (/\b(last|past) month\b/.test(t)) return { since: new Date(today.getTime() - 31 * day).toISOString() };
  const ago = t.match(/\b(\d{1,3}) (day|week|month)s? ago\b/);
  if (ago) {
    const n = Number(ago[1]);
    const mult = ago[2] === 'day' ? day : ago[2] === 'week' ? 7 * day : 30 * day;
    const center = today.getTime() - n * mult;
    return { since: new Date(center - mult).toISOString(), until: new Date(center + mult + day).toISOString() };
  }
  const iso = t.match(/\b(20\d\d-\d\d-\d\d)\b/);
  if (iso) {
    const d = new Date(iso[1] + 'T00:00:00');
    return { since: d.toISOString(), until: new Date(d.getTime() + day).toISOString() };
  }
  return {};
}

export interface ConversationHit {
  session_key: string;
  harness: string;
  session_id: string;
  cwd: string | null;
  title: string | null;
  started_at: string;
  turns: { role: string; ts: string; snippet: string }[];
  score: number;
}

export function searchConversations(db: DB, query: string, opts: { limit?: number; since?: string; until?: string; scope?: string } = {}): ConversationHit[] {
  const limit = opts.limit ?? 5;
  const hint = parseTimeHint(query);
  const since = opts.since ?? hint.since;
  const until = opts.until ?? hint.until;
  const fq = ftsQuery(query);
  const args: (string | number)[] = [];
  let sql: string;
  if (fq) {
    sql = `select t.id, t.session_key, t.role, t.ts, snippet(turns_fts, 0, '[', ']', ' … ', 24) snip, bm25(turns_fts) bm
           from turns_fts join turns t on t.id = turns_fts.rowid where turns_fts match ?`;
    args.push(fq);
  } else {
    sql = `select t.id, t.session_key, t.role, t.ts, substr(t.text, 1, 200) snip, 0 bm from turns t where 1=1`;
  }
  if (since) {
    sql += ' and t.ts >= ?';
    args.push(since);
  }
  if (until) {
    sql += ' and t.ts < ?';
    args.push(until);
  }
  sql += fq ? ' order by bm limit 200' : ' order by t.id desc limit 200';
  let rows: { id: number; session_key: string; role: string; ts: string; snip: string; bm: number }[] = [];
  try {
    rows = db.prepare(sql).all(...args) as typeof rows;
  } catch {
    rows = [];
  }
  const groups = new Map<string, { score: number; turns: { role: string; ts: string; snippet: string }[] }>();
  rows.forEach((r, i) => {
    const g = groups.get(r.session_key) || { score: 0, turns: [] };
    g.score += 1 / (10 + i);
    if (g.turns.length < 4) g.turns.push({ role: r.role, ts: r.ts, snippet: clip(r.snip.replace(/\s+/g, ' '), 320) });
    groups.set(r.session_key, g);
  });
  const out: ConversationHit[] = [];
  for (const [key, g] of groups) {
    const s = db.prepare('select * from sessions where key = ?').get(key) as Record<string, unknown> | undefined;
    if (!s) continue;
    if (opts.scope && opts.scope !== 'global' && s.scope !== opts.scope) g.score *= 0.7;
    out.push({
      session_key: key,
      harness: s.harness as string,
      session_id: s.session_id as string,
      cwd: (s.cwd as string) ?? null,
      title: (s.title as string) ?? null,
      started_at: s.started_at as string,
      turns: g.turns.sort((a, b) => a.ts.localeCompare(b.ts)),
      score: g.score,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
