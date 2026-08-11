# 01 — Audit the KP build-cluster efforts: verify real state in code, answer zk_spawn, recommend per-effort disposition

## type

`research` (AFK)

## Question

For each of the 7 knowledge-pipeline build-cluster efforts, determine the TRUE state — not what the planning text claims, but what the code/git shows — and recommend a single disposition (close+archive | migrate-live-tickets-into-`2026-08-08-knowledge-pipeline` | leave-live). This is the fact-base every downstream disposition ticket cites.

Verify specifically (check code + git, don't trust planning prose):

1. **`2026-08-08-knowledge-pipeline`** — confirm which build tickets are genuinely still open by cross-checking the map's "next/still-open" claims against git: 10-impl (#1242) is merged (map is stale saying it's next); 08 (#1208) and 09 shipped; confirm 03/07/13/14/15 are unimplemented. Note ticket 07 now has a spec+plan on origin/main (#1245, not on this branch).
2. **`2026-08-01-continue-improve-the-pipeline-…` tickets 05 & 06** — were they actually delivered? Look in `bun-apps/pi-agent-ext-knowledge-card/` and the file2md extension for: a `pi:knowledge` bus sink subscriber calling `ingestRecords` (ticket 05), and a `knowledge` opt-in flag + direct `pi.events.emit({source,sourceLabel,dir})` in file2md (ticket 06). The canonical spine used a *different* path (`walkAndIngest`) — so delivery of the file2md→bus→sink wiring is the open question. **This answer directly drives ticket 03.**
3. **`2026-08-11-knowledge-card-typecheck-gate`** — run `( cd bun-apps/pi-agent-ext-knowledge-card && bun run typecheck )`; confirm exit 0 (gate green). Is the gate wired (tsconfig + typecheck script present)?
4. **`2026-07-28-hermes-surrealdb-graph-search`** — confirm shipped (git: branch `feat/hermes-surrealdb-graph-search`, 758/758 green). Has no map.md — note that.
5. **`2026-08-08-pi-agent-ext-knowledge-card-obsidian-surealdb-or`** — confirm its 5 tickets (01-05) exist verbatim in canonical `2026-08-08-knowledge-pipeline/tickets/` (same numbers); confirm nothing live remains here.
6. **`2026-07-30-file2md-for-pdf-…`** — confirm the hybrid extractor verdict (mupdf body + selective VLM) landed; is re-opened ticket 04 a paper-trail loose end only?
7. **`2026-08-04-tell-me-what-zk-spwan-…`** — **answer the question:** what is `zk_spawn` / `zk-spawn`? Is it part of the knowledge-card extension or a separate process? (Search `bun-apps/pi-agent-ext-knowledge-card/` and the CLI for `zk_spawn`/`zk-spawn`/spawn.) Record the one-paragraph answer.

Output: a per-effort table `{effort, true-state (verified), recommended-disposition, evidence (file/git ref)}`. This becomes ticket 03/04's input.

## blocked by

— (none)

## claimed

pi/main-session (charting research pass, 2026-08-12)

## Resolution (closed 2026-08-12 — charting research pass)

Method: every claim below was verified against **code + git** (repo root `/Users/huangziyu/proj/video_generation__memory`), not planning prose. Two task-premise corrections surfaced and are flagged inline (cross-effort misattribution of #1245; canonical ticket-15 staleness).

### Per-effort disposition table

| # | effort | true-state (verified) | recommended-disposition | evidence (file:line / git ref) |
|---|--------|-----------------------|------------------------|-------------------------------|
| 1 | `2026-08-08-knowledge-pipeline` (canonical survivor) | **ACTIVE; spine + Phase-2 shipped. Map is stale on TWO tickets, not one.** Shipped: 08 (#1208 `02976974`), 09-impl (`178611dd`), 10-impl (#1242 `1fcb4504`), **and 15-Phase1 (#1168 `48df0b1a`)** — but `tickets/15-effort-query-phase1-list-search.md` frontmatter still says `status: open` and map line 16 lists 15 as still-open. **Genuinely unimplemented** (git title-grep for each canonical title returns 0 `feat`/impl commits): **03** (two-layer-knowledge-graph), **07** (image-card-and-extractor), **13** (migrate-memory-cards-at-graduation), **14** (build-embed-index). **05** closed (policy only; full-3-tier impl behind it is open). **CORRECTION to task premise:** the #1245 spec+plan (07-**port-binding-auth-url**) lives in effort `2026-08-10-pi-agent-ext-webui-from-scratch`, **NOT** this effort — canonical **07-image-card-and-extractor has NO spec/plan on origin/main** and is a plain open build ticket. Material to ticket 02 (next-pick). | **leave-live** (canonical survivor). **Action:** fix the stale map — move 10 & 15 to shipped; open set = {03, 07, 13, 14} + full-3-tier behind closed 05; drop the #1245→07-image-card cross-reference (it belongs to webui). | git `02976974`/`178611dd`/`1fcb4504`/`48df0b1a`; `git show f099b3f7 --raw` → paths all under `.planning/2026-08-10-pi-agent-ext-webui-from-scratch/`; title-grep `two-layer-knowledge-graph|image-card|migrate-memory-cards|build-embed-index` = 0 commits; `tickets/15-…md` frontmatter `status: open` |
| 2 | `2026-08-01-continue-improve-the-pipeline-between-extension-` (tickets 05 & 06) | **DELIVERED-IN-CODE (both).** Ticket 06 (knowledge opt-in flag + emit): `file2md.ts:92` `KNOWLEDGE_CHANNEL="pi:knowledge"`; `:237-242` `knowledge` opt-in flag (Type.Optional); `:272-273` `if (params.knowledge) emitFile2mdKnowledge(pi, buildFile2mdEmission(slug, …))`; `:101` payload `{source:"generic", sourceLabel:"file2md:<slug>", dir}` — exactly ticket 06's shape. Ticket 05 (bus sink → `ingestRecords`): `knowledge-card.ts:1495` `onKnowledge(pi, async (payload) => { … convergeKnowledgeEmission(payload, {vaultPath,cwd}) })`; `converge.ts:61` `return ingestRecords(records, {…})`. The sink walker is `collectInputFiles`+`adaptGenericMarkdown` (not the spine's `walkAndIngest`), but it shares the canonical sink `ingestRecords` → card store, so convergence is real. | **close** (both delivered; not net-new). Drives ticket 03 = no migration needed. | `bun-apps/pi-agent-ext-file2md/extensions/file2md.ts:92,101,237-242,272-273`; `bun-apps/pi-agent-ext-knowledge-card/extensions/knowledge-card.ts:1490-1503`; `bun-apps/pi-agent-ext-knowledge-card/src/converge.ts:61`; tests `pi-agent-ext-file2md/__tests__/knowledge-emit.test.ts:18-24` |
| 3 | `2026-08-11-knowledge-card-typecheck-gate` | **GREEN + wired (done-but-untracked).** `( cd bun-apps/pi-agent-ext-knowledge-card && bun run typecheck )` → **exit 0**. `package.json` has `"typecheck":"bunx tsc --noEmit"`; `tsconfig.json` present (406 B). Plan checkboxes (1/6) are stale prose — gate is in fact green. | **close** (done; update plan checkboxes). | exit 0 (verified 2026-08-12); `package.json` `scripts.typecheck`; `tsconfig.json` exists |
| 4 | `2026-07-28-hermes-surrealdb-graph-search` | **SHIPPED.** `1c285603` "feat(hermes): SurrealDB graph-augmented search (… cross-backend e2e) (#912)". **No `map.md`** — dir holds only `spec.md`. | **close + archive** to `.planning/done/`. | git `1c285603`; `ls .planning/2026-07-28-…/` → only `spec.md` |
| 5 | `2026-08-08-pi-agent-ext-knowledge-card-obsidian-surealdb-or` | **SUPERSEDED — nothing live remains.** Dir holds **only `map.md` — NO `tickets/` dir at all** (the `diff` in the task is vacuous: left side empty). Its 5 tickets migrated verbatim INTO canonical where they are tickets 01-05 with matching titles: `01-define-hermes-zk-layering-contract`, `02-pick-file-ingest-extractors`, `03-design-two-layer-knowledge-graph`, `04-resolve-embed-backend-and-chromadb-consolidation`, `05-decide-memory-card-migration-and-sync`. | **close + archive** to `.planning/done/`. | `ls` shows only `map.md`; canonical `tickets/01..05-*.md` title-match |
| 6 | `2026-07-30-file2md-for-pdf-…` | **ABSORBED — hybrid verdict LANDED.** `file2md.ts:204` `extract: vlm (default, rasterize→VLM) | text (mupdf text-layer, no VLM) | hybrid (mupdf text + VLM for figure-bearing pages)`; `src/native/pdftext.ts` mupdf text-layer extractor; `__tests__/pipeline-extract.test.ts` covers the hybrid path. Re-opened ticket 04 is a **paper-trail loose end only** (decision settled in 06/closed). | **close + archive** (mark re-opened ticket 04 closed as settled). | `file2md.ts:204`; `src/native/pdftext.ts`; `__tests__/pipeline-extract.test.ts:277-314` |
| 7 | `2026-08-04-tell-me-what-zk-spwan-…` | **Empty question stub — answered (zk_spawn paragraph below).** No code artifact named `zk_spawn` is a CLI/separate process; it is an in-extension function. | **close + archive** (question answered; no ticket to migrate). | `knowledge-card.ts:96-101,78,845,993`; `pi-agent-ext-subagent/src/spawn-subagent.ts:233`; no `bin` in `pi-agent-ext-knowledge-card/package.json` |

**Summary of recommended dispositions:** leave-live = effort 1 (canonical; + stale-map fix); close = efforts 2, 3; close+archive = efforts 4, 5, 6, 7. **No live orphan tickets need migration into the canonical map** — the one judgment call (effort-2 tickets 05/06) is **delivered-in-code**, so ticket 03 resolves to "close, nothing to migrate".

### zk_spawn answer

`zk_spawn` / `zk-spawn` is **not a CLI command, not a subprocess, and not a separate package** — it is the **knowledge-card extension's private in-process subagent-spawn wrapper**. Concretely, `extensions/knowledge-card.ts:96-97` declares `export type ZkSpawnFn = (opts: SpawnSubagentOptions) => Promise<SpawnSubagentResult>; let zkSpawn: ZkSpawnFn = __defaultSpawnSubagent;`, where `__defaultSpawnSubagent` is `spawnSubagent` re-imported from the sibling `@repo/pi-agent-ext-subagent` package (`knowledge-card.ts:78`). The extension calls `zkSpawn({cwd, task, tools, model, excludeTools, …})` at `knowledge-card.ts:845` (distill) and `:993` (heal) to run a ZK action inside an isolated in-process subagent session behind a **frozen tool allowlist** (the `tools` array built at `:107`); `__setZkSpawnForTest` (`:100`) swaps it for a fake in tests. The string **"zk-spawn"** that appears in code is just the **display label** assigned to that spawned subagent run (`pi-agent-ext-subagent/src/spawn-subagent.ts:233` `label: "zk-spawn"`), and "the zk-spawn task" referenced in `pi-agent-ext-hermes-memory/bench/*.ts` comments is the wayfinder-tracked work item that delivered this wrapper + allowlist parity (wayfinder ticket 06). The knowledge-card `package.json` has **no `bin` field**, confirming there is no installed `zk_spawn` executable. **Net:** `zk-spawn` = knowledge-card delegating to `spawnSubagent` for sandboxed distill/heal subagent runs; the only process surface is the subagent run it kicks off, not a separately-invokable command.

> **status: closed** — resolved by charting research pass 2026-08-12.
