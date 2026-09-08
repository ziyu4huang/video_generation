# self-arc-13 — research-tool reliability arc (plan)

Effort: `2026-09-08-self-arc-13` · Family: `bun-apps/s2-agent-ext-research-tool` ·
Directive (2026-09-08): "I want to USE s2-agent-ext-research-tool; improve it with the
same self-develop arc the previous PRs show."

Probe log (all on this machine, 2026-09-08): package tree + package.json, README,
`extensions/research-tool.ts`, `lib/{youtube,bilibili,news,arxiv,vault}.ts`,
`.planning/2026-09-06-self-arc-9/map.md`, env (`env | grep -iE 'proxy|youtube_api'` →
**empty**), `extensions/cli-subcommand.ts` (head), deployed tree
`~/proj/dist/s2-agent-sh/darwin-arm64/current/` (listing + bundle greps),
`bun-apps/s2-agent/src/registry-config.ts`.

---

## 1. FINDINGS

1. **The deployed tree ships ZERO research-tool code — the family has never been deployed.**
   MEASURED: `~/proj/dist/s2-agent-sh/darwin-arm64/current/ext/ext-standalone.mjs`
   (6,058,532 bytes, mtime 2026-09-06 14:55) greps **0** for both `arxiv_search` and
   `collect_videos` — tool names are string literals/property values, which minification
   preserves (operating learning #1: grep the artifact, not the label). The per-extension
   dir listing under `current/ext/` shows 15 packages (archify, btw, compact, devops,
   file2md, hermes-memory, knowledge-card, obsidian, power-tool, prompt-history, subagent,
   superpowers, task, ultracode, wayfind) — **no `research`**. Meanwhile the source
   registry DOES register it (`bun-apps/s2-agent/src/registry-config.ts:535-537`,
   `name: "s2-agent-ext-research-tool"`, `entry: "extensions/research-tool.ts"`; manifest
   mentions it ×3), and a comment at `registry-config.ts:129` groups it among
   "darwin-by-nature ext"s — so the darwin-arm64 tree *should* carry it. Root cause not
   yet pinned: either no deploy has run since the package entered the registry, or the
   crossos per-tree ext filtering (#2099, D5) drops it. Both are cheap to pin; the fix is
   the same either way (deploy + verify-by-grep). **This is the arc's reason to exist: a
   user on the deployed leg cannot USE the family at all.** Learning #2 corollary:
   "registered in source" is a label, not bytes.

2. **Bilibili engine collapses every failure into "0 videos" (silent degradation family).**
   `lib/bilibili.ts:searchVideos` returns `[]` on WBI-key fetch failure (`.catch(() => null)
   → return []`), on HTTP 412 (`if (resp.status === 412) return []`), and on
   `code !== 0`; `lib/bilibili.ts:fetchBuvid3` falls back to a FABRICATED random
   `BUVID3_...` cookie on any network error; `lib/bilibili.ts:fetchHotVideos` mirrors the
   pattern. The tool layer (`extensions/research-tool.ts:collectVideosTool.execute`)
   then reports `"keyword": 0` and happily writes an empty-looking "successful" Markdown —
   a 412 risk-control block, a dead proxy, and a genuinely empty result are
   indistinguishable to the user. Root cause: the engine returns values, not outcomes.

3. **WBI keys are refetched on every search call** — `lib/bilibili.ts:searchVideos` calls
   `fetchWbiKeys` per invocation, i.e. per keyword × per page. Keys rotate daily; per-run
   this multiplies `/x/web-interface/nav` hits by the keyword count, amplifying exactly
   the risk-control exposure the buvid3+proxy machinery exists to avoid, and slowing every
   collection run.

4. **`lib/youtube.ts` has ZERO tests, and its stats path is latently broken past one
   page.** `__tests__/` listing confirms no `youtube.test.ts`. Beyond the coverage gap:
   `lib/youtube.ts:searchYtKeyword` accumulates items across pages, then
   `lib/youtube.ts:fetchYtStats` sends ALL ids in ONE `videos.list` call
   (`id: videoIds.join(",")`) — the endpoint accepts ≤50 ids, so `pages ≥ 2` (>50 ids)
   fails the request, and `if (json.error) return new Map()` swallows it → **every video
   reports 0 views/likes/duration, silently**. Same silent-swallow family as F2. Also
   untested: pagination stop on missing `nextPageToken`, `publishedAfterDays(0) →
   undefined` (no filter), `parseIsoDuration`, quota-error throw path (`YouTube API error
   403`), normalization/HTML-strip.

5. **arXiv tools have no skill.** `skills/` holds 5 (collect-bilibili-llm,
   collect-bilibili-media, collect-news-llm, collect-youtube-llm, research-pi-packages) —
   none covers the arXiv trio, the family's only keyless LIVE-capable remote tools
   (`lib/arxiv.ts:searchPapers` / `lookupPaper` / `fetchMarkdown`; 3s self-throttle at
   `lib/arxiv.ts:rateLimitArxivApi`). The chaining workflow (search → paper → fetch2md →
   `<vault>/papers/`) exists only in tool descriptions. Usability gap against the "USE
   it" directive; the collect-news-llm skill is the shape specimen.

6. **No receipts exist for ANY research-tool operation** (measured context, confirmed by
   `output/` having no self-arc13 dirs). The family has never been through a receipts leg.

7. Environment, measured: `YOUTUBE_API_KEY` NOT set; NO `*PROXY*`/`HTTP_PROXY`-style vars
   → bilibili live legs are OFF (off-China HTTP 412, no proxy), YouTube live legs OFF
   (no key), arXiv + local-vault legs ON (keyless / pure FS).

8. Verified-sound (no ticket needed): `lib/news.ts:parseIsoDate` strict local-noon anchor
   + `planScaffoldWrite` overwrite guard (#2191 hardening, tested in
   `__tests__/news.test.ts`); `lib/vault.ts:resolveVaultRoot` throws loudly with an
   actionable fix (parity-guarded by `__tests__/vault-parity.test.ts`); `lib/arxiv.ts` is
   deliberately SDK-free and unit-testable; gating is owner-declared with probe exports.

9. UNVERIFIED: whether root-level `run-test.ts` / `run-video-collection.ts` still run
   (not read — out of budget); the exact `platforms` field on the registry entry; the
   ext-standalone export surface (deployed leg should copy the existing import pattern at
   `bun-apps/s2-agent-ext-devops/src/deploy-e2e-recipe.ts:1737`, the t04
   ext-standalone-import surface, rather than re-deriving it).

---

## 2. TICKETS

### T1 — Ship the family: pin deploy gap, deploy, verify bytes (BLOCKER, no-choice)
- **Problem**: F1 — deployed `current` tree has zero research-tool symbols; deployed-leg
  usage is impossible; nothing downstream can receipt against it.
- **Change** (no production code): (a) pin the cause — `git log -S research-tool --
  bun-apps/s2-agent/src/registry-config.ts`, read the entry's platform/load fields vs
  `deploy-cli.ts` filtering; record in the effort map; (b) deploy via
  `bun bun-apps/s2-agent-ext-devops/src/deploy-cli.ts`; (c) verify BYTES not labels
  (learning #1/#2): `grep -c arxiv_search ext-standalone.mjs` ≥1, `grep -c
  collect_videos` ≥1, `ls current/ext/ | grep research`.
- **Done-when**: `output/self-arc13-deploy-verify-<date>/receipt.json` passes named checks
  `bundleHasResearchToolSymbols`, `extDirResearchPresent`, `versionLabelMatchesBytes`
  (deployed version label + on-disk bundle content agree). No unit-test change.
- **Effort**: M.

### T2 — Bilibili outcome surfacing + WBI key cache
- **Problem**: F2 + F3 — silent `[]` on 412/WBI-failure/offline + fabricated buvid3
  fallback + per-call `/nav` hammering.
- **Change** (file-level): `lib/bilibili.ts` — `searchVideos`/`fetchHotVideos`/`
  fetchBuvid3` return outcome objects (`{ videos, status: "ok" | "blocked-412" |
  "wbi-unavailable" | "network-error", reason }`); process-scoped WBI key cache
  (fetch once, invalidate+refetch once on signature rejection); `extensions/research-tool.ts:
  collectVideosTool.execute` renders reasons into tool text + `details` (e.g.
  `blocked by risk-control (412): pass proxy=http://…`). Tool names/params/schemas
  UNCHANGED.
- **Done-when**: new `__tests__/bilibili-engine.test.ts` (mocked `fetch`) passes:
  `412 surfaces blocked reason (not empty success)`, `wbi failure surfaces reason`,
  `wbi keys cached across keywords (nav called once)`, `buvid3 failure surfaces, never
  fabricates`; existing `__tests__/bilibili-wbi.test.ts` still green.
- **Effort**: M.

### T3 — YouTube engine: stats chunking fix + first test file (closes the flagged gap)
- **Problem**: F4 — `>50 ids` single-call stats failure swallowed → all zeros past page 1;
  zero test coverage on a quota-aware engine.
- **Change** (file-level): `lib/youtube.ts` — `fetchYtStats` chunks ids into ≤50 per call
  and merges maps; stats-fetch errors surface into a `statsPartial`/reason instead of a
  silent empty Map (error text, not throw — search results remain usable). New
  `__tests__/youtube.test.ts` (mocked `fetch`, zero network, zero LLM): pagination stop,
  `publishedAfterDays(0)→undefined`, `parseIsoDuration` table, normalization + HTML strip,
  quota-error throw (`YouTube API error 403`), chunking call-count/id-count assertions.
- **Done-when**: `__tests__/youtube.test.ts` exists and passes, including
  `chunks stats batches at 50 ids` and `missing-key path errors cleanly` (the
  `collectVideosTool` YOUTUBE_API_KEY guard is asserted via the extension factory import —
  no LLM). The chunking test FAILS on pre-fix code (regression proof).
- **Effort**: M.

### T4 — arXiv skill + the family's first LIVE receipts (source + deployed legs)
- **Problem**: F5 + F6 — no workflow doc for the only keyless remote trio; no live
  receipts anywhere in the family.
- **Change**: new `skills/arxiv-research/SKILL.md` (chain: `arxiv_search` →
  `arxiv_paper` → `arxiv_fetch2md` → `<vault>/papers/`, throttle etiquette, save=false
  preview mode; shape follows `skills/collect-news-llm/SKILL.md`); receipt drivers:
  source leg imports `extensions/research-tool.ts`'s factory and executes tools directly
  with a stub ctx (`{ cwd }`, `OB_VAULT_PATH` → temp vault); deployed leg imports the
  deployed `ext/ext-standalone.mjs` per the `deploy-e2e-recipe.ts:1737` pattern. No LLM
  anywhere (direct `execute()`, not the agent-driving CLI twin — each
  `cli-subcommand.ts` subcommand spawns an agent session by design).
- **Done-when**: `output/self-arc13-arxiv-src-<date>/receipt.json` AND
  `output/self-arc13-arxiv-deployed-<date>/receipt.json` pass named checks:
  `searchReturnsPapers` (live `arxiv_search`, e.g. query "video diffusion",
  max_results 3, ≥1 paper with id+title), `paperLookupKnown` (live `arxiv_paper`
  1706.03762 → "Attention Is All You Need"), `fetch2mdSavesMarkdown` (live
  `arxiv_fetch2md` → temp-vault `papers/*.md`, >2KB; if arxiv2md.org is down, the receipt
  RECORDS the failure with the response evidence and the check is marked blocked — never
  deleted, never faked). 3s throttle respected between live calls.
- **Effort**: S.

### T5 — Local-vault trio receipts on both legs (deterministic LIVE)
- **Problem**: F6 — `collect_news` / `organize_vault_notes` / `import_memory_to_vault`
  are the operations a user actually runs daily and have zero receipts (unit tests exist:
  `__tests__/{news,organize,import-memory-dry-run,vault}.test.ts`).
- **Change**: receipt drivers only (same stub-ctx mechanism as T4): temp vault via
  `OB_VAULT_PATH`, fixture hermes dir (`--hermes-dir` param) with 2-3 entries + one
  pre-existing id for dedup. Sequenced: scaffold → re-run without overwrite (guard) →
  organize → import dry-run.
- **Done-when**: `output/self-arc13-localvault-src-<date>/receipt.json` and
  `output/self-arc13-localvault-deployed-<date>/receipt.json` pass named checks:
  `newsScaffoldWritten` (file exists, frontmatter + zh title, correct Saturday anchor),
  `overwriteGuardRefuses` (second run action=skip, file content unchanged),
  `organizeTagsNotes` (fixture note gains tags/aliases/created; orphan listed),
  `importMemoryDryRun` (parsed/added/existing counts match fixtures, no file written),
  `youtubeMissingKeyErrorsCleanly` (collect_videos platform=youtube returns isError with
  the YOUTUBE_API_KEY hint — deterministic, no key by env F7).
- **Effort**: S.

---

## 3. EXECUTION ORDER

```
T1 (deploy+verify)            ← no-choice blocker: every deployed leg needs the bytes
   ↓
T2 ∥ T3 (hardening, parallel) ← both touch lib/*; land before the FINAL redeploy
   ↓
redeploy + re-run T1's byte-grep checks (cheap; receipts must prove the FINAL state)
   ↓
T4 ∥ T5 (receipts, both legs) ← source leg unaffected by deploy timing, but run after
                                T2/T3 so receipts capture hardened behavior
```

- T1 is strictly first: T4/T5's deployed legs import code that does not exist in the
  deployed tree today (F1).
- T2 and T3 are independent of each other; both precede the second deploy so the family
  is receipted exactly once, in its final shape.
- T4 and T5 are independent; either order.

## 4. RECEIPTS PLAN

| Leg | Live? | Why | Receipt dir |
|---|---|---|---|
| Deploy verify | live (deploy act + bundle grep) | learning #1/#2: verify bytes, not version labels | `output/self-arc13-deploy-verify-<date>/` |
| arXiv source | **LIVE** (real arXiv API) | keyless, 3s self-throttle (F7/F8) | `output/self-arc13-arxiv-src-<date>/` |
| arXiv deployed | **LIVE** (real arXiv API via ext-standalone) | same; proves shipped bytes work | `output/self-arc13-arxiv-deployed-<date>/` |
| Local-vault source | **LIVE** process/FS (deterministic) | pure-local ops, temp vault + fixtures | `output/self-arc13-localvault-src-<date>/` |
| Local-vault deployed | **LIVE** process/FS via ext-standalone | same | `output/self-arc13-localvault-deployed-<date>/` |
| Bilibili | **unit-only** | off-China IPs → HTTP 412 risk-control; no proxy env (F7 measured) — a live leg would receipt Bilibili's WAF, not our code | covered by `__tests__/bilibili-engine.test.ts` (T2) |
| YouTube | **unit-only** | `YOUTUBE_API_KEY` unset (F7); live search burns ~100 quota units/call | covered by `__tests__/youtube.test.ts` (T3) + `youtubeMissingKeyErrorsCleanly` check (T5) |

All receipt drivers: direct `execute()` against a stub ctx — **no LLM calls** (the CLI
twin spawns agent sessions; deliberately not used). No new `scripts/` entries: drivers
are ad-hoc bun scripts living beside their receipt output, per prior self-arc practice.

**Schema-cost delta: target +0.** Production changes are confined to
`lib/bilibili.ts` (return shapes widen to outcome objects — lib-internal consumers only),
`lib/youtube.ts` (chunking inside `fetchYtStats`; exported signatures stable), and result
text/`details` rendering in `extensions/research-tool.ts` — no tool names, params, JSON
schemas, GATE_DEFS, or probe exports change, so extension-entry schema cost is +0. New
files are tests + `skills/arxiv-research/SKILL.md` (not a schema surface).

## 5. DESCOPED

- **Bilibili live receipts** — 412 risk-control from off-China IPs + no proxy env
  (measured F7); would produce a receipt of Bilibili's WAF, not of our code.
- **YouTube live receipts** — no API key (measured); quota burn for no new information
  over mocked fixtures.
- **tui-drive scenario** — wrong family: no TUI surface to drive; live legs are
  direct-execute/ext-standalone (task constraint).
- **CLI-twin receipts** — each `cli-subcommand.ts` subcommand creates an agent session
  (LLM) by design; receipts must stay deterministic and LLM-free.
- **Deleting `run-test.ts` / `run-video-collection.ts`** — UNVERIFIED whether still
  live (F9); removal is cosmetic churn risk, out of arc scope.
- **arXiv zh-adversarial keyword/requires split** (the 論文 noun/keyword collision noted
  in `extensions/research-tool.ts`'s probe comment) — tool-gate family concern, no
  observed recall failure; separate arc if ever needed.
- **Gate/probe recalibration** — gates pass their floors today (F8); touching them is
  churn.
