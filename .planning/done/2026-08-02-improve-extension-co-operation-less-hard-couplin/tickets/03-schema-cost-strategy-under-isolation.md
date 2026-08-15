---
type: grilling
claimed: charting-session (2026-08-02)
status: closed
---
## Question

**Under the no-cross-dep isolation constraint, what is the schema-cost strategy** so the `(desc.length + JSON.stringify(parameters).length)/4` heuristic stops drifting across its placements — without introducing or relying on cross-package imports?

Current state (the coupling cluster):

- `pi-agent-ext-power-tool/src/schema-cost/` — canonical submodule.
- `pi-agent-cli/src/commands/schema-cost.ts` — imports `@repo/pi-agent-ext-power-tool/schema-cost` (a **cross-package runtime dep** — itself a violation of the isolation constraint; its own comment marks the re-export `@deprecated delegate`).
- `pi-agent-ext-tool-gate/extensions/tool-gate.ts` — inlines `measureToolTokens` verbatim ("to keep this always-on extension decoupled") — no dep, but a drifting copy.
- `pi-agent-ext-tool-gate/qa/*.ts` — imports `../../pi-agent-cli/src/commands/schema-cost.ts` (dev-time cross-package path import).

Options to grill:

- **Sever + accept duplication, guard with a test** — each package owns its inline copy (max isolation); a test asserts all copies agree. Cheapest, honors isolation, drift is caught (not silent).
- **Neutral foundation lib** — extract the heuristic to a non-extension `@repo/pi-shared` (or `shared/`) that extensions MAY depend on. Reduces isolation (removing the foundation breaks all three); decide if a non-extension foundation is in-bounds (see map's "Shared-utility boundary" fog).
- **Upstream into pi-core** — push `measureToolTokens` into `@earendil-works/pi-coding-agent` (it is a generic tool-cost primitive). Cleanest ownership, but external / slow (ticket 01).

**Decide also:** is the existing `pi-agent-cli → power-tool/schema-cost` dep a smell to sever, or acceptable because `pi-agent-cli` is the CLI host (not a peer extension)? This sets the bar for what "no cross-dep" actually forbids.

## Resolution (2026-08-02)

Decided via 1 grilling answer — the decision tree was smaller than framed. (The "3-way duplication" is really **1 inline copy + 1 host delegation**, not three drifts.)

- **Strategy — inline + guard test; keep delegation.** The 1-line heuristic stays inline in tool-gate (runtime-isolated, no dep — already the case). A guard TEST (dev-time cross-package import, as tool-gate's QA already does) asserts `measureToolTokens` (tool-gate) agrees with `estimateToolCost` (power-tool) — drift is caught, not silent. Canonical = power-tool's `estimateToolCost`; tool-gate's inline is a guarded replica. The analysis engine (`analyzeTools` / `formatReport` / report types) stays power-tool's value-add.
- **Host→extension ruling — IN-BOUNDS.** The `pi-agent-cli → @repo/pi-agent-ext-power-tool/schema-cost` delegation is ACCEPTED: the host legitimately assembles extensions, and power-tool is always-on/static so the dep is safe. **This sets the bar for the isolation constraint:** "no cross-dep" forbids extension↔extension deps (the real constraint; none exist between the 3 pilots) but PERMITS host→extension.
- **Cleanup (execution, for the spec→plan):** remove the `@deprecated delegate` re-export scaffolding in `pi-agent-cli/src/commands/schema-cost.ts` so consumers import from power-tool directly and the boundary is honest.

**Meets the acceptance bar:** heuristic drift is stopped (guard test) without introducing any extension↔extension dependency (✓).

**Clears the map's "Shared-utility boundary" fog:** no neutral `@repo/pi-shared` foundation is introduced — the heuristic is too trivial (1 line) to justify one, and host→extension delegation covers the CLI's need. The question "does broader isolation forbid even a foundation?" is moot here.
