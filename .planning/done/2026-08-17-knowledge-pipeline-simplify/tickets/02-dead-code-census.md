## Question
Which files/modules across the four packages are dead or near-dead? Verify each suspect with import graph + test coverage + git log — CITE or ACQUIT every one (ticket-09 lesson: verify "dead code" claims before deleting — serializer/trigger were live). Suspects (non-exhaustive): zk loop.ts / merge.ts / task-builders.ts / card-render.ts; hermes review-memory-ops.ts / session-anchor-search.ts / constants.ts hotspots; obsidian's ~17 fat-tool actions reachability.
type: research
blocked by: (none)
claimed: research-02 (2026-08-17)

## Resolution

### Census table
| File (LOC) | Verdict | Evidence (importer/test/git) |
|---|---|---|
| zk src/loop.ts (350) | NEAR-DEAD | importers: pi-agent CLI kcard-loop.ts:39 + 1 test (knowledge-pipeline-seam.test.ts); no extension-src importer; last touch b78454f8 (2026-08-16, rename-only) |
| zk src/merge.ts (337) | NEAR-DEAD | importers: 3 CLIs only (memory-to-vault.ts:23, zk-query.ts:37, knowledge-pipeline.ts:34); wiki-match/similarity refs are comments; last touch d95442a7 (2026-08-16 ingest split) |
| zk src/task-builders.ts (325) | LIVE | ext entry knowledge-card.ts:143-148/395/430/444/449/600 uses 6 builders in body; CLI zk-extract.ts:139 uses buildDistillTask; re-export :1123 |
| zk src/card-render.ts (291) | LIVE | imported by adapters.ts:7, retrieve.ts:41, graph-health.ts:42, ingest.ts:58 |
| hermes handlers/review-memory-ops.ts (464) | LIVE | importers: composition/store-providers.ts, background-review.ts, contradiction-judge.ts + 4 tests (id-lifecycle, background-review, overflow-superseded-sync, memory-mirror-sole-source) |
| hermes store/session-anchor-search.ts (472) | LIVE (single chain) | session-search-tool.ts → search-tool.ts:19 → composition/tools.ts:17 → compose.ts:27; own test suite; last touch 61f42065 (2026-07-10 — stale, refactor candidate not deletion) |
| hermes constants.ts (439) | LIVE, 1 dead export | 10+ src importers (config, git-ops, paths, walk-and-ingest, failure-model-migration, grill-seam, merge-union, prompt-context…); **INTERVIEW_PROMPT: 0 usages repo-wide** (~17 LOC, onboarding-era leftover) |
| hermes handlers/skills-command.ts (745) | LIVE | composition/commands.ts (registered `/skills` command) + siblings skill-key-reducer/skill-rows/skill-batch-ops + tests/handlers/skills-command.test.ts — live skills mgmt surface |
| hermes store/skill-store.ts (828) | LIVE | importers: tools/skill-tool.ts, composition/stores.ts, composition/project-skills.ts, skills-command.ts, skill-batch-ops.ts + 3 tests |
| obsidian fat tool — 17 actions (ext 2171 LOC) | LIVE (all reachable) | all 17 register as `obsidian_*` subtools in `_capture` (obsidian.ts:1626 etc.) and dispatch via validateActionArgs; per-action test refs: read 20, search 50, create 19, append 15, append_section 10, delete 11, list 9, query 8, invalidate 8, status 8, semantic_search 6, move 6, open 6, update_frontmatter 7, rename 4, distill 1 (routed-to by knowledge-card.ts:267), garden 0-exact-string but gardenValidation.test.mjs + registration + routing.ts:185/subagent.ts wiring |
| core-interface (1k, 8 files) | LIVE | publishSeam/readSeam/seam-types consumed by knowledge-pipeline-seam.ts in BOTH hermes-memory and knowledge-card (ADR tier boundary); entities fns exported for cross-pkg recall — no unimported export found in index.ts audit |

### Near-dead detail
- **zk loop.ts**: one live path = CLI `kcard-loop` command (pi-agent/src/cli/commands/kcard-loop.ts). Removing loop.ts breaks that command + the seam test; removing BOTH frees 350 LOC with no extension-runtime impact — convergence loop is not invoked by the extension entry.
- **zk merge.ts**: live paths = 3 CLI commands (memory-to-vault, zk-query, knowledge-pipeline) calling `mergeDuplicates`/`formatMerge`. No src-module importers — merge is CLI-surface only; removing it + its CLI callsites frees 337 LOC. git log shows active maintenance (ingest-split wave), so confirm CLI retirement intent first.

### Verdict
- Removal candidates ranked by LOC-freed-per-risk:
  1. **constants.ts INTERVIEW_PROMPT** (~17 LOC, zero refs, risk ≈ 0) — trivially dead export.
  2. **zk loop.ts + kcard-loop CLI** (350 LOC, 1 CLI + 1 test, low risk if convergence is retired).
  3. **zk merge.ts + 3 CLI callsites** (337 LOC, medium risk — 3 CLI commands retire together).
- Totals: freely removable now = ~17 LOC; with CLI retirements = ~704 LOC.
- Structure: **0 DEAD modules** across all four packages — every suspect is cited-or-acquitted (ticket-09 lesson held: nothing is dead). Real finding is shape, not death: knowledge-card's merge/loop live only behind the CLI tier, and obsidian's "fat tool" is genuinely all-reachable (17/17 actions registered + ≥1 test each, garden thinnest). session-anchor-search.ts is live but single-chain and untouched since 2026-07-10 — flag for refactor review, not removal.
