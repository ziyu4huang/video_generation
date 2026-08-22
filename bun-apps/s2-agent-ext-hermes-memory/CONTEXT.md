# s2-agent-ext-hermes-memory

The ubiquitous language of s2-agent-ext-hermes-memory — persistent memory, session search, and secret scanning for Pi. The agent that normally forgets everything at session close instead keeps facts, failures, corrections, and procedures across sessions, searchable on demand.

## Architecture

Consolidation, background-review fallback, correction-detector, and session-flush now dispatch via `spawnSubagent` (`@repo/s2-agent-ext-subagent`, small tier) instead of a bespoke `pi -p` subprocess. The child receives the `memory` tool via `extensionTools` bridging. `pi-child-process.ts` is deleted; `direct` (`completeSimple`) remains background-review's default transport.

## Language

### Retrieval-quality terms (LeanRAG-informed)

- **Capture-only journal** — hermes's post-fold scope (2026-08-22, context-lifecycle D1): the session journal + auto-capture + convergence handoff. Recall routes through kcard `retrieveRecords` (knowledge-card ext); hermes runs no semantic/vector search of its own. SurrealDB stays the CRUD journal store of record.
- **Redundancy-aware retrieval** — retrieval that collapses duplicates and de-emphasizes repeated evidence before assembly, so the context budget carries distinct information rather than repeats. (Selective port; ADR-0001, ticket 19.)
- **Exact-contentHash dedup** — collapsing cards that share an identical content hash within one result set. (Near-dup cosine collapse is a separate concern — ticket 17.)

### The five stores

**Memory** (`memory` target, `MEMORY.md`):
The agent's personal notes — env facts, project conventions, tool quirks, lessons. Size-limited (default 10,000 chars), human-readable Markdown, searchable by default.
_Avoid_: notes, log (it is the curated, bounded fact store — distinct from the `memory` *tool* and from "a memory" as a single entry)

**User profile** (`user` target, `USER.md`):
Who the user is — name, preferences, communication style, habits. Kept separate from Memory so identity isn't mixed with facts.
_Avoid_: profile, settings (it is persona/identity, not configuration)

**Skills** (`skill_manage` tool, `SKILL.md`):
Procedures — *how* to do something reusable across sessions (debug, deploy, test). Unlimited; stored as Pi-native `SKILL.md`.
_Avoid_: snippets, docs (skills are procedural and Pi-discoverable, not reference text)

**Extended store** (`sessions.db`):
The SQLite mirror of Markdown memory beyond the core char limit. Fresh `memory` writes mirror here automatically; older entries backfilled via `/memory-sync-markdown`. Searching it does **not** bypass the core Markdown limit. Accessed only through the backend-neutral `MemoryRepository` interface (`src/store/repository.ts`); the SQLite implementation lives in `src/store/sqlite/`.
_Avoid_: cache, index (it is a durable searchable store; core Markdown stays the source of truth)

**Sessions** (`sessions.db`, FTS5):
Indexed past conversation history, searchable via `session_search`. Indexed on shutdown plus a bounded incremental startup backfill. Accessed only through the backend-neutral `SessionRepository` interface; the SQLite implementation lives in `src/store/sqlite/`.
_Avoid_: history, transcripts (it is FTS5-indexed, queryable conversation memory)

- `src/store/surreal/` — SurrealDB backend (default-off; `config.dbBackend: "surrealdb"`). Implements the same repository interfaces via a local SurrealDB v3 server (`/sql`, `snowball(english)` fulltext, `seq`-field ids). Shared `repository-contract.test.ts` proves equivalence.

### Two-tier scoping

**Global memory** (`~/.pi/agent/pi-hermes-memory/`):
Facts that apply everywhere — your name, OS, tools. Searchable in every session.
_Avoid_: base memory, default memory

**Project memory** (`~/.pi/agent/projects-memory/<project>/`):
Facts scoped to one codebase — architecture decisions, API quirks, team norms. Searchable only when cwd matches the project.
_Avoid_: local memory, repo memory

### Memory categories

**Failure**:
A categorized memory of what didn't work and why, so the agent doesn't repeat it.
_Avoid_: error, mistake (it is a saved, searchable lesson, not a runtime error)

**Correction**:
A categorized memory of a user correction ("use pnpm, not npm") — saved *immediately* on detection, not waiting for background review.
_Avoid_: feedback, fix

**Insight / Preference / Convention / Tool-quirk**:
The remaining memory categories — durable learning, stable user want, team/repo norm, and non-obvious tool behavior respectively.
_Avoid_: tags (these are semantic categories with retrieval semantics, not labels)

### Prompt behavior

**Policy-only mode** (`memoryMode: "policy-only"`, default):
Injects only the *memory policy* (guidance on when to call `memory_search`) into the system prompt — not the memories themselves. Keeps first-turn token cost low.
_Avoid_: disabled, off (memory is fully available via search; only auto-injection is absent)

**Legacy-inject mode** (`memoryMode: "legacy-inject"`):
Restores the old behavior — injects MEMORY.md, USER.md, project memory, and recent failures into the prompt.
_Avoid_: full mode, inject mode

**Memory policy**:
The `<memory-policy>` block injected in policy-only mode, telling the agent *when* to search and how to treat results (context, not instruction; repo/tool evidence wins).
_Avoid_: rules, instructions (it is guidance, not commands)

### The learning loop

**Background review**:
The activity-triggered learning cycle — every `nudgeInterval` turns (default 10) OR every `nudgeToolCalls` tool calls (default 15), reviews the session and saves what matters. Counters reset after each review.
_Avoid_: auto-save, indexer, cron (it is an LLM-judged review loop, not a keyword extractor)

**Review transport** (`reviewTransport`):
How background review reaches a model — `direct` (in-process `completeSimple()`, default, preserves the main session's prefix cache) with `subprocess` (`pi -p`) fallback.
_Avoid_: backend, runner

**Correction detection**:
Immediate save when the user corrects the agent ("no, use yarn"), bypassing the background-review cadence.
_Avoid_: feedback capture, listener

**Auto-consolidation** (`memoryOverflowStrategy: "auto-consolidate"`):
When a store hits its char limit, a one-shot child agent merges related entries and drops stale ones, then retries the write — instead of erroring.
_Avoid_: compaction, garbage collection, truncation (it is a semantic merge, not byte-level compression or FIFO drop)

### Security

**Content scanning**:
Every memory/skill write passes a scanner that blocks API keys, tokens, and SSH keys — preventing the LLM from being tricked into storing secrets or injection payloads later surfaced via search.
_Avoid_: filter, sanitizer (it is a security gate on persistence)

### grill-memory skill

**grill-memory** (skill, `skills/grill-memory/SKILL.md`):
A trigger-on-description Pi skill shipped from this package's `skills/` dir.
Co-fires with the `grilling` skill during a grill — READ behavioral memory
into each recommendation via `memory_search`, WRITE each resolved decision via
the `grill_decision` tool (whose runtime lives in this package's
`src/tools/grill-decision-tool.ts`). Formerly its own package
(`s2-agent-ext-grill-memory`); merged in because the runtime was already here.

## Learning loop: subagent-output capture

The background-review learning loop now also reviews `subagent` tool outputs.
A subagent's output returns to the parent session as a `tool_result` content
block, which the shared `getMessageText` deliberately skips (text-only, 500-char
cap — it is also consumed by `session-flush` and `correction-detector`, where
injecting tool-result noise would be harmful). A dedicated collector,
`collectSubagentOutputs` (`src/handlers/message-parts.ts`), matches each
`tool_result` to its producing `subagent` tool_use and feeds the text into the
review prompt at a relaxed per-output cap (4000), always-on — no config knob.
The existing distill logic decides what is notable, exactly as for user/assistant
text. `getMessageText` / `collectMessageParts` are intentionally left unchanged.
