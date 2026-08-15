# 04 — Design the file2md→hub emit contract

## Question

Design the emit contract between file2md and the knowledge-card hub — **the no-upward-edge
mechanism AND the payload shape for a generic-source folder**. Two coupled sub-questions:

### Sub-question A — mechanism (no upward edge, ADR-0001)

file2md must emit on `pi:knowledge` **without importing the hub's logic** (preserve TIER-0
purity). Options:
- **(a) Direct `pi.events.emit`** — file2md calls `pi.events.emit("pi:knowledge", payload)`
  directly, hardcoding the channel name + payload shape. Zero dependency, but **duplicates the
  contract** (drift risk vs `src/emit.ts`).
- **(b) Shared zero-dep `pi-knowledge-contract` package** — extract `src/emit.ts` into a
  package both file2md and knowledge-card import. Cleanest single-source-of-truth, but more
  packaging machinery (new workspace package, manifest wiring, schema-cost canary entry).
- **(c) Import the thin `emit.ts` module** from knowledge-card. Lightweight (it's just a
  channel string + a `bus.emit` wrapper + types), but technically a source-tree import edge —
  blurs the ADR-0001 line even though it imports no hub *logic*.

### Sub-question B — payload shape (folder, not jsonl)

`KnowledgeEmission` today (`src/emit.ts`) carries inline `records[]` **OR** a `kbFile` path to
a `.knowledge.jsonl`. file2md produces **neither** — it writes a generic-source **folder** of
`.md` (`./vlm-out/<slug>/` = index note + per-page `.md` + manifest). Options:
- **(a) Extend `KnowledgeEmission`** with a `dir` / `files` field for generic-folder ingest
  (the sink runs `adaptGenericMarkdown` over the folder).
- **(b) file2md emits `records[]`** derived from its index note (one record per doc, title +
  summary + tags from the manifest).
- **(c) file2md writes a tiny `.knowledge.jsonl` sidecar** and emits `kbFile` (reuses the
  existing path, but file2md then owns record-shaping it doesn't naturally produce).

## Context

- This is the **frontier** decision — everything downstream ([05], [06]) is gated on it.
- The charting grill did NOT resolve it; it is the first ticket a follow-on session should
  claim and resolve (via `grilling` + `domain-modeling`).
- Relevant files: `pi-agent-ext-knowledge-card/src/emit.ts` (contract),
  `pi-agent-ext-knowledge-card/src/ingest.ts` (`adaptGenericMarkdown` @ ~618, `KnowledgeRecord`),
  `pi-agent-ext-file2md/extensions/file2md.ts` (tool params, output layout).

## type

`grilling` (HITL) — a design decision needing the human's call on the purity/dependency and
payload-shape tradeoffs.

## blocked by

— (this is the frontier; unblocked)

## claimed

wayfind-resolve (2026-08-01)

## Resolution

**Closed 2026-08-01 (wayfind-resolve).**

**Sub-A — mechanism: direct `pi.events.emit`.** file2md calls
`pi.events.emit("pi:knowledge", payload)` directly, hardcoding the channel name + payload shape
(~5 lines, no import). Purest no-edge: file2md depends on NOTHING from the hub and works fine
with no sink attached. Chosen over (b) a shared `pi-knowledge-contract` package — more
machinery for one emitter (YAGNI; trivially refactorable later IF a 2nd emitter appears, e.g.
hermes migrating to bus-emit) — and (c) importing `emit.ts` from the hub, rejected because it
creates the upward edge ADR-0001 + the bus exist to avoid (file2md would need knowledge-card
installed).

**Sub-B — payload: extend `KnowledgeEmission` with a `dir?: string` field.** file2md emits
`{ source: "generic", sourceLabel: "file2md:<slug>", dir: "<abs path to ./vlm-out/<slug>>" }`.
The knowledge-card sink extends `onKnowledge`'s validation gate (today hard-requires
`records`|`kbFile`) to accept `dir`, then routes a `dir` payload to the EXISTING
directory-expansion generic ingest path (the same one `zk_ingest --dir` uses: recurse →
`adaptGenericMarkdown` per `.md` → `ingestRecords`, `source:"generic"`, shared
`Zettelkasten/knowledge-graph/` folder). Chosen because it (1) reuses a tested path, (2) keeps
full fidelity (every page `.md` → a card), (3) keeps file2md dumb (points at a folder, shapes
no records), (4) is idempotent (`generic:<slug>` dedup). Rejected: `records[]` from the index
note (low-fidelity summary-only, or re-implements the adapter inside file2md) and a
`.knowledge.jsonl` sidecar (file2md owns record-shaping it doesn't naturally produce + an extra
write).

**Net contract**: file2md emits a plain object on `"pi:knowledge"` with `{source, sourceLabel,
dir}`; knowledge-card adds a `dir`-aware sink → directory generic ingest. No new package, no
upward edge, no LLM, idempotent. Unblocks [05](05-knowledge-card-sink-subscriber.md) (sink) and
[06](06-file2md-opt-in-knowledge-flag.md) (file2md flag+emit) — now parallelizable across the
two packages; converges in the round-trip test.
