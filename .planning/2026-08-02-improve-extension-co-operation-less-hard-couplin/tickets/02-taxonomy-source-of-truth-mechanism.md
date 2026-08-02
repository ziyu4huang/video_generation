---
type: grilling
blocked by: [01]
claimed: charting-session (2026-08-02)
status: closed
---
## Question

**Which no-import discovery mechanism should be the single source of truth for tool-gate's taxonomy** — the `GATES[]` keyword/intent map AND the `CORE_TOOLS` always-on set — so adding/renaming a tool in power-tool or core-task can't silently orphan it (as `inspect_hooks` is orphaned today)?

**Constraint (from the map's Notes):** no cross-`@repo/pi-agent-ext-*` package dependencies — cooperation by runtime discovery only. Ticket 01 ruled out the shared-registry-import option and established the viable family.

Candidates (grill one at a time, with the S2 keyword-tuning regression risk in mind):

- **(e) source-metadata discovery** — tool-gate derives gates from `pi.getAllTools()` + each tool's `sourceInfo` / `promptGuidelines`. Zero imports. Open sub-question: how does a tool declare its keywords/intent when `ToolDefinition` has no metadata field? May force ticket 01's patch question back open.
- **(c) EventBus registration** — each tool-owner emits `tool-gate:register({ names, keywords, requires })` at load; tool-gate accumulates. Zero imports. Risk: load / `session_start` ordering not guaranteed; stringly-typed payloads (see map's "Timing contract" fog).
- **(a) pi-core `ToolDefinition.gating?` field** — most elegant (owner declares on its own def); blocked on patch infra / upstream (ticket 01). Re-open only if (e)/(c) can't meet fidelity.
- **(d) drift-catching CI test (guard, not source)** — keep `GATES` in tool-gate, add a test failing on any registered tool that is neither in `CORE_TOOLS` nor any `GATES[].names` (would have caught `inspect_hooks`). Pairs with any mechanism; cheapest, but does not by itself delegate — tool-gate still owns the taxonomy.

**This is the headline decision.** Resolve dependencies in order: can a tool self-declare metadata (e / a) at acceptable cost, or do we accept tool-gate-owns-taxonomy + a loud drift guard (d) as the pragmatic floor? The answer graduates the map's migration-path and timing-contract fog into fresh tickets.

## Resolution (2026-08-02)

Decided via 3 grilling answers. The taxonomy's single source of truth: **each tool-owner declares gating intent ON its own `ToolDefinition`; tool-gate discovers + applies it at `session_start`.**

- **Mechanism — (a) patch `getAllTools` to pass a `gating` field through.** Verified fact: `pi.getAllTools()` (`agent-session.js:613`) reconstructs each tool to `{ name, description, parameters, promptGuidelines, sourceInfo }` and DROPS every other field; the raw `getToolDefinition()` is NOT on the `ExtensionAPI`. So a `bun patch` of `@earendil-works/pi-coding-agent` adds `gating?: GatingSpec` to `ToolDefinition` (type) + one mapper line (`gating: definition.gating`) to `getAllTools()`. Owner sets `gating` on its own def; tool-gate reads it at `session_start`. **Timing-SAFE** — `getAllTools()` aggregates all extensions by `session_start` (tool-gate already relies on this). Intent travels WITH the tool. No inter-extension package dep (framework patch only; repo has vendor-patch precedent via `vendor_patches.py`).
- **`gating` field shape:** `{ keywords: string[]; requires?: { nouns: string[]; verbs: string[] }; core?: boolean }`. `keywords` = the gate's triggers; `requires` = the noun∧verb co-occurrence tuning (S2-audit precision), now OWNER-owned (folds ticket 05); `core: true` = always-on, never gated (folds ticket 04).
- **Enforcement — (d) drift-guard, STRICT.** A CI test ERRORS on any extension-registered tool whose `gating` is absent (built-ins read / bash / edit / write / grep / find / ls exempt by list). This makes `inspect_hooks`-style orphaning impossible BY CONSTRUCTION — you cannot ship an undeclared extension tool. Default-gated-hidden (today's bug) and default-always-visible are both rejected.

**Meets the acceptance bar:** the owner of a tool owns its gate (✓); silent orphaning is impossible by construction, not discipline (✓).

**Consequences for the map:**
- Tickets **04** (always-core) and **05** (co-occurrence ownership) COLLAPSE into the `gating` field shape (`core?` / `requires?`) → closed, resolved-by-02.
- "Timing contract" fog CLEARED (no EventBus → no ordering problem).
- "Migration path" fog (move the existing hardcoded `GATES` / `CORE_TOOLS` into per-tool `gating` fields, preserving S2 tuning) is EXECUTION → defers to the spec→plan that follows this map, not a map ticket.
- `inspect_hooks` stays unfixed until that migration lands — it remains the canonical motivating evidence; the strict drift-guard will force its `gating` declaration during migration.
