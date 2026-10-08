# engram

Durable personal memory for every AI agent you use. One local store, many front doors: Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Hermes, Claude Desktop, claude.ai, ChatGPT and your own agents all read and write the same memory, and it keeps accumulating on its own.

- **Automatic.** Hooks inject what matters at session start and on every prompt, capture every turn, and a background worker distills sessions into memories. No one has to remember to call a tool.
- **Durable.** SQLite in WAL mode is the source of truth, every change is an append-only op you can undo, writes never depend on the daemon being up, and there are daily backups plus a Markdown mirror in git.
- **Small context.** A hard-capped digest (1,500 tokens) at session start, a gated recall (at most 5 items, 700 tokens) per prompt, never the same memory twice in one session.
- **Correct over time.** Near duplicates merge, contradictions supersede with validity windows instead of piling up, unused memories decay, and machine edits to things you said yourself wait in an inbox for your OK.
- **Safe.** Secrets are redacted at write, injection attempts are quarantined, memories are rendered as data not instructions, sensitive memories are never auto-injected.

Design and research: [DESIGN.md](DESIGN.md) and `~/dev/research_notes/Agent memory systems/`.

## Quick start

```bash
npm install
node bin/engram.js install path         # links ~/.local/bin/engram
engram install launchd                   # daemon at login, restarts if it dies
engram install all                       # every detected harness
engram import claude-memory              # seed from Claude Code auto memory
engram ingest                            # pull the last 14 days of transcripts
engram doctor
```

Requires Node 23.6 or newer (it runs the TypeScript directly). Everything lives in `~/.engram` (override with `ENGRAM_HOME`).

## How memory flows

```
              read                                      write
 SessionStart ──► digest (profile, rules,     UserPromptSubmit ──► turn archive
                  project, procedures)        Stop / PreCompact ──► transcript delta
 UserPromptSubmit ► gated recall              SessionEnd ─────────► extraction job
 any time ──────► memory_search / get         memory_write ───────► dedupe, merge, supersede
                                              daemon ─────────────► transcript tailer (fallback)
                                                     └─ LLM extraction ► add / update / supersede / noop
                                                     └─ daily: consolidate, decay, mirror, backup
```

**Memory kinds**

| Kind | What | Reaches the model |
|---|---|---|
| profile | who you are | always in the digest |
| preference | how you want things done, with the why | digest, then recall |
| decision | choices and reasons | project digest, recall |
| fact | durable facts about you, people, projects | key facts in digest, recall |
| procedure | how-tos that took effort (skills) | title index in digest, body on demand |
| episode | summaries of past sessions | recall and search only |
| reference | pointers to files, URLs, dashboards | recall |

The raw conversation archive (every user and assistant turn, redacted) is searchable with `memory_search source="conversations"`.

**Trust tiers.** `user` (you typed it, or told an agent to remember it), `agent` (a model called `memory_write`), `extracted` (background extraction), `external` (tool output, web). Extraction can never overwrite a `user` memory; it stages the change in `engram inbox`. External content never auto-injects.

**Retrieval gate.** Each prompt passes through: skip acknowledgements and bare slash commands, hybrid search (FTS5 BM25 plus local bge-small embeddings, fused with reciprocal rank fusion, boosted by importance, scope and recent use), a relevance floor (cosine 0.64) and a gap filter (within 0.07 of the best hit), drop anything already shown this session, MMR for diversity, then pack into the budget. On the built-in benchmark (`engram eval`) this gives 97% recall, 88% precision and 100% abstention on unrelated prompts.

## Harnesses

| Harness | Install | Automatic read | Automatic write |
|---|---|---|---|
| Claude Code | `engram install claude-code` | SessionStart digest, per-prompt recall | Stop, PreCompact, PostCompact, SessionEnd, transcripts |
| Codex CLI | `engram install codex`, then trust in `/hooks` | SessionStart, UserPromptSubmit | Stop, PreCompact, SessionEnd, transcripts |
| Cursor | `engram install cursor` | sessionStart | afterAgentResponse, preCompact, stop, sessionEnd |
| Gemini CLI | `engram install gemini` | SessionStart, BeforeAgent | AfterAgent, PreCompress, SessionEnd |
| OpenCode | `engram install opencode` (plugin + MCP) | per-message plugin | session.idle, compaction |
| Hermes | `engram install hermes` (plugin + MCP) | pre_llm_call | post_llm_call, on_session_end |
| Claude Desktop | `engram install claude-desktop` | MCP tools and instructions | `memory_write` |
| claude.ai, ChatGPT | `engram remote enable` plus a tunnel | MCP tools | `memory_write` |
| your own agents | REST | `GET /v1/context`, `POST /v1/recall` | `POST /v1/ingest` |
| anything else | `@~/.engram/digest.md` in its instruction file | refreshed every 10 minutes | |

Installers merge into existing configs, back up every file they touch to `~/.engram/backups/config/`, and `engram uninstall <harness>` reverses them. Set `ENGRAM_DISABLE=1` to make every hook a no-op.

## MCP surface

Server name `engram`, stdio (`engram mcp`) or Streamable HTTP (`http://127.0.0.1:7432/mcp`, bearer token in `~/.engram/token`). It serves both the 2025 and 2026-07-28 protocol eras.

| Tool | Purpose |
|---|---|
| `memory_context` | the digest, optionally plus memories relevant to a task |
| `memory_search` | hybrid search over memories, past conversations, or both; `as_of` for history |
| `memory_get` | full memories with provenance and change history |
| `memory_write` | remember one thing (dedupes, merges, supersedes) |
| `memory_update` | edit, re-scope, pin, mark outdated |
| `memory_forget` | soft delete with a reason |

Resources `engram://digest`, `engram://profile`, `engram://memory/{id}`. Prompts `remember`, `recall`, `reflect`.

## REST (daemon on 127.0.0.1:7432)

All routes need `Authorization: Bearer $(cat ~/.engram/token)` except `/healthz`.

```
GET  /healthz
GET  /v1/context?cwd=&session_id=&harness=&budget=&format=json
POST /v1/recall            {prompt, cwd, session_id, harness}
POST /v1/search            {query, source, kinds, scope, cwd, as_of, limit}
GET  /v1/memories          ?kind=&scope=&status=&tag=&limit=
POST /v1/memories          {text, kind, scope, tags, importance, supersedes, sensitive, pinned, trust}
GET|PATCH|DELETE /v1/memories/{id}      GET /v1/memories/{id}/history
POST /v1/hooks/{harness}/{event}        raw hook JSON in, harness-shaped output back
POST /v1/ingest            {harness, session_id, cwd, turns: [{role, text, ts}], end}
GET  /v1/inbox             POST /v1/inbox/{id}/approve|reject
GET  /v1/ops               POST /v1/undo/{op}
GET  /v1/sessions          GET /v1/stats          POST /v1/maintain {task}
POST /mcp
```

`engram ui` opens a local page to browse, search, edit, pin and forget memories, review the inbox, see sessions and undo any change.

## CLI

```
engram add <text> [--kind K] [--scope global|project|PATH] [--tags a,b] [--importance N] [--pin] [--sensitive]
engram search <query> [--source memories|conversations|all] [--as-of DATE] [--json]
engram list | get <id> [--history] | edit <id> | forget <id> | restore <id> | purge <id> --yes
engram inbox [approve|reject <id> | approve --all]
engram ops | undo <op-id> | history <id>
engram context [--cwd DIR] [--task T]      engram recall <prompt>   (see what the gate would inject)
engram ingest | extract [--pending] | consolidate | decay | mirror | backup | maintain
engram daemon start|stop|restart|status|logs
engram install|uninstall <harness|all>     engram doctor
engram remote enable|disable|status|revoke|passphrase
engram import claude-memory | import json FILE | export [--out FILE]
engram stats | sessions | jobs | config [get|set KEY VALUE] | eval [--sweep 0.6,0.64]
```

## Background learning

The daemon scans Claude Code, Codex and loom transcripts every two minutes, waits until a session has been idle for 20 minutes (or has ended or is about to compact), then asks an LLM to propose memory operations against the most related existing memories. No-op is the preferred answer, your own words outweigh the assistant's, relative dates become absolute, and every operation carries an evidence quote. A session summary is kept as an episode and updated as the session continues.

The LLM is picked automatically: `ANTHROPIC_API_KEY`, then `OPENAI_API_KEY`, then the `claude` CLI on your subscription (Haiku, no tools, no session saved), then the `codex` CLI, then Ollama. Pin one with `engram config set llm.provider claude-cli`. Calls are capped at 20 per hour (`llm.maxExtractionsPerHour`). With no LLM, capture, explicit writes, search and recall all still work and extraction waits.

Daily maintenance merges near duplicates (automatically above 0.95 cosine, through the LLM with a shrinkage guard between 0.86 and 0.95), archives low-importance memories nobody has used in 120 days (never your own or pinned ones), rewrites the Markdown mirror at `~/.engram/mirror` and commits it to git, and writes a backup (14 kept).

## Remote access (claude.ai, Claude mobile, ChatGPT)

These clients only reach public HTTPS servers. engram ships a separate listener on 127.0.0.1:7433 with OAuth 2.1 (dynamic client registration, S256 PKCE, refresh rotation) and a passphrase consent page. `memory_forget` is off there by default.

```bash
engram remote enable                                   # prints the passphrase
cloudflared tunnel --url http://127.0.0.1:7433         # or: tailscale funnel 7433
engram remote enable --public-url https://<your-host>
```

Add `https://<your-host>/mcp` as a custom connector in claude.ai (Settings, Connectors) or ChatGPT (developer mode), approve with the passphrase. `engram remote revoke` kills every token.

## Configuration

`~/.engram/config.json`, or `engram config set key value`. Main knobs: `digestBudget` 1500, `recallItems` 5, `recallBudget` 700, `recallFloor` 0.64, `nearDuplicate` 0.92, `bodyMaxChars` 2000, `extract.idleMinutes` 20, `decay.unusedDays` 120, `ingest.maxAgeDays` 14, `embed.enabled`, `llm.provider`, `remote.*`. Environment: `ENGRAM_HOME`, `ENGRAM_PORT`, `ENGRAM_DISABLE`, `ENGRAM_EMBED=off`, `ENGRAM_LLM`, `ENGRAM_DEBUG`.

## Durability details

- Every process (hooks, MCP servers, CLI, daemon) opens the same WAL database with an 8 second busy timeout, so writes land even when the daemon is down. 8 processes writing 400 records concurrently lose nothing (`bench/concurrent-writers.sh`).
- If a hook cannot reach the database at all, its payload goes to `~/.engram/spool/` and the daemon replays it.
- Background work is a job table with leases: a crashed worker's job is picked up again after its lease expires, failures back off exponentially.
- Every create, update, merge, supersede, archive and delete is an op with before and after snapshots. `engram undo <op>` reverts one, or a whole extraction batch.
- Search stays under 40 ms at 10,000 memories (`bench/search-latency.ts`).

## Tests

```bash
npm test          # 42 tests: store, search, safety, hooks, parsers, jobs, extraction, daemon, OAuth, installers, benchmark
npm run bench
engram eval
```
