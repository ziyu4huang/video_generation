# REJECTED.md — hermes-memory banned-mechanism ledger

> Decision-log-as-anti-regression-device (format borrowed from UPSP §三三 淘汰机制汇总).
> Three columns: **old mechanism · why killed · replacement**.
> This is a **living doc** — seed it with settled rejections; **append a row whenever a
> design is killed**, so a future contributor (or the agent) doesn't re-invent it.
> "Why don't we do X?" → find the row here before re-proposing.

| Old mechanism | Why killed | Replacement |
|---|---|---|
| **Bespoke `pi -p` subprocess** (`pi-child-process.ts`) for consolidation / background-review / correction-detector / session-flush | An extra process to maintain; `@repo/s2-agent-ext-subagent`'s `spawnSubagent` already bridges the `memory` tool to a child and reuses the small tier | `spawnSubagent` dispatch; `pi-child-process.ts` **deleted** — `CONTEXT.md → Architecture` |
| **Always-inject memory into the prompt** (legacy-inject: MEMORY.md + USER.md + project memory + recent failures all in the system prompt) | First-turn token cost too high; most sessions don't need most memories up front | **Policy-only mode** (default): inject only the `<memory-policy>` guidance; memories fetched on demand via `memory_search` — `CONTEXT.md → Prompt behavior` |
| **FIFO drop / byte truncation / hard error on store overflow** | Loses curated signal blindly; truncation corrupts entries; erroring blocks the write | **Auto-consolidation**: a one-shot child semantically merges related entries + drops stale ones, then retries — `CONTEXT.md → Auto-consolidation` |
| **Lineage-preserving consolidation** (keep the old entry linked to the new merged entry) | Doubles storage; the lineage graph rots; the merged entry is the new truth anyway | **Destructive consolidation** — the LLM merge yields a fresh active entry; consumed `.md` + DB rows are hard-deleted. Overflow priority: **offload superseded FIRST**; TRIM never touches active — PR #961 |
| **SurrealDB as the default backend** | Heavier ops surface (local server process); SQLite is dependency-light and sufficient for the read side | **SQLite default**; SurrealDB `default-off` (`config.dbBackend: "surrealdb"`), opt-in; `repository-contract.test.ts` proves equivalence — `CONTEXT.md → Extended store` |
| **`grill-memory` as a separate package** (`s2-agent-ext-grill-memory`) | The `grill_decision` runtime already lived in hermes-memory; a separate package duplicated the seam | **Merged into hermes-memory**; the skill ships from this package's `skills/` — `CONTEXT.md → grill-memory skill` |
| **errors.log-rotation for raw `errorCapture`** | Premise unfounded: `errorCapture` extracts **lesson lines** (not raw traces) and **3-layer-dedups** (#854: this-session LRU + cross-session signature check + rate cap 5/10min) before any write, so raw traces never reach `failureCharLimit`; only ~1 `failure`-category entry exists | **Inline #854 hardening** (lesson-line extraction + cross-session signature dedup + rate-limiting) — no separate store file / rotation / DB↔.md sync. Decided 2026-08-05 — `.planning/2026-08-05-let-s-continue-to-learning-from-prevous-wayfind-/tickets/03` |

## Candidates under consideration (NOT yet rejected — see UPSP graduation)

These are known smells with a proposed replacement still pending a decision. Listed here so the
"why don't we X?" lookup still finds them; remove to the rejection table only once adopted or killed.

- _(none currently — the errorCapture/`errors.log` candidate was rejected 2026-08-05; see the rejection table above.)_

## How to use this doc

- **When you kill a design**: append a row (old · why · replacement) in the same change that
  makes the replacing decision.
- **When you propose X**: grep this file first — if X (or its rationale) is here, address the
  "why killed" column before re-proposing.
- **Format**: keep rows one-line-dense; link the replacing decision (ADR / PR / CONTEXT.md
  anchor) where it exists.
