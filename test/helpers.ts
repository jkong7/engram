import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resetConfigCache } from '../src/config.ts';
import { openDb, closeAll } from '../src/db.ts';

export function freshHome(embed = false) {
  closeAll();
  const dir = mkdtempSync(join(tmpdir(), 'engram-test-'));
  process.env.ENGRAM_HOME = dir;
  process.env.ENGRAM_MODELS = resolve(import.meta.dirname, '..', '.cache', 'models');
  process.env.ENGRAM_EMBED = embed ? 'on' : 'off';
  process.env.ENGRAM_PORT = String(17000 + Math.floor(Math.random() * 2000));
  process.env.ENGRAM_LLM = 'none';
  resetConfigCache();
  const db = openDb();
  return {
    dir,
    db,
    cleanup() {
      closeAll();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
