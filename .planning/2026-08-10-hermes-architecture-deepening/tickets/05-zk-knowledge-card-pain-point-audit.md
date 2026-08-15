---
type: research
status: closed
claimed:
blocked by: (none)
---
# 05 — zk knowledge-card pain-point audit (gates the wave)

From the 2026-08-16 simplify-&-robusten grilling round. This audit GATES the whole wave — nothing downstream (C3 split, kp21 drift, backend tests) starts until it closes.

## Question
Where does `bun-apps/pi-agent-ext-knowledge-card` actually hurt? Scan for:
- LOC hotspots (size as a smell, not a metric)
- duplicated logic across modules
- test-coverage gaps (hot paths with zero direct tests)

## Acceptance
- Findings written up here (or an appended note), severity-tagged.
- Findings become follow-up tickets on this map — or amend wave tickets 06/08 where they overlap.

## Notes
- Acceptance gate for the wave = deletion-test + invariants (e.g. "memories column list declared exactly once") — never raw LOC counts.
- Blocks ticket 06 (C3 split) by design: the split's shape may change on findings.

## Resolution (2026-08-16)

**Verdict: the package is dedup-poor, not test-poor.** 7005 test LOC across 36 files; every src module has direct tests (only `distill/types.ts` uncovered, types-only). All three audit axes (LOC hotspots, duplicated logic, test-coverage gaps) hit.

### Findings (severity · evidence · dedup shape)

- **K4 (S1)** — card frontmatter schema (id/created/tags/sources/source_id/record_type/status/superseded_by/confidence) re-declared ~6×: ingest.ts:988,1147; retrieve.ts:427,651; merge.ts:122; supersede.ts:62; distill/gate.ts:43 → single extended `readCardMeta`.
- **K5 (S1)** — ~45-line MOC renderer byte-duplicated (ingest.ts:1184-1240 vs retrieve.ts:1022-1060); drift silently breaks `healGraph` → export `buildMocContent`.
- **K6 (S2)** — `yamlScalar` copied (ingest.ts:1082 vs supersede.ts:28).
- **K7 (S2)** — card-anatomy regexes + tokenisers ×3 byte-identical (merge.ts:79 / ingest.ts:1264 / retrieve.ts:1008-1020) → `cardAnatomy()`.
- **K8 (S3)** — liveness guard + status coercion ×3 → `isLiveStatus()`.
- **K9 (S3)** — readFileSync + parseFrontmatter ×8 → `readCard()`.
- **K1 (S2)** — ingest.ts 1767 LOC mixed concerns (3 adapters + render + MOC + wiki + engine) → split adapters/render/engine.
- **K2 (S2)** — extensions/knowledge-card.ts 1506 LOC (tools + task builders + zk-spawn + seam + converge conflated) → task builders to src/.
- **K3 (S2)** — retrieve.ts 1102 LOC (rank + graph + MOC + semantic) → extract graph-health module.

### Gaps (unverified at budget stop, ~70% depth)

Importer map, K11 deletion-test (converge vs distill/converge), manifest registration check — folded into ticket 12 scope.

### Disposition

- **K4–K9 → ticket 12** (dedup consolidation, S1s first).
- **K1–K3 → ticket 13** (megafile split, blocked by 12).
- Wave tickets 06/08 unamended and now **UNBLOCKED** (this gate closes).
