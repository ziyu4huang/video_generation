## Question

Owner-declare `gating` on every tool belonging to `file2md` (`bun-apps/pi-agent-ext-file2md/extensions/file2md.ts`), mirroring its current hardcoded entry in `extensions/tool-gate.ts` `GATES` (tool names: file2md, vision_ask). Then remove `file2md`'s entries from the hardcoded `GATES`/`CORE_TOOLS`, add `file2md` to the drift-guard migrated set (ticket 02), and verify `bun test` + drift-guard pass. Single-name tools: straight keyword/requires gate. Multi-name group: confirm ticket 01's resolution keeps siblings gated. Blocked until the hardening (01) and the net (02) are in place.

type: task
blocked by: 01, 02
