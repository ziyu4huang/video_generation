## Question

claimed: resume-04-session

Owner-declare `gating` on every tool belonging to `file2md` (`bun-apps/pi-agent-ext-file2md/extensions/file2md.ts`), mirroring its current hardcoded entry in `extensions/tool-gate.ts` `GATES` (tool names: file2md, vision_ask). Then remove `file2md`'s entries from the hardcoded `GATES`/`CORE_TOOLS`, add `file2md` to the drift-guard migrated set (ticket 02), and verify `bun test` + drift-guard pass. Single-name tools: straight keyword/requires gate. Multi-name group: confirm ticket 01's resolution keeps siblings gated. Blocked until the hardening (01) and the net (02) are in place.

type: task
blocked by: 01, 02

## Resolution

status: closed

Post-rebase GATES entry matched the snapshot EXACTLY (names `file2md`/`vision_ask`, keywords, requires nouns/verbs) — no drift from origin/main's 2 commits.

Done — file2md rollout to owner-declared gating, mirroring ticket 03 (deploy):

- **Owner-declared `gating`** added to BOTH `file2md` and `vision_ask` `registerTool` calls (`extensions/file2md.ts`), with IDENTICAL keywords + `requires` (nouns/verbs) copied verbatim from the former hardcoded GATES entry. Identical signatures → `reconstructOwnerDeclaredGates` collapses them back into ONE multi-name gate `{names:["file2md","vision_ask"], ...}` (names[0] === "file2md"), preserving the original co-fire semantics (ticket 01's sibling-gating resolution holds). NOT `core:true` (gated tools).
- **Removed** the `{names:["file2md","vision_ask"]}` entry from `GATES` (tool-gate.ts); header comment updated. No CORE_TOOLS change (file2md/vision_ask were never core).
- **drift-guard** (`drift-guard.test.ts`): appended `file2md` to `MIGRATED_EXTENSIONS` (registrar `@repo/pi-agent-ext-file2md/extensions/file2md.ts`); SCOPE comment updated.
- **qa/evaluate.ts**: appended `file2mdDefault` to `reconstructOwnerDeclaredGates([...])` so the L1 probe corpus (MUST_FIRE / MUST_NOT_FIRE / ESCAPE reference the "file2md" gate) stays live.
- **qa/l2.ts + qa/savings.ts**: switched from bare hardcoded `GATES` to `CORPUS_GATES` (the qa single source of truth). `qa/evaluate.ts` was the ONLY qa consumer deploy (03) needed to touch, but file2md has a heavy schema (≈828 tok) AND an L2 task (`file2md-ocr`), so l2 reachability + the savings drift-band test also needed the reconstructed gate set. savedTok = 7,171 (within the ±20% band of the 8,050 claim); deploy (also owner-declared) is now counted too (was undercounted since 03). Stopgap until ticket 13's buildEffectiveGates-over-live-tools.
- **tool-gate.test.ts**: the 3 file2md-touching unit-test helpers (`matchIntent`, `S2 keyword audit`, `S2 cross-gate invariant`) threaded `buildEffectiveGates` (the production `session_start` merge path) so file2md/vision_ask stay tracked+gated instead of falling open (absent from module-level TRACKED_TOOLS post-removal). The `matchIntent` test now asserts `["file2md","vision_ask"]` — buildEffectiveGates splits the former multi-name gate into single-name gates, so intent-mode surfaces both.

Commit: `e7397e18` — `feat(tool-gate): rollout file2md to owner-declared gating (ticket 04)`.

Tests: tool-gate suite **253/253 green** (drift-guard net, qa corpus, l2 reachability, savings drift-band, all gating unit tests). file2md package suite: 34 pre-existing failures (env-dependent `resolveLLM`/`askImage` — need a configured VLM; ticket-01-era) UNCHANGED by this additive `gating` edit (verified identical 34 fail with/without the edit via `git stash`). Zero new failures introduced.

**Multi-name collapse preserved: YES** — identical gating on both tools reconstructs to the single multi-name gate, so probe/L2/savings firing behavior is preserved (only the representation moved from hardcoded to owner-declared).

Known cross-cutting (NOT fixed here, per ticket): the multi-name-gate split means `enable_tool({name:"file2md"})` no longer auto-activates `vision_ask` (and vice versa) — the old shared hardcoded gate did. Intent/keyword firing still co-activates both (identical predicates). Tracked in the map under "enable_tool sibling co-activation".
