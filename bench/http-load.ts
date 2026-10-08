import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'engram-load-'));
process.env.ENGRAM_HOME = dir;
process.env.ENGRAM_MODELS = process.env.ENGRAM_MODELS || resolve(import.meta.dirname, '..', '.cache', 'models');
process.env.ENGRAM_PORT = String(19000 + Math.floor(Math.random() * 500));
process.env.ENGRAM_LLM = 'none';
process.env.ENGRAM_RATE = '100000';
process.env.ENGRAM_BURST = '100000';

const { openDb, closeAll } = await import('../src/db.ts');
const { writeMemory } = await import('../src/store.ts');
const { setEmbedMode } = await import('../src/embed.ts');
const { startDaemon } = await import('../src/server.ts');
const { authToken } = await import('../src/config.ts');

setEmbedMode('local');
const db = openDb();
const topics = ['deploy', 'resume', 'calendar', 'gmail', 'sqlite', 'react', 'kafka', 'interview', 'pickleball', 'obsidian', 'raycast', 'cloud run', 'docker', 'python', 'golang'];
const seedN = Number(process.env.SEED || 2000);
for (let i = 0; i < seedN; i++) await writeMemory(db, { body: `Seed memory ${i}: note about ${topics[i % topics.length]} and ${topics[(i * 7) % topics.length]} variant ${i}`, kind: 'fact', dedupe: false });

const d = await startDaemon({ db, jobs: false });
const base = `http://127.0.0.1:${d.port}`;
const headers = { authorization: `Bearer ${authToken()}`, 'content-type': 'application/json' };
const total = Number(process.env.REQUESTS || 3000);
const concurrency = Number(process.env.CONCURRENCY || 32);
const lat: Record<string, number[]> = { recall: [], write: [], search: [] };
let errors = 0;
let next = 0;

async function worker(w: number) {
  while (next < total) {
    const i = next++;
    const r = i % 10;
    const t0 = performance.now();
    let kind: string;
    let res: Response;
    try {
      if (r < 6) {
        kind = 'recall';
        res = await fetch(`${base}/v1/hooks/claude-code/UserPromptSubmit`, { method: 'POST', headers, body: JSON.stringify({ session_id: `load-${w}`, cwd: '/tmp', prompt: `how do I handle ${topics[i % topics.length]} for request ${i}` }) });
      } else if (r < 8) {
        kind = 'write';
        res = await fetch(`${base}/v1/memories`, { method: 'POST', headers, body: JSON.stringify({ text: `Load test memory ${i} about ${topics[i % topics.length]} written by worker ${w}` }) });
      } else {
        kind = 'search';
        res = await fetch(`${base}/v1/search`, { method: 'POST', headers, body: JSON.stringify({ query: `${topics[i % topics.length]} notes`, limit: 8 }) });
      }
      await res.text();
      if (!res.ok) errors++;
    } catch {
      errors++;
      kind = 'error';
    }
    (lat[kind] ||= []).push(performance.now() - t0);
  }
}

const start = performance.now();
await Promise.all(Array.from({ length: concurrency }, (_, w) => worker(w)));
const secs = (performance.now() - start) / 1000;
const q = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]?.toFixed(1);
};
console.log(`seeded ${seedN} memories; ${total} requests at concurrency ${concurrency} in ${secs.toFixed(1)}s (${(total / secs).toFixed(0)} req/s), errors ${errors}`);
for (const [k, a] of Object.entries(lat)) if (a.length) console.log(`  ${k.padEnd(7)} n=${a.length} p50 ${q(a, 0.5)}ms p95 ${q(a, 0.95)}ms p99 ${q(a, 0.99)}ms`);
const integ = db.prepare('pragma integrity_check').get() as Record<string, string>;
console.log(`  integrity ${Object.values(integ)[0]}, memories ${(db.prepare('select count(*) n from memories').get() as { n: number }).n}`);
await d.close();
closeAll();
rmSync(dir, { recursive: true, force: true });
