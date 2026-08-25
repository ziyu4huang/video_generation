---
type: task
blocking: 02
status: closed
closed: 2026-08-25 (merged as PR #2022, verify-merge CLEAN — s2-agent 0.7.12)
---

# 01 — `resource` table + document-tree L2 ingest

## Question
Can a markdown tree be ingested into `context_db` as embedded per-file L2 rows, rebuildable from the tree alone, without touching the zettel `card` lane?

## What to build
`s2-agent cli resource-ingest <dir>` walks a markdown tree and indexes it: every `.md` file (excluding sidecars) becomes a `resource` row (uri, level 2, name, deterministic first-sentence abstract, bge-m3 vector via the existing embedding seam, embed_model, created/updated, parent) in its own fingerprint-gated shadow rebuild, and `resource-query --knn <text>` returns top-k rows. Re-running ingest on an unchanged tree is a no-op (fingerprint); editing one file re-embeds only what changed. The `card` index, its fingerprint, and the D36 default are provably untouched.

## Acceptance
- [x] Ingesting the USB4 vlm-out tree (839 pages) produces 839 level-2 rows with vectors + parent links; rebuild time recorded in the ticket receipt
- [x] Fingerprint gate: second run is a skip (receipt shows skip + elapsed ms); single-file edit flips it and re-embeds only the delta
- [x] `resource-query --knn "PM Packet CLx"` returns the USB4 PM-packet page in top-5 (manual smoke, recorded)
- [x] `card` row count + `index_meta` fingerprint unchanged by a resource ingest (regression assertion)
- [x] Hermetic unit tests: uri/key derivation, abstract clamp, fingerprint salt isolation; scratch-db integration test skipping under CI (eval-gate.test.ts pattern)
- [x] Canonical `bun run test` green; independent reviewer subagent pass (or disclosed inline fallback)

## Resolution

**Implemented 2026-08-25** (same session as the effort opening). Files:
`bun-apps/s2-agent-ext-knowledge-card/src/resource-index.ts` (new — walk, hash-keyed per-tree embedding cache, shadow rebuild, flat KNN), `bun-apps/s2-agent/src/cli/commands/resource-{ingest,query}.ts` (new CLIs), dispatch/flag-spec/args wiring (`--tree` value flag), `__tests__/resource-index{,-live}.test.ts`.

**Live receipts (USB4 corpus, production `context_db`, bge-m3 @ LM Studio):**
- R1 cold ingest: **840 rows** (839 pages + 1 combined index md), 840 embedded, dim 1024, **16,223 ms**.
- R2 unchanged: **SKIP (fingerprint match), 144 ms**, 0 embedded / 840 cached.
- R3 single-file append (page-300) then R4 revert: **REBUILT with embedded: 1 / cached: 839** both directions (4,028 ms) — the delta contract holds on the real corpus.
- KNN smoke `resource-query "PM Packet CLx low power states" --tree usb4-…-clean`: **pages/page-300.md rank #1, sim 0.6126, 87 ms** (the exact page zk_ask cited this morning).
- Card lane regression: after R1–R4, `card` count **71** and `index_meta:current` fingerprint present — untouched (the resource rebuild never references `card`/`index_meta`; asserted by construction + live check).

**Tests:** kcard `bun run test` **630 pass / 0 fail** (12 new hermetic: walk exclusions, row shape, mtime-free fingerprint, zero-embed cache hit, 1-file delta, model-keyed cache, embedder-down degrade, mid-run failure degrade, record keys); live round-trip (scratch ns `kcard_resource_test` / db `resource_receipt_tmp`, fake 8-dim embedder): rebuild → stamp → skip → edit-delta → KNN rank-1 → cross-tree isolation. s2-agent `bun run test` **971 pass / 0 fail**.

**Known L2-quality limitations (ticket 02's lane, not regressions):** file2md pages carry no H1 → `name` falls back to the filename stem; the first-sentence abstract picks up the page-header copyright/version line (the same header pollution measured in the morning's generic-card verification). D4 (deterministic abstract) holds; any per-file LLM summary stays rejected.

**Review:** independent reviewer subagent PASSED with findings, all folded before merge (second commit on the branch):
- **M1 (MAJOR, fixed)** — skip gate couldn't see a vector-less/partially-vector build (embedder-down ingest bricked the tree's KNN lane until content changed): `dim` now rides `resource_meta`, `resourceMetaStatus` selects it, skip requires `status.dim === built.dim` + every-row-vec check (the card lane's F2/F3 class, reopened and re-closed here).
- **M2 (MAJOR, fixed)** — single global `resource_shadow` broke the multi-tree design under concurrent rebuilds: per-tree shadow `resource_shadow_<sha16(tree)>`.
- **m1 (fixed)** — `--dry-run` embedded over the network and wrote the cache into the previewed tree; now walk+fingerprint only (no embedder, no cache write).
- **m2 (fixed)** — dim-mismatch against a stale `resource_vec` failed mid-swap AFTER the tree's rows were deleted: recovery path drops the index and retries the copy bare.
- **m3 (fixed)** — KNN fallback lane untested: fake-client tests pin combined-predicate rejection → k*5 over-fetch → client-side tree filter → slice, plus the no-fallback and embedder-down paths.
- **m4 (fixed)** — card-lane isolation now a TRIPWIRE test (captured-SQL fake client asserts no statement matches `card`/`index_meta`), not prose.
- **m5 (fixed)** — `REMOVE INDEX resource_vec` before the bulk copy + re-apply after (the card lane's measured per-row-index-maintenance discipline).
- NITs taken: live-test namespace cleanup, codepoint walk sort, topK clamp, SelectRow type (cast dropped), readTitle divergence comment.
- NIT noted-not-taken: cache-entry pruning for deleted files only on embed-runs (bounded hygiene; revisit if a tree churns heavily).
Post-fix: kcard `bun run test` **637 pass / 0 fail** (7 new review-driven tests); live re-smoke SKIP-gate + KNN rank-1 hold.
