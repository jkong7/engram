import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { freshHome } from './helpers.ts';
import { chunkMarkdown, indexSources, searchDocs } from '../src/docs.ts';
import { saveConfigPatch } from '../src/config.ts';

test('markdown chunking keeps headings as breadcrumbs', () => {
  const c = chunkMarkdown('/v/a.md', '---\ntags: x\n---\n# Title\nintro paragraph that is long enough\n## Section A\nbody of section a with words\n## Section B\nbody of section b with words');
  assert.deepEqual(c.map((x) => x.heading), ['Title', 'Title > Section A', 'Title > Section B']);
});

test('index a vault, honor excludes, reindex only changed files, drop deleted files', async () => {
  const h = freshHome(false);
  const vault = join(h.dir, 'vault');
  mkdirSync(join(vault, 'journal'), { recursive: true });
  mkdirSync(join(vault, 'projects'), { recursive: true });
  writeFileSync(join(vault, 'projects', 'sidebet.md'), '# sidebet\n## Stack\nsidebet is a prediction market app written in Go with SQLite.');
  writeFileSync(join(vault, 'journal', 'today.md'), '# today\nprivate journal entry about prediction markets');
  saveConfigPatch({ sources: [{ path: vault, exclude: ['journal'] }] });
  const r1 = await indexSources(h.db);
  assert.equal(r1.files, 1);
  const hits = await searchDocs(h.db, 'prediction market stack');
  assert.equal(hits.length, 1);
  assert.match(hits[0].heading, /Stack/);
  const r2 = await indexSources(h.db);
  assert.equal(r2.files, 0);
  rmSync(join(vault, 'projects', 'sidebet.md'));
  const r3 = await indexSources(h.db);
  assert.equal(r3.removed, 1);
  h.cleanup();
});
