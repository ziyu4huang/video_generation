> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Wayfinder map: 2026-08-02-improve-extension-co-operation-less-hard-couplin

## Destination

A settled **architectural decision** (not landed code) that gives a single source of truth for two coupling pains between **tool-gate, core-task, and power-tool**, under a hard constraint the human set this session: **no cross-package dependencies between the extension packages** (`@repo/pi-agent-ext-*`) — they cooperate at runtime via *discovery*, not imports, for broader isolation (any one can evolve / be added / removed independently).

The two pains:

1. **tool-gate's hand-mirrored tool taxonomy** — its `GATES[]` (keyword/intent map) + `CORE_TOOLS` (always-on set) hardcode other extensions' tool names by hand. Live symptom: power-tool's `inspect_hooks` (`src/tools/inspect-hooks.ts:236`) is registered but **orphaned** — in no gate and not core, so it's hidden at start and no keyword ever reactivates it (only `enable_tool` recovers it).
2. **the schema-cost heuristic cluster** — `(desc.length + JSON.stringify(parameters).length)/4` lives in three places: canonical in `power-tool/src/schema-cost/`, imported as a cross-package dep by `pi-agent-cli/schema-cost`, and inlined verbatim in `tool-gate` ("to keep this always-on extension decoupled").

The decision covers tool-gate + core-task + power-tool as the **pilot**; the chosen mechanism must **generalize** so the other ~9 mirrored extensions adopt it in a later execution plan. Output = a decision; implementation = a later spec→plan.

## Notes

- **Domain**: pi extension packages (`bun-apps/pi-agent-ext-*`), their `package.json` dependency graphs, and pi's `ExtensionAPI` (`getAllTools`, `setActiveTools`, `EventBus`, `ToolDefinition`).
- **Hard constraint (decided this session — 4 grilling answers)**: decouple at BOTH (a) the Bun / package-dependency level — no inter-`@repo/pi-agent-ext-*` `dependencies` / `peerDependencies` — and (b) the tool-calling level — cooperation via runtime discovery (`getAllTools()` source metadata / `EventBus`), never hand-mirroring. Work-efficient at runtime, isolated in the dep graph.
- **Skills every session should consult**: `grilling` + `domain-modeling` (tickets 02/03/04/05 are grilling); the pi `ExtensionAPI` surface at `…/pi-coding-agent/dist/core/extensions/types.d.ts`.
- **Key facts (from charting research — see ticket 01)**: `ToolDefinition` has **no** `intent`/`keywords`/`gating`/free-form-metadata field (only `promptGuidelines?`); `getAllTools(): ToolInfo[]` carries `sourceInfo` (owning extension); `EventBus` is stringly-typed pub/sub (`emit(channel,data)`/`on(channel,handler)`); the repo has **no npm-dep patch infra** (no `patches/`, no patch-package) → patching pi-core is high-cost / fragile.
- **Motivating live bug — do NOT hotfix yet; it is the canonical evidence**: power-tool's `inspect_hooks` is orphaned by tool-gate.

## Decisions so far

<!-- the index — one line per closed ticket -->

- [01 · pi-core patchability + discovery surface](tickets/01-pi-core-patchability-and-discovery-surface.md) — no patch infra exists (a `ToolDefinition` edit = high-cost / upstream); `getAllTools()` carries `sourceInfo` + `EventBus` is stringly-typed pub/sub, so **no-import runtime discovery is viable** — the only mechanism family that honors the isolation constraint. Shared-registry-import is ruled OUT.
- [02 · Taxonomy source-of-truth mechanism](tickets/02-taxonomy-source-of-truth-mechanism.md) — **owner-declares via a patched `gating` field on `ToolDefinition`** (`bun patch` of `getAllTools`; introduces the patch infra 01 found missing). tool-gate discovers + applies at `session_start`. Shape `{ keywords, requires?, core? }`. A STRICT drift-guard errors on any extension tool lacking `gating` (built-ins exempt) → `inspect_hooks`-style orphaning impossible by construction.
- [04 · Always-core declaration without coupling](tickets/04-always-core-declaration-without-coupling.md) — resolved by 02: `gating.core?: boolean` (owner-declared, opt-in core).
- [05 · Co-occurrence tuning ownership](tickets/05-co-occurrence-tuning-ownership.md) — resolved by 02: `gating.requires?` is owner-owned; the S2 false-fire gotchas become an owner tuning-guide, not a tool-gate override layer.
- [03 · Schema-cost strategy under isolation](tickets/03-schema-cost-strategy-under-isolation.md) — **inline + guard test; keep the host→extension delegation.** Heuristic stays inline in tool-gate; a dev-time guard test keeps it honest vs power-tool's `estimateToolCost`. Ruling: extension↔extension deps forbidden, host→extension in-bounds. Clears the "Shared-utility boundary" fog (no foundation needed).

## Not yet specified

<!-- All in-scope fog cleared. 02 cleared the migration-path + timing-contract fog; 03 cleared the shared-utility-boundary fog (no foundation needed; host→extension ruled in-bounds). The map is complete — frontier empty, destination reached. -->

## Out of scope

<!-- work ruled beyond the destination -->

- **Hook ordering** between the three extensions' `session_start` / `before_agent_start` handlers — no demonstrated drift; not a coupling pain.
- **core-task's shared status widget** (goal / todo / ask_user_question cohabit one widget) — internal to core-task, not cross-extension coupling.
- **static-vs-dynamic registration** (tool-gate is dynamic `bundleMode: thin`; core-task + power-tool are static) — a registration / UX concern, not a co-operation coupling.
- **Rolling the chosen mechanism out to the other ~9 mirrored extensions** (flux2, ltx, krea2, file2md, movie, research-tool, arxiv, deploy, zai-mcp) — a later execution plan; this map settles the mechanism on the 3-ext pilot only.
- **Landing code** — this map produces a decision; implementation is a later spec→plan (wayfinder "plan, don't do").
