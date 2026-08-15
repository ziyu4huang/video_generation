# Plan — kp 13: three waves (A→B→C), TDD, one squash-PR each + review gate

Verification per wave: `( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit && bun test )` green; review gate (bounded reviewer) before each merge; never wait on remote CI.

## Wave A — card-store dual-backend + bundle join
Files: store/card-store.ts (extract sqlite impl behind internal seam; add surreal impl over SurrealMemoryRepository using addMemory/getCard semantics with C6 dedup), store/backend-factory.ts (cardStore in bundle; extend sole-source gate sanctions if construction moves), store/repository.ts (BackendBundle type + cardStore field), tests: dual-backend contract (upsert/get/list round-trip, C6 dedup rides on surreal path), bundle hot-swap test.
Gate: card-store throws-on-surreal GONE; bundle carries cardStore on both branches.

## Wave B — memory mirror switch + lazy re-migration
Files: tools/memory-tool.ts, tools/memory-supersede-tool.ts, tools/grill-decision-tool.ts, handlers/correction-detector.ts, handlers/error-detector.ts, handlers/sync-markdown-memories.ts, handlers/review-memory-ops.ts — mirror calls → cardStore (md stays canonical); tests: each writer's mirror target asserted; lazy re-migration idempotence (run twice → same rows).
Gate: zero syncMemoryEntry calls on memory-kind paths (grep test).

## Wave C — Tier-1 mirror + legacy deletion + harness
Files: walk-and-ingest.ts (memory-kind hash-compare mirror), delete legacy mirror code path, acceptance harness test file (parity per bullet), tickets/13 checkboxes ticked + map update.
Gate: acceptance bullets green; legacy path deleted (grep test); map stamped 13 SHIPPED.
