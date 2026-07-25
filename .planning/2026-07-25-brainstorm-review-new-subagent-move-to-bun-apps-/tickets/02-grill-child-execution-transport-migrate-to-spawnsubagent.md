## Question

Ticket 01 audited the child-execution surface: `execChildPrompt` has **four** call sites with very different profiles, and the `direct` transport is NOT duplicated by `spawnSubagent`. So this is **not** a blanket migration — it's a per-site decision, with 01 already steering hard toward "partial."

Should the memory ext **partially migrate** its child-execution transport to `spawnSubagent`, scoped per the four sites?

This is the primary ③-anchor decision. Resolve **after** ticket 01 supplies the trade-off facts. Decide:

- **Migrate, partial, or keep?** Three honest options:
Per-site decisions (01's steer in parentheses):
  - **consolidation** (`auto-consolidate.ts`, on-demand/when-full) → 01 says **clean spawnSubagent win** (low-freq tolerates cold-start; gains model-tier routing + worktree isolation + `/subagents` observability). Confirm, or keep?
  - **background-review subprocess fallback** (`background-review.ts:226`) → 01 says **keep `direct` as default** (frequency makes cold-start hurt); only question is whether to drop the `subprocess` fallback in favor of spawnSubagent, or leave it.
  - **correction-detector** (`:220`, real-time/latency-sensitive) + **session-flush** (`:46`, shutdown-sensitive) → 01 says **must stay light** (NOT spawnSubagent — they want the cheapest transport, closer to `direct`). Confirm they're out of the migration scope.

And the cross-cutting decisions:
  - **The `pi-child-process.ts` fate** — if consolidation migrates AND the review subprocess fallback is dropped, `pi-child-process.ts` + the `-e` hack + the `subprocess` transport become dead code → delete. If either stays, it stays. (This is the tech-debt cleanup payoff.)
  - **Observability scope** — do consolidation runs need to appear in the `/subagents` viewer? If yes → import via the `src/` subpath (module-identity rule, per 01); if no → bare `.` root import suffices.
  - **Model tier** — consolidation on the **small** tier; confirm the child gets the `memory` tool (via `extensionTools` bridging, not `-e`) and only what it needs.

- **Model tier** — if migrating, consolidation/review should run on the **small** tier (cheap, isolated). Confirm the tier resolves and the child gets the memory tool (and only what it needs).

- **The cache-preservation sub-question** — if (a) is chosen, is the cold-start cost acceptable for background-review's every-N-turns frequency? (This may force (b).)

- **Observability** — does migrating consolidation onto the shared in-flight/persistence singletons give the user a `/subagents` view of consolidation runs (a real UX win), or is that noise?

type: grilling
blocked by: 01-research-audit-child-execution-vs-spawnsubagent
claimed: controller (2026-07-25)

## Resolution

_Closed 2026-07-25 — grilling: Q1=A, Q2=A, Q3=A, Q4=A._

**Decision: UNIFORM migration — every `execChildPrompt` (subprocess) caller → `spawnSubagent`; `direct` survives ONLY as background-review's default; `pi-child-process.ts` fully deleted.**

### Per-site outcome (all four `execChildPrompt` sites + the review default)

| Site | From | To | Why |
|---|---|---|---|
| consolidation (`auto-consolidate.ts`) | `pi -p` subprocess | **`spawnSubagent` (small tier)** | on-demand/low-freq; clean win — model-tier routing + worktree isolation + structured output + `/subagents` observability |
| background-review **default** (`background-review.ts`) | `direct` (`completeSimple`) | **`direct` (unchanged)** | every-N-turns frequency; cold-start would hurt; the SOLE surviving `direct` path |
| background-review **subprocess fallback** | `pi -p` subprocess | **`spawnSubagent`** | rarely-hit heavy fallback; spawnSubagent beats a raw OS subprocess; enables deletion |
| correction-detector (`:220`, real-time) | `pi -p` subprocess | **`spawnSubagent`** | uniform, zero rework; in-process agent loop is FASTER than its current OS-process subprocess (improvement); avoids bespoke parse+apply |
| session-flush (`:46`, shutdown) | `pi -p` subprocess | **`spawnSubagent`** | uniform, zero rework; fire-and-forget w/ timeout handles it; faster than current subprocess |

> Note on Q4: correction-detector/session-flush were considered for `direct` (01's "lightest" preference) but they save via the child's `memory` tool, so `direct` would require a bespoke parse+apply rework per handler. Uniform `spawnSubagent` avoids that AND is still faster than their current subprocess. `direct`'s single-completion advantage is preserved where frequency matters most (review default).

### Deletion (tech-debt payoff — the point of Q2)
With every subprocess caller on `spawnSubagent`, **nothing calls `execChildPrompt`** → delete:
- `src/handlers/pi-child-process.ts` (the subprocess builder + `-e OWN_EXTENSION_PATH` minimal-extension hack + `resolveChildPiInvocation` + `execChildPrompt` + the model-resolution retry).
- the `subprocess` arm of `ReviewTransport` (type narrows to `direct`; or keep the union but remove the impl + the `runSubprocessReview` path).
- the `buildSubprocessReviewPrompt` helper (dead after fallback migrates).

### Import path (observability — Q3)
`hermes-memory → @repo/pi-agent-ext-subagent` via the **`src/` subpath** (`@repo/pi-agent-ext-subagent/src/index.ts`) so consolidation (+ review-fallback + correction + flush) runs share the SAME in-flight/persistence singletons the `/subagents` viewer reads (module-identity rule — matches `pi-agent-ext-workflow`'s existing pattern). Bare `.` root would yield a private instance and hide the runs.

### Confirmed givens
- **Model tier:** consolidation (and the other migrated ops) on **small**.
- **Child gets the `memory` tool via `extensionTools` bridging** (`agent.ts:201-214`), NOT the `-e` subprocess hack.
- **Backend-neutrality preserved** — writes go through the same backend-neutral `MemoryRepository`.
- **background-review default stays `direct`** — do NOT migrate it (frequency).
- **Non-candidates confirmed out:** `session-backfill`, `session-live-index`, `sync-markdown-memories` (no LLM child).

### Hand-off
This is a **decision**, not a build. Implementation → `writing-plans` (one plan, ~5 tasks: ① consolidation→spawnSubagent; ② review subprocess-fallback→spawnSubagent; ③ correction-detector + session-flush→spawnSubagent; ④ delete `pi-child-process.ts` + narrow `ReviewTransport`; ⑤ verify). **Acceptance:** `bun test` green across hermes-memory + subagent + workflow; migrated runs visible in `/subagents`; `grep -rn execChildPrompt src/` returns zero; consolidation still writes via the backend-neutral store.
