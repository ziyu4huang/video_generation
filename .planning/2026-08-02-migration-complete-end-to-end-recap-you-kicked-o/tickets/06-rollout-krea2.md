## Question

Owner-declare `gating` on every tool belonging to `krea2` (`bun-apps/pi-agent-ext-krea2/extensions/krea2.ts`), mirroring its current hardcoded entry in `extensions/tool-gate.ts` `GATES` (tool names: krea2, krea2_help). Then remove `krea2`'s entries from the hardcoded `GATES`/`CORE_TOOLS`, add `krea2` to the drift-guard migrated set (ticket 02), and verify `bun test` + drift-guard pass. Single-name tools: straight keyword/requires gate. Multi-name group: confirm ticket 01's resolution keeps siblings gated. Blocked until the hardening (01) and the net (02) are in place.

claimed: resume-06-session
type: task
blocked by: 01, 02

## Resolution

Owner-declared `gating` (keywords-only, mirroring the GATES entry which had no `requires`) added to both `krea2` and `krea2_help` (byte-identical → `reconstructOwnerDeclaredGates` collapses them into one multi-name gate `{names:["krea2","krea2_help"]}`, preserving co-fire per ticket 01). Removed the krea2 entry (incl. its no-requires comment) from hardcoded `GATES` (krea2 not in CORE_TOOLS — no change). Added `krea2` to `MIGRATED_EXTENSIONS` (registrar `krea2Extension`). `qa/evaluate.ts` `reconstructOwnerDeclaredGates` now includes `krea2Default` (l2/savings unchanged — no krea2 refs). `tool-gate.test.ts` adapted: `captureOwner(krea2Extension)` + dormant stand-in swapped krea2→movie (proven pattern from tickets 04/05). The krea2 `session_start` always-on promotion handler left untouched (orthogonal visibility layer). Tests: tool-gate 255/0, krea2 66/0. enable_tool NAME-mode sibling co-activation gap noted, NOT fixed (cross-cutting, tracked in map). Commit: 51717bea.
status: closed
