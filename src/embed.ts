import { loadConfig, paths, authToken } from './config.ts';
import { withTimeout } from './util.ts';

type Extractor = (texts: string[], opts: Record<string, unknown>) => Promise<{ tolist(): number[][] }>;

let extractor: Extractor | null = null;
let loading: Promise<Extractor | null> | null = null;
let failed = false;

export function embedModelName(): string {
  return loadConfig().embed.model;
}

export function embedEnabled(): boolean {
  return loadConfig().embed.enabled && !failed;
}

async function load(): Promise<Extractor | null> {
  const cfg = loadConfig();
  if (!cfg.embed.enabled || failed) return null;
  try {
    const mod = await import('@huggingface/transformers');
    mod.env.cacheDir = paths().models;
    mod.env.allowRemoteModels = process.env.ENGRAM_OFFLINE !== '1';
    const pipe = await mod.pipeline('feature-extraction', cfg.embed.model, { dtype: 'q8' });
    return pipe as unknown as Extractor;
  } catch (err) {
    failed = true;
    if (process.env.ENGRAM_DEBUG) console.error('engram: embeddings unavailable:', (err as Error).message);
    return null;
  }
}

export function localEmbedderLoaded(): boolean {
  return extractor !== null;
}

export async function getEmbedder(): Promise<Extractor | null> {
  if (extractor) return extractor;
  if (!loading) loading = load().then((e) => (extractor = e));
  return loading;
}

export async function embedLocal(texts: string[]): Promise<Float32Array[] | null> {
  if (!texts.length) return [];
  const fe = await getEmbedder();
  if (!fe) return null;
  const cfg = loadConfig();
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32).map((t) => t.slice(0, 2000));
    const res = await fe(batch, { pooling: cfg.embed.pooling, normalize: true });
    for (const row of res.tolist()) out.push(Float32Array.from(row));
  }
  return out;
}

export async function embedViaDaemon(texts: string[], timeoutMs = 1500): Promise<Float32Array[] | null> {
  const cfg = loadConfig();
  const call = (async () => {
    try {
      const res = await fetch(`http://${cfg.host}:${cfg.port}/v1/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${authToken()}` },
        body: JSON.stringify({ texts }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { vectors: number[][]; model: string };
      if (data.model !== cfg.embed.model) return null;
      return data.vectors.map((v) => Float32Array.from(v));
    } catch {
      return null;
    }
  })();
  return withTimeout(call, timeoutMs + 100, null);
}

export type EmbedMode = 'local' | 'daemon' | 'daemon-then-local' | 'none';

let defaultMode: EmbedMode = 'daemon-then-local';

export function setEmbedMode(mode: EmbedMode): void {
  defaultMode = mode;
}

export function getEmbedMode(): EmbedMode {
  return defaultMode;
}

export async function embed(texts: string[], mode: EmbedMode = defaultMode): Promise<Float32Array[] | null> {
  if (!embedEnabled() || mode === 'none') return null;
  if (mode === 'local') return embedLocal(texts);
  if (localEmbedderLoaded()) return embedLocal(texts);
  const viaDaemon = await embedViaDaemon(texts);
  if (viaDaemon) return viaDaemon;
  if (mode === 'daemon') return null;
  return embedLocal(texts);
}

export async function embedOne(text: string, mode?: EmbedMode): Promise<Float32Array | null> {
  const out = await embed([text], mode);
  return out ? out[0] : null;
}
