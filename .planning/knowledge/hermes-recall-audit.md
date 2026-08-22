# Hermes Recall Audit — Final Report

- **Date:** 2026-08-19
- **UPDATE 2026-08-22 (ticket 04):** the /tmp runner is now the committed harness
  `bun-apps/scripts/recall-audit.mjs` (battery JSON + CI-safe fixture test alongside).
  Post-fold re-run: journal arm 0/20 unchanged (capture-only by design); the SAME question
  class through kcard `retrieveRecords` (semantic bge-m3 live) = hit@1 11/20, hit@3 16/20,
  hit@5 17/20, MRR 0.688 — receipt `output/recall-audit/receipt-2026-08-22T11-27-22-314Z.json`.
- **Scope:** recall quality of the hermes-memory query path, as actually served today
- **Artifacts:** `/tmp/hermes-audit/run-audit.ts` (runner), `/tmp/hermes-audit/final-output.txt` (verbatim output), `/tmp/hermes-audit/parse-sim.ts` + `parse-sim-output.txt` (parser simulation), `/tmp/hermes-audit/audit-probe-run.txt` (probe run)
- **No fixes were implemented** — this document records findings only.

## Method

- **Script:** `/tmp/hermes-audit/run-audit.ts`, executed with Bun inside `bun-apps/pi-agent-ext-hermes-memory`. Target: live SurrealDB (`ns=user_huangziyu`, crud db `memory`, vectors db `vectors`, endpoint `http://127.0.0.1:8000`, model version `nomic-embed-text-v1.5+es1`).
- **Battery:** 20 graded natural-language queries (2 per target memory card, 10 targets) + 2 negative controls; `k=5`.
- **Serving path measured:** **lexical fallback arm only.** The vector warm path is dead — the `vectors` database does not exist in SurrealDB, so `card_vectors` probing fails and every query falls back to the lexical/FTS arm. The battery mirrors `SurrealMemoryRepository.searchMemories`'s lexical arm (`content @@ $q ORDER BY lastReferenced DESC LIMIT k` with a `string::contains` fallback); neighbor augmentation + ranker are **not** replicated (documented deviation — see Verdict).
- **Script fix during run (1 line, allowed budget):** SurrealDB rejected the original query with `Parse error: Missing order idiom 'lastReferenced' in statement selection`; adding `lastReferenced` to the SELECT projection (both arms) fixed it. No other changes.

### Endpoint findings (trusted facts, confirmed by run header)

- `lmStudioBaseUrl` runtime default → `http://127.0.0.1:1234` — **UP**, serving 8 models incl. `text-embedding-nomic-embed-text-v1.5` and `text-embedding-bge-m3`.
- Documented embed endpoint `embed-mlx-server` → `http://127.0.0.1:8090` — **HTTP 404**.
- I.e. the reachable embedding server and the documented one disagree → endpoint drift.

## Metrics (verbatim from final-output.txt)

```
hit@1=0/20 hit@3=0/20 hit@5=0/20 MRR=0.000 misses=20
```

Every graded query returned **zero rows** (`top1=(none)`); no target was ever retrieved, so no ranking signal exists at any depth ≤ 5.

## Per-query appendix

| # | Query | Target id | Rank |
|---|-------|-----------|------|
| Q1 | task lifecycle status names why finished tasks never say completed | b896eb49-99c6-4d0c-ae98-f446801da1b2 | MISS |
| Q2 | where run projections get their glyphs and frozen elapsed time | b896eb49-99c6-4d0c-ae98-f446801da1b2 | MISS |
| Q3 | a repo check breaks on a pull request that only touches documentation | 749ef2b2-5347-4a57-909c-e78e11025375 | MISS |
| Q4 | is bypassing verification hooks acceptable when unrelated checks fail | 749ef2b2-5347-4a57-909c-e78e11025375 | MISS |
| Q5 | single place that splits fenced yaml and the test guarding it | 7738820c-39ed-408b-b593-c22084266b13 | MISS |
| Q6 | why duplicate implementations reappear after a canonical leaf exists | 7738820c-39ed-408b-b593-c22084266b13 | MISS |
| Q7 | where the wayfinder procedure document actually lives | dc2ec7a8-51ad-4acd-8324-7ba9e0bfd18b | MISS |
| Q8 | how many skill definition files exist inside the wayfind extension | dc2ec7a8-51ad-4acd-8324-7ba9e0bfd18b | MISS |
| Q9 | what happens to a standalone script after its logic moves into an extension | f2baa43e-06b3-46ca-b252-c2b3b25fd9f6 | MISS |
| Q10 | pitfalls when relocating directory trees that use relative imports | f2baa43e-06b3-46ca-b252-c2b3b25fd9f6 | MISS |
| Q11 | child agents burn their whole budget exploring how to structure dispatches | 540be258-dc14-4f67-953b-bfeee8951acb | MISS |
| Q12 | why force resetting the repository inside a child session is forbidden | 540be258-dc14-4f67-953b-bfeee8951acb | MISS |
| Q13 | a cleanup pass archived an effort folder that was still running | fd401c04-84e1-4f2f-99e1-decc2fa5dec4 | MISS |
| Q14 | how to list ongoing planning efforts without extension tools | fd401c04-84e1-4f2f-99e1-decc2fa5dec4 | MISS |
| Q15 | checking out the default branch in a secondary worktree fails | 4806129f-69c5-4a47-a691-83a3d7033604 | MISS |
| Q16 | sibling agents moved the upstream default branch mid session | 4806129f-69c5-4a47-a691-83a3d7033604 | MISS |
| Q17 | markdown database mirror keyed by identifier for memory cards | dfdd1bf5-2d65-4a87-9dad-fcb9e860212c | MISS |
| Q18 | why surreal was picked over sqlite as the primary persistence backend | dfdd1bf5-2d65-4a87-9dad-fcb9e860212c | MISS |
| Q19 | dozens of modified and deleted files appear before syncing is the churn real work | 68c5150a-c54e-4707-a98b-6c350b32503b | MISS |
| Q20 | how to prove working tree changes contain nothing unique before discarding them | 68c5150a-c54e-4707-a98b-6c350b32503b | MISS |

All 20 ranks are MISS with `top1=(none)` (zero rows returned), so the MISS is "no retrieval at all", not "retrieved but ranked low".

## Negatives

- `NEG "recipe for sourdough starter hydration ratios" -> top1=(none)`
- `NEG "weekend train schedule from Lisbon to Porto" -> top1=(none)`

Both negative controls returned no rows. Note: with a path that returns zero rows for *everything*, negatives passing is vacuous — it indicates no spurious hits, not discriminative selectivity.

## Parse coverage

- Audit parser (splits MEMORY.md on `\n---\n` + `^id:` match) sees **11 entries**.
- Raw grep census sees **24 line-start `^id:` ids** (parse-sim census: `lineStartIds=24`, `midLineIds=2`, total 26).
- Prior probe (trusted, not re-verified): all 20 probed ids exist as **active DB rows** — the DB side is populated; the discrepancy is a MEMORY.md parsing/mirroring artifact, not lost data.

**Cause (from parse-sim.ts artifacts — format drift, not parser strictness alone):**

- The **live** MEMORY.md format delimits entries with `\n§\n` (ENTRY_DELIMITER) → **10 chunks**; the audit parser assumed `\n---\n` fences → **11 entries**, where entry #11 is a collapsed 15,884-byte mega-block containing everything the `---`-split failed to delimit (first id `5047a82b-…`).
- One live entry (`68c5150a-…`) embeds **15 further line-start ids inside its body** (`embeddedIdCount=15`), which inflates the raw grep census to 24. So 10 real entries + embedded ids ≈ 24 line-start ids vs 11 mis-split entries: the divergence is **delimiter format drift between parser assumption and actual `§` format, compounded by multi-id entry bodies**.

## Infrastructure

1. **Vectors DB absent:** `SurrealDB error: The database 'vectors' does not exist` → `card_vectors` unreachable, warm/vector path dead; all queries serve via lexical fallback.
2. **Embedding endpoint drift:** runtime default `lmStudioBaseUrl` = `http://127.0.0.1:1234` (UP, 8 models) vs documented `embed-mlx-server` = `http://127.0.0.1:8090` (HTTP 404). Two different "embedding sources of truth" are in play.

## Verdict

**FAIL — measured recall is exactly zero (hit@1/3/5 = 0/20, MRR = 0.000): the hermes recall path is effectively non-functional today.** The serving path measured is the lexical fallback (vector warm path dead: `vectors` DB missing), and in this audit replica it returned zero rows for every query — the `content @@ $q` FTS arm failed (no FTS index / not satisfied) and the `string::contains` fallback requires the *entire multi-word query string* as a literal substring, which natural-language queries never satisfy. Caveat: the audit mirrors the lexical arm only (neighbor augmentation + ranker not replicated), so production recall may be marginally above zero via those layers — but nothing observed here suggests the base retrieval returns any candidate rows to augment or rank. Negatives are vacuously clean; dedup scan is clean (no duplicate pairs).

### Fix pointers (not implemented)

1. **Re-arm the vector path:** create/init the `vectors` SurrealDB database and run the embedding backfill for all active `memories` rows under `nomic-embed-text-v1.5+es1`, then re-run this audit expecting warm-path metrics.
2. **Single-source the embedding endpoint:** pick one canonical endpoint (LM Studio :1234 or embed-mlx-server :8090), make config/docs/runtime agree, and alert on drift.
3. **Reconcile parser vs format:** align the MEMORY.md entry parser with the live `\n§\n` delimiter (and handle embedded line-start ids in entry bodies, e.g. `68c5150a-…`'s 15 embedded ids), or normalize MEMORY.md to the delimiter the parser expects; then re-check parsed-entry count against DB row count.
