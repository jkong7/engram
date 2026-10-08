import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { runEval } from '../src/eval.ts';

test('retrieval benchmark stays above quality bars', async () => {
  process.env.ENGRAM_MODELS = resolve(import.meta.dirname, '..', '.cache', 'models');
  const [r] = await runEval({ json: true });
  assert.ok(r.recallAt5 >= 0.9, `recall ${r.recallAt5}`);
  assert.ok(r.precision >= 0.75, `precision ${r.precision}`);
  assert.ok(r.abstainAcc >= 0.88, `abstention ${r.abstainAcc}`);
  assert.equal(r.forbidViolations, 0);
  assert.equal(r.gateAcc, 1);
});
