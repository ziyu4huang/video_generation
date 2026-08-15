---
type: feature
status: open
claimed:
blocked by: []
---
# 12 — knowledge-card dedup consolidation (K4–K9)

Consolidate the copy-paste duplication found by audit ticket 05 (findings K4–K9) into single-source helpers. Also closes the audit's unverified gaps (importer map, K11 deletion-test, manifest registration check) that were folded in at budget stop.

## Scope (ordered — S1s first)

1. **K4 (S1)** `readCardMeta` — one extended frontmatter reader (id/created/tags/sources/source_id/record_type/status/superseded_by/confidence) replacing ~6 re-declared schemas (ingest.ts:988,1147; retrieve.ts:427,651; merge.ts:122; supersede.ts:62; distill/gate.ts:43).
2. **K5 (S1)** `buildMocContent` — shared MOC renderer for the ~45-line byte-duplicated block (ingest.ts:1184-1240 vs retrieve.ts:1022-1060). Byte-contract: `healGraph` depends on the rendered MOC staying identical — drift silently breaks healGraph.
3. **K7 (S2)** `cardAnatomy()` — one home for the card-anatomy regexes + tokenisers currently byte-identical ×3 (merge.ts:79 / ingest.ts:1264 / retrieve.ts:1008-1020).
4. **K6 (S2)** `yamlScalar` — dedupe the copy (ingest.ts:1082 vs supersede.ts:28).
5. **K8 (S3)** `isLiveStatus()` — one liveness guard + status coercion (×3 copies).
6. **K9 (S3)** `readCard()` — one readFileSync + parseFrontmatter path (×8 sites).

## Audit-gap closures

- Importer map: grep-verify where card imports enter the package.
- K11 deletion-test: `converge` vs `distill/converge` — prove the split of responsibilities is real (one deletable without the other's tests going red).
- Manifest registration check: knowledge-card extension registered exactly once.

## Acceptance (deletion-test gate)

- Each helper declared EXACTLY once — grep proves zero duplicate declarations.
- Canonical `bun run typecheck && bun test` green.
- Behavior-goldens unchanged: MOC render output and healGraph detection are byte-stable against pre-refactor goldens.

## Estimate
small-M
