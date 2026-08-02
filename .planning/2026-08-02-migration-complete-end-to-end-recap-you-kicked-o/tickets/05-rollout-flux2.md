## Question

claimed: resume-05-session

Owner-declare `gating` on every tool belonging to `flux2` (`bun-apps/pi-agent-ext-flux2/extensions/flux2.ts`), mirroring its current hardcoded entry in `extensions/tool-gate.ts` `GATES` (tool names: flux2, flux2_help). Then remove `flux2`'s entries from the hardcoded `GATES`/`CORE_TOOLS`, add `flux2` to the drift-guard migrated set (ticket 02), and verify `bun test` + drift-guard pass. Single-name tools: straight keyword/requires gate. Multi-name group: confirm ticket 01's resolution keeps siblings gated. Blocked until the hardening (01) and the net (02) are in place.

## Resolution

Owner-declared `gating` added to both `flux2` and `flux2_help` (identical signature → `reconstructOwnerDeclaredGates` collapses them into one multi-name gate `{names:["flux2","flux2_help"]}`, preserving co-fire per ticket 01). Removed the `{names:["flux2","flux2_help"]}` entry from hardcoded `GATES` (flux2 not in CORE_TOOLS — no change). Added `flux2` to `MIGRATED_EXTENSIONS` (registrar `flux2Extension`). `qa/evaluate.ts` `reconstructOwnerDeclaredGates` now includes `flux2Default`; 4 test files adapted (former hardcoded-flux2 examples switched to still-gated tools + threaded effective gates). defineTool is a pure identity fn, so `gating` on the tool literal flows verbatim into `pi.registerTool` and is captured (drift-guard net passing proves it). Tests: tool-gate 254/0, flux2 134/0. enable_tool NAME-mode sibling co-activation gap noted in code, NOT fixed (cross-cutting, tracked in map). Commit: 3aea42ef.

status: closed
type: task
blocked by: 01, 02
