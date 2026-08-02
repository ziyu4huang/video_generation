## Question

Owner-declare `gating` on every tool belonging to `zai-mcp` (`bun-apps/pi-agent-ext-zai-mcp/extensions/zai-mcp.ts`), mirroring its current hardcoded entry in `extensions/tool-gate.ts` `GATES` (tool names: zai_web_search_web_search_prime, zai_web_reader_webReader). Then remove `zai-mcp`'s entries from the hardcoded `GATES`/`CORE_TOOLS`, add `zai-mcp` to the drift-guard migrated set (ticket 02), and verify `bun test` + drift-guard pass. Single-name tools: straight keyword/requires gate. Multi-name group: confirm ticket 01's resolution keeps siblings gated. Blocked until the hardening (01) and the net (02) are in place.

type: task
blocked by: 01, 02
claimed: resume-12

## Resolution

zai-mcp was the LAST hardcoded GATES entry — rolled out to owner-declared gating. Architecturally unique: zai-mcp tools register DYNAMICALLY at session_start via registerServerTools() (names from each MCP server's listTools()), not via a static defineTool literal. The single build-site (registerServerTools) now attaches the gate's keywords (no requires, not core) to each dynamically-built tool. The zai GATES entry `["zai_web_search_web_search_prime","zai_web_reader_webReader"]` was removed → **GATES is now EMPTY (length 0)** — the hardcoded→owner-declared migration's removal side is COMPLETE. zai-mcp added to MIGRATED_EXTENSIONS; zaiRegistrar (drives registerServerTools) added to qa/evaluate.ts reconstructOwnerDeclaredGates → CORPUS_GATES keeps the zai gate (QA savings claim ~8,050 tok intact). Tests adapted via small inline synthetic-fixture swaps (no QA-harness restructuring, no 13-spillover): computeBannerSaved parameterized (backward-compatible, default=GATES); tool-gate.test.ts synthesizes zai defs inline (captureOwner can't capture dynamic registration) + threads EFF.gates/tracked; qa/coverage.test.ts swaps zai fixtures → enable_tool NAME-mode sibling co-activation gap noted in comments, not fixed (cross-cutting). Tests: tool-gate 263/0 (+1 = new drift-guard zai per-extension test, the rollout proof), zai-mcp 6/0. **KNOWN CONSEQUENCE (tracked, NOT fixed here):** with GATES empty, the runtime savings banner (computeBannerSaved, default=GATES) reads 0 — threading effectiveGates into prod call sites is ticket 14's subject (the undercount grew across all rollouts; 12 completes it to 0). No correctness bug; QA harness still validates savings via CORPUS_GATES. enable_tool NAME-mode sibling co-activation gap noted in comments, not fixed (cross-cutting). Commit: e90be8c4.

status: closed
