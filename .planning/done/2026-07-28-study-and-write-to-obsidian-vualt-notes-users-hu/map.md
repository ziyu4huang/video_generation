# Wayfinder map: 2026-07-28-study-and-write-to-obsidian-vualt-notes-users-hu

> **Status: DONE — executed directly, no tickets.** The deliverable was a study
> note, not code; it was researched and written in a single pass to the
> `study-news` vault. Authoritative output lives outside this repo (see
> Resolution).

## Destination

Study `bun-apps/pi-agent-ext-hermes-memory/` and write a structured Obsidian
note to `/Users/huangziyu/proj/study-news/content/` explaining how the extension
works — the cost-vs-reliability tension that drives its design.

## Resolution (executed, not ticketed)

- **Deliverable:** `pi-agent-ext-hermes-memory-study.md` — a 14-section study
  note (~34 KB) written to `/Users/huangziyu/proj/study-news/content/` on
  2026-07-28. Frontmatter: `created/updated: 2026-07-28`, `type: study`, tags
  `hermes-memory / pi-extension / agent-memory / persistent-memory /
  learning-loop / security / study`.
- **Coverage:** one-line summary → why-it's-needed (cost ↔ reliability) → the
  five stores → two-layer scoping (global vs project) → six memory categories
  (and correction's immediacy) → prompt behavior (policy-only vs legacy-inject)
  → the capture learning loop → content-scanning security gate → the
  backend-neutral store seam → grill-memory skill → evolution archaeology →
  source map (file → responsibility) → design takeaways & red flags.
- **Through-line:** the "cost ↔ reliability" tug-of-war — from "inject every
  memory every turn (reliable but expensive)" to "inject only policy, retrieve
  on demand via search (cheap yet still reliable)".
- **Cross-links:** `[[memo-memory-as-a-model|Memory as a Model]]`,
  `[[knowledge-graph]]`, `[[llm-kasten]]`, `[[pi-extension-ecosystem-study]]`,
  `[[agents-develop-sop-wayfind-superpowers]]` (grill-memory interplay).

## Notes

- This effort's only artifact lives in the **`study-news` repo**, not here. This
  map records that the study was completed; no code change was produced or
  expected.

## Decisions / Not yet specified / Out of scope

_(Single-pass study; no further tickets.)_
