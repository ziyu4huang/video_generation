# pi-agent CLI

The ubiquitous language of the pi-agent CLI — a non-interactive, self-contained
entry point for driving single-turn agent runs and deterministic engine
workflows from scripts and sub-agents.

## Language

### Execution model

**Non-interactive run**:
The defining mode of every invocation: one process, no persistent TUI session
loop, scriptable. Applies to all invocations, including those that never create
an agent session (META commands, `workflow run`).
_Avoid_: single-turn (a subcategory, not the definition); one-shot / oneshot
(legacy CLI alias, not a concept)

**Single-turn agent run**:
One ephemeral agent session created and driven to completion within a single
invocation — the shape of agent commands and passthrough. A subcategory of
Non-interactive run, not equivalent to it.
_Avoid_: one-shot (legacy alias); session (overloaded — see Agent session)

### Extension loading

**Baked-in extension**:
An extension whose factory is statically imported into the CLI process, not
loaded at runtime via `.pi/settings.json` or `-e`. Describes the *load
mechanism* only. Every extension this CLI uses is baked-in.
_Avoid_: "always active" / "always loaded" (a different property — see
Always-on extension)

**Always-on extension**:
A baked-in extension present in every session regardless of command. Only
pi-obsidian qualifies — it sits unconditionally first in `extensionFactories`.

**Per-command extension**:
A baked-in extension injected only by the command that needs it (via
`extraExtensionFactories`) — knowledge-card, flux2, file2md, etc. Absent from
sessions of commands that don't use it.
_Avoid_: "lazy-loaded" (it's eager at session build, just conditional)

### Invocation dispatch

**Command**:
A typed dispatch unit implemented as a `Command` record (`{ name, summary,
details, run }`). Three groups: agent command, pipeline, workflow sub-command.
Distinct from Meta command (no record) and Passthrough (no match).
_Avoid_: "subcommand" (ambiguous — spans very different execution shapes)

**Agent command**:
A Command whose `run` produces a Single-turn agent run — the leaf agent
commands (`file2md`, `zk-*`, …). The canonical shape of a pi-agent-cli
invocation.

**Pipeline**:
A Command that orchestrates multiple agent commands in-process, in sequence,
under a resumable coordination layer (e.g. `pipeline.json`). Creates agent
sessions indirectly, via its stages.

**Workflow sub-command**:
A Command that calls the workflow engine directly (`runWorkflow`) — non-agent.
The CLI layer creates no session; the engine's own internal agents drive the
LLM. The structural exception to "every command is an agent run."
_Avoid_: conflating with agent command (it is NOT one)

**Workflow pack**:
A folder of `manifest.json` + an entry workflow script, run headless by the
workflow sub-command (`workflow run <name|path>`) via `runWorkflow()` — a
dispatch branch, NOT an extension: no factory, no agent session, no session
tools. Its folder+manifest shape echoes a pi extension folder, but it is not
loaded via `-e` and ADR 0001 never applies to it. Named resolution lives under
`PWD/.pi/workflows/` (the project engine dir) + `bun-apps/<pkg>/workflows/`; a
literal path reaches any folder. The run log defaults to `PWD/.pi/workflows/runs/`
(override: `--out-dir` / `PI_WORKFLOWS_OUT_DIR`). `.claude/workflows/` is
Claude Code's Workflow-tool dir and is NOT name-resolved here.
_Avoid_: "extension" / "headless pack-extension" (deprecated ADR 0007 term —
a pack is not an extension); "loaded via `-e`"

**Workflow-pack resolution precedence**: the order `workflow run <name>` looks
for a pack — absolute path → `<cwd>/workflows` → `<binDir>/workflows` → repo
`.pi/workflows` → repo `bun-apps/<pkg>/workflows`. "Most local wins": cwd-local
and binary-bundled packs shadow repo packs. See ADR 0008.

**Meta command**:
A typed token handled inline without a Command record (`list`, `version`,
`completions`, `help`). Produces no agent session.

**Passthrough**:
The fallback when no command token matches the first positional. Mirrors
`pi -p`: the raw prompt becomes a Single-turn agent run. Exists so the binary
itself can serve as a Sub-agent target.

**Sub-agent target**:
A binary that its own extensions can re-invoke as a child agent run (via
`process.argv[1]` + pi flags). pi-agent-cli is its own sub-agent target: a
parent run's obsidian tool spawns a child Passthrough run, so the same binary
recurses.

### Knowledge distillation

**Distill pipeline**:
The WRITE path that converges raw memories into the knowledge graph. Three
fixed stages: Gate → Enrich → Converge. Only Enrich involves an LLM.

**Gate**:
The first distill stage — deterministic, no LLM. Filters raw memory entries by
dedup (fuzzy Jaccard ≥ 0.72), staleness (90 days), and format validity. Emits
Survivors (kept) and Killed (rejected, with reason).

**Enrich**:
The second distill stage — the ONLY LLM step, performed by the driving agent
as a normal reasoning turn through its pi-agent session (the extension imports
no model client, reads no key, makes no provider call). Rewrites each Survivor
into a structured note: clarity, tags, wiki-links, fragment merging.

**Converge**:
The third distill stage — deterministic, no LLM. Writes enriched notes into
the knowledge graph via knowledge-card's ingest: canonical-id dedup, tag
cross-links, MOC indexing, supersede marking. Feeds its metrics back into the
Adaptive threshold.

**Adaptive threshold**:
A tunable N (default 50, clamped [20,200]) that triggers distillation when
raw-memory bloat exceeds it. After each Converge, metrics auto-adjust N: high
kill+pass rate → lower N (run often, it's efficient); low pass rate → raise N
(be conservative). Event-driven, not scheduled.

### Knowledge retrieval

**Deterministic retrieval**:
The knowledge-stack READ path with no LLM — in-process shared-tag ranking plus
boost, returning a digest. Reproducible and zero token cost. Backs `zk-query`
and the `knowledge_query` tool. Use when you want a fast, stable digest of
relevant cards.

**Graph-enhanced RAG**:
The knowledge-stack READ path driven by the agent — search seed → N-hop
wiki-link graph expansion → rank (0.7×lexical + 0.3×link) → tiered full-read →
LLM synthesis with references. Backs `zk-ask`. Use when you want a question
answered in prose with citations.
