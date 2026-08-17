## Question
Which claims in bun-apps/KNOWLEDGE-LAYER.md and the per-package docs (KNOWLEDGE-LAYER.md / ARCHITECTURE.md / CONTEXT.md per package) are stale relative to post-#1556/#1571 code? Produce a drift census: every stale/wrong claim with file:line citation + what the code actually does now.
type: research
blocked by: (none)
claimed: research-01 (2026-08-17)

## Resolution
Method: read all 7 knowledge-layer docs fully; diff each concrete claim (tool names/counts, defaults, deps, LOC, file paths) against code (config.ts, package.json, src/tools, extensions/*.ts, wc -l). Note: token-count/LOC-delta claims (3066→2033 tok, −601) not re-measured before budget end.
### Drift table
| Doc claim (file:line) | Says | Reality (evidence file:line) | Severity |
|---|---|---|---|
| bun-apps/KNOWLEDGE-LAYER.md:57 (per-ext table) | hermes tools = `memory, memory_search, session_search` | also `knowledge_ingest` (knowledge-ingest-tool.ts:54), `knowledge_search` (knowledge-search-tool.ts:322), `skill_manage`(+help), `grill_decision`, `memory_supersede`, `planning_stale`; search-tool.ts:50 registers `name:"search"` not `memory_search` | high |
| bun-apps/KNOWLEDGE-LAYER.md:57 | hermes "auto-converges memory into the graph" | convergence ownership moved to hub per ADR-0001 (same doc's own header) + vault-converge.ts deleted | med (internal contradiction) |
| hermes docs/KNOWLEDGE-LAYER.md:6-21 | peerDependencies pi-knowledge-card `"*"` + optional + vault-converge.ts:129 dynamic import | package.json has NO pi-knowledge-card edge at all; src/store/vault-converge.ts does not exist | high |
| hermes CONTEXT.md:~108 (surreal section) | SurrealDB "default-off", `config.dbBackend: "surrealdb"` opt-in | src/config.ts:112 `dbBackend: "surrealdb"` is the DEFAULT (sqlite is the fallback) | high |
| hermes CONTEXT.md:12 (Architecture) / reviewTransport entry | reviewTransport `subprocess` (`pi -p`) fallback | "subprocess" removed in spawnSubagent migration (src/config.ts:41, src/types.ts:13); fallback is spawnSubagent | med |
| hermes CONTEXT.md:~30 | sessions.db "SQLite FTS5" framing as primary | sqlite is now the fallback backend; surreal primary (config.ts:112) | med |
| knowledge-card docs/ARCHITECTURE.md:3-4 | "4 src modules"; ingest.ts 934 LOC, retrieve.ts 600, merge 368, emit 100; extensions 1132 LOC | ≥9 src modules incl. hierarchy.ts(281), hierarchy-build.ts(207), aggregation-write.ts(192), loop.ts(350), graph-health.ts(385), adapters.ts(631), card-render.ts(291); ingest.ts=517, retrieve.ts=826, merge.ts=337; extensions=1175 | med |
| knowledge-card docs/ARCHITECTURE.md (C2 + module map) | still names `emit.ts`/`KNOWLEDGE_CHANNEL` | emit.ts absent from src listing (verify before rewrite) | low-med |
| knowledge-card CONTEXT.md:~26-30 | "`zk_extract`" as LLM-distill tool surface | zk_extract tool removed in #450 (ARCHITECTURE.md itself corrected; CONTEXT.md not) | med |
| clean rows | knowledge-card 4-tool registration; obsidian docs (KNOWLEDGE-LAYER.md, CONTEXT.md) post-#450 corrections; knowledge-card CONTEXT.md Hierarchy section (#1571) all match code | extensions/knowledge-card.ts:312/514/663/969; config.ts:89 | none |
### Verdict
Rewrites needed: hermes docs/KNOWLEDGE-LAYER.md (dead peerDep+vault-converge story), hermes CONTEXT.md surreal/transport/store sections. Touch-ups: top-level KNOWLEDGE-LAYER.md tool table (hermes row + stale auto-converge phrasing), knowledge-card ARCHITECTURE.md module map/LOC, knowledge-card CONTEXT.md zk_extract mention. Structural reveal: docs describe a hermes→knowledge-card soft edge that code has fully severed (post-ADR-0001 dead-coupling path); the hub owns convergence and now also hierarchy (knowledge-card CONTEXT.md current). Unverified: 3066→2033 token + −601 LOC claims (not re-measured); DEPENDENCIES.md/DATA-MODEL.md/TOOL-ORCHESTRATION.md not line-checked.
