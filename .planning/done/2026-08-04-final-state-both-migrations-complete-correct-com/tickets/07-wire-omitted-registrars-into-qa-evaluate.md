type: task
claimed: wayfind-session (interactive, 2026-08-04)
status: closed

## Question

Wire the 3 tool sources omitted from `qa/evaluate.ts`'s capture list (devops, wayfind, memory_supersede) so their source-level `gating:` declarations are read by the QA harness — the gap that left tickets 02–05 "ungated" in the report despite correct source edits.

## Resolution

**Done (2026-08-04).** Additive wiring in `bun-apps/pi-agent-ext-tool-gate/qa/evaluate.ts`:
- Imported + added `devopsDefault` (`@repo/pi-agent-ext-devops/extensions/devops.ts`) to `captureOwnerDeclaredDefs([...])` → captures `sweep_branches` + `await_pr_merge` (gated) + `pr_status` (ungated, skipped).
- Imported + added `wayfindDefault` (`@repo/pi-agent-ext-wayfind/extensions/wayfind.ts`) → captures `wayfind_effort` (core:true → tracked set).
- Added `registerMemorySupersedeTool(pi, null, {} as any)` inside `hermesMemoryRegistrar` → captures `memory_supersede`. Reversed the deliberate `evaluate.ts:169` "best-effort / out of scope" omission — required by the destination (qa green for all 5).
- Rewrote the now-stale `:130` (subagents) and `:169` (memory_supersede) comments.

Two necessary side-fixes:
- `pi-agent-ext-wayfind/package.json` exports map only allowed `.`→`dist/` (no dist) → blocked the subpath import. Added `"./src/*"` + `"./extensions/*"`, matching every sibling extension.
- 6 L1 probe data rows in `qa/probes.ts` (3 MUST_FIRE + 3 MUST_NOT_FIRE) for the 3 newly-captured keyword gates — 0 lines of new abstraction.

Result: `bun run qa --strict` → ✅ PASS, `coverage: 0 ungated heavy tool(s)`.
