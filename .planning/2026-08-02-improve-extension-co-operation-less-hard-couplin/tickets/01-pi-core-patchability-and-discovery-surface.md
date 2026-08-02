---
type: research
claimed: charting-session (2026-08-02)
status: closed
---
## Question

Which decoupling mechanisms are even viable given pi-core's actual surface and the repo's patch infrastructure? Specifically: (a) can this repo patch `ToolDefinition` in `@earendil-works/pi-coding-agent` to add a gating-metadata field, or is that upstream-PR / fragile? (b) what does `pi.getAllTools()` / `ToolInfo` expose — can tool-gate key on the owning extension? (c) what is the `EventBus` surface — typed channels or stringly-typed?

## Resolution

Researched inline during charting from `…/pi-coding-agent/dist/core/extensions/types.d.ts` + `event-bus.d.ts` + repo conventions.

- **(a) `ToolDefinition` patch — NOT currently viable without new infra.** `ToolDefinition` exposes `name / label / description / promptSnippet? / promptGuidelines? / parameters / constrainedSampling? / renderShell? / prepareArguments? / executionMode? / execute / renderCall? / renderResult?` — **no** `intent` / `keywords` / `gating` / free-form `metadata`. The repo has **no npm-dep patch mechanism** (no `bun-apps/patches/`, no patch-package, no postinstall patch). Python sibling-forks (mflux / ltx-2-mlx) ARE patched via `python/mlx-movie-director/app/vendor_patches.py`, but that is Python source — there is no equivalent for the npm `pi-coding-agent` package. Adding a gating field therefore means either introducing bun-patch / patch-package infra (fragile across `0.83.0`→next bumps) or an upstream PR to `@earendil-works/pi-coding-agent` (external, slow). High cost.
- **(b) `getAllTools(): ToolInfo[]` carries source metadata.** `RegisteredTool = { definition: ToolDefinition; sourceInfo: SourceInfo }`, and `getAllTools()` returns "all configured tools with parameter schema, prompt guidelines, and source metadata." So tool-gate CAN read each tool's owning extension at runtime — discovery-by-source is possible with zero imports. Caveat: `ToolDefinition` has no free-form metadata slot, so a tool cannot today carry its OWN gating hints on the def without patching (see (a)).
- **(c) `EventBus` is stringly-typed pub/sub.** `{ emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void; }`. Arbitrary string channels, `unknown` payloads — workable for a `"tool-gate:register"` channel, but untyped, and ordering vs `session_start` is not guaranteed.

**Implication for the headline ticket (02):** the only mechanism family that honors the "no cross-package imports" constraint is **runtime discovery** — either (e) tool-gate derives gates from `getAllTools()` source metadata, or (c) extensions emit gate-registrations on the `EventBus`. The shared-registry-import option is OUT (import = dep). The pi-core `ToolDefinition.gating?` field (a) is the most elegant but blocked on patch infra. A drift-catching test (d) is a cheap guard that pairs with any of these. These are the candidates ticket 02 grills.
