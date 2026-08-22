# s2-agent

The ubiquitous language of s2-agent — a thin wrapper around the real pi TUI that layers reversible monkey-patches to add hardcoded providers and a cwd-independent extension set. It does not reimplement pi; it calls the official `main()` untouched. The same package also owns a second entry namespace, `s2-agent cli` — non-interactive, single-turn agent runs and deterministic engine workflows for scripts and sub-agents (see [Non-interactive CLI](#non-interactive-cli)).

## Language

### Wrapper model

**Thin wrapper**:
s2-agent calls the official `main()` from `@earendil-works/pi-coding-agent` untouched, then layers reversible monkey-patches — it never forks or reimplements pi.
_Avoid_: fork, reimplementation, port (it is a passthrough that patches in place)

**Patch** (`src/patches/<name>.ts`):
A reversible monkey-patch on a pi prototype/module (e.g. `ModelRuntime.create`), applied before `main()` runs. Bun's shared module cache means one patch affects every instance `main()` constructs.
_Avoid_: override, hook, plugin (it is a prototype monkey-patch, not a subclass or lifecycle hook)

**pre-load-providers** (`src/pre-load-providers.ts` + `src/patches/pre-load-providers.ts`):
The single home for ALL baked model config, in three pure sections: §1 the hardcoded provider catalog (lm-studio, …) + `resolveApiKey`/`registerAllProviders` helpers, §2 `BUILTIN_MODEL_DEFAULT` (the default provider/model/thinking choice), §3 the tier→model routing seed (`DEFAULT_MODEL_TIER_CONFIG`). §1's providers are injected by wrapping `ModelRuntime.create()` — no `~/.pi/agent/models.json` is read, and no `~/.pi/agent/models-store.json` is ever created: pi 0.84.2's builtin catalog already ships zai/deepseek/huggingface, and `src/patches/in-memory-models-store.ts` forces an in-memory models store so catalog refresh never persists. (A §4 models-store seed existed until 2026-08-22; retired as redundant.) Split across two files: `src/pre-load-providers.ts` holds all the pure data + helpers, with no import-time side effects — safe for any consumer (e.g. `src/cli/sessions/shared.ts`, which imports it as `../../pre-load-providers.ts`) to import directly. The actual `ModelRuntime.create` wrap lives in `src/patches/pre-load-providers.ts`, reached only through the env-gated `applyPatches()`. (Pre-0.80 SDK this hooked `ModelRegistry.prototype.loadModels`; that method was removed when ModelRegistry became a stateless facade over ModelRuntime, silently breaking the old patch — every runtime now goes through `ModelRuntime.create()`.)
_Avoid_: provider config, model list (it is source-hardcoded, not config-file-driven); don't reintroduce the patch into `pre-load-providers.ts` itself — that was the exact bug this split fixed (importing the catalog alone used to silently apply the patch)

### Resource loading

**run-dir** (`run-dir/`):
This repo's fixed extension + skill set, loaded cwd-independently by splicing resolved absolute paths into argv before `main()`. Never reads or writes anything under `<cwd>/.pi/`.
_Avoid_: config dir, settings (it is a cwd-independent resource manifest, not user config)

**manifest.json** (`run-dir/manifest.json`):
The **eager** extension/skill list — loaded every session. Edit this to add/remove workspace-local extensions.
_Avoid_: extension list (too generic; distinguish from the lazy registry)

**Lazy extension** (`run-dir/manifest.json` `lazyExtensions`):
An opt-in extension resolved only when invoked via `-e <alias>` (e.g. `workflow`). Costs zero context unless asked for by alias — for heavy on-demand tools. (No `run-dir/settings.json` exists — the registry is a field of the manifest.)
_Avoid_: optional extension, plugin (it is alias-gated, zero-cost-until-invoked)

**Alias resolution**:
`run-dir/lazy-extensions.ts` rewrites `-e <alias>` to an absolute factory path before `main()` sees argv. First-hit-wins: exact key → unique substring → single-`.ts` directory fallback; real paths and URL schemes pass through untouched. Acts on the USER's argv — which is what makes it a separate module from the argv `resolve.ts` produces.
_Avoid_: alias mapping, shortcut

**npmExtensions**:
The single array in `manifest.json` that is the source of truth for npm-sourced extensions, read by both `run-dir/deps-probe.ts` (source) and `../s2-agent-ext-devops/src/deploy/lib/codegen.ts` (bundle).
_Avoid_: deps list, package array

**run-dir module split** (`run-dir/run-context.ts`):
`resolve.ts` owns deploy-layout detection + argv construction and re-exports — one hop, naming the defining module — what moved out: `deps-probe.ts` (will the extensions be able to import what they need; auto-install; missing-deps guide) and `lazy-extensions.ts` (alias rewriting). `run-context.ts` holds the three facts all of them must agree on: `mode`, `resolveBunAppsDir()`, `warn()`. Import direction is strictly `resolve → {deps-probe, lazy-extensions} → run-context`.
_Avoid_: helpers, utils (each module is a concern, not a grab bag)

### Build & deploy

**Execution modes**:
The two that remain after the deploy consolidation (spec: `.planning/specs/2026-08-20-deploy-architecture-consolidation-design.md`): source (`bun src/cli.ts`) resolves deps via the real node_modules; binary (the deployed core, entry `src/cli-sh.ts`) cannot dynamically load `.ts` extensions (jiti + Bun-compile `ENAMETOOLONG`) — it statically imports the static extension set (`run-dir/manifest.json` → `staticExtensions`, generated into `src/static-extensions.ts` by #1739's codegen) and discovers deployed `ext/<name>/` cjs bundles at runtime. The four legacy `deploy.ts` modes (`--bundle`/`--snapshot`/`--standalone`/`--exe`) are gone; so are `.deploy-bundle` and `ext-bundles/`. (The extension count is deliberately NOT restated here — it drifted independently in six documents before `run-dir/manifest-consistency.test.ts` made the manifest the single source of truth.)
_Avoid_: dev/prod modes (these are packaging modes, not environments), "three modes" (bundle mode was collapsed in Phase 1b)

**deploy (s2-agent-sh)**:
THE deploy pipeline (`bun run deploy` → `../s2-agent-ext-devops/src/deploy-cli.ts` → `src/deploy/run.ts`): a versioned tree at `~/proj/dist/s2-agent-sh/<version>/` holding a minimal compiled core (entry `src/cli-sh.ts`, ZERO extensions inside) plus extension packages under `ext/<name>/` that the core discovers at runtime. Extensions are cjs bundles with pi's runtime `--external`; the core injects its own embedded modules through the bundle's `require` (`src/sh/host-modules.ts`), which is what keeps extension and host on ONE module instance. See `docs/deploy.md`.
_Avoid_: sh deploy as a separate thing (since the consolidation there is only one deploy), plugin dir (the contract is `ext.json` + host-injected require, not drop-in files)

**Read-only deploy**:
The default deploy artifact — immutable (chmod a-w + `.deploy-readonly` marker), with all per-user state routed to `~/.pi/agent`. Drops onto `/opt` or an app bundle as-is.
_Avoid_: frozen release, static deploy (it is an immutable artifact with writable state routed out)

**Warm-deploy hash cache** (RETIRED with the legacy pipeline):
The per-extension `<name>.<thin|full>.hash` sidecar is gone — a full deploy is ~2s, so nothing skips rebuilds anymore.
_Avoid_: reusing the term for the sh deploy (it rebuilds unconditionally)

### Self-check

**doctor**:
The offline self-check — detects deploy mode, verifies the extension set is complete for it, checks host deps, reports provider keys + which patches would apply. Exit 0 = all hard checks pass.
_Avoid_: health check, preflight (it is a deploy/machine boundary-condition checker)

**`doctor --smoke`**:
Spawns a throwaway probe that calls `pi.getAllTools()` at `session_start` and counts run-dir-sourced tools — catches the silent-no-op class (extensions that fail to load while every static check stays green).
_Avoid_: runtime test, integration check (it is an offline tool-count probe at session_start)

**`doctor --fix`** — REMOVED:
Derived a fix plan and ran `bun install` in the deploy dir. It gated on `portable`/`release`, modes deploy.ts cannot produce, so it never ran; and `bun install` cannot repair a snapshot anyway (not a workspace → every `workspace:*` dep fails to resolve). A deploy artifact is re-deployed, not repaired.
_Avoid_: describing s2-agent as self-healing — it is not

## Non-interactive CLI

The vocabulary of `s2-agent cli` (`src/cli/`) — the package's second entry
namespace: non-interactive, driving single-turn agent runs and deterministic
engine workflows from scripts and sub-agents. Merged in from the former
`s2-agent-cli` package (2026-08-12); this is now one package's glossary, not
two.

**`cli` namespace**:
The argv token that routes into the non-interactive CLI (`s2-agent cli <command>`).
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
commands (`file2md`, `zk-*`, …). The canonical shape of a `s2-agent cli`
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
s2-agent itself can serve as a Sub-agent target.

**Sub-agent target**:
A binary that its own extensions can re-invoke as a child agent run (via
`process.argv[1]` + pi flags). s2-agent is its own sub-agent target. When the
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
as a normal reasoning turn through its s2-agent session (the extension imports
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
