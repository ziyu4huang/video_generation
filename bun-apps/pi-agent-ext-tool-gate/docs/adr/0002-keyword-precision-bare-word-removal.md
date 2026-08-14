**ID:** `ADR-tool-gate-0002` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# ADR-0002: Keyword precision — bare-word removal + word-boundary matching

Date: 2026-07-20 (S2 audit)
Status: accepted
See: [spec `2026-07-20-tool-gate-s2-s3-keyword-precision-telemetry-design.md`](../../../../docs/superpowers/specs/2026-07-20-tool-gate-s2-s3-keyword-precision-telemetry-design.md)

## Context

Early gate keywords included bare common words — `image`, `scene`, `style`, `swap`, `render`, `video`, `電影`, `動畫`, `describe`, `pdf`, `chain`, `collect`, `organize`, `movie`, `compose`. These false-fired constantly: "docker **image**", "video call", "paper trail", "PDF of the report" all loaded heavy tools that were never needed — eroding the savings the gate was meant to deliver and eroding trust in gate firing. Separately, plain substring matching let `flux` match inside "con**flux**" and `image` inside "**image**s".

## Decision

1. **Remove over-broad bare words** from gate keywords (the S2 audit). Keep only unambiguous triggers (e.g. `flux`, `t2i`, `arxiv`, `montage`).
2. **Match single ASCII tokens with word boundaries** (`\bflux\b`); multi-word phrases and CJK use substring (no segmenter; phrases are specific enough once bare words are removed).
3. **Core nouns whose recall must survive** (`image`/`video`/`pdf`) move behind `requires` co-occurrence (ADR-0003) rather than living as bare keywords.

## Consequences

- Gates fire only on unambiguous intent. False-fires dropped to **benign-only** (8 reported, none gating — they merely load an unneeded tool at minor token cost, never break a task).
- Keyword precision is now **testable**: the L1 corpus (`qa/evaluate.ts`) has must-fire + must-not-fire cases; `bun run qa` gates on them.
- Word-boundary matching compiles a regex per keyword on the hot per-turn path — handled via a bounded `wordBoundaryRegexCache` (the keyspace is the finite GATES keyword set, ~120).

## Alternatives considered

- **Semantic / embedding intent matching.** *Rejected:* a mechanism redesign, ruled out of scope by the prior QA and reaffirmed by effort `2026-07-30` (incremental only).
- **Accept the false-fires.** *Rejected:* constant false-fires erode savings + trust — the whole reason for the S2 audit.
- **Segmenter-based CJK word boundaries.** *Rejected:* adds a dependency; CJK phrases are specific enough on substring once bare words are removed.
