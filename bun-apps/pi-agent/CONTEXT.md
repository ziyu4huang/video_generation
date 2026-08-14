# pi-agent

The ubiquitous language of pi-agent — a thin wrapper around the real pi TUI that layers reversible monkey-patches to add hardcoded providers and a cwd-independent extension set. It does not reimplement pi; it calls the official `main()` untouched. The same package also owns a second entry namespace, `pi-agent cli` — non-interactive, single-turn agent runs and deterministic engine workflows for scripts and sub-agents (see [Non-interactive CLI](#non-interactive-cli)).

## Language

### Wrapper model

**Thin wrapper**:
pi-agent calls the official `main()` from `@earendil-works/pi-coding-agent` untouched, then layers reversible monkey-patches — it never forks or reimplements pi.
_Avoid_: fork, reimplementation, port (it is a passthrough that patches in place)

**Patch** (`src/patches/<name>.ts`):
A reversible monkey-patch on a pi prototype/module (e.g. `ModelRuntime.create`), applied before `main()` runs. Bun's shared module cache means one patch affects every instance `main()` constructs.
_Avoid_: override, hook, plugin (it is a prototype monkey-patch, not a subclass or lifecycle hook)

**pre-load-providers** (`src/pre-load-providers.ts` + `src/patches/pre-load-providers.ts`):
The hardcoded provider catalog (lm-studio, ollama, openrouter, …), injected by wrapping `ModelRuntime.create()` — no `~/.pi/agent/models.json` is read. Split across two files: `src/pre-load-providers.ts` holds the pure catalog (`PROVIDERS`) + `resolveApiKey`/`registerAllProviders` helpers, with no import-time side effects — safe for any consumer (e.g. `src/cli/sessions/shared.ts`, which imports it as `../../pre-load-providers.ts`) to import directly. The actual `ModelRuntime.create` wrap lives in `src/patches/pre-load-providers.ts`, reached only through the env-gated `applyPatches()`. (Pre-0.80 SDK this hooked `ModelRegistry.prototype.loadModels`; that method was removed when ModelRegistry became a stateless facade over ModelRuntime, silently breaking the old patch — every runtime now goes through `ModelRuntime.create()`.)
_Avoid_: provider config, model list (it is source-hardcoded, not config-file-driven); don't reintroduce the patch into `pre-load-providers.ts` itself — that was the exact bug this split fixed (importing the catalog alone used to silently apply the patch)

### Resource loading

**run-dir** (`run-dir/`):
This repo's fixed extension + skill set, loaded cwd-independently by splicing resolved absolute paths into argv before `main()`. Never reads or writes anything under `<cwd>/.pi/`.
_Avoid_: config dir, settings (it is a cwd-independent resource manifest, not user config)

**manifest.json** (`run-dir/manifest.json`):
The **eager** extension/skill list — loaded every session. Edit this to add/remove workspace-local extensions.
_Avoid_: extension list (too generic; distinguish from the lazy registry)

**Lazy extension** (`run-dir/settings.json` `lazyExtensions`):
An opt-in extension resolved only when invoked via `-e <alias>` (e.g. `workflow`). Costs zero context unless asked for by alias — for heavy on-demand tools.
_Avoid_: optional extension, plugin (it is alias-gated, zero-cost-until-invoked)

**Alias resolution**:
`run-dir/resolve.ts` rewrites `-e <alias>` to an absolute factory path before `main()` sees argv. First-hit-wins: exact key → unique substring → single-`.ts` directory fallback; real paths and URL schemes pass through untouched.
_Avoid_: alias mapping, shortcut

**npmExtensions**:
The single array in `manifest.json` that is the source of truth for npm-sourced extensions, read by both `resolve.ts` (source) and `scripts/lib/codegen.ts` (bundle).
_Avoid_: deps list, package array

### Build & deploy

**Source / bundle / binary modes**:
The three execution modes. Source (`bun src/cli.ts`) resolves deps via the real node_modules; bundle (`dist/pi-agent/pi-agent.js`) symlinks a node_modules for `getAliases()`; the compiled binary (`--exe`) cannot dynamically load `.ts` extensions (jiti + Bun-compile `ENAMETOOLONG`) — it statically imports the static extension set (`run-dir/manifest.json` → `staticExtensions`, mirrored by `src/static-extensions.ts`) instead. (The size is deliberately NOT restated here — it drifted independently in six documents before `run-dir/manifest-consistency.test.ts` made the manifest the single source of truth.) `deploy.ts` also has `--snapshot` (raw source copy) and `--standalone` (bundle + bun binary), both still "source" or "bundle" at the `detectMode()` level.
_Avoid_: dev/prod modes (these are packaging modes, not environments)

**THIN bundle**:
The (only, since the unified `deploy.ts`) extension-bundling mode: each extension is pre-bundled to one `.js` sharing a single typebox instance instead of each pulling its own copy. Deployed as `ext-bundles/*.thin.js`.
_Avoid_: minified bundle, slim bundle, FULL bundle (a FULL/per-extension-typebox mode existed historically but was removed — see `docs/superpowers/plans/2026-07-18-unified-deploy.md`)

**Read-only deploy**:
The default deploy artifact — immutable (chmod a-w + `.deploy-readonly` marker), with all per-user state routed to `~/.pi/agent`. Drops onto `/opt` or an app bundle as-is.
_Avoid_: frozen release, static deploy (it is an immutable artifact with writable state routed out)

**Warm-deploy hash cache**:
Per-extension `<name>.<thin|full>.hash` sidecar (hashed over source tree + flag + externals + `Bun.version`) that lets a warm deploy skip rebuild for unchanged extensions.
_Avoid_: build cache, incremental cache

### Self-check

**doctor**:
The offline self-check — detects deploy mode, verifies the extension set is complete for it, checks host deps, reports provider keys + which patches would apply. Exit 0 = all hard checks pass.
_Avoid_: health check, preflight (it is a deploy/machine boundary-condition checker)

**`doctor --smoke`**:
Spawns a throwaway probe that calls `pi.getAllTools()` at `session_start` and counts run-dir-sourced tools — catches the silent-no-op class (extensions that fail to load while every static check stays green).
_Avoid_: runtime test, integration check (it is an offline tool-count probe at session_start)

**`doctor --fix`** — REMOVED:
Derived a fix plan and ran `bun install` in the deploy dir. It gated on `portable`/`release`, modes deploy.ts cannot produce, so it never ran; and `bun install` cannot repair a snapshot anyway (not a workspace → every `workspace:*` dep fails to resolve). A deploy artifact is re-deployed, not repaired.
_Avoid_: describing pi-agent as self-healing — it is not

## Non-interactive CLI

The vocabulary of `pi-agent cli` (`src/cli/`) — the package's second entry
namespace: non-interactive, driving single-turn agent runs and deterministic
engine workflows from scripts and sub-agents. Merged in from the former
`pi-agent-cli` package (2026-08-12); this is now one package's glossary, not
two.

**`cli` namespace**:
The argv token that routes into the non-interactive CLI (`pi-agent cli <command>`).
Intercepted in `src/cli.ts` BEFORE `applyPatches()`, so a CLI invocation inherits
none of the TUI's run-dir splice, provider patch, or static extension factories —
that separation is what keeps per-command tool curation (ADR 0001) meaningful.
_Avoid_: subcommand (ambiguous), mode (it is an entry namespace, not a runtime mode)

### Execution model

**Non-interactive run**:
The defining mode of every `cli` invocation: one process, no persistent TUI
session loop, scriptable. Applies to all of them, including those that never
create an agent session (META commands, `workflow run`).
_Avoid_: single-turn (a subcategory, not the definition); one-shot / oneshot
(legacy CLI alias, not a concept)

**Single-turn agent run**:
One ephemeral agent session created and driven to completion within a single
invocation — the shape of agent commands and passthrough. A subcategory of
Non-interactive run, not equivalent to it.
_Avoid_: one-shot (legacy alias); session (overloaded — see Agent session)

### Extension loading

**Baked-in extension**:
An extension whose factory is statically imported into the process, not loaded
at runtime via `.pi/settings.json` or `-e`. Describes the *load mechanism*
only. Every extension the `cli` namespace uses is baked-in — distinct from the
TUI path, where run-dir splices `-e <abs path>` into argv.
_Avoid_: "always active" / "always loaded" (a different property — see
Always-on extension)

**Always-on extension**:
A baked-in extension present in every `cli` session regardless of command. Only
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
commands (`file2md`, `zk-*`, …). The canonical shape of a `pi-agent cli`
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
The fallback when no command token matches the first positional after `cli`.
Mirrors `pi -p`: the raw prompt becomes a Single-turn agent run. Exists so
pi-agent itself can serve as a Sub-agent target.

**Sub-agent target**:
A binary that its own extensions can re-invoke as a child agent run (via
`process.argv[1]` + pi flags). pi-agent is its own sub-agent target. When the
parent is in the `cli` namespace, `runCli()` exports `PI_SELF_ENTRY_PREFIX=cli`
so `getPiInvocation()` puts the child in the same namespace instead of the TUI root.

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
