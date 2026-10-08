import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetConfigCache, loadConfig } from './config.ts';
import { openDb, closeAll, type DB } from './db.ts';
import { writeMemory, type Kind } from './store.ts';
import { searchMemories, recallGate } from './search.ts';
import { buildRecall } from './digest.ts';
import { setEmbedMode } from './embed.ts';

interface Seed {
  key: string;
  body: string;
  kind: Kind;
  scope?: string;
  sensitive?: boolean;
  importance?: number;
  supersedes?: string;
}

export const SEEDS: Seed[] = [
  { key: 'name', kind: 'profile', body: 'The user goes by Sam; his full name is Sam Rivera and he signs messages as Sam.' },
  { key: 'school', kind: 'profile', body: 'Sam is a Lakeshore University computer science senior finishing his B.S. part-time in fall 2026.' },
  { key: 'grad', kind: 'profile', body: 'Sam plans to walk at Lakeshore graduation in June 2027.' },
  { key: 'gf', kind: 'profile', body: 'Sam has a partner and a tight group of seven close college friends.' },
  { key: 'cologne', kind: 'profile', body: 'Sam collects colognes, about 16 bottles, mostly niche and designer fragrances.' },
  { key: 'sports', kind: 'profile', body: 'Sam plays ping pong, pickleball and basketball for fun.' },
  { key: 'intern', kind: 'profile', body: 'Sam interned at Medscribe as a Member of Technical Staff intern, and before that at Northwind and Pulseband.' },
  { key: 'health', kind: 'profile', body: 'Sam takes an antidepressant prescribed by his doctor.', sensitive: true },
  { key: 'nocomments', kind: 'preference', body: 'Sam never wants code comments or docstrings in code written for him; usage docs go in the README instead.' },
  { key: 'nodash', kind: 'preference', body: 'Sam does not want em dashes in any writing, replies or AI output because they read as AI-generated.' },
  { key: 'nosend', kind: 'preference', body: 'Agents must never send emails or LinkedIn messages for Sam; they only draft and he clicks Send himself.' },
  { key: 'attrib', kind: 'preference', body: 'Sam wants no Co-Authored-By Claude trailers or "Generated with Claude Code" lines in his commits or PRs.' },
  { key: 'mornings', kind: 'preference', body: 'Sam does not want calendar time blocks in the morning; schedule work blocks at noon or later.' },
  { key: 'location', kind: 'preference', body: 'For job applications, Sam uses San Francisco as his location for non-Chicago roles and Oakland, CA only for Chicago roles.' },
  { key: 'resume', kind: 'reference', body: 'Sam\'s resumes are ~/Downloads/SamRiveraResumeInternship.pdf for internships and ~/Downloads/SamRiveraResumeGrad.pdf for new grad roles.' },
  { key: 'onecompany', kind: 'preference', body: 'Sam applies to at most one role per company and never applies twice to the same company.' },
  { key: 'hear', kind: 'preference', body: 'On "How did you hear about us" questions, Sam picks Referral when offered, else campus, else company website.' },
  { key: 'greenhouse', kind: 'procedure', body: 'To fill Greenhouse react-select dropdowns: click the real input, type the option text, press Enter, then re-read the field; setting React state through the fiber only changes the display.', importance: 6 },
  { key: 'ashby', kind: 'procedure', body: 'On Ashby forms a picked option can show without committing: click the option for real, blur the field, and re-read the value before marking the application ready.', importance: 6 },
  { key: 'tabs', kind: 'preference', body: 'When filling job applications in Chrome, use one new tab per application, stop before Submit, and keep about five tabs open at once to save RAM.' },
  { key: 'devdir', kind: 'fact', body: 'All of Sam\'s code lives in ~/dev; ~/projects is a hidden symlink to it.' },
  { key: 'brain', kind: 'fact', body: 'Sam\'s second-brain vault is ~/brain, an Obsidian vault in its own private git repo samr/brain.' },
  { key: 'todoist', kind: 'fact', body: 'Sam keeps all tasks in a single Todoist list on the free plan with projects School, Career, Projects and Life.' },
  { key: 'gmail', kind: 'fact', body: 'The Gmail connector is Sam\'s personal Gmail account, not his Lakeshore school email; school mail is read through Chrome.' },
  { key: 'notetaker', kind: 'fact', scope: 'project:~/dev/notetaker', body: 'notetaker is an AI medical scribe; its wave2 branch is live on Google Cloud Run and main matches wave2.' },
  { key: 'vigil', kind: 'fact', scope: 'project:~/dev/vigil', body: 'vigil is a Go uptime monitor that Sam uses as a portfolio project.' },
  { key: 'persona', kind: 'fact', scope: 'project:~/dev/onboarding-demo', body: 'The onboarding-demo take-home uses Deepgram plus Claude for voice onboarding and is hosted on Cloud Run in project onboarding-demo.' },
  { key: 'burnerdecision', kind: 'decision', scope: 'project:~/dev/burner', body: 'For burner, Sam decided all AI runs on Claude with no local models, and photos use a curated Nano Banana recipe with a style reference.' },
  { key: 'sqlite', kind: 'decision', scope: 'project:~/dev/engram', body: 'engram stores memory in SQLite with FTS5 and local bge-small embeddings instead of a vector database, because the store is small and must work offline.' },
  { key: 'skhd', kind: 'fact', body: 'Sam launches Claude sessions with skhd hotkeys: Cmd+1 through Cmd+4, where Cmd+4 starts the apply run for handoffs and the top 15 roles.' },
  { key: 'chicago', kind: 'fact', body: 'Sam is pushing for Chicago winter and spring 2027 internships and co-ops between January and June 2027.' },
  { key: 'voice', kind: 'reference', body: 'Before writing anything as Sam, read ~/brain/me/voice.md, the canonical rules for his writing voice.' },
  { key: 'consumer', kind: 'profile', body: 'Sam wants to build his own exciting consumer AI product, not boring B2B software.' },
  { key: 'city-old', kind: 'profile', body: 'Sam lives in Oakland, California.' },
  { key: 'city-new', kind: 'profile', body: 'Sam moved to San Francisco in summer 2027 after graduating.', supersedes: 'city-old' },
  { key: 'editor-old', kind: 'preference', body: 'Sam uses VS Code as his main editor.' },
  { key: 'editor-new', kind: 'preference', body: 'Sam switched from VS Code to Zed as his main editor.', supersedes: 'editor-old' },
  { key: 'terminal', kind: 'fact', body: 'Sam uses the macOS Terminal.app, not iTerm or Ghostty.' },
  { key: 'ollama', kind: 'fact', body: 'Ollama is installed on Sam\'s Mac with qwen3:8b and nomic-embed-text, but the server is usually not running.' },
  { key: 'episode1', kind: 'episode', body: 'On 2026-10-06 Sam and Claude ran an apply session: filled 12 Greenhouse applications, stopped each before Submit, and logged them in the ledger.' },
];

interface Query {
  q: string;
  expect: string[];
  cat: 'paraphrase' | 'keyword' | 'update' | 'scope' | 'abstain' | 'sensitive' | 'multi';
  scope?: string;
  forbid?: string[];
}

export const QUERIES: Query[] = [
  { q: 'what name should I sign this email with', expect: ['name'], cat: 'paraphrase' },
  { q: 'when does he graduate', expect: ['grad'], cat: 'paraphrase' },
  { q: 'write a quick python helper function with good docstrings', expect: ['nocomments'], cat: 'paraphrase' },
  { q: 'draft a LinkedIn post about my internship and send it', expect: ['nosend'], cat: 'multi' },
  { q: 'commit these changes with a good message', expect: ['attrib'], cat: 'paraphrase' },
  { q: 'block out time tomorrow to study for the exam', expect: ['mornings'], cat: 'paraphrase' },
  { q: 'what location should I put on the Stripe application', expect: ['location'], cat: 'paraphrase' },
  { q: 'which resume file do I upload for a new grad role', expect: ['resume'], cat: 'keyword' },
  { q: 'I already applied to Datadog, should I apply to their other opening too?', expect: ['onecompany'], cat: 'paraphrase' },
  { q: 'how did you hear about us dropdown', expect: ['hear'], cat: 'keyword' },
  { q: 'the greenhouse dropdown value is not sticking', expect: ['greenhouse'], cat: 'keyword' },
  { q: 'ashby form option shows selected but does not save', expect: ['ashby'], cat: 'keyword' },
  { q: 'open the applications in chrome and fill them out', expect: ['tabs'], cat: 'paraphrase' },
  { q: 'where is my code folder', expect: ['devdir'], cat: 'paraphrase' },
  { q: 'save this note to my obsidian vault', expect: ['brain'], cat: 'paraphrase' },
  { q: 'add a task for this to my todo list', expect: ['todoist'], cat: 'paraphrase' },
  { q: 'check my school email for the registrar message', expect: ['gmail'], cat: 'paraphrase' },
  { q: 'where is notetaker deployed', expect: ['notetaker'], cat: 'scope', scope: 'project:~/dev/notetaker' },
  { q: 'why did we pick sqlite instead of a vector database', expect: ['sqlite'], cat: 'scope', scope: 'project:~/dev/engram' },
  { q: 'should burner use a local model for image generation', expect: ['burnerdecision'], cat: 'scope', scope: 'project:~/dev/burner' },
  { q: 'what does cmd+4 do', expect: ['skhd'], cat: 'keyword' },
  { q: 'what city does Sam live in now', expect: ['city-new'], forbid: ['city-old'], cat: 'update' },
  { q: 'which code editor do I use', expect: ['editor-new'], forbid: ['editor-old'], cat: 'update' },
  { q: 'what fragrances does he like', expect: ['cologne'], cat: 'paraphrase' },
  { q: 'any sports he plays on weekends', expect: ['sports'], cat: 'paraphrase' },
  { q: 'tell me about his work experience at Medscribe', expect: ['intern'], cat: 'keyword' },
  { q: 'write the cover letter in my voice', expect: ['voice'], cat: 'paraphrase' },
  { q: 'what kind of startup does he want to build', expect: ['consumer'], cat: 'paraphrase' },
  { q: 'is the local model server running', expect: ['ollama'], cat: 'paraphrase' },
  { q: 'what did we get done in the apply session on monday', expect: ['episode1'], cat: 'paraphrase' },
  { q: 'what medication is he on', expect: [], forbid: ['health'], cat: 'sensitive' },
  { q: 'what is the capital of Mongolia', expect: [], cat: 'abstain' },
  { q: 'explain how a B-tree index works in postgres', expect: [], cat: 'abstain' },
  { q: 'convert this json to yaml for me', expect: [], cat: 'abstain' },
  { q: 'what is 17 times 23', expect: [], cat: 'abstain' },
  { q: 'refactor the function to use async await', expect: [], cat: 'abstain' },
  { q: 'summarize the plot of Dune', expect: [], cat: 'abstain' },
  { q: 'fix the failing unit test in parser.ts', expect: [], cat: 'abstain' },
  { q: 'what is the weather like in Tokyo in April', expect: [], cat: 'abstain' },
  { q: 'translate good morning into spanish', expect: [], cat: 'abstain' },
];

export const GATE_CASES: [string, boolean][] = [
  ['ok', false],
  ['continue', false],
  ['thanks!', false],
  ['/compact', false],
  ['yes do it', false],
  ['go ahead', false],
  ['fix the login bug', true],
  ['what do I usually sign emails with', true],
  ['apply to the stripe role', true],
];

export interface EvalReport {
  floor: number;
  byCat: Record<string, { n: number; hit: number; clean: number }>;
  recallAt5: number;
  precision: number;
  abstainAcc: number;
  forbidViolations: number;
  mrr: number;
  gateAcc: number;
  failures: string[];
}

export async function seedEval(db: DB): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const s of SEEDS) {
    const r = await writeMemory(db, { body: s.body, kind: s.kind, scope: s.scope || 'global', sensitive: s.sensitive, importance: s.importance, trust: 'user', supersedes: s.supersedes ? [ids.get(s.supersedes)!] : undefined, embedMode: 'local', dedupe: false });
    ids.set(s.key, r.id!);
  }
  return ids;
}

export async function scoreEval(db: DB, ids: Map<string, string>, floor?: number): Promise<EvalReport> {
  const back = new Map([...ids].map(([k, v]) => [v, k]));
  const byCat: EvalReport['byCat'] = {};
  let hitsTotal = 0;
  let expectTotal = 0;
  let returned = 0;
  let relevantReturned = 0;
  let abstainN = 0;
  let abstainOk = 0;
  let forbid = 0;
  let rr = 0;
  let rrN = 0;
  const failures: string[] = [];
  for (const q of QUERIES) {
    const scope = q.scope || 'global';
    const r = await buildRecall(db, q.q, { scope, record: false, embedMode: 'local', floor });
    const got = r.ids.map((id) => back.get(id)!);
    const c = (byCat[q.cat] ||= { n: 0, hit: 0, clean: 0 });
    c.n++;
    const hit = q.expect.every((e) => got.includes(e));
    const bad = (q.forbid || []).some((f) => got.includes(f));
    if (bad) forbid++;
    if (q.expect.length) {
      expectTotal += q.expect.length;
      hitsTotal += q.expect.filter((e) => got.includes(e)).length;
      const rank = got.indexOf(q.expect[0]);
      rr += rank >= 0 ? 1 / (rank + 1) : 0;
      rrN++;
      returned += got.length;
      relevantReturned += got.filter((g) => q.expect.includes(g)).length;
      if (hit && !bad) c.hit++;
      if (got.length <= q.expect.length + 1) c.clean++;
      if (!hit || bad) failures.push(`[${q.cat}] "${q.q}" expected ${q.expect.join(',')} got ${got.join(',') || 'nothing'}`);
    } else {
      abstainN++;
      const ok = got.length === 0 && !bad;
      if (ok) {
        abstainOk++;
        c.hit++;
        c.clean++;
      } else failures.push(`[${q.cat}] "${q.q}" should be empty, got ${got.join(',')}`);
    }
  }
  let gateOk = 0;
  for (const [p, want] of GATE_CASES) if (recallGate(p).recall === want) gateOk++;
  return {
    floor: floor ?? loadConfig().recallFloor,
    byCat,
    recallAt5: hitsTotal / Math.max(1, expectTotal),
    precision: relevantReturned / Math.max(1, returned),
    abstainAcc: abstainOk / Math.max(1, abstainN),
    forbidViolations: forbid,
    mrr: rr / Math.max(1, rrN),
    gateAcc: gateOk / GATE_CASES.length,
    failures,
  };
}

export async function runEval(o: { json?: boolean; verbose?: boolean; sweep?: number[] }): Promise<EvalReport[]> {
  const saved = { home: process.env.ENGRAM_HOME, embed: process.env.ENGRAM_EMBED, port: process.env.ENGRAM_PORT, db: process.env.ENGRAM_DB, models: process.env.ENGRAM_MODELS };
  const realModels = loadConfig().home + '/models';
  const dir = mkdtempSync(join(tmpdir(), 'engram-eval-'));
  closeAll();
  process.env.ENGRAM_HOME = dir;
  process.env.ENGRAM_MODELS = saved.models || realModels;
  process.env.ENGRAM_EMBED = 'on';
  process.env.ENGRAM_PORT = '1';
  delete process.env.ENGRAM_DB;
  resetConfigCache();
  setEmbedMode('local');
  const reports: EvalReport[] = [];
  try {
    const db = openDb();
    const ids = await seedEval(db);
    const floors = o.sweep?.length ? o.sweep : [undefined as unknown as number];
    for (const f of floors) {
      const r = await scoreEval(db, ids, f);
      reports.push(r);
      if (o.json) continue;
      console.log(`\nrecall floor ${r.floor.toFixed(2)}: recall@5 ${(r.recallAt5 * 100).toFixed(0)}%  precision ${(r.precision * 100).toFixed(0)}%  abstention ${(r.abstainAcc * 100).toFixed(0)}%  MRR ${r.mrr.toFixed(2)}  forbidden ${r.forbidViolations}  gate ${(r.gateAcc * 100).toFixed(0)}%`);
      for (const [cat, c] of Object.entries(r.byCat)) console.log(`  ${cat.padEnd(10)} ${c.hit}/${c.n} correct, ${c.clean}/${c.n} without extra noise`);
      if (o.verbose || floors.length === 1) for (const f of r.failures) console.log('  miss ' + f);
    }
    if (o.json) console.log(JSON.stringify(reports, null, 2));
  } finally {
    closeAll();
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries({ ENGRAM_HOME: saved.home, ENGRAM_EMBED: saved.embed, ENGRAM_PORT: saved.port, ENGRAM_DB: saved.db, ENGRAM_MODELS: saved.models })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfigCache();
  }
  return reports;
}
