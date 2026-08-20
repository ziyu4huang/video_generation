**ID:** `ADR-subagent-0001` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# 0001 — Why the subagent subsystem was extracted into its own package

> ⚠️ **PARTIALLY SUPERSEDED by [ADR-0002](./0002-relocate-viewer-command-to-subagent.md)
> (2026-07-25, PR #821).** The section *"Why `subagent-viewer` and
> `subagents-command` stayed in workflow"* below is **historical only** — the
> viewer, command, and progress-widget were subsequently MOVED into this package
> by extracting the generic render helpers into a subagent-local
> `agent-row-display.ts` (breaking the `display.ts ⟹ workflow.ts` cycle that
> originally blocked the move). The singletons also became intra-package (no
> peer-extension callers remain); the `src/` subpath rule is retained as
> forward-compat. Everything else here (extraction rationale, Design B) stands.

**Status:** accepted (2026-07-24; part of the `feat/extract-subagent-package` work)

The subagent subsystem — the `subagent` + `subagent_runs` tools, the `WorkflowAgent` runner, the `spawnSubagent` programmatic API, the in-flight registry, run-persistence, agent-registry, model-tier, worktree, and the SDD-report parser — was extracted out of `s2-agent-ext-workflow` into a new, lower-dependency package `s2-agent-ext-subagent`, which ships its own extension that registers the two tools. This ADR records why we extracted, why the `/subagents` viewer and command stayed behind, why the new package gets its own extension (Design B), and the singleton module-identity decision that holds the two extensions together.

## Why extract at all

`s2-agent-ext-workflow` had grown into a monolith: the workflow orchestration DSL (`agent`/`parallel`/`pipeline`/`phase`, the vm sandbox, pack resolution, resume journal) and the single-subagent capability (`spawnSubagent`, `WorkflowAgent`, the `subagent` tool, agent-registry, model-tier) were fused in one package. Peer extensions that only wanted to `spawnSubagent` — `s2-agent-ext-knowledge-card` (`zk_card`/`zk_ask`), `s2-agent-ext-wayfind`, `s2-agent-ext-superpowers` — had to depend on the whole workflow package, dragging in the engine, the sandbox, the pack resolver, and the resume machinery just to make one child-model call.

Extracting the subagent subsystem into its own package gives those peer consumers a small, stable, lower-dependency library: they import `spawnSubagent` + types from `@repo/s2-agent-ext-subagent` and never touch the workflow engine. The dependency graph inverts — workflow now depends on subagent (for the runner, the singletons, the agent-registry), not the other way around.

## Why `subagent-viewer` and `subagents-command` stayed in workflow

The `/subagents` interactive TUI viewer (`subagent-viewer.ts`) and the `/subagents` slash command (`subagents-command.ts`) were NOT moved. The blocker is a dependency cycle: `subagent-viewer.ts` imports rendering helpers from `display.ts`, and `display.ts` imports types from `workflow.ts`. Moving the viewer into the subagent package would drag `display.ts` along, and `display.ts ⟹ workflow.ts` would pull the workflow engine back in — re-creating exactly the monolith we just split, now with a cycle.

Instead the viewer/command stay in workflow and read the SAME singletons the subagent tool writes (see the module-identity decision below). The split is clean: this package OWNS the tools + runner + singletons + data; workflow OWNS the orchestration engine + the interactive surfaces that observe runs. Workflow imports the singletons from this package; the data flows one way.

## Why Design B: the new package ships its own extension

Two designs were on the table:

- **Design A — library only, no extension.** The new package is a pure library; `s2-agent-ext-workflow`'s extension keeps registering `subagent` + `subagent_runs` (constructed from the now-imported factories) and keeps force-activating them.
- **Design B — library AND its own extension.** ✅ Chosen. The new package registers `subagent` + `subagent_runs` from its own `extensions/subagent.ts`; workflow's extension stops registering them and only reads the singletons for its viewer.

Design B was chosen so the subagent tools load **independently** of the workflow engine. Under Design A, disabling/uninstalling workflow would disable the `subagent` tool too — the capability is needlessly coupled to orchestration. Under Design B, the subagent tools stand on their own: a host that loads only `s2-agent-ext-subagent` gets working `subagent` + `subagent_runs` tools with no workflow dependency at runtime. It also localizes the tool's lifecycle (session_start capture of parent tools + main model, force-activation on `before_agent_start`) in the package that owns the tool, rather than splitting "the runner lives here, the registration lives there."

The cost of Design B is the cross-extension singleton-sharing problem — which the next decision addresses.

## The singleton module-identity decision (import via the `src/` subpath)

`getSubagentInFlightRegistry()` and `getSubagentRunPersistence()` are **module-local lazy singletons** (a module-level `let _singleton;` initialized on first call). For the `subagent` tool (this package's extension) and the `/subagents` viewer/command (workflow's extension) to share ONE instance, both call sites must resolve the singleton from the **same JS module instance**.

The decision:

- This package's own extension (`extensions/subagent.ts`) imports the singletons via the relative path `../src/index.js`, which resolves to `src/index.ts`.
- Peer extensions — workflow's `s2-agent-ext-workflow/extensions/workflow.ts` and `src/subagents-command.ts` — import them via the **`src/` subpath**: `@repo/s2-agent-ext-subagent/src/index.ts` (`.js` for the type-only import). The package's `exports` map exposes `"./src/*": "./src/*"` for exactly this.
- Both resolutions land on the identical `src/index.ts` module → one `_singleton` per process → the viewer sees the live runs the tool writes.

The failure mode this prevents: if a peer extension imported the singletons via the **dist root** (`@repo/s2-agent-ext-subagent` → `dist/index.js`), it would get a *different* module instance — `dist/index.js` and `src/index.ts` are not guaranteed to be module-identical — and its lazily-initialized singleton would be a separate, empty registry. The `/subagents` viewer would show nothing during a run.

Values and types that are merely *used* (`spawnSubagent`, `WorkflowAgent`, errors, the tool factories, `AgentUsage`, …) are safe to import from the package root — only the two singletons demand the `src/` subpath. This asymmetry is documented in the README and is the one rule peer-extension authors must not break.

## Considered alternatives

- **Move the singletons to a dedicated "shared-state" micro-package** so every importer (including this package) depends on it. Rejected — adds a third package for two module-local variables; the `src/` subpath achieves the same module identity without the extra hop, and keeps the singletons co-located with the registry/persistence code that defines them.
- **Make the singletons global (`globalThis.__piSubagentInFlight`)** so module identity is irrelevant. Rejected — globals are invisible to the type system, untestable, and collide across nested pi processes; the module-local singleton with a documented import path is strictly better.
- **Re-export the singletons from workflow's package root** for back-compat. Rejected — it would invite peer extensions to import them from workflow (dist root), silently breaking the identity invariant. The singletons are imported from `@repo/s2-agent-ext-subagent/src/*` only.

## Consequences

- **One rule to remember.** Peer extensions importing the singletons MUST use the `src/` subpath. Documented in README + this ADR; the registry source is commented with the same warning.
- **Load order matters.** In `s2-agent/src/static-extensions.ts`, `s2-agent-ext-subagent` is registered BEFORE `s2-agent-ext-workflow`, so workflow's viewer reads a populated registry at load time. (Both lazily init on first use, so this is defense-in-depth, not a hard requirement.)
- **Schema-cost canary must mirror the registration.** `s2-agent/run-dir/manifest.json` `staticExtensions[]` is the source of truth for `discoverExtensionEntries()` in `s2-agent-cli/src/commands/schema-cost.ts`; it must list `s2-agent-ext-subagent` so the canary measures the two tools and catches a future regression where the tool-registering extension disappears.
- **Symbol continuity.** `WorkflowAgent` keeps its `Workflow`-prefixed name (not renamed to `SubagentAgent`) so every existing import across the repo + downstream keeps working; the name is historical, not a workflow-only scope claim.
- **`spawnSubagent` is re-exported from `s2-agent-ext-workflow`** for backward compatibility, so any external consumer still importing it from the workflow package root keeps compiling. New consumers should import from `@repo/s2-agent-ext-subagent`.
