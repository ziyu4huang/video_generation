# Strict downward dependency edges in the knowledge/memory layer

**Status:** accepted · 2026-07-18 · supersedes the tier diagram in `bun-apps/KNOWLEDGE-LAYER.md` (hermes was misclassified TIER-2)

> **Naming collision — read this before citing "ADR-0001".** There are two.
> THIS one (`bun-apps/docs/adr/0001-strict-downward-edges-knowledge-layer.md`)
> is monorepo-level and is what `bun-apps/tests/dep-guard.test.ts` enforces.
> The other, `pi-agent-ext-hermes-memory/docs/adr/0001-leanrag-selective-port.md`,
> is package-local and is the one the `.planning/2026-08-08-knowledge-pipeline/`
> docs mean when they write "ADR-0001". Conflating them is not hypothetical:
> #1323 labelled a dep-guard failure an "ADR-0001 false positive" while the ADR
> it named had nothing to say about dependency direction. Cite by path.

The knowledge/memory layer is two tiers: **TIER-0 foundations**
(`pi-agent-ext-obsidian` = vault I/O, `pi-agent-ext-hermes-memory` = memory I/O)
and the **TIER-1 convergence hub** (`pi-agent-ext-knowledge-card` = `zk_*`).
Dependency edges may point **DOWN only** (hub → foundation); a foundation must
never import or reference a component above it. `pi-agent-ext-hermes-memory`
violated this: its `src/store/vault-converge.ts` dynamically imported both
`@repo/pi-agent-ext-knowledge-card/src/ingest.ts` and
`@repo/pi-agent-ext-obsidian/extensions/obsidian.ts` to auto-converge memory
entries into the vault on `session_shutdown` — two upward edges from a
foundation to the hub, plus a lateral reach into another foundation's vault.

We remove those edges by moving convergence **ownership to the hub**:
knowledge-card subscribes to `session_shutdown`, reads hermes's memory files at
their well-known path (`~/.pi/agent/pi-hermes-memory/*.md`), adapts them via the
`adaptHermesMarkdown` adapter that already lives in the hub, and converges
through its own `ingestRecords` → obsidian write path. Hermes becomes a pure
foundation (store / search / flush) with zero upward coupling. The runtime data
still flows up, but via the hub *pulling* on a lifecycle hook rather than the
foundation *pushing* through an import — no static dependency points upward.

## Considered Options

- **A — Push via event bus.** Hermes emits `pi:knowledge` records on shutdown;
  hub subscribes. **Rejected:** the `pi:knowledge` contract *and* the
  hermes→record adapter both live in knowledge-card, so hermes would still
  import the hub (or hardcode the channel string `"pi:knowledge"` with drift
  risk). Inverts the wrong way.
- **B — Pull from hub (CHOSEN).** Hub owns the `session_shutdown` converge
  trigger; reads hermes data at its path; no hermes→hub edge at all. Reuses the
  hub's existing adapter + the idempotent `ingestRecords`. The CLI
  `memory-to-vault` pipeline already proves hub-side convergence works.
- **C — Move to a coordinator.** Convergence becomes CLI-only (the
  `memory-to-vault` command already exists). **Rejected:** loses the
  auto-on-shutdown behavior the layer relies on; B preserves it without the
  inversion.

## Consequences

- `pi-agent-ext-hermes-memory` loses `src/store/vault-converge.ts`,
  `src/store/converge-health.ts`, the `passive-converge.ts` `session_shutdown`
  handler, and its dev+peer deps on knowledge-card + obsidian. The `memory
  transfer` tool action (legacy, already superseded by auto-converge) loses its
  converge call.
- Idempotency state (`.vault-converge-state.json` / `.vault-converge-health.json`)
  moves from hermes to the hub, OR is replaced by `ingestRecords`'s canonical-id
  idempotency (safe to re-converge; the state file is only an optimization to
  skip unchanged entries).
- **Same principle governs documentation (resolved).** A foundation package's
  skill must not describe the hub above it. The `using-obsidian-vault` skill was
  stripped to pure TIER-0 (zero `zk_*` references); the two-tier hand-off moved
  to a new `using-knowledge-cards` skill in the hub, which may reference
  `obsidian` (its down dependency). Doc edges now point down, mirroring the code.
- `KNOWLEDGE-LAYER.md` tier diagram corrected below: hermes-memory is TIER-0.

## Recurrence (2026-08-14) — and the third sanctioned mechanism

The inversion came back. #1311 (ticket 20, `entityRecall`) added
`hermes-memory/src/tools/knowledge-search-tool.ts:24`:

```ts
import { extractEntities, normEntity } from "@repo/pi-agent-ext-knowledge-card/src/entities.ts";
```

with the in-code justification *"hermes→zk is the sanctioned spine direction"*.
That sentence is true about the **runtime call direction** — `retrieve.ts`
states the same, and it is why the `__piKnowledgePipeline` seam exists — but
this ADR governs the **static import edge**. Conflating the two is the failure
mode to watch for: "hermes may call zk" does not imply "hermes may import zk".
The `tests/dep-guard.test.ts` gate caught it at pre-push.

Neither existing mechanism fit. Option B (hub pulls on a lifecycle hook) does
not apply — the query side needs the extractor *during its own* tool call. The
seam would have worked, but `extractEntities`/`normEntity` are **pure
deterministic functions**, and the correctness requirement is that both sides
normalize *identically* (`normEntity` is what makes "MLX" in prose match "mlx"
in a card graph). Behind a runtime seam that agreement is a coincidence, and the
signal dies whenever zk is not loaded.

- **D — Shared primitive, owned below both (CHOSEN).** The module was
  self-contained (291 lines, zero imports), so it moved to
  `pi-agent-ext-core-interface/src/entities.ts` — a package both tiers already
  depend on. Both edges now point down and the shared-normalization guarantee is
  structural. `LinkWeighting`, previously declared in both `entities.ts` and
  `interfaces/knowledge-pipeline.ts`, collapsed to one definition.
- **Consequence**: core-interface is deliberately no longer types-only. It owns
  contracts *and* the deterministic primitives two tiers must share by value.
  Anything placed there must stay dependency-free — it sits below everything.
- **Rejected — duplicate into hermes**: breaks the one property the feature
  needs. The package already carries two such copies
  (`store/surreal/embedder.ts` "Mirrors …/semantic.ts", `bench/hnsw-vs-cosine.ts`
  copying `cosine()` verbatim); a third would deepen the drift, not contain it.
- **Rejected — revise the tiering**: the guard exists so this class of inversion
  "can never silently return". It worked. The code was wrong, not the rule.
- **Rejected — allowlist the edge (#1323, reverted).** Between the diagnosis and
  this fix, the failing check was allowlisted via a `SANCTIONED_EDGES` set,
  commit-titled *"ADR-0001 false positive"*. It was not a false positive. The
  allowlist has been removed with the edge.

### Where the "sanctioned" belief came from

Worth recording, because the same reasoning will look correct again:

1. **Runtime vs static.** `plans/20-leanrag-multi-signal-frequency-vote.md:60`
   planned the dep in as many words — and in the same breath noted *"absent
   today — hermes consumes zk only via the runtime seam"*. The plan knew the
   seam was the existing mechanism and added a static edge anyway, under the
   "sanctioned spine direction" banner. The banner is true of runtime calls.
2. **The same effort said the opposite.** `plans/2026-08-08-hermes-spine-orchestrator.md:21`
   — *"hermes ... NEVER imports `obsidian` or `knowledge-card`"* — with an
   explicit grep-to-confirm step at `:146`. Ticket 06 and ticket 20 contradict
   each other; ticket 20 is the one that drifted.
3. **Two ADR-0001s.** See the note at the top of this file.

**Rule going forward:** an upward edge is permitted only by amending THIS file
first. A guard allowlist that outruns its ADR is a rubber stamp.
