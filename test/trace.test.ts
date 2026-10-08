import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { freshHome } from './helpers.ts';
import { createHttpHandler } from '../src/server.ts';
import { authToken } from '../src/config.ts';
import { flushTraces, setTraceFetch, Span, withSpan, activeSpan } from '../src/trace.ts';

const PARENT = { traceId: 'ab'.repeat(16), spanId: 'cd'.repeat(8) };
const TP = `00-${PARENT.traceId}-${PARENT.spanId}-01`;

function attrs(s: any): Record<string, unknown> {
  return Object.fromEntries(s.attributes.map((a: any) => [a.key, Object.values(a.value)[0]]));
}

test('daemon requests become memory spans that join the caller trace', async () => {
  const home = freshHome();
  const exported: any[] = [];
  process.env.ENGRAM_OTEL_ENDPOINT = 'http://127.0.0.1:4318';
  setTraceFetch((async (_url: string, init: RequestInit) => {
    for (const rs of JSON.parse(String(init.body)).resourceSpans) for (const ss of rs.scopeSpans) exported.push(...ss.spans);
    return new Response('{}', { status: 200 });
  }) as typeof fetch);
  const server = createServer(createHttpHandler(home.db));
  const port = Number(process.env.ENGRAM_PORT);
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}`;
  const h = { authorization: `Bearer ${authToken()}`, 'content-type': 'application/json' };
  try {
    const w = await fetch(`${base}/v1/memories`, { method: 'POST', headers: { ...h, traceparent: TP }, body: JSON.stringify({ text: 'The heron cluster runs the billing service', kind: 'fact', trust: 'user' }) });
    assert.equal(w.status, 200);
    await fetch(`${base}/v1/recall`, { method: 'POST', headers: { ...h, traceparent: TP }, body: JSON.stringify({ prompt: 'which cluster runs billing?', session_id: 's-1' }) });
    await fetch(`${base}/v1/hooks/claude-code/UserPromptSubmit`, { method: 'POST', headers: h, body: JSON.stringify({ session_id: 's-2', prompt: 'which cluster runs billing?', cwd: home.dir }) });
    await fetch(`${base}/v1/hooks/claude-code/Notification`, { method: 'POST', headers: h, body: JSON.stringify({ session_id: 's-2' }) });
    await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...h, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'heron' }, _meta: { traceparent: TP } } }),
    }).then((r) => r.text());
    await fetch(`${base}/v1/stats`, { headers: h });
    await new Promise((r) => setTimeout(r, 20));
    await flushTraces();

    const byOp = (op: string) => exported.filter((s) => attrs(s)['blackbox.memory.op'] === op);
    const [create] = byOp('create');
    assert.equal(create.name, 'create_memory engram');
    assert.equal(create.traceId, PARENT.traceId);
    assert.equal(create.parentSpanId, PARENT.spanId);
    assert.equal(attrs(create)['engram.write.status'], 'created');
    assert.equal(create.status.code, 1);

    const recalls = byOp('recall');
    assert.equal(recalls.length, 2);
    const viaRest = recalls.find((s) => attrs(s)['session.id'] === 's-1')!;
    assert.equal(viaRest.parentSpanId, PARENT.spanId);
    assert.equal(attrs(viaRest)['gen_ai.memory.query.text'], 'which cluster runs billing?');
    const viaHook = recalls.find((s) => attrs(s)['session.id'] === 's-2')!;
    assert.equal(viaHook.parentSpanId, '');
    assert.equal(attrs(viaHook)['engram.harness'], 'claude-code');

    const [search] = byOp('search');
    assert.equal(search.parentSpanId, PARENT.spanId, 'MCP tools/call honours params._meta.traceparent');
    assert.equal(attrs(search)['gen_ai.tool.name'], 'memory_search');

    assert.ok(!exported.some((s) => /Notification|stats/.test(s.name)), 'unparented non-memory hooks and admin reads are not traced');
  } finally {
    server.close();
    setTraceFetch(null);
    delete process.env.ENGRAM_OTEL_ENDPOINT;
    home.cleanup();
  }
});

test('tracing is a no-op without an endpoint and spans nest through withSpan', async () => {
  const home = freshHome();
  try {
    const s = new Span('x', null);
    assert.equal(s.active, false);
    s.end();
    process.env.ENGRAM_OTEL_ENDPOINT = 'http://127.0.0.1:4318';
    const outer = new Span('outer', null);
    const inner = withSpan(outer, () => new Span('inner', activeSpan()!.ctx));
    assert.equal(inner.ctx.traceId, outer.ctx.traceId);
    process.env.ENGRAM_TELEMETRY = 'off';
    assert.equal(new Span('y', null).active, false);
  } finally {
    delete process.env.ENGRAM_OTEL_ENDPOINT;
    delete process.env.ENGRAM_TELEMETRY;
    home.cleanup();
  }
});
