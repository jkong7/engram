import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, symlinkSync, unlinkSync, lstatSync, readlinkSync, rmSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, paths, authToken } from './config.ts';
import { openDb } from './db.ts';
import { stats } from './store.ts';
import { resolveProvider } from './llm.ts';
import { getEmbedder, embedModelName } from './embed.ts';
import { nowIso } from './util.ts';

const HOME = homedir();
const BIN = resolve(import.meta.dirname, '..', 'bin', 'engram.js');
function stableNode(): string {
  const real = realpathSync(process.execPath);
  const dirs = [...(process.env.PATH || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const d of dirs) {
    if (!d) continue;
    const p = join(d, 'node');
    try {
      if (existsSync(p) && realpathSync(p) === real && !p.includes('/Cellar/')) return p;
    } catch {}
  }
  return process.execPath;
}

const NODE = stableNode();

function q(s: string): string {
  return /^[\w./:@-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function hookCommand(harness: string, event: string): string {
  return `${q(NODE)} ${q(BIN)} hook ${harness} ${event}`;
}

function mcpArgs(harness: string): string[] {
  return [BIN, 'mcp', '--harness', harness];
}

interface Opts {
  dryRun?: boolean;
}

function backupFile(file: string): void {
  if (!existsSync(file)) return;
  const dir = join(paths().backups, 'config');
  mkdirSync(dir, { recursive: true });
  copyFileSync(file, join(dir, `${file.replace(HOME, '').replace(/[\/\\]/g, '_')}.${nowIso().replace(/[:.]/g, '-')}`));
}

function readJson(file: string): Record<string, any> {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON; fix it or remove it, then retry`);
  }
}

function writeJson(file: string, data: unknown, o: Opts, label: string): void {
  const text = JSON.stringify(data, null, 2) + '\n';
  if (o.dryRun) {
    console.log(`[dry-run] would write ${file} (${label})\n${text}`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  backupFile(file);
  writeFileSync(file, text);
  console.log(`wrote ${file} (${label})`);
}

function writeText(file: string, text: string, o: Opts, label: string): void {
  if (o.dryRun) {
    console.log(`[dry-run] would write ${file} (${label})`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  backupFile(file);
  writeFileSync(file, text);
  console.log(`wrote ${file} (${label})`);
}

const isOurs = (cmd: unknown) => typeof cmd === 'string' && cmd.includes(BIN.split('/').slice(-2).join('/')) && cmd.includes(' hook ');
const isOursLoose = (cmd: unknown) => typeof cmd === 'string' && /engram(\.js)?['"]? hook /.test(cmd);

function stripOurHooks(hooks: Record<string, any[]>): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const [event, groups] of Object.entries(hooks || {})) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => {
        if (g && Array.isArray(g.hooks)) return { ...g, hooks: g.hooks.filter((h: any) => !(isOurs(h.command) || isOursLoose(h.command))) };
        if (g && typeof g.command === 'string') return isOurs(g.command) || isOursLoose(g.command) ? null : g;
        return g;
      })
      .filter((g) => g && (!Array.isArray(g.hooks) || g.hooks.length));
    if (kept.length) out[event] = kept;
  }
  return out;
}

const CLAUDE_EVENTS: [string, Record<string, unknown>][] = [
  ['SessionStart', { timeout: 15 }],
  ['UserPromptSubmit', { timeout: 15 }],
  ['Stop', { timeout: 15 }],
  ['PreCompact', { timeout: 30 }],
  ['PostCompact', { timeout: 10 }],
  ['SessionEnd', { timeout: 15 }],
];

function claudeSettingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude'), 'settings.json');
}

function installClaudeCode(o: Opts): void {
  const file = claudeSettingsPath();
  const s = readJson(file);
  const hooks = stripOurHooks(s.hooks || {});
  for (const [event, extra] of CLAUDE_EVENTS) {
    hooks[event] = [...(hooks[event] || []), { hooks: [{ type: 'command', command: hookCommand('claude-code', event), ...extra }] }];
  }
  s.hooks = hooks;
  if (!s.cleanupPeriodDays || s.cleanupPeriodDays < 90) s.cleanupPeriodDays = 365;
  writeJson(file, s, o, 'Claude Code hooks');
  const claude = spawnSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();
  if (!claude) return console.log('claude CLI not found; add the MCP server manually: claude mcp add -s user engram -- ' + [NODE, ...mcpArgs('claude-code')].map(q).join(' '));
  if (o.dryRun) return console.log(`[dry-run] would run: claude mcp add -s user engram -- ${[NODE, ...mcpArgs('claude-code')].map(q).join(' ')}`);
  spawnSync(claude, ['mcp', 'remove', '-s', 'user', 'engram'], { encoding: 'utf8' });
  const r = spawnSync(claude, ['mcp', 'add', '-s', 'user', 'engram', '--', NODE, ...mcpArgs('claude-code')], { encoding: 'utf8' });
  console.log(r.status === 0 ? 'registered MCP server "engram" for Claude Code (user scope)' : `claude mcp add failed: ${r.stderr || r.stdout}`);
}

function uninstallClaudeCode(o: Opts): void {
  const file = claudeSettingsPath();
  if (existsSync(file)) {
    const s = readJson(file);
    s.hooks = stripOurHooks(s.hooks || {});
    if (!Object.keys(s.hooks).length) delete s.hooks;
    writeJson(file, s, o, 'removed engram hooks');
  }
  if (!o.dryRun) spawnSync('/bin/sh', ['-lc', 'claude mcp remove -s user engram'], { encoding: 'utf8' });
  console.log('removed Claude Code MCP server registration');
}

function codexHome(): string {
  return process.env.CODEX_HOME || join(HOME, '.codex');
}

function tomlSetTable(text: string, header: string, body: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === header);
  const block = [header, ...body.trim().split('\n')];
  if (start < 0) return (text.trimEnd() + '\n\n' + block.join('\n') + '\n').replace(/^\n+/, '');
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  while (end > start + 1 && lines[end - 1].trim() === '') end--;
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n');
}

function tomlRemoveTables(text: string, prefix: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const l of lines) {
    if (/^\s*\[/.test(l)) skipping = l.trim() === prefix || l.trim().startsWith(prefix.slice(0, -1) + '.');
    if (!skipping) out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

const CODEX_EVENTS: [string, Record<string, unknown>][] = [
  ['SessionStart', { timeout: 15, matcher: 'startup|resume|clear|compact' }],
  ['UserPromptSubmit', { timeout: 15 }],
  ['Stop', { timeout: 20 }],
  ['PreCompact', { timeout: 30 }],
  ['PostCompact', { timeout: 10 }],
  ['SessionEnd', { timeout: 1 }],
];

function installCodex(o: Opts): void {
  const cfgFile = join(codexHome(), 'config.toml');
  const text = existsSync(cfgFile) ? readFileSync(cfgFile, 'utf8') : '';
  const body = `command = ${JSON.stringify(NODE)}\nargs = ${JSON.stringify(mcpArgs('codex'))}\nstartup_timeout_sec = 20\ntool_timeout_sec = 60`;
  let next = tomlRemoveTables(text, '[mcp_servers.engram]');
  next = tomlSetTable(next, '[mcp_servers.engram]', body);
  writeText(cfgFile, next.endsWith('\n') ? next : next + '\n', o, 'Codex MCP server');
  const hooksFile = join(codexHome(), 'hooks.json');
  const h = readJson(hooksFile);
  const hooks = stripOurHooks(h.hooks || {});
  for (const [event, extra] of CODEX_EVENTS) {
    const { matcher, ...rest } = extra as { matcher?: string };
    hooks[event] = [...(hooks[event] || []), { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: hookCommand('codex', event), ...rest }] }];
  }
  writeJson(hooksFile, { ...h, hooks }, o, 'Codex hooks');
  console.log('Codex: open codex and run /hooks to review and trust the engram hooks (Codex requires approval, and again after any hook edit).');
}

function uninstallCodex(o: Opts): void {
  const cfgFile = join(codexHome(), 'config.toml');
  if (existsSync(cfgFile)) writeText(cfgFile, tomlRemoveTables(readFileSync(cfgFile, 'utf8'), '[mcp_servers.engram]'), o, 'removed engram MCP server');
  const hooksFile = join(codexHome(), 'hooks.json');
  if (existsSync(hooksFile)) {
    const h = readJson(hooksFile);
    writeJson(hooksFile, { ...h, hooks: stripOurHooks(h.hooks || {}) }, o, 'removed engram hooks');
  }
}

function installCursor(o: Opts): void {
  const dir = join(HOME, '.cursor');
  const mcpFile = join(dir, 'mcp.json');
  const m = readJson(mcpFile);
  m.mcpServers = { ...(m.mcpServers || {}), engram: { command: NODE, args: mcpArgs('cursor') } };
  writeJson(mcpFile, m, o, 'Cursor MCP server');
  const hooksFile = join(dir, 'hooks.json');
  const h = readJson(hooksFile);
  const hooks = stripOurHooks(h.hooks || {});
  for (const event of ['sessionStart', 'beforeSubmitPrompt', 'afterAgentResponse', 'preCompact', 'stop', 'sessionEnd']) {
    hooks[event] = [...(hooks[event] || []), { command: hookCommand('cursor', event), timeout: event === 'sessionStart' ? 15 : 10 }];
  }
  writeJson(hooksFile, { version: 1, ...h, hooks }, o, 'Cursor hooks');
}

function uninstallCursor(o: Opts): void {
  const dir = join(HOME, '.cursor');
  const mcpFile = join(dir, 'mcp.json');
  if (existsSync(mcpFile)) {
    const m = readJson(mcpFile);
    if (m.mcpServers) delete m.mcpServers.engram;
    writeJson(mcpFile, m, o, 'removed engram MCP server');
  }
  const hooksFile = join(dir, 'hooks.json');
  if (existsSync(hooksFile)) {
    const h = readJson(hooksFile);
    writeJson(hooksFile, { ...h, hooks: stripOurHooks(h.hooks || {}) }, o, 'removed engram hooks');
  }
}

function installGemini(o: Opts): void {
  const file = join(HOME, '.gemini', 'settings.json');
  const s = readJson(file);
  s.mcpServers = { ...(s.mcpServers || {}), engram: { command: NODE, args: mcpArgs('gemini'), trust: true } };
  const hooks = stripOurHooks(s.hooks || {});
  const ev: [string, number][] = [
    ['SessionStart', 15000],
    ['BeforeAgent', 15000],
    ['AfterAgent', 10000],
    ['PreCompress', 30000],
    ['SessionEnd', 10000],
  ];
  for (const [event, timeout] of ev) hooks[event] = [...(hooks[event] || []), { hooks: [{ name: `engram-${event}`, type: 'command', command: hookCommand('gemini', event), timeout }] }];
  s.hooks = hooks;
  writeJson(file, s, o, 'Gemini CLI MCP server and hooks');
}

function uninstallGemini(o: Opts): void {
  const file = join(HOME, '.gemini', 'settings.json');
  if (!existsSync(file)) return;
  const s = readJson(file);
  if (s.mcpServers) delete s.mcpServers.engram;
  s.hooks = stripOurHooks(s.hooks || {});
  writeJson(file, s, o, 'removed engram');
}

function opencodePlugin(): string {
  return `import { spawn } from "node:child_process";

const NODE = ${JSON.stringify(NODE)};
const BIN = ${JSON.stringify(BIN)};

function hook(event, payload, wait) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [BIN, "hook", "opencode", event], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => { child.kill(); resolve(null); }, wait);
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => {
      clearTimeout(timer);
      try { resolve(out.trim() ? JSON.parse(out) : null); } catch { resolve(null); }
    });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.stdin.end(JSON.stringify(payload));
  });
}

export const EngramPlugin = async ({ directory }) => {
  const digests = new Map();
  return {
    "chat.message": async (input, output) => {
      const text = (output.parts || []).map((p) => p.text || "").join("\\n");
      const sessionID = input.sessionID;
      const res = await hook("UserPromptSubmit", { session_id: sessionID, cwd: directory, prompt: text, include_digest: !digests.has(sessionID) }, 4000);
      const ctx = res && (res.context || res.additionalContext);
      if (ctx) {
        digests.set(sessionID, true);
        const base = (output.parts[0] && output.parts[0].id) || "prt_" + Date.now().toString(16);
        output.parts.push({ id: base + "m", sessionID, messageID: output.message.id, type: "text", text: ctx, synthetic: true });
      }
    },
    "experimental.session.compacting": async (input, output) => {
      await hook("PreCompact", { session_id: input.sessionID, cwd: directory }, 8000);
      digests.delete(input.sessionID);
    },
    event: async ({ event }) => {
      const sid = event.properties && (event.properties.sessionID || (event.properties.info && event.properties.info.id));
      if (event.type === "session.idle") hook("Stop", { session_id: sid, cwd: directory }, 4000);
      if (event.type === "session.deleted") hook("SessionEnd", { session_id: sid, cwd: directory }, 4000);
      if (event.type === "message.updated" && event.properties && event.properties.info && event.properties.info.role === "assistant" && event.properties.info.time && event.properties.info.time.completed) {
        hook("AfterAgent", { session_id: sid, cwd: directory }, 2000);
      }
    },
  };
};
`;
}

function installOpencode(o: Opts): void {
  const dir = join(HOME, '.config', 'opencode');
  const file = join(dir, 'opencode.json');
  const s = readJson(file);
  if (!s.$schema) s.$schema = 'https://opencode.ai/config.json';
  s.mcp = { ...(s.mcp || {}), engram: { type: 'local', command: [NODE, ...mcpArgs('opencode')], enabled: true } };
  writeJson(file, s, o, 'OpenCode MCP server');
  writeText(join(dir, 'plugins', 'engram.js'), opencodePlugin(), o, 'OpenCode plugin');
}

function uninstallOpencode(o: Opts): void {
  const dir = join(HOME, '.config', 'opencode');
  const file = join(dir, 'opencode.json');
  if (existsSync(file)) {
    const s = readJson(file);
    if (s.mcp) delete s.mcp.engram;
    writeJson(file, s, o, 'removed engram');
  }
  const plugin = join(dir, 'plugins', 'engram.js');
  if (existsSync(plugin) && !o.dryRun) unlinkSync(plugin);
}

function hermesPlugin(): string {
  return `import json
import subprocess

NODE = ${JSON.stringify(NODE)}
BIN = ${JSON.stringify(BIN)}


def _hook(event, payload, timeout):
    try:
        out = subprocess.run([NODE, BIN, "hook", "hermes", event], input=json.dumps(payload, default=str), capture_output=True, text=True, timeout=timeout)
        return json.loads(out.stdout) if out.stdout.strip() else {}
    except Exception:
        return {}


def _payload(kw):
    return {k: v for k, v in kw.items() if isinstance(v, (str, int, float, bool, list, dict)) or v is None}


def pre_llm_call(**kw):
    res = _hook("pre_llm_call", _payload(kw), 5)
    ctx = res.get("context")
    return {"context": ctx} if ctx else None


def post_llm_call(**kw):
    _hook("post_llm_call", _payload(kw), 5)


def on_session_end(**kw):
    _hook("on_session_end", _payload(kw), 5)


def register(ctx):
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("post_llm_call", post_llm_call)
    ctx.register_hook("on_session_end", on_session_end)
`;
}

function installHermes(o: Opts): void {
  const dir = join(HOME, '.hermes');
  const file = join(dir, 'config.yaml');
  let text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!/^\s{2}engram:/m.test(text)) {
    const block = `  engram:\n    command: ${JSON.stringify(NODE)}\n    args: ${JSON.stringify(mcpArgs('hermes'))}\n`;
    if (/^mcp_servers:\s*$/m.test(text)) text = text.replace(/^mcp_servers:\s*$/m, `mcp_servers:\n${block.trimEnd()}`);
    else text = text.trimEnd() + `\n\nmcp_servers:\n${block}`;
    writeText(file, text.replace(/^\n+/, ''), o, 'Hermes MCP server');
  } else console.log('Hermes config already has an engram MCP server');
  writeText(join(dir, 'plugins', 'engram', '__init__.py'), hermesPlugin(), o, 'Hermes plugin');
  writeText(join(dir, 'plugins', 'engram', 'plugin.yaml'), 'name: engram\ndescription: engram persistent memory recall and capture\nversion: 0.1.0\n', o, 'Hermes plugin manifest');
}

function uninstallHermes(o: Opts): void {
  const dir = join(HOME, '.hermes');
  const file = join(dir, 'config.yaml');
  if (existsSync(file)) writeText(file, readFileSync(file, 'utf8').replace(/^\s{2}engram:\n(\s{4}.*\n?)+/m, ''), o, 'removed engram MCP server');
  if (!o.dryRun) rmSync(join(dir, 'plugins', 'engram'), { recursive: true, force: true });
}

function claudeDesktopFile(): string {
  return join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
}

function installClaudeDesktop(o: Opts): void {
  const file = claudeDesktopFile();
  const s = readJson(file);
  s.mcpServers = { ...(s.mcpServers || {}), engram: { command: NODE, args: mcpArgs('claude-desktop') } };
  writeJson(file, s, o, 'Claude Desktop MCP server (restart Claude Desktop)');
}

function uninstallClaudeDesktop(o: Opts): void {
  const file = claudeDesktopFile();
  if (!existsSync(file)) return;
  const s = readJson(file);
  if (s.mcpServers) delete s.mcpServers.engram;
  writeJson(file, s, o, 'removed engram');
}

const LABEL = 'com.engram.daemon';

function plistPath(): string {
  return join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function installLaunchd(o: Opts): void {
  const logs = paths().logs;
  const pathEnv = [dirname(NODE), join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${NODE}</string><string>${BIN}</string><string>daemon</string><string>run</string><string>--quiet</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>WorkingDirectory</key><string>${paths().home}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${pathEnv}</string>
    <key>HOME</key><string>${HOME}</string>${process.env.ENGRAM_HOME ? `\n    <key>ENGRAM_HOME</key><string>${process.env.ENGRAM_HOME}</string>` : ''}
  </dict>
  <key>StandardOutPath</key><string>${join(logs, 'launchd.out.log')}</string>
  <key>StandardErrorPath</key><string>${join(logs, 'launchd.err.log')}</string>
</dict>
</plist>
`;
  if (o.dryRun) return console.log(`[dry-run] would write ${plistPath()}\n${plist}`);
  mkdirSync(logs, { recursive: true });
  mkdirSync(dirname(plistPath()), { recursive: true });
  const pid = paths().pid;
  if (existsSync(pid)) {
    try {
      process.kill(Number(readFileSync(pid, 'utf8')), 'SIGTERM');
    } catch {}
  }
  spawnSync('launchctl', ['bootout', `gui/${process.getuid!()}/${LABEL}`], { encoding: 'utf8' });
  writeFileSync(plistPath(), plist);
  let r = spawnSync('launchctl', ['bootstrap', `gui/${process.getuid!()}`, plistPath()], { encoding: 'utf8' });
  for (let i = 0; i < 10 && r.status !== 0; i++) {
    spawnSync('sleep', ['1']);
    r = spawnSync('launchctl', ['bootstrap', `gui/${process.getuid!()}`, plistPath()], { encoding: 'utf8' });
  }
  console.log(r.status === 0 ? `launchd agent ${LABEL} loaded; the daemon now starts at login and restarts if it dies` : `launchctl bootstrap failed: ${r.stderr}`);
}

function uninstallLaunchd(o: Opts): void {
  if (o.dryRun) return console.log(`[dry-run] would unload and remove ${plistPath()}`);
  spawnSync('launchctl', ['bootout', `gui/${process.getuid!()}/${LABEL}`], { encoding: 'utf8' });
  if (existsSync(plistPath())) unlinkSync(plistPath());
  console.log('launchd agent removed');
}

function installPath(o: Opts): void {
  const link = join(HOME, '.local', 'bin', 'engram');
  if (o.dryRun) return console.log(`[dry-run] would link ${link} -> ${BIN}`);
  mkdirSync(dirname(link), { recursive: true });
  try {
    if (lstatSync(link)) {
      if (readlinkSync(link) === BIN) return console.log(`${link} already links to ${BIN}`);
      unlinkSync(link);
    }
  } catch {}
  symlinkSync(BIN, link);
  console.log(`linked ${link} -> ${BIN}`);
}

function uninstallPath(o: Opts): void {
  const link = join(HOME, '.local', 'bin', 'engram');
  if (!o.dryRun && existsSync(link)) unlinkSync(link);
}

const TARGETS: Record<string, { install: (o: Opts) => void; uninstall: (o: Opts) => void; detect: () => boolean }> = {
  'claude-code': { install: installClaudeCode, uninstall: uninstallClaudeCode, detect: () => existsSync(join(HOME, '.claude')) },
  codex: { install: installCodex, uninstall: uninstallCodex, detect: () => existsSync(codexHome()) },
  cursor: { install: installCursor, uninstall: uninstallCursor, detect: () => existsSync(join(HOME, '.cursor')) },
  gemini: { install: installGemini, uninstall: uninstallGemini, detect: () => existsSync(join(HOME, '.gemini')) },
  opencode: { install: installOpencode, uninstall: uninstallOpencode, detect: () => existsSync(join(HOME, '.config', 'opencode')) },
  hermes: { install: installHermes, uninstall: uninstallHermes, detect: () => existsSync(join(HOME, '.hermes')) },
  'claude-desktop': { install: installClaudeDesktop, uninstall: uninstallClaudeDesktop, detect: () => existsSync(dirname(claudeDesktopFile())) },
  launchd: { install: installLaunchd, uninstall: uninstallLaunchd, detect: () => process.platform === 'darwin' },
  path: { install: installPath, uninstall: uninstallPath, detect: () => true },
};

export function install(target: string, o: Opts = {}): void {
  authToken();
  if (target === 'all') {
    for (const [name, t] of Object.entries(TARGETS)) {
      if (!t.detect()) {
        console.log(`skip ${name} (not installed)`);
        continue;
      }
      console.log(`\n== ${name}`);
      try {
        t.install(o);
      } catch (err) {
        console.log(`  failed: ${(err as Error).message}`);
      }
    }
    return;
  }
  const t = TARGETS[target];
  if (!t) return console.log(`unknown target ${target}; one of: ${Object.keys(TARGETS).join(', ')}, all`);
  t.install(o);
}

export function uninstall(target: string, o: Opts = {}): void {
  const names = target === 'all' ? Object.keys(TARGETS) : [target];
  for (const n of names) {
    const t = TARGETS[n];
    if (!t) {
      console.log(`unknown target ${n}`);
      continue;
    }
    try {
      t.uninstall(o);
    } catch (err) {
      console.log(`${n}: ${(err as Error).message}`);
    }
  }
}

export function claudeMemoryDirs(): string[] {
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude'), 'projects');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((d) => join(root, d, 'memory'))
    .filter((d) => existsSync(d));
}

function mark(ok: boolean | null, label: string, detail = ''): void {
  console.log(`${ok === null ? '·' : ok ? '✓' : '✗'} ${label}${detail ? ': ' + detail : ''}`);
}

export async function doctor(): Promise<void> {
  const cfg = loadConfig();
  const major = Number(process.versions.node.split('.')[0]);
  mark(major >= 23, 'node', process.versions.node);
  let db;
  try {
    db = openDb();
    db.prepare("select count(*) from memories_fts where memories_fts match 'test'").get();
    mark(true, 'database', cfg.dbPath);
  } catch (err) {
    mark(false, 'database', (err as Error).message);
    return;
  }
  const s = stats(db);
  mark(null, 'memories', s.byStatus.map((x) => `${x.status} ${x.n}`).join(', ') || 'none');
  mark(null, 'sessions / turns', `${s.sessions} / ${s.turns}`);
  const pending = s.byStatus.find((x) => x.status === 'pending')?.n || 0;
  if (pending) mark(null, 'review inbox', `${pending} pending (engram inbox)`);
  const emb = cfg.embed.enabled ? await getEmbedder() : null;
  mark(!!emb || !cfg.embed.enabled, 'embeddings', cfg.embed.enabled ? (emb ? embedModelName() : 'failed to load (keyword search still works)') : 'disabled');
  if (s.unembedded) mark(null, 'awaiting embedding', String(s.unembedded));
  const p = await resolveProvider();
  mark(!!p, 'LLM for extraction', p ? p.name : 'none (explicit writes and capture still work; extraction waits)');
  let up = false;
  try {
    up = (await fetch(`http://${cfg.host}:${cfg.port}/healthz`, { signal: AbortSignal.timeout(800) })).ok;
  } catch {}
  mark(up, 'daemon', up ? `http://${cfg.host}:${cfg.port}` : 'not running (engram daemon start, or engram install launchd)');
  mark(existsSync(plistPath()), 'launchd agent', existsSync(plistPath()) ? plistPath() : 'not installed');
  const spool = paths().spool;
  const spooled = existsSync(spool) ? readdirSync(spool).filter((f) => f.endsWith('.jsonl')).length : 0;
  mark(spooled === 0, 'spool', spooled ? `${spooled} file(s) waiting for the daemon` : 'empty');
  const cs = readJsonSafe(claudeSettingsPath());
  const ccHooks = Object.values((cs.hooks || {}) as Record<string, any[]>).flat().some((g: any) => (g.hooks || []).some((h: any) => isOurs(h.command) || isOursLoose(h.command)));
  const ccMcp = spawnSync('/bin/sh', ['-lc', 'claude mcp get engram 2>/dev/null'], { encoding: 'utf8' }).status === 0;
  mark(ccHooks && ccMcp, 'Claude Code', `hooks ${ccHooks ? 'on' : 'off'}, mcp ${ccMcp ? 'on' : 'off'}${cs.cleanupPeriodDays ? `, transcripts kept ${cs.cleanupPeriodDays}d` : ', transcripts kept 30d (default)'}`);
  if (existsSync(codexHome())) {
    const toml = existsSync(join(codexHome(), 'config.toml')) ? readFileSync(join(codexHome(), 'config.toml'), 'utf8') : '';
    const ch = readJsonSafe(join(codexHome(), 'hooks.json'));
    const hooksOn = Object.values((ch.hooks || {}) as Record<string, any[]>).flat().some((g: any) => (g.hooks || []).some((h: any) => isOurs(h.command) || isOursLoose(h.command)));
    mark(toml.includes('[mcp_servers.engram]') && hooksOn, 'Codex', `mcp ${toml.includes('[mcp_servers.engram]') ? 'on' : 'off'}, hooks ${hooksOn ? 'on (trust them in /hooks)' : 'off'}`);
  }
  for (const [name, file, key] of [
    ['Cursor', join(HOME, '.cursor', 'mcp.json'), 'mcpServers'],
    ['Gemini CLI', join(HOME, '.gemini', 'settings.json'), 'mcpServers'],
    ['OpenCode', join(HOME, '.config', 'opencode', 'opencode.json'), 'mcp'],
    ['Claude Desktop', claudeDesktopFile(), 'mcpServers'],
  ] as const) {
    if (!existsSync(dirname(file))) continue;
    const j = readJsonSafe(file);
    mark(!!j[key]?.engram, name, j[key]?.engram ? 'mcp on' : 'not installed (engram install ' + name.toLowerCase().replace(/ cli$/, '').replace(' ', '-') + ')');
  }
  const last = db.prepare("select max(updated_at) t from jobs where kind = 'extract' and status = 'done'").get() as { t: string | null };
  mark(null, 'last extraction', last.t || 'never');
}

function readJsonSafe(file: string): Record<string, any> {
  try {
    return readJson(file);
  } catch {
    return {};
  }
}
