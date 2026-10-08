# engram design

A personal, durable memory layer that any agent harness or frontier model can read from and write to. One store on this Mac, many front doors.

Research behind every decision: `~/dev/research_notes/Agent memory systems/` (01 Anthropic, 02 OpenAI, 03 open harnesses, 04 frameworks and papers, 05 integration surfaces).

## Goals

1. **Universal.** Works with Claude Code, Codex CLI, Cursor, Gemini CLI, OpenCode, Hermes, Claude Desktop, claude.ai, ChatGPT, and raw API agents. Lowest common denominator is MCP tools; anything better (hooks, plugins, transcripts) is used where it exists.
2. **Automatic.** Memory accumulates without the user or the model remembering to call a tool. Reads happen at session start and on every prompt; writes happen from hooks, transcript tailing and background extraction.
3. **Durable.** No write is lost because a daemon is down, a hook timed out, or a model crashed mid-session. Every change is an append-only op that can be audited and undone. The store is one SQLite file plus backups and a Markdown mirror.
4. **Small context.** The always-on digest is hard-capped (default 1,500 tokens). Per-prompt recall is gated and capped (default 5 items, 700 tokens). Nothing is injected twice in a session. Everything else is a tool call away.
5. **Correct over time.** Facts have validity intervals; contradictions supersede instead of piling up; unused memories decay; duplicates merge; summaries never shrink silently.
6. **Safe.** Secrets are redacted at write. Memory is rendered as data, not instructions. Provenance and trust tier live outside the text. Sensitive memories are never auto-injected. External content cannot rewrite user-stated facts.
7. **Covers every memory type.** Profile, preferences, semantic facts, decisions, procedures (skills), episodes, references, and the raw conversation archive.
8. **Observable.** A CLI, a local web page, and an inbox of pending changes make every machine-written memory reviewable.

Non-goals: multi-user tenancy, cloud hosting, a graph database.

## What the research said (short version)

| System | Store | Write | Read | Lesson taken |
|---|---|---|---|---|
| Claude Code | `MEMORY.md` index + one-fact files | model writes inline + background extractor each turn | index always, side-call selects up to 5 files per turn | two tiers, typed records, store the why, absolute dates, never re-surface |
| Codex | SQLite stage-1 outputs, `MEMORY.md`, `memory_summary.md` | idle sessions summarized by small model, single-writer consolidation | 2,500-token summary + grep handbook, citations | no-op preferred, decay by disuse, consolidation lease, user signal over assistant |
| Hermes | `MEMORY.md` 2,200 chars, `USER.md` 1,375 chars, FTS5 sessions | memory tool add/replace/remove, review fork every 10 turns | frozen snapshot at session start, per-turn prefetch in user message | hard caps with model-visible overflow, declarative facts, lessons go to skills |
| OpenClaw | daily files + `MEMORY.md`, SQLite hybrid index | pre-compaction flush, dreaming | BM25 + vector + recency + MMR | flush before compaction, only trusted items auto-inject |
| Copilot | server memories with citations | `store_memory` | verify citations before use | 28-day unused expiry, citations |
| Mem0 | vectors + graph | extract, top-k similar, ADD/UPDATE/DELETE/NOOP | vector search | reconcile against neighbours before writing |
| Zep/Graphiti | temporal KG | episodes to facts with valid/invalid times | hybrid + BFS | supersede, never delete, on contradiction |
| Letta | core blocks + archival | memory_replace/insert/rethink, sleep-time agent | blocks in system prompt | capped labelled blocks, background rewrite |

Common denominators: MCP for tools, AGENTS.md-style instruction files, and Claude-Code-compatible hook events (SessionStart, UserPromptSubmit, PreCompact, Stop, SessionEnd) that Codex, Gemini, Cursor and OpenCode now mirror.

## Architecture

```
 harness hooks ─┐                         ┌─ MCP stdio (engram mcp)
 transcripts  ──┼─► engram core library ◄─┼─ MCP HTTP  (daemon /mcp)
 CLI / REST   ──┘    (store, search,      └─ REST      (daemon /v1/*)
                      gate, digest)
                          │
                 ~/.engram/engram.db  (SQLite WAL, source of truth)
                 ~/.engram/mirror/    (Markdown mirror, git)
                 ~/.engram/backups/   (daily VACUUM INTO)
                          │
                   daemon job runner: embed, ingest transcripts,
                   extract, consolidate, decay, mirror, backup
```

Every process opens the same SQLite file in WAL mode with a busy timeout, so hooks and MCP servers write directly and durably even when the daemon is down. The daemon only adds speed (warm embedding model) and background work (jobs). Work is queued in a `jobs` table with leases, so a crash leaves nothing half-done.

## Data model

`memories`: id, kind, scope, title, body, tags, importance (1 to 10), trust, sensitive, pinned, status (active, superseded, archived, pending, deleted), valid_from, valid_to, superseded_by, source (harness, session, cwd, uri, evidence), created_at, updated_at, version, access_count, last_accessed, injected_count, last_injected, hash, embedding, embed_model.

Kinds:

| Kind | Meaning | Read path |
|---|---|---|
| profile | who the user is | always in digest |
| preference | how the user likes things done (declarative) | digest when global or in scope, else recall |
| fact | semantic fact about the user, people, projects, world | recall |
| decision | a choice made, with why | recall, recent ones in project digest |
| procedure | how to do a task (skill body) | title index in digest, body on demand |
| episode | summary of a session or event | recall, never in digest |
| reference | pointer to an external resource | recall |

Trust tiers: `user` (typed by the user through CLI, UI or explicit remember), `agent` (model called the write tool), `extracted` (background extraction), `external` (came from tool output or web). Extraction may never supersede a `user` memory; it stages a pending change instead. `external` never auto-injects.

`turns`: raw conversation archive (harness, session, role, text, ts), redacted, FTS-indexed. This is the episodic ground truth that extraction reads and that `memory_search` can query.

`sessions`: harness, session id, cwd, scope, timestamps, transcript path, ingest offset, extraction state.

`ops`: append-only log of every create, update, supersede, archive, delete, restore, with before and after snapshots. `engram undo` replays it backwards.

`jobs`: durable queue with kind, key, payload, status, attempts, run_after, lease.

`injections`: which memory was shown in which session, to stop repeats and drive decay.

## Write path

1. **Explicit**: `memory_write` (MCP), `engram add`, `POST /v1/memories`. Synchronous. Redact secrets, scan for injection, normalize, hash. Exact duplicate returns `duplicate`. Near duplicate (same kind and scope, cosine at least 0.92 or same title) is merged as an update and returns `merged`. `supersedes` closes the old fact's validity. Hard cap on body size (2 KB) with a model-readable error.
2. **Hooks**: each harness hook appends turns to `turns` and touches `sessions`. Stop, PreCompact and SessionEnd enqueue an `extract` job. Hooks never block on the LLM.
3. **Transcript tailer**: the daemon scans Claude Code and Codex transcript folders on an interval and ingests new turns by byte offset. This covers harnesses with no hooks and any hook that failed.
4. **Extraction** (background, LLM): for an idle or ended session, feed the user and assistant turns plus the top related existing memories, ask for operations (`add`, `update`, `supersede`, `noop`) with evidence quotes. No-op is preferred. User messages outweigh assistant messages. Relative dates resolved against the session date. Applied with trust `extracted`; conflicts against `user` memories go to the pending inbox. A session summary is stored as an `episode`.
5. **Consolidation** (daily): merge near duplicates, rebuild the profile with a shrinkage guard, decay and archive unused low-importance items, refresh the mirror, back up.

LLM providers are pluggable and auto-detected: Anthropic API, OpenAI API, Claude Code CLI (subscription), Codex CLI (subscription), Ollama, or none. With none, the system still captures turns and explicit writes; extraction waits.

## Read path

1. **Digest** (SessionStart, `memory_context`, instruction files): profile, top preferences, pinned items, procedures index, recent project decisions. Scored by importance, use and recency; packed to budget; truncation is stated in the text.
2. **Retrieval gate** (UserPromptSubmit, Gemini BeforeAgent, Hermes pre_llm_call, OpenCode transform):
   - skip trivial prompts (acknowledgements, slash commands, very short with no content words)
   - hybrid search: FTS5 BM25 and cosine over embeddings, fused with RRF (k=60), boosted by importance, scope and recency of use, then MMR for diversity
   - relevance floor: drop anything without a lexical hit or with cosine below the floor
   - novelty: drop anything already in the digest or injected earlier in this session
   - budget: at most 5 items and 700 tokens
   - rendered as `<memory-context>` background data with dates, kind and id
3. **On demand**: `memory_search` (memories or the conversation archive, with `as_of` for history), `memory_get`.
4. **Usage feedback**: reads and injections update counters; `memory_update` and `memory_forget` record corrections.

Memory is always presented as reference material ("background, may be stale, current instructions win").

## Exposure surface

MCP server `engram` (stdio and Streamable HTTP):

| Tool | Purpose | Annotations |
|---|---|---|
| `memory_context` | digest for the current task and cwd | read only |
| `memory_search` | hybrid search over memories or past conversations | read only |
| `memory_get` | full items with provenance and history | read only |
| `memory_write` | remember something (dedupes, merges, supersedes) | idempotent, not destructive |
| `memory_update` | edit, pin, re-scope, mark outdated | idempotent |
| `memory_forget` | soft delete with reason | destructive |

Resources `engram://digest`, `engram://profile`, `engram://memory/{id}`. Prompts `remember`, `recall`, `reflect`.

REST on `127.0.0.1:7432` with a bearer token: `/healthz`, `/mcp`, `/v1/context`, `/v1/search`, `/v1/memories`, `/v1/hooks/{harness}/{event}`, `/v1/ingest`, and a small web UI at `/`.

CLI `engram`: `add`, `search`, `get`, `edit`, `forget`, `restore`, `history`, `undo`, `context`, `inbox`, `ingest`, `extract`, `consolidate`, `daemon`, `mcp`, `hook`, `install`, `uninstall`, `doctor`, `export`, `import`, `backup`, `stats`, `eval`.

## Per-harness integration

| Harness | MCP | Auto read | Auto write | Fallback |
|---|---|---|---|---|
| Claude Code | `claude mcp add` user scope | SessionStart, UserPromptSubmit | Stop, PreCompact, SessionEnd | transcript tailer |
| Codex CLI | `[mcp_servers.engram]` | SessionStart, UserPromptSubmit | Stop, PreCompact | transcript tailer, AGENTS.md block |
| Cursor | `~/.cursor/mcp.json` | sessionStart | afterAgentResponse, stop | `.mdc` rule |
| Gemini CLI | `settings.json` | SessionStart, BeforeAgent | AfterAgent, PreCompress | GEMINI.md block |
| OpenCode | `opencode.json` | plugin system transform | plugin chat.message, session.idle | AGENTS.md |
| Hermes | `config.yaml` | plugin pre_llm_call | plugin post_llm_call | |
| Claude Desktop | stdio config | `memory_context` via instructions | `memory_write` | |
| claude.ai, ChatGPT | remote HTTPS (tunnel + auth) | tool calls | tool calls | |
| API agents | REST | `/v1/context` | `/v1/ingest` | |

## Budgets and defaults

| Setting | Default |
|---|---|
| digest budget | 1,500 tokens |
| per-prompt recall | 5 items, 700 tokens |
| memory body cap | 2,000 chars |
| near-duplicate cosine | 0.92 |
| recall cosine floor | 0.5 |
| RRF k | 60 |
| decay | archive non-pinned, non-user items unused 120 days with importance under 5 |
| extraction | sessions idle 20 minutes or ended |
| consolidation | daily, single lease |
| embeddings | bge-small-en-v1.5 (384 dims, q8, local) |
