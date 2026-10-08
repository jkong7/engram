import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const cache = new Map<string, string>();

function findRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function tildify(p: string): string {
  const home = homedir();
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~/' + p.slice(home.length + 1);
  return p;
}

export function scopeForCwd(cwd: string | null | undefined): string {
  if (!cwd) return 'global';
  const hit = cache.get(cwd);
  if (hit) return hit;
  let real = resolve(cwd);
  try {
    real = realpathSync(real);
  } catch {}
  const home = homedir();
  let scope = 'global';
  if (real !== home && real !== '/' && !real.startsWith('/private/tmp') && !real.startsWith('/tmp')) {
    const root = findRoot(real);
    if (root && root !== home) scope = 'project:' + tildify(root);
  }
  cache.set(cwd, scope);
  return scope;
}

export function scopeLabel(scope: string): string {
  if (scope === 'global') return 'global';
  if (scope.startsWith('project:')) return basename(scope.slice(8)) || scope.slice(8);
  return scope;
}

export function normalizeScope(input: string | null | undefined, cwd?: string | null): string {
  if (!input || input === 'auto') return cwd ? scopeForCwd(cwd) : 'global';
  const s = input.trim();
  if (s === 'global' || s === 'user') return 'global';
  if (s === 'project' || s === 'here' || s === 'repo') return cwd ? scopeForCwd(cwd) : 'global';
  if (s.startsWith('project:')) return s;
  if (s.startsWith('/') || s.startsWith('~')) {
    const abs = s.startsWith('~') ? join(homedir(), s.slice(1)) : s;
    return scopeForCwd(abs);
  }
  return 'project:' + s;
}

export function scopeMatches(memScope: string, active: string): number {
  if (memScope === 'global') return 1;
  if (memScope === active) return 1.15;
  if (active !== 'global' && memScope.startsWith('project:') && active.startsWith('project:')) {
    const a = memScope.slice(8);
    const b = active.slice(8);
    if (b.startsWith(a + '/') || a.startsWith(b + '/')) return 1.05;
    if (basename(a) === basename(b)) return 1.05;
  }
  return 0.55;
}
