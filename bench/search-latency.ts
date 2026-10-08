import { freshHome } from '../test/helpers.ts';
import { embedLocal, setEmbedMode } from '../src/embed.ts';
import { toBlob } from '../src/util.ts';
import { tx } from '../src/db.ts';
import { searchMemories } from '../src/search.ts';
import { buildRecall, buildDigest } from '../src/digest.ts';
import { memoryHash } from '../src/store.ts';
const h = freshHome(true); setEmbedMode('local');
const topics = ['deploy','resume','cologne','basketball','sqlite','react','calendar','email','gmail','todoist','python','golang','kafka','postgres','docker','cloud run','interview','pickleball','obsidian','raycast'];
const N = 10000; const texts: string[] = [];
for (let i = 0; i < N; i++) texts.push(`Memory ${i}: note about ${topics[i % 20]} and ${topics[(i * 7) % 20]} variant ${i % 97} with detail ${i * 31 % 1000}`);
let t = Date.now(); const vecs = (await embedLocal(texts))!; console.log('embed 10k ms', Date.now() - t);
const now = new Date().toISOString();
const st = h.db.prepare("insert into memories (id, kind, scope, title, body, hash, created_at, updated_at, embedding, embed_model) values (?,?,?,?,?,?,?,?,?,?)");
tx(h.db, () => texts.forEach((x, i) => st.run('m_p' + i, 'fact', 'global', x.slice(0, 60), x, memoryHash('fact','global',x), now, now, toBlob(vecs[i]), 'Xenova/bge-small-en-v1.5')));
for (const q of ['how do we deploy to cloud run', 'which resume do I use', 'what is the capital of france']) {
  t = Date.now(); await searchMemories(h.db, { query: q, limit: 8 }); const first = Date.now() - t;
  t = Date.now(); const r = await buildRecall(h.db, q, { scope: 'global', record: false }); console.log(q, '| first search ms', first, '| warm recall ms', Date.now() - t, '| hits', r.ids.length);
}
t = Date.now(); const d = buildDigest(h.db, { scope: 'global', record: false }); console.log('digest ms', Date.now() - t, 'tokens', d.tokens);
h.cleanup();
