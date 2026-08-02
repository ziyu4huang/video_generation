## Question

Owner-declare `gating` on every tool belonging to `krea2` (`bun-apps/pi-agent-ext-krea2/extensions/krea2.ts`), mirroring its current hardcoded entry in `extensions/tool-gate.ts` `GATES` (tool names: krea2, krea2_help). Then remove `krea2`'s entries from the hardcoded `GATES`/`CORE_TOOLS`, add `krea2` to the drift-guard migrated set (ticket 02), and verify `bun test` + drift-guard pass. Single-name tools: straight keyword/requires gate. Multi-name group: confirm ticket 01's resolution keeps siblings gated. Blocked until the hardening (01) and the net (02) are in place.

type: task
blocked by: 01, 02
