# Map — continue/improve the pipeline between extensions (hermes-memory + file2md → knowledge card → obsidian)

## Destination

Close the **file2md gap**: file2md's *opt-in* conversions flow into the shared obsidian
knowledge graph the same way hermes-memory already does, so the
`hermes-memory + file2md → knowledge card → obsidian` diagram is complete and queryable
end-to-end. The read/query side (`zk_ask`, `knowledge_query`) is unchanged. The orphaned
`pi:knowledge` event bus gets a real emitter + sink as the no-upward-edge convergence
mechanism (de-orphaning a contract that existed but wired to nothing).

## Notes

- **Domain**: pi extension monorepo (`bun-apps/`). Relevant packages:
  - `pi-agent-ext-file2md` — PDF/image → `.md` vision bridge (TIER-0 foundation). Writes
    `./vlm-out/<slug>/` (index note + per-page `.md` + manifest; lang `zh-TW`, mode `hybrid`).
  - `pi-agent-ext-knowledge-card` — the hub: `zk_ingest` (deterministic convergence sink),
    `zk_card` (LLM CRUD), `zk_ask` (graph-RAG), `knowledge_query` (tag digest). Owns
    `src/emit.ts` (the `pi:knowledge` bus contract: `emitKnowledge` / `onKnowledge`).
  - `pi-agent-ext-hermes-memory` — TIER-0 memory foundation. Already converges via a
    `session_shutdown` PULL hook in knowledge-card (`convergeHermesMemory`, ADR-0001).
  - `pi-agent-ext-obsidian` — vault backend.
- **Load-bearing invariant (ADR-0001)**: convergence ownership lives in the **hub**
  (knowledge-card), NOT in foundation extensions — so hermes/file2md carry **no upward
  dependency edge** into the hub. The `pi:knowledge` bus is the no-edge mechanism:
  payload-only emit; the hub subscribes and persists.
- **Skills every session should consult**: `grilling` + `domain-modeling` (extension-
  architecture decisions); `using-obsidian-vault` when touching vault layout/folders.
- **Standing preference**: deterministic over LLM where a lossless idempotent path exists
  (PRD: "deterministic is the convergence sink"). Token-cost discipline.
- **Fact freshness**: charted 1 commit behind `origin/main` (planning-only chore
  `b4ad3b55`); no code drift. Re-check `git rev-list --count HEAD..origin/main` before
  implementing.

## Decisions so far

<!-- one line per closed ticket; open the link for the detail the ticket holds -->

- [01 Convergence mechanism](tickets/01-convergence-mechanism.md) — deterministic `zk_ingest source:generic` (zero-token, idempotent); LLM distill stays manual opt-in.
- [02 Scope — opt-in vs auto](tickets/02-scope-opt-in-vs-auto.md) — opt-in per conversion (a `knowledge` flag, default off); protects the curated graph.
- [03 Trigger + orphaned-bus fate](tickets/03-trigger-and-bus-fate.md) — wire the `pi:knowledge` bus; file2md emits on-conversion; knowledge-card adds a sink → `ingestRecords`.
- [04 Design the file2md→hub emit contract](tickets/04-emit-contract-file2md-to-hub.md) — direct `pi.events.emit` (no upward edge) + extend `KnowledgeEmission` with `dir` (reuse existing dir-ingest; full fidelity; file2md stays dumb).
- **2026-08-12 reconciliation:** [05 sink subscriber](tickets/05-knowledge-card-sink-subscriber.md) & [06 file2md emit](tickets/06-file2md-opt-in-knowledge-flag.md) closed as superseded (verified delivered in code 2026-08-12; canonical spine uses `walkAndIngest`).

## Not yet specified

<!-- in-scope fog you can't yet ticket; graduates as the frontier advances -->

- **Opt-in convergence observability** — the sink should probably surface "converged N cards
  from doc X" (the user explicitly opted in, unlike hermes' silent shutdown pull), but the
  channel (tool result? log? a return event?) is undecided. Graduates after [05](tickets/05-knowledge-card-sink-subscriber.md) lands.
- **Manifest / index-note reuse** — file2md writes a manifest + index note (profile, page
  count, lang). [04] chose the `dir` payload → the generic adapter reads the `.md` folder
  directly, so the manifest is **not consulted in the MVP**. Could still seed richer records
  (tags, type) later — a post-MVP refinement; revisit once the basic wire works.
- **Single convergence pattern?** — once the bus is wired for file2md, should hermes ALSO
  migrate from shutdown-pull to bus-emit for one coherent pattern? Adjacent coherence
  question; natural follow-on effort, not this one.

## Out of scope

<!-- work ruled beyond the destination; closed, never graduates -->

- **Read/query side** (`zk_ask` ranking, `knowledge_query` digest, MOC, dedup quality) —
  the destination explicitly leaves it unchanged.
- **LLM distill as an auto-convergence mechanism** — D1 settled deterministic;
  `obsidian_distill` stays a manual opt-in for high-value docs.
- **Re-architecting the working hermes shutdown-pull** — it works (ADR-0001); untouched.
  See "Single convergence pattern?" above for the coherence follow-on.

## Cross-effort links (2026-08-08 review)

- **Absorbed-by:** `2026-08-08-pi-agent-ext-knowledge-card-obsidian-surealdb-or` — this effort's CLOSED ingest decisions (zk_ingest source:generic, opt-in knowledge flag, pi:knowledge bus, file2md->hub emit contract) are carried forward there (ticket 02). Remaining OPEN tickets (sink subscriber, file2md emit side) are superseded by the 2026-08-08 implementation plan. Per CONVENTIONS: close these as superseded (backlog item in .planning/REVIEW-2026-08-08.md).
