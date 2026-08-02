## Question

Owner-declare `gating` on every tool belonging to `research-tool` (`bun-apps/pi-agent-ext-research-tool/extensions/research-tool.ts`), mirroring its current hardcoded entry in `extensions/tool-gate.ts` `GATES` (tool names: collect_videos, organize_vault_notes, import_memory_to_vault, arxiv_search, arxiv_fetch2md, arxiv_paper). Then remove `research-tool`'s entries from the hardcoded `GATES`/`CORE_TOOLS`, add `research-tool` to the drift-guard migrated set (ticket 02), and verify `bun test` + drift-guard pass. Single-name tools: straight keyword/requires gate. Multi-name group: confirm ticket 01's resolution keeps siblings gated. Blocked until the hardening (01) and the net (02) are in place.

type: task
blocked by: 01, 02
