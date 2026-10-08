import { createHash, randomBytes } from 'node:crypto';

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix = 'm'): string {
  const t = Date.now().toString(36).slice(-5);
  const r = randomBytes(4).readUInt32BE(0).toString(36).padStart(4, '0').slice(0, 4);
  return `${prefix}_${t}${r}`;
}

export function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

export function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/g, '').trim();
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.8);
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

export function daysBetween(a: string | Date, b: string | Date = new Date()): number {
  const ta = typeof a === 'string' ? Date.parse(a) : a.getTime();
  const tb = typeof b === 'string' ? Date.parse(b) : b.getTime();
  return (tb - ta) / 86400000;
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}

export const STOPWORDS = new Set(
  `a about above after again against all am an and any are aren't as at be because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves also just like get got really thing things want wanna gonna please thanks thank ok okay yeah yes hey hi hello um uh so do does lets let make sure now then use using`.split(
    /\s+/,
  ),
);

export function contentTerms(text: string): string[] {
  const words = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .match(/[a-z0-9][a-z0-9_+#.-]*[a-z0-9+#]|[a-z0-9]/g);
  if (!words) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    if (w.length < 2 && !/\d/.test(w)) continue;
    if (STOPWORDS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

export function stem(word: string): string {
  let w = word;
  for (const suf of ['ingly', 'edly', 'ing', 'ers', 'ies', 'ied', 'ed', 'es', 'er', 'ly', 's']) {
    if (w.length > suf.length + 2 && w.endsWith(suf)) {
      w = w.slice(0, -suf.length);
      if (suf === 'ies' || suf === 'ied') w += 'y';
      break;
    }
  }
  return w;
}

export function ftsQuery(text: string, maxTerms = 24): string | null {
  const terms = contentTerms(text).slice(0, maxTerms);
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

export function safeJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(b: Uint8Array | null | undefined): Float32Array | null {
  if (!b || !b.byteLength) return null;
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
