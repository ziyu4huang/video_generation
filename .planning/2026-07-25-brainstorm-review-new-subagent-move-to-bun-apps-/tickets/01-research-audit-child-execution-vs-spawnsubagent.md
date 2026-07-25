## Question

Audit the memory ext's **existing child-execution subsystem** and compare it against what `spawnSubagent` (post-#789) now offers — to give tickets 02+ a factual base for the migration trade-off.

Specifically map and document:

1. **The current child-execution surface** in `pi-agent-ext-hermes-memory`:
   - `src/handlers/pi-child-process.ts` — the `pi -p` subprocess builder (`--no-extensions`, `-e <minimal-ext>`, model resolution). What exactly does it spawn, and what does the minimal `-e` extension load?
   - `execChildPrompt` / `triggerConsolidation` (`auto-consolidate.ts`) and `runSubprocessReview` + `runDirectBackgroundReview` (`background-review.ts` + `review-memory-ops.ts`).
   - The **dual transport** (`ReviewTransport = "direct" | "subprocess"`): what the `direct` in-process `complete()` side-channel buys (parent LLM cache preservation, no cold start) vs the `subprocess` fallback, and **which is the default** (`config.reviewTransport ?? "direct"`).

2. **What `spawnSubagent` / `WorkflowAgent` offers instead** — read `bun-apps/pi-agent-ext-subagent/src/{spawn-subagent,agent}.ts` + README. Concretely: model-tier routing, worktree isolation, `/subagents` viewer observability (the shared singletons), structured output, retry/budget hooks, the tools the child can call.

3. **The duplication / architecture finding** — is `pi-child-process.ts` + the dual-transport now **duplicated machinery** vs the shared `createAgentSession` runner the extraction created? Is this tech debt the #789 move left behind? (This is the "① move health" context the destination asked for.)

4. **The cold-start cost question** — `spawnSubagent` creates a fresh `createAgentSession` (no parent cache). Reason about (or, if feasible, roughly measure) the per-dispatch overhead vs the `direct` path's cached `complete()`. Frequency matters: consolidation is on-demand/when-full; background-review fires every N turns.

5. **Dependency check** — confirm `hermes-memory → @repo/pi-agent-ext-subagent` remains acyclic and is a clean `peerDep`/`dep` add (no singleton subpath needed unless the memory ext must observe the shared registry).

**Resolution = a findings block** appended to this ticket: a side-by-side (current child subsystem vs spawnSubagent), the duplication verdict, the cache/cold-start trade-off in concrete terms, and the dependency verdict. This unblocks ticket 02.

type: research

## Resolution

_Closed 2026-07-25 — research pass._

**Verdict: partial duplication; the migration trade-off is per-site, not uniform.**

### 1. Current child-execution surface
- `pi-child-process.ts` builds a `pi -p --no-session --no-extensions -e <hermes-root-entry> <prompt>` OS subprocess (`:83-102`); `-e` loads ONLY hermes-memory so the child has the `memory` tool. Invocation reuses the parent's own CLI entry, else PATH `pi` (`:152-200`). `execChildPrompt` retries once without `--model`/`--thinking` overrides on resolution failure (`:203-238`).
- Consolidation (`auto-consolidate.ts:80-100`): builds `CONSOLIDATION_PROMPT` + entries → `execChildPrompt({retryWithoutOverrides:true, timeoutMs:60000})`; child writes via the `memory` tool, parent `store.loadFromDisk()` after.
- Background-review dual transport (`background-review.ts:100-228`): **default = `direct`** (`config.reviewTransport ?? "direct"`). `direct` → `runDirectBackgroundReview`; falls through to `runSubprocessReview` (`execChildPrompt`) only on failure or when configured `subprocess`.
- **What `direct` actually buys** (`review-memory-ops.ts:105-114,405,430-440`): a single stateless `completeSimple(parentModel, {systemPrompt, messages:[userMessage]})` — reuses the parent's live `Model` object + registry auth, same provider (prompt-cache friendly). It does NOT share the parent's conversation KV cache; it's a fresh one-shot. Real savings = no OS-process cold start + no model/auth re-resolution.

### 2. spawnSubagent capabilities the current subsystem lacks
Model-tier routing (`agent.ts:316-390`); worktree isolation (`worktree.ts`); `/subagents` viewer observability via the in-flight/persistence singletons; structured output with in-session repair (`agent.ts:60-145`); retry/budget hooks (`tokenBudget`/`spendBudget` → `session.abort()`, `agent.ts:498-528`); tool policy + **`extensionTools` bridging** (`agent.ts:201-214`) — the path to give the child the `memory` tool WITHOUT an OS subprocess + `-e`.

### 3. Duplication verdict — **YES (partial)**
`pi-child-process.ts` + the `subprocess` transport ARE parallel implementations of "isolated child LLM task," strictly heavier than the in-process `createAgentSession` path (OS process + extension load + second pi session). **Tech debt #789 left behind.** **Carve-out:** the `direct` transport (`completeSimple`, tool-less one-shot) is NOT duplicated — spawnSubagent always runs a full agent loop. A migration must preserve `direct` or accept agent-loop overhead on every review.

### 4. Cache vs cold-start
Per-dispatch overhead: **subprocess ≫ spawnSubagent ≫ direct**. spawnSubagent is lighter than `pi.exec` (no OS process / settings scan) but heavier than `completeSimple` (full agent loop + settings load + tool assembly, `agent.ts:473-499`). Frequency decides per site (see ticket 02).

### 5. Dependency verdict — **clean, acyclic**
`pi-agent-ext-subagent` has zero code imports of hermes/memory (grep returns README/CONTEXT prose only). `hermes-memory → @repo/pi-agent-ext-subagent` is a clean dep add. **Bare `.` root import suffices** for `spawnSubagent`/`WorkflowAgent`; the **`src/` subpath** is needed ONLY if consolidation/review runs must appear in the `/subagents` viewer (module-identity rule), else skip it.

### 6. Newly-visible — execChildPrompt has **FOUR** call sites (not two)
| Caller | Trigger | Profile | spawnSubagent fit |
|---|---|---|---|
| `auto-consolidate.ts:93` | on-demand / store-full / manual | low-freq, 60s | **clean win** (gains isolation + observability) |
| `background-review.ts:226` (subprocess fallback) | every N turns, only when direct fails | higher-freq; but `direct` is the default and better | keep `direct`; spawnSubagent only if dropping the subprocess fallback |
| **`correction-detector.ts:220`** | real-time, on correction-pattern match | **latency-sensitive** (user just corrected), 30s | **NO** — wants lightest transport |
| **`session-flush.ts:46`** | `session_before_compact` / `session_shutdown` | **shutdown-sensitive**, fire-and-forget 10s | **NO** — wants lightest transport |

**Non-candidates (ruled out — no LLM child):** `session-backfill`, `session-live-index`, `sync-markdown-memories` (all CPU/IO, no `execChildPrompt`).

**Net steer for ticket 02:** consolidation is the single unambiguous spawnSubagent win; review should keep `direct`; correction-detector + session-flush must stay light (closer to `direct` than spawnSubagent). The decision in 02 is now "partial migration scoped to consolidation (+ optionally dropping the review subprocess fallback) + observability scope," not a blanket migration.
