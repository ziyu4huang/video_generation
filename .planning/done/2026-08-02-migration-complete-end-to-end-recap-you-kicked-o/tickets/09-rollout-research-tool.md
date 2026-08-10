## Question

claimed: resume-09-session

Owner-declare `gating` on every tool belonging to `research-tool` (`bun-apps/pi-agent-ext-research-tool/extensions/research-tool.ts`), mirroring its current hardcoded entry in `extensions/tool-gate.ts` `GATES` (tool names: collect_videos, organize_vault_notes, import_memory_to_vault, arxiv_search, arxiv_fetch2md, arxiv_paper). Then remove `research-tool`'s entries from the hardcoded `GATES`/`CORE_TOOLS`, add `research-tool` to the drift-guard migrated set (ticket 02), and verify `bun test` + drift-guard pass. Single-name tools: straight keyword/requires gate. Multi-name group: confirm ticket 01's resolution keeps siblings gated. Blocked until the hardening (01) and the net (02) are in place.

type: task
blocked by: 01, 02

## Resolution

Owner-declared `gating` added to all 6 research-tool tools across TWO gate groups (one extension, two signatures): vault trio (`collect_videos`/`organize_vault_notes`/`import_memory_to_vault`, keywords-only) and arxiv trio (`arxiv_search`/`arxiv_fetch2md`/`arxiv_paper`, keywords+requires). Each trio byte-identical within itself → `reconstructOwnerDeclaredGates` collapses them back into the original 2 multi-name gates (vault `names[0]:collect_videos`, arxiv `names[0]:arxiv_search`), preserving co-fire per ticket 01; qa probes keyed on gate-id stayed live with zero edits. Removed BOTH research-tool GATES entries from hardcoded `GATES` (research-tool not in CORE_TOOLS). Added `research-tool` to `MIGRATED_EXTENSIONS`; `qa/evaluate.ts` `reconstructOwnerDeclaredGates` includes `researchDefault` (l2/savings untouched — keyed on names[0]). `tool-gate.test.ts` adapted: `captureOwner(researchExtension)` + extended the capture stub with `registerCommand:()=>{}` (research-tool's factory also registers 3 slash commands); vault stand-ins retained (EFF-reconstructable, like movie in 08). Tests: tool-gate 258/0, research-tool 108/0, extensions-registry 18/0. enable_tool co-fire by design (ESCAPE_NAME reaches arxiv_search); no cross-cutting gap. Commit: 80a88cb8.
status: closed
