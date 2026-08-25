**ID:** `ADR-tool-gate-0003` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: repo-root `CONTEXT-MAP.md`

# ADR-0003: Noun∧verb co-occurrence (`requires`) for core nouns

Date: 2026-07-20 (S2)
Status: accepted
See: [ADR-0002](./0002-keyword-precision-bare-word-removal.md)

## Context

Core nouns — `image`, `video`, `pdf` (and their CJK equivalents) — are the most common generation intents ("generate an image", "make a video", "read this PDF"). But their **bare form false-fires on ubiquitous phrases**: "docker image", "video call", "PDF of the report". This is a precision/recall tension with no good single-keyword answer: removing the noun entirely (per ADR-0002's bare-word removal) kills recall on the most common intents; keeping it bare restores the constant false-fires ADR-0002 eliminated.

## Decision

Add a **`requires` co-occurrence trigger**: a gate fires not just on a `keywords` match, but also when the prompt contains **≥1 noun AND ≥1 verb** from the gate's `requires` lists.

```typescript
requires: {
  nouns: ["image", "picture", "photo", "圖片", …],
  verbs: ["generate", "create", "make", "draw", "render", "生成", …],
}
```

"generate an image" (image ∧ generate) fires; "docker image" (image, no generation verb) does not. `gateFires` returns true if any keyword matches **OR** the `requires` noun∧verb co-occurrence holds.

## Consequences

- Core-noun gates (flux2, ltx, file2md, inspect, arxiv, deploy_pi_agent_sh) keep recall on real intents while killing bare-form false-fires — the best of both.
- Gates whose keywords are already narrow enough to not bare-false-fire (krea2, workflow, research/collect, movie, zai-mcp) **skip `requires` entirely** — `requires` is only for the core-noun case.
- Adds a noun∧verb data structure per qualifying gate; the L1 corpus tests the co-occurrence boundary directly (e.g. "docker image cleanup" → must-not-fire).

## Alternatives considered

- **Remove core nouns entirely** (bare-word rule, ADR-0002). *Rejected:* kills recall on the most common generation intents.
- **Keep core nouns as bare keywords.** *Rejected:* restores the constant false-fires ADR-0002 eliminated.
- **Require all keywords be multi-word phrases.** *Rejected:* cannot cover "generate an image" without the bare noun somewhere; the phrase space is too large to enumerate.
