## Question

claimed: resume-07-session

Owner-declare `gating` on every tool belonging to `ltx` (`bun-apps/pi-agent-ext-ltx/extensions/ltx.ts`), mirroring its current hardcoded entry in `extensions/tool-gate.ts` `GATES` (tool names: ltx, ltx_help). Then remove `ltx`'s entries from the hardcoded `GATES`/`CORE_TOOLS`, add `ltx` to the drift-guard migrated set (ticket 02), and verify `bun test` + drift-guard pass. Single-name tools: straight keyword/requires gate. Multi-name group: confirm ticket 01's resolution keeps siblings gated. Blocked until the hardening (01) and the net (02) are in place.

type: task
blocked by: 01, 02

## Resolution

Owner-declared `gating` (keywords + requires, mirroring the GATES entry) added to both `ltx` and `ltx_help` (byte-identical → `reconstructOwnerDeclaredGates` collapses them into one multi-name gate `{names:["ltx","ltx_help"]}`, preserving co-fire per ticket 01). Removed the ltx entry from hardcoded `GATES` (ltx not in CORE_TOOLS — no change). Added `ltx` to `MIGRATED_EXTENSIONS` (registrar `ltxExtension`). `qa/evaluate.ts` `reconstructOwnerDeclaredGates` now includes `ltxDefault`; `qa/miss-rate.ts` switched GATES→CORPUS_GATES (resolves migrated ltx gate; mirrors l2.ts/evaluate.ts — NOT ticket 13's buildEffectiveGates swap). `tool-gate.test.ts` adapted (`captureOwner(ltxExtension)`, dormant stand-ins ltx→movie/zai-mcp/workflow); `self-promotion-interaction.test.ts` + `coverage.test.ts` fixtures updated. l2/savings untouched (no ltx refs). The ltx `session_start` always-on promotion handler left untouched (orthogonal visibility layer). Tests: tool-gate 256/0, ltx 158 pass/2 skip/0 fail. enable_tool NAME-mode sibling co-activation gap noted in comments, NOT fixed (cross-cutting, tracked in map). Commit: fbf5f345.
status: closed
