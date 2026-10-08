import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { loadConfig } from './config.ts';

type AttrValue = string | number | boolean | string[];
export type Attrs = Record<string, AttrValue | null | undefined>;

export interface SpanContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

interface Finished {
  ctx: SpanContext;
  parentId?: string;
  name: string;
  kind: number;
  startNs: bigint;
  endNs: bigint;
  attrs: Attrs;
  status: { code: number; message?: string };
}

const MAX_ATTR = 32000;
let queue: Finished[] = [];
let timer: NodeJS.Timeout | undefined;
const inflight = new Set<Promise<void>>();
export const traceStats = { exported: 0, dropped: 0, lastError: '' as string | undefined };
let fetchImpl: typeof fetch = (...a) => fetch(...a);

export function setTraceFetch(f: typeof fetch | null): void {
  fetchImpl = f ?? ((...a) => fetch(...a));
}

function nowNs(): bigint {
  return BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
}

function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '::1' || h === '[::1]' || h.startsWith('127.');
  } catch {
    return false;
  }
}

function parseHeaders(v: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (v ?? '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) out[decodeURIComponent(pair.slice(0, i).trim())] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

export interface TraceSettings {
  endpoint: string;
  headers: Record<string, string>;
  captureContent: boolean;
  serviceName: string;
}

export function traceSettings(): TraceSettings | null {
  if (/^(0|false|off)$/i.test(process.env.ENGRAM_TELEMETRY ?? '') || /^(1|true)$/i.test(process.env.OTEL_SDK_DISABLED ?? '')) return null;
  const t = loadConfig().telemetry ?? {};
  const endpoint = (process.env.ENGRAM_OTEL_ENDPOINT || t.endpoint || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '').replace(/\/$/, '');
  if (!endpoint || t.enabled === false) return null;
  const envCapture = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
  return {
    endpoint: /\/v1\/traces$/.test(endpoint) ? endpoint : `${endpoint}/v1/traces`,
    headers: { ...parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS), ...(t.headers ?? {}) },
    captureContent: t.captureContent ?? (envCapture ? /^(1|true)$/i.test(envCapture) : isLoopback(endpoint)),
    serviceName: t.serviceName || 'engram',
  };
}

export function parseTraceparent(v: unknown): SpanContext | null {
  const m = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/i.exec(String(v ?? '').trim());
  if (!m || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return null;
  return { traceId: m[1].toLowerCase(), spanId: m[2].toLowerCase(), sampled: (parseInt(m[3], 16) & 1) === 1 };
}

export function formatTraceparent(c: SpanContext): string {
  return `00-${c.traceId}-${c.spanId}-${c.sampled ? '01' : '00'}`;
}

export class Span {
  readonly ctx: SpanContext;
  readonly name: string;
  readonly attrs: Attrs;
  private parentId?: string;
  private kind: number;
  private start = nowNs();
  private done = false;
  private settings: TraceSettings | null;

  constructor(name: string, parent: SpanContext | null, attrs: Attrs = {}, kind = 2, settings = traceSettings()) {
    this.name = name;
    this.kind = kind;
    this.settings = settings;
    this.ctx = { traceId: parent?.traceId ?? randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'), sampled: parent ? parent.sampled : true };
    this.parentId = parent?.spanId;
    this.attrs = attrs;
  }

  get active(): boolean {
    return !!this.settings;
  }

  set(attrs: Attrs): this {
    Object.assign(this.attrs, attrs);
    return this;
  }

  content(key: string, v: unknown): this {
    if (!this.settings?.captureContent || v === undefined || v === null) return this;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    this.attrs[key] = s.length > MAX_ATTR ? s.slice(0, MAX_ATTR) + '…' : s;
    return this;
  }

  end(error?: string): void {
    if (this.done) return;
    this.done = true;
    if (!this.settings || !this.ctx.sampled) return;
    if (error) this.attrs['error.type'] = this.attrs['error.type'] ?? 'error';
    push({ ctx: this.ctx, parentId: this.parentId, name: this.name, kind: this.kind, startNs: this.start, endNs: nowNs(), attrs: this.attrs, status: error ? { code: 2, message: error.slice(0, 1000) } : { code: 1 } }, this.settings);
  }
}

function anyValue(v: AttrValue): Record<string, unknown> {
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map((x) => ({ stringValue: String(x) })) } };
  return { stringValue: v };
}

function encode(a: Attrs): { key: string; value: Record<string, unknown> }[] {
  return Object.entries(a)
    .filter(([, v]) => v !== null && v !== undefined && !(typeof v === 'number' && !Number.isFinite(v)))
    .map(([key, v]) => ({ key, value: anyValue(v as AttrValue) }));
}

function push(s: Finished, settings: TraceSettings): void {
  if (queue.length > 5000) {
    traceStats.dropped++;
    return;
  }
  queue.push(s);
  if (queue.length >= 200) void flushTraces(settings);
  else if (!timer) {
    timer = setTimeout(() => {
      timer = undefined;
      void flushTraces(settings);
    }, 1000);
    timer.unref?.();
  }
}

export function flushTraces(settings = traceSettings()): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  const batch = queue.splice(0);
  if (batch.length && settings) {
    const p = send(batch, settings).finally(() => inflight.delete(p));
    inflight.add(p);
  }
  return Promise.all([...inflight]).then(() => {});
}

async function send(batch: Finished[], settings: TraceSettings): Promise<void> {
  const body = {
    resourceSpans: [
      {
        resource: { attributes: encode({ 'service.name': settings.serviceName, 'service.version': '0.1.0', 'host.name': hostname(), 'process.pid': process.pid }) },
        scopeSpans: [
          {
            scope: { name: 'engram', version: '0.1.0' },
            spans: batch.map((s) => ({
              traceId: s.ctx.traceId,
              spanId: s.ctx.spanId,
              parentSpanId: s.parentId ?? '',
              name: s.name,
              kind: s.kind,
              startTimeUnixNano: s.startNs.toString(),
              endTimeUnixNano: s.endNs.toString(),
              attributes: encode(s.attrs),
              status: s.status,
            })),
          },
        ],
      },
    ],
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(settings.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...settings.headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        traceStats.exported += batch.length;
        traceStats.lastError = undefined;
        return;
      }
      traceStats.lastError = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      traceStats.lastError = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 200 * 2 ** attempt).unref?.());
  }
  traceStats.dropped += batch.length;
}

const MEMORY_OPS: Record<string, [string, string]> = {
  memory_search: ['search_memory', 'search'],
  memory_context: ['read_memory', 'read'],
  memory_get: ['read_memory', 'read'],
  memory_write: ['create_memory', 'create'],
  memory_update: ['update_memory', 'update'],
  memory_forget: ['delete_memory', 'delete'],
};

export function memoryToolSpan(tool: string): [string, string] | null {
  return MEMORY_OPS[tool] ?? null;
}

const active = new AsyncLocalStorage<Span>();

export function activeSpan(): Span | undefined {
  return active.getStore();
}

export function withSpan<T>(span: Span | null | undefined, fn: () => T): T {
  return span ? active.run(span, fn) : fn();
}
